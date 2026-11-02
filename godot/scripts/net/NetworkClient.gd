class_name NetworkClient
extends Node
## Thin WebSocket link to the authoritative server; every game decision happens there.
## Opens each connection with the versioned handshake (protocol 2, capability 'geo'), forwards
## messages as signals, matches command replies by request id, and after a drop reconnects and
## rejoins with the session token, like the PixiJS client.

signal message(m: Dictionary)
signal status_changed(state: String)
signal handshake_done(info: Dictionary)

const PROTOCOL := 2
const WANT_CAPS := ["geo"]
const CLIENT_NAME := "godot-native/0.1"

var url := "ws://127.0.0.1:8137/ws"
var ws: WebSocketPeer
var state := "idle"            # idle, connecting, open, ready, closed, retrying
var session := {}              # { match, token } once seated
var proto := 1
var caps: Array = []
var rtt_ms := 0.0
var bytes_in := 0
var msgs_in := 0
var last_msg_ms := 0
var closed_by_user := false

var _rid := 1
var _pending := {}             # rid -> { cb: Callable, at: float }
var _retry := 0
var _retry_at := 0.0
var _queue: Array = []         # sent before the handshake finished
var _ping_at := 0.0


func connect_to(u: String) -> void:
	url = u
	closed_by_user = false
	_open()


func close() -> void:
	closed_by_user = true
	if ws:
		ws.close()


func _open() -> void:
	ws = WebSocketPeer.new()
	# full-sync snapshots of a large map are several megabytes of JSON
	ws.inbound_buffer_size = 64 * 1024 * 1024
	ws.outbound_buffer_size = 1024 * 1024
	ws.max_queued_packets = 8192
	var err := ws.connect_to_url(url)
	if err != OK:
		push_warning("NetworkClient: cannot open %s (%d)" % [url, err])
		_set_state("closed")
		_schedule_retry()
		return
	_set_state("connecting")


func _process(_dt: float) -> void:
	if ws == null:
		return
	ws.poll()
	var st := ws.get_ready_state()
	var now := Time.get_ticks_msec() / 1000.0
	if st == WebSocketPeer.STATE_OPEN:
		if state == "connecting":
			_set_state("open")
			_retry = 0
			_send_raw({"t": "hello", "proto": PROTOCOL, "caps": WANT_CAPS, "client": CLIENT_NAME})
		while ws.get_available_packet_count() > 0:
			var pkt := ws.get_packet()
			bytes_in += pkt.size()
			msgs_in += 1
			last_msg_ms = Time.get_ticks_msec()
			var m = JSON.parse_string(pkt.get_string_from_utf8())
			if typeof(m) == TYPE_DICTIONARY:
				_on_message(m)
		if state == "ready" and now - _ping_at > 2.0:
			_ping_at = now
			_send_raw({"t": "ping", "at": Time.get_ticks_msec()})
		_expire(now)
	elif st == WebSocketPeer.STATE_CLOSED:
		if state == "retrying":
			if now >= _retry_at:
				_open()
		elif state != "closed" and state != "idle":
			_set_state("closed")
			if not closed_by_user:
				_schedule_retry()


func _schedule_retry() -> void:
	var wait := minf(8.0, 0.5 * pow(2.0, _retry))
	_retry += 1
	_retry_at = Time.get_ticks_msec() / 1000.0 + wait
	_set_state("retrying")


func _set_state(s: String) -> void:
	if s == state:
		return
	state = s
	status_changed.emit(s)


func _ready_after_hello(info: Dictionary) -> void:
	_set_state("ready")
	handshake_done.emit(info)
	if not session.is_empty():
		_send_raw({"t": "rejoin", "match": session.match, "token": session.token})
	for q in _queue:
		_send_raw(q)
	_queue.clear()


func _on_message(m: Dictionary) -> void:
	var t: String = str(m.get("t", ""))
	if state == "open":
		if t == "hello":
			if m.get("ok", false):
				proto = int(m.get("proto", 1))
				caps = m.get("caps", [])
				_ready_after_hello(m)
			else:
				push_error("Server refused the protocol: %s" % m.get("error", "?"))
				_set_state("closed")
				closed_by_user = true
				ws.close()
			return
		if t == "error":
			# a server older than the handshake: speak protocol 1 without capabilities
			proto = 1
			caps = []
			_ready_after_hello({"ok": true, "proto": 1, "caps": [], "legacy": true})
			return
	if t == "pong":
		rtt_ms = float(Time.get_ticks_msec()) - float(m.get("at", 0))
		return
	if t == "joined":
		session = {"match": m.get("match"), "token": m.get("token")}
	if m.has("rid"):
		var rid := int(m.rid)
		if _pending.has(rid):
			var p: Dictionary = _pending[rid]
			_pending.erase(rid)
			(p.cb as Callable).call(m)
			if t == "ack":
				return
	message.emit(m)


func send(o: Dictionary) -> void:
	if state == "ready":
		_send_raw(o)
	else:
		_queue.append(o)


## an intent for the server; cb receives the server's reply (or an error after 6 s)
func cmd(c: Dictionary, cb: Callable = Callable()) -> int:
	var rid := _rid
	_rid += 1
	_pending[rid] = {"cb": cb if cb.is_valid() else func(_r): pass, "at": Time.get_ticks_msec() / 1000.0}
	send({"t": "cmd", "rid": rid, "cmd": c})
	return rid


func _expire(now: float) -> void:
	for rid in _pending.keys():
		var p: Dictionary = _pending[rid]
		if now - float(p.at) > 6.0:
			_pending.erase(rid)
			(p.cb as Callable).call({"error": "The server did not answer in time"})


func _send_raw(o: Dictionary) -> void:
	if ws and ws.get_ready_state() == WebSocketPeer.STATE_OPEN:
		ws.send_text(JSON.stringify(o))
