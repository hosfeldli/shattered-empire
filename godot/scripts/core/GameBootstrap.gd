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
var order_test_at := 0.0
var order_test := {}
var battle := {}
var quality := "medium"


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
	_apply_quality(str(args.get("quality", "medium")))
	if args.has("novsync"):
		DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
		Engine.max_fps = 0
	if args.has("bench"):
		diag.start_bench(float(args.bench), str(args.get("bench-out", "")))
		diag.bench_wait = float(args.get("bench-wait", "0"))
		diag.label.visible = true
	if args.has("probe"):
		diag.start_probe(float(args.probe), str(args.get("probe-out", "")), _probe_extra)
	if args.has("order-test"):
		order_test_at = float(args["order-test"])
	if args.has("tour"):
		_tour(str(args.tour))
	if args.has("mode"):
		start({"mode": args.mode, "url": args.get("server", "ws://127.0.0.1:8137/ws"), "name": args.get("name", "Native"), "seed": args.get("seed", ""), "map": args.get("map", ""), "match": args.get("match", "")})
	else:
		hud.show_lobby(true)
		hud.url_edit.text = str(args.get("server", ""))


## --order-test=SECONDS: select the scout and order it three hexes east through the normal input path
func _run_order_test() -> void:
	for id in world.units.keys():
		var u: Dictionary = world.units[id]
		if int(u.owner) == world.civ_id and str(u.type) == "scout_buggy":
			military.selected.clear()
			military.selected[id] = true
			var target := world.grid.nb[world.grid.nb[world.grid.nb[int(u.tile) * 6] * 6] * 6]
			order_test = {"unit": id, "from": int(u.tile), "to": target, "sent_at": world.server_time}
			net.cmd({"c": "move", "units": [id], "tile": target}, func(r: Dictionary): order_test["reply"] = r)
			return


## --tour=DIR: once the land is built, capture screenshots at several views (close, mid, far, seam)
func _tour(dir: String) -> void:
	DirAccess.make_dir_recursive_absolute(dir)
	var wait := float(args.get("tour-wait", "0"))
	while not (world.ready_ and world.snapshot_count > 8 and terrain.dirty.is_empty() and settlements.version >= 0 and world.server_time >= wait):
		await get_tree().process_frame
	await get_tree().create_timer(1.0).timeout
	var shots := [["close", 9.0, 0.0], ["city", 16.0, 0.0], ["mid", 34.0, 0.0], ["far", 200.0, 0.0], ["seam", 30.0, -1.0]]
	for s in shots:
		if s[2] < 0.0:
			cam.focus.x = 0.5   # look straight at the east-west seam
		else:
			cam.focus_tile(_tour_target())
		cam.size = s[1]
		cam.goal_size = s[1]
		for k in 20:
			await get_tree().process_frame
		var img := get_viewport().get_texture().get_image()
		img.save_png("%s/%s.png" % [dir, s[0]])
		print("TOUR saved ", s[0])
	get_tree().quit()


## --battle=SCENARIO (sandbox matches only): stage a developer scenario through the server's own
## sandbox command, dig in half the infantry, then attack-move the rest. Every step is an intent the
## server validates; the client decides nothing about the outcome.
func _stage_battle(key: String) -> void:
	net.cmd({"c": "sandbox", "op": "scenario", "key": key}, func(r: Dictionary):
		battle = r.get("scenario", {})
		if battle.is_empty():
			push_warning("battle: %s" % str(r))
			return
		cam.focus_tile(int(battle.arena), 24.0)
		var mine: Array = battle.A
		var half := mine.slice(0, mine.size() / 3)
		net.cmd({"c": "fortify", "units": half}, func(f): battle["fortify"] = f)
		await get_tree().create_timer(6.0).timeout
		net.cmd({"c": "move", "units": mine.slice(mine.size() / 3), "tile": int(battle.arena), "attackMove": true}, func(m): battle["advance"] = m))


