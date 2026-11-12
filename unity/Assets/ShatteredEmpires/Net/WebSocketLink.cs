using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using SE.Core.Protocol;

namespace SE.Net
{
    /// <summary>
    /// The WebSocket transport. Receiving and JSON decoding never run on the main thread:
    ///  - a background loop reads whole messages;
    ///  - small messages are decoded inline, large ones (full syncs, snapshots) on the thread pool;
    ///  - results are handed to the main thread strictly in wire order (a later message waits for an
    ///    earlier one's decode), so snapshot deltas are never reordered or skipped;
    ///  - command replies and pongs also go to a priority queue the main thread reads first, so an
    ///    acknowledgment never waits behind a backlog of world updates.
    /// Sending uses one loop with a high-priority lane for commands, pings and handshakes.
    /// </summary>
    public sealed class WebSocketLink : IDisposable
    {
        public enum LinkState { Idle, Connecting, Open, Closed }

        sealed class Slot
        {
            public Task<ServerMessage> Decode;
            public ServerMessage Ready;
            public bool Completed => Ready != null || (Decode != null && Decode.IsCompleted);
            public ServerMessage Value => Ready ?? Decode.Result;
        }

        const int InlineDecodeBytes = 8192;
        const int MaxBacklog = 512;

        readonly ConcurrentQueue<Slot> inbox = new ConcurrentQueue<Slot>();
        readonly ConcurrentQueue<ServerMessage> priority = new ConcurrentQueue<ServerMessage>();
        readonly ConcurrentQueue<byte[]> sendHigh = new ConcurrentQueue<byte[]>();
        readonly ConcurrentQueue<byte[]> sendLow = new ConcurrentQueue<byte[]>();
        readonly SemaphoreSlim sendSignal = new SemaphoreSlim(0);
        ClientWebSocket ws;
        CancellationTokenSource cts;
        long sequence;
        volatile int generation;
        volatile LinkState state = LinkState.Idle;

        public LinkState State => state;
        public string LastError { get; private set; }
        public long BytesIn => Interlocked.Read(ref bytesIn);
        public long MessagesIn => Interlocked.Read(ref messagesIn);
        public int Backlog => inbox.Count;
        public double LastDecodeMs { get; private set; }
        long bytesIn, messagesIn;

        public void Connect(Uri uri)
        {
            Dispose();
            cts = new CancellationTokenSource();
            ws = new ClientWebSocket();
            ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
            state = LinkState.Connecting;
            var token = cts.Token;
            var socket = ws;
            int gen = ++generation;
            Task.Run(() => Run(socket, uri, token, gen));
        }

        async Task Run(ClientWebSocket socket, Uri uri, CancellationToken ct, int gen)
        {
            try
            {
                await socket.ConnectAsync(uri, ct).ConfigureAwait(false);
                if (gen == generation) state = LinkState.Open;
                var sender = SendLoop(socket, ct);
                await ReceiveLoop(socket, ct).ConfigureAwait(false);
                await Task.WhenAny(sender, Task.Delay(100)).ConfigureAwait(false);
            }
            catch (Exception e) when (!(e is OutOfMemoryException))
            {
                LastError = e.Message;
            }
            finally
            {
                // a superseded connection must not mark the current one closed
                if (gen == generation) state = LinkState.Closed;
                sendSignal.Release();
            }
        }

        async Task ReceiveLoop(ClientWebSocket socket, CancellationToken ct)
        {
            var buffer = new byte[64 * 1024];
            var message = new MemoryStream(256 * 1024);
            while (socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                message.SetLength(0);
                WebSocketReceiveResult r;
                do
                {
                    r = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), ct).ConfigureAwait(false);
                    if (r.MessageType == WebSocketMessageType.Close) return;
                    message.Write(buffer, 0, r.Count);
                } while (!r.EndOfMessage);
                Interlocked.Add(ref bytesIn, message.Length);
                Interlocked.Increment(ref messagesIn);
                string text = Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
                long seq = ++sequence;
                var slot = new Slot();
                if (text.Length < InlineDecodeBytes)
                {
                    var m = SafeDecode(text, seq);
                    slot.Ready = m;
                    if (IsPriority(m)) { priority.Enqueue(m); continue; }
                }
                else slot.Decode = Task.Run(() => SafeDecode(text, seq));
                inbox.Enqueue(slot);
                // the main thread drains every frame; if it ever falls far behind, slow the socket down
                // rather than dropping anything (TCP back-pressure reaches the server)
                while (inbox.Count > MaxBacklog && !ct.IsCancellationRequested) await Task.Delay(2, ct).ConfigureAwait(false);
            }
        }

        static bool IsPriority(ServerMessage m) => m.T == "pong" || (m.Rid >= 0 && (m.T == "ack" || m.T == "error"));

        static ServerMessage SafeDecode(string text, long seq)
        {
            try
            {
                var m = ProtocolDecoder.Decode(text);
                m.Sequence = seq;
                return m;
            }
            catch (Exception e)
            {
                return new ServerMessage { T = "decode-error", Error = e.Message, Bytes = text.Length, Sequence = seq };
            }
        }

        async Task SendLoop(ClientWebSocket socket, CancellationToken ct)
        {
            try
            {
                while (!ct.IsCancellationRequested && socket.State == WebSocketState.Open)
                {
                    await sendSignal.WaitAsync(ct).ConfigureAwait(false);
                    while (sendHigh.TryDequeue(out var hi) || sendLow.TryDequeue(out hi))
                        await socket.SendAsync(new ArraySegment<byte>(hi), WebSocketMessageType.Text, true, ct).ConfigureAwait(false);
                }
            }
            catch (Exception e) when (!(e is OutOfMemoryException)) { LastError = e.Message; }
        }

        public void Send(string json, bool high)
        {
            var bytes = Encoding.UTF8.GetBytes(json);
            (high ? sendHigh : sendLow).Enqueue(bytes);
            sendSignal.Release();
        }

        /// <summary>
        /// Main thread: hand over decoded messages. Priority replies first, then wire-order messages whose
        /// decode has finished, stopping at the first one still decoding or when the budget is spent
        /// (the rest are handled next frame, never dropped).
        /// </summary>
        public int Drain(Action<ServerMessage> handler, double budgetMs)
        {
            int handled = 0;
            while (priority.TryDequeue(out var p)) { handler(p); handled++; }
            var start = System.Diagnostics.Stopwatch.GetTimestamp();
            double tickMs = 1000.0 / System.Diagnostics.Stopwatch.Frequency;
            while (inbox.TryPeek(out var slot) && slot.Completed)
            {
                inbox.TryDequeue(out _);
                var m = slot.Value;
                LastDecodeMs = m.DecodeMs;
                handler(m);
                handled++;
                if ((System.Diagnostics.Stopwatch.GetTimestamp() - start) * tickMs > budgetMs) break;
            }
            return handled;
        }

        public void Dispose()
        {
            try { cts?.Cancel(); } catch (ObjectDisposedException) { }
            try { ws?.Abort(); ws?.Dispose(); } catch (Exception) { }
            ws = null;
            while (inbox.TryDequeue(out _)) { }
            while (priority.TryDequeue(out _)) { }
            while (sendHigh.TryDequeue(out _)) { }
            while (sendLow.TryDequeue(out _)) { }
            state = LinkState.Idle;
        }
    }
}
