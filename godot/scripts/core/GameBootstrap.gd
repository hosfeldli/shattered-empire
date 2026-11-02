extends Node3D
## Entry point of the native client. Builds the subsystems, wires them together and runs them in a
## fixed order each frame (camera first, so everything is placed for this frame's view: that is
## what keeps the east-west seam from ever jumping). The client is a view of the authoritative
## server: it sends intents and draws what it is told.
##
## Command line (after `--`):
##   --server=ws://host:port/ws   server WebSocket (default ws://127.0.0.1:8137/ws)
##   --mode=ai|observe|sandbox|rejoin|spectate   start straight away instead of showing the start panel
##   --name=NAME  --seed=N  --map=small|medium|large  --match=CODE (spectate)
##   --bench=SECONDS  --bench-out=PATH   scripted benchmark, writes JSON and quits

const SESSION_FILE := "user://session.json"

var net: NetworkClient
var world: WorldState
var cam: CameraController
var terrain: WorldRenderer
var settlements: SettlementRenderer
var infra: InfrastructureRenderer
var military: MilitaryRenderer
var environment: EnvironmentRenderer
var combat: CombatRenderer
var input: InputController
var hud: GameHUD
var diag: Diagnostics
var args := {}
var pending_mode := ""
var pending_opts := {}


func _ready() -> void:
	args = _parse_args(OS.get_cmdline_user_args())
	net = NetworkClient.new()
	net.name = "NetworkClient"
	add_child(net)
	world = WorldState.new()
	world.name = "WorldState"
	add_child(world)
	cam = CameraController.new()
	cam.name = "CameraController"
	cam.process_priority = -10
	add_child(cam)
	cam.setup(world)
	terrain = WorldRenderer.new()
	terrain.name = "WorldRenderer"
	add_child(terrain)
	terrain.setup(world)
	environment = EnvironmentRenderer.new()
	environment.name = "EnvironmentRenderer"
	add_child(environment)
	environment.setup(world, cam, terrain)
	infra = InfrastructureRenderer.new()
	infra.name = "InfrastructureRenderer"
	add_child(infra)
	infra.setup(world, cam)
	settlements = SettlementRenderer.new()
	settlements.name = "SettlementRenderer"
	add_child(settlements)
	settlements.setup(world, cam)
	military = MilitaryRenderer.new()
	military.name = "MilitaryRenderer"
	add_child(military)
	military.setup(world, cam)
	combat = CombatRenderer.new()
	combat.name = "CombatRenderer"
	add_child(combat)
	combat.setup(world, cam)
	input = InputController.new()
	input.name = "InputController"
	add_child(input)
	input.setup(world, net, cam, military, settlements)
	input.attach_marker(self)
	hud = GameHUD.new()
	hud.name = "GameHUD"
	add_child(hud)
	hud.setup(world, net, military, settlements)
	hud.input_ref = input
	diag = Diagnostics.new()
	diag.name = "Diagnostics"
	add_child(diag)
	diag.setup(world, net, cam, terrain, military)

	net.message.connect(_on_message)
	net.status_changed.connect(_on_status)
	hud.start_requested.connect(start)
	input.order_feedback.connect(hud.show_toast)
	if args.has("bench"):
		diag.start_bench(float(args.bench), str(args.get("bench-out", "")))
		diag.label.visible = true
	if args.has("mode"):
		start({"mode": args.mode, "url": args.get("server", "ws://127.0.0.1:8137/ws"), "name": args.get("name", "Native"), "seed": args.get("seed", ""), "map": args.get("map", ""), "match": args.get("match", "")})
	else:
		hud.show_lobby(true)
		hud.url_edit.text = str(args.get("server", ""))


func _parse_args(list: PackedStringArray) -> Dictionary:
	var out := {}
	for a in list:
		if a.begins_with("--"):
			var kv := a.substr(2).split("=", true, 1)
			out[kv[0]] = kv[1] if kv.size() > 1 else "1"
	return out


func start(opts: Dictionary) -> void:
	hud.show_lobby(true, "Connecting to %s…" % opts.url)
	pending_mode = str(opts.mode)
	pending_opts = opts
	if pending_mode == "rejoin":
		var s := _load_session()
		if s.is_empty():
			hud.show_lobby(true, "No earlier match to return to.")
			return
		net.session = s
	elif pending_mode == "spectate":
		net.send({"t": "spectate", "match": str(opts.get("match", "")), "name": str(opts.name)})
	else:
		var msg := {"t": "create", "mode": pending_mode, "name": str(opts.name)}
		if pending_mode == "observe":
			msg.ais = 3
		else:
			msg.ais = 1
		if str(opts.get("seed", "")) != "":
			msg.seed = int(opts.seed)
		if str(opts.get("map", "")) != "":
			msg.mapSize = str(opts.map)
		net.send(msg)
	net.connect_to(str(opts.url))


func _on_status(s: String) -> void:
	if s == "retrying" and not world.ready_:
		hud.show_lobby(true, "Cannot reach %s; retrying…" % net.url)


func _on_message(m: Dictionary) -> void:
	match str(m.get("t", "")):
		"joined":
			_save_session(net.session)
			if str(m.get("status", "")) == "lobby":
				hud.show_lobby(true, "Waiting in the match lobby…")
		"welcome":
			world.apply_welcome(m)
			cam.on_world()
			cam.focus_tile(world.start_tile, 26.0)
			hud.show_lobby(false)
		"error":
			var err := str(m.get("error", "error"))
			if world.ready_:
				hud.show_toast(err, false)
			else:
				hud.show_lobby(true, err)
			if err.contains("no longer exists") or err.contains("Invalid session"):
				_save_session({})
		"over":
			hud.show_toast("The match is over.", true)
		_:
			world.on_message(m)


func _process(dt: float) -> void:
	cam.input_enabled = not hud.lobby.visible
	hud.update(dt)
	if not world.ready_:
		return
	world.advance_clock(dt)
	terrain.update_view(cam.focus.x, cam.view_half_width())
	environment.update(dt)
	infra.update(dt)
	settlements.update(dt)
	military.update(dt)
	combat.update(dt)
	input.update(dt)


func _save_session(s: Dictionary) -> void:
	var f := FileAccess.open(SESSION_FILE, FileAccess.WRITE)
	if f:
		f.store_string(JSON.stringify(s))
		f.close()


func _load_session() -> Dictionary:
	if not FileAccess.file_exists(SESSION_FILE):
		return {}
	var f := FileAccess.open(SESSION_FILE, FileAccess.READ)
	if f == null:
		return {}
	var d = JSON.parse_string(f.get_as_text())
	return d if typeof(d) == TYPE_DICTIONARY and d.has("match") else {}