## the biggest city (spectators), the battle arena, or the start, for screenshots
func _tour_target() -> int:
	if battle.has("arena"):
		return int(battle.arena)
	var best := world.start_tile
	var pop := -1.0
	for c in world.cities.values():
		if float(c.pop) > pop:
			pop = float(c.pop)
			best = int(c.t)
	return best


func _probe_extra() -> Dictionary:
	var out := order_test.duplicate()
	out["bridges_drawn"] = infra.bridge_count()
	out["trucks_drawn"] = infra.trucks.multimesh.visible_instance_count
	out["districts"] = settlements.districts.size()
	out["merged_districts"] = settlements.districts.keys().filter(func(k): return str(k).contains(",")).size()
	if not battle.is_empty():
		out["battle"] = {"arena": battle.get("arena"), "fortify": battle.get("fortify"), "advance": battle.get("advance")}
	if args.has("pick-test"):
		var res := []
		# the most rugged known ground: where picking against a flat plane would go wrong
		var hi := 0
		for i in world.grid.n:
			if world.known[i] and world.height[i] > world.height[hi]:
				hi = i
		cam.focus_tile(hi)
		for z in [9.0, 30.0, 120.0]:
			cam.size = z
			cam.goal_size = z
			cam._apply()
			res.append(diag.pick_test())
		out["picking"] = res
	if out.has("unit") and world.units.has(out.unit):
		out["now_tile"] = int(world.units[out.unit].tile)
		out["path"] = world.paths.get(str(out.unit), [])
	return out


## high: soft 4k shadows, SSAO, MSAA 2x. medium (default): sharper 2k shadows, no SSAO, MSAA 2x.
## low: no shadows, no SSAO, FXAA.
func _apply_quality(q: String) -> void:
	var vp := get_viewport()
	var e: Environment = environment.env.environment
	match q:
		"high":
			RenderingServer.directional_soft_shadow_filter_set_quality(RenderingServer.SHADOW_QUALITY_SOFT_HIGH)
			RenderingServer.directional_shadow_atlas_set_size(4096, true)
			e.ssao_enabled = true
			vp.msaa_3d = Viewport.MSAA_2X
		"low":
			environment.sun.shadow_enabled = false
			e.ssao_enabled = false
			vp.msaa_3d = Viewport.MSAA_DISABLED
			vp.screen_space_aa = Viewport.SCREEN_SPACE_AA_FXAA
		_:
			RenderingServer.directional_soft_shadow_filter_set_quality(RenderingServer.SHADOW_QUALITY_SOFT_LOW)
			RenderingServer.directional_shadow_atlas_set_size(2048, true)
			e.ssao_enabled = false
			vp.msaa_3d = Viewport.MSAA_2X
	quality = q


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
			if args.has("battle") and world.sandbox:
				_stage_battle(str(args.battle))
			if world.spectator and args.has("speed"):
				net.cmd({"c": "speed", "speed": int(args.speed)})
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
	var t0 := Time.get_ticks_usec()
	world.advance_clock(dt)
	if order_test_at > 0.0 and world.snapshot_count > 3 and Time.get_ticks_msec() / 1000.0 > order_test_at:
		order_test_at = 0.0
		_run_order_test()
	var t1 := Time.get_ticks_usec()
	terrain.update_view(cam.focus.x, cam.view_half_width())
	var t2 := Time.get_ticks_usec()
	environment.update(dt)
	var t3 := Time.get_ticks_usec()
	infra.update(dt)
	var t4 := Time.get_ticks_usec()
	settlements.update(dt)
	var t5 := Time.get_ticks_usec()
	military.update(dt)
	var t6 := Time.get_ticks_usec()
	combat.update(dt)
	input.update(dt)
	var t7 := Time.get_ticks_usec()
	diag.record_subsystems({"state": t1 - t0, "terrain": t2 - t1, "environment": t3 - t2, "infrastructure": t4 - t3, "settlements": t5 - t4, "military": t6 - t5, "combat+input": t7 - t6, "total": t7 - t0})


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
