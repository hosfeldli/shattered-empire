using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;

namespace SE.Net
{
    /// <summary>
    /// A session with the authoritative server: versioned handshake (protocol 2 with capabilities
    /// 'geo' and 'udelta'), request ids and replies, ping, and automatic reconnect that rejoins the
    /// same seat with the session token. Every game decision happens on the server.
    /// Call <see cref="Update"/> once per frame on the main thread.
    /// </summary>
    public sealed class GameConnection : IDisposable
    {
        public const int Protocol = 2;
        public static readonly string[] WantCaps = { "geo", "udelta", "action-rts", "ring-cities-v1" };
        public const string ClientName = "unity-native/0.1";

        public enum Status { Idle, Connecting, Open, Ready, Closed, Retrying }

        readonly WebSocketLink link = new WebSocketLink();
        public readonly CommandTracker Commands = new CommandTracker();
        readonly List<string> queued = new List<string>();
        Func<double> clock;

        public string Url { get; private set; } = "ws://127.0.0.1:8137/ws";
        public Status State { get; private set; } = Status.Idle;
        public int ProtocolVersion { get; private set; } = 1;
        public string[] Capabilities { get; private set; } = Array.Empty<string>();
        public string ServerVersion { get; private set; } = "";
        public double RttMs { get; private set; }
        public int Connections { get; private set; }
        public string LastError => link.LastError;
        public WebSocketLink Link => link;

        /// <summary>The seat to rejoin after a drop: { match, token }.</summary>
        public string SessionMatch, SessionToken;

        public event Action<ServerMessage> Message;
        public event Action<Status> StatusChanged;
        public event Action Ready;

        bool closedByUser;
        int retry;
        double retryAt, pingAt;

        public GameConnection(Func<double> nowSeconds) { clock = nowSeconds; }

        public void Connect(string url)
        {
            Url = url;
            closedByUser = false;
            Open();
        }

        public void Close()
        {
            closedByUser = true;
            link.Dispose();
            SetState(Status.Closed);
        }

        void Open()
        {
            link.Connect(new Uri(Url));
            SetState(Status.Connecting);
        }

        void SetState(Status s)
        {
            if (s == State) return;
            State = s;
            StatusChanged?.Invoke(s);
        }

        public void Update(double budgetMs)
        {
            double now = clock();
            var ls = link.State;
            if (ls == WebSocketLink.LinkState.Open)
            {
                if (State == Status.Connecting)
                {
                    SetState(Status.Open);
                    retry = 0;
                    SendRaw(new JObject { ["t"] = "hello", ["proto"] = Protocol, ["caps"] = new JArray(WantCaps), ["client"] = ClientName }, true);
                }
                link.Drain(OnMessage, budgetMs);
                if (State == Status.Ready && now - pingAt > 2.0)
                {
                    pingAt = now;
                    SendRaw(new JObject { ["t"] = "ping", ["at"] = now * 1000.0 }, true);
                }
                Commands.Expire(now);
            }
            else if (ls == WebSocketLink.LinkState.Closed || ls == WebSocketLink.LinkState.Idle)
            {
                // deliver anything already received before the socket closed
                link.Drain(OnMessage, budgetMs);
                if (State == Status.Retrying)
                {
                    if (now >= retryAt) Open();
                }
                else if (State != Status.Closed && State != Status.Idle)
                {
                    SetState(Status.Closed);
                    if (!closedByUser) ScheduleRetry(now);
                }
            }
        }

        void ScheduleRetry(double now)
        {
            double wait = Math.Min(8.0, 0.5 * Math.Pow(2.0, retry));
            retry++;
            retryAt = now + wait;
            SetState(Status.Retrying);
        }

        void OnMessage(ServerMessage m)
        {
            double now = clock();
            if (State == Status.Open)
            {
                if (m.T == "hello")
                {
                    if (ProtocolDecoder.Bool(m.Raw["ok"]))
                    {
                        ProtocolVersion = ProtocolDecoder.Int(m.Raw["proto"], 1);
                        Capabilities = (m.Raw["caps"] as JArray)?.ToObject<string[]>() ?? Array.Empty<string>();
                        ServerVersion = ProtocolDecoder.Str(m.Raw["version"], "");
                        BecomeReady();
                    }
                    else
                    {
                        closedByUser = true;
                        link.Dispose();
                        SetState(Status.Closed);
                        Message?.Invoke(new ServerMessage { T = "error", Error = "Server refused the protocol: " + (m.Error ?? "?") });
                    }
                    return;
                }
                if (m.T == "error" && m.Rid < 0)
                {
                    // a server older than the handshake: protocol 1 without capabilities
                    ProtocolVersion = 1;
                    Capabilities = Array.Empty<string>();
                    BecomeReady();
                    return;
                }
            }
            if (m.T == "pong")
            {
                RttMs = now * 1000.0 - ProtocolDecoder.Float(m.Raw?["at"]);
                return;
            }
            if (m.T == "joined")
            {
                SessionMatch = ProtocolDecoder.Str(m.Raw["match"]);
                SessionToken = ProtocolDecoder.Str(m.Raw["token"]);
            }
            if (m.Rid >= 0 && Commands.Resolve(m, now) && m.T == "ack") return;
            Message?.Invoke(m);
        }

        void BecomeReady()
        {
            Connections++;
            SetState(Status.Ready);
            Ready?.Invoke();
            if (!string.IsNullOrEmpty(SessionMatch) && !string.IsNullOrEmpty(SessionToken))
                SendRaw(new JObject { ["t"] = "rejoin", ["match"] = SessionMatch, ["token"] = SessionToken }, true);
            foreach (var q in queued) link.Send(q, true);
            queued.Clear();
        }

        /// <summary>Send a lobby or control message (queued until the handshake completes).</summary>
        public void Send(JObject o)
        {
            var json = o.ToString(Formatting.None);
            if (State == Status.Ready) link.Send(json, true);
            else queued.Add(json);
        }

        /// <summary>Send an intent; the callback receives the server's reply, or an error after 6 s.</summary>
        public int Command(JObject command, Action<ServerMessage> callback = null)
        {
            int rid = Commands.Register(command, callback, clock());
            Send(new JObject { ["t"] = "cmd", ["rid"] = rid, ["cmd"] = command });
            return rid;
        }

        /// <summary>A spectator's command (follow a nation, fog of war, match speed): its own envelope on the server.</summary>
        public int ObserverCommand(JObject command, Action<ServerMessage> callback = null)
        {
            int rid = Commands.Register(command, callback, clock());
            Send(new JObject { ["t"] = "obsCmd", ["rid"] = rid, ["cmd"] = command });
            return rid;
        }

        void SendRaw(JObject o, bool high) => link.Send(o.ToString(Formatting.None), high);

        public void ForgetSession() { SessionMatch = null; SessionToken = null; queued.Clear(); Commands.Clear(); }

        public void Dispose() => link.Dispose();
    }
}
