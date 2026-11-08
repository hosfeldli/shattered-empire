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
var session_file:=SESSION_FILE

var net: NetworkClient
var wildlife: WildlifePresentation
var world: WorldState
var composition: WorldCompositionSystem
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
var generation_diag: GenerationDiagnostics
var command_tools: NativeCommandTools
var command_panel: NativeCommandPanel
var civilians: CivilianActivitySystem
var squads: SquadPresentation
var strategic: StrategicPresentation
var workspace: NativeWorkspace
var live_validation: LiveValidation
var battlefield_composer: BattlefieldComposer
var audio: AudioDirector
var args := {}
var pending_mode := ""
var pending_opts := {}
var order_test_at := 0.0
var order_test := {}
var battle := {}
var quality := "medium"
var preferences:=NativePreferences.new()
var shell:NativeAppShell
var automated:=false
var atmosphere_validation:AtmosphereValidation
var ui_validation:NativeUIValidation
var surface_validation:SurfaceValidation
var commands:=CommandRegistry.new()
var command_dock:NativeCommandDock
var map_overlay:NativeMapOverlay
var resource_strip:NativeResourceStrip
var onboarding:NativeOnboarding
var recipe_inspector:NativeRecipeInspector
var follow_pill:NativeFollowPill
var perf_samples = null   # --perf: [frame ms, military, squads, combat, civilians+input, settlements, terrain, environment, total] (us)
var alert_feed:NativeAlertFeed
var world_labels:NativeWorldLabels
var observer_bar:NativeObserverBar
var production_feedback:NativeProductionFeedback


func _ready() -> void:
	args = _parse_args(OS.get_cmdline_user_args())
	get_viewport().size_changed.connect(_apply_render_scale)
	automated=args.has("bench") or args.has("perf") or args.has("probe") or args.has("validate-lwe") or args.has("tour") or args.has("ui-test") or args.has("water-test") or args.has("surface-test")
	if not automated: preferences.load_from(str(args.get("settings-file","user://settings.cfg")))
	else: preferences.path=str(args.get("settings-file","user://test-settings.cfg"))
	if args.has("server"): preferences.values.server=str(args.server)
	session_file=str(args.get("session-file",SESSION_FILE))
	# Decode imported meshes/textures before connecting. First use must not stall construction.
	for key in MaterialLibrary.SPECS: MaterialLibrary.get_mat(key)
	for variant in 3: AssetLibrary.residential(variant)
	for model in ["infantry_idle","infantry_walk_0","infantry_walk_1","infantry_cover","tank_hull","tank_turret","scout_vehicle","artillery_gun","aircraft"]:
		AssetLibrary.unit_component(model)
	net = NetworkClient.new()
	net.name = "NetworkClient"
	net.process_priority = -100
	add_child(net)
	world = WorldState.new()
	world.name = "WorldState"
	add_child(world)
	composition = WorldCompositionSystem.new()
	composition.setup(world)
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
	environment.composition = composition
	infra = InfrastructureRenderer.new()
	infra.name = "InfrastructureRenderer"
	add_child(infra)
	infra.setup(world, cam)
	settlements = SettlementRenderer.new()
	settlements.name = "SettlementRenderer"
	add_child(settlements)
	settlements.setup(world, cam, composition)
	military = MilitaryRenderer.new()
	military.name = "MilitaryRenderer"
	add_child(military)
	military.setup(world, cam)
	combat = CombatRenderer.new()
	combat.name = "CombatRenderer"
	add_child(combat)
	combat.setup(world, cam)
	combat.military=military
	combat.terrain=terrain
	civilians = CivilianActivitySystem.new()
	add_child(civilians)
	civilians.setup(composition, cam)
	squads = SquadPresentation.new()
	add_child(squads)
	squads.setup(world, cam, military, settlements)
	military.squads = squads
	wildlife = WildlifePresentation.new(); add_child(wildlife); wildlife.setup(world, cam, composition)
	combat.composition = composition
	combat.director = CombatPresentationDirector.new()
	combat.director.world = world; combat.director.camera = cam; combat.director.lod = composition.lod
	battlefield_composer = BattlefieldComposer.new()
	battlefield_composer.setup(composition,terrain)
	audio=AudioDirector.new(); add_child(audio); audio.setup(world,cam)
	audio.weather=composition.weather
	net.command_result.connect(audio.on_command_result)
	net.message.connect(audio.on_message)
	wildlife.audio = audio
	wildlife.settlements = settlements
	environment.lightning.connect(audio.thunder)
	combat.audio=audio
	input = InputController.new()
	input.name = "InputController"
	add_child(input)
	input.setup(world, net, cam, military, settlements)
	input.attach_marker(self)
	command_tools = NativeCommandTools.new()
	add_child(command_tools)
	command_tools.setup(world, net, cam, military)
	input.tools = command_tools
	hud = GameHUD.new()
	hud.name = "GameHUD"
	add_child(hud)
	hud.setup(world, net, military, settlements)
	hud.input_ref = input
	command_panel = NativeCommandPanel.new()
	add_child(command_panel)
	command_panel.setup(world, command_tools, input, settlements)
	command_tools.feedback.connect(hud.show_toast)
	strategic = StrategicPresentation.new()
	hud.root.add_child(strategic)
	strategic.setup(world,cam,composition,terrain)
	workspace = NativeWorkspace.new()
	add_child(workspace)
	commands.setup(world,net,hud.show_toast)
	workspace.commands=commands
	workspace.setup(world,net,cam,settlements,military,hud.show_toast)
	command_tools.commands=commands; command_tools.settlements=settlements; command_tools.infrastructure=infra; command_tools.terrain=terrain
	input.commands=commands
	commands.finished.connect(func(command,reply):
		if command.get("c")=="army" and command.get("op")=="create" and int(reply.get("id",-1))>=0: input.selected_army=int(reply.id)
		if command.get("c") in ["move","deploy","army"]: military.path_until=Time.get_ticks_msec()+3500)
	workspace.tools=command_tools; workspace.input_ref=input
	input.selection_changed.connect(workspace.follow_selection)
	input.selection_changed.connect(workspace.cancel_pending_scenario_selection)
	shell=NativeAppShell.new(); add_child(shell); shell.setup(self,preferences,automated)
	command_dock=NativeCommandDock.new(); add_child(command_dock); command_dock.setup(self)
	map_overlay=NativeMapOverlay.new(); hud.root.add_child(map_overlay); map_overlay.setup(self)
	world_labels=NativeWorldLabels.new(); hud.root.add_child(world_labels); world_labels.setup(self)
	input.labels=world_labels
	resource_strip=NativeResourceStrip.new(); hud.root.add_child(resource_strip); resource_strip.setup(self)
	terrain.territory.scheduler=composition.scheduler
	onboarding=NativeOnboarding.new(); hud.root.add_child(onboarding); onboarding.setup(self)
	recipe_inspector=NativeRecipeInspector.new(); hud.root.add_child(recipe_inspector); recipe_inspector.setup(self)
	follow_pill=NativeFollowPill.new(); hud.root.add_child(follow_pill); follow_pill.setup(self)
	alert_feed=NativeAlertFeed.new(); hud.root.add_child(alert_feed); alert_feed.setup(self)
	observer_bar=NativeObserverBar.new(); hud.root.add_child(observer_bar); observer_bar.setup(self)
	production_feedback=NativeProductionFeedback.new(); hud.root.add_child(production_feedback); production_feedback.setup(self)
	diag = Diagnostics.new()
	diag.name = "Diagnostics"
	add_child(diag)
	diag.setup(world, net, cam, terrain, military)
	generation_diag = GenerationDiagnostics.new()
	generation_diag.name = "GenerationDiagnostics"
	add_child(generation_diag)
	generation_diag.setup(composition, settlements, cam, self)

	net.message.connect(_on_message)
	net.status_changed.connect(_on_status)
	hud.start_requested.connect(start)
	input.order_feedback.connect(hud.show_toast)
	preferences.apply(self,automated or args.has("windowed"))
	if args.has("quality"): _apply_quality(str(args.quality))
	if args.has("novsync"):
		DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
		Engine.max_fps = 0
	if args.has("bench"):
		Engine.max_fps = 60
		diag.start_bench(float(args.bench), str(args.get("bench-out", "")))
		diag.bench_wait = float(args.get("bench-wait", "0"))
		diag.label.visible = true
	if args.has("probe"):
		diag.start_probe(float(args.probe), str(args.get("probe-out", "")), _probe_extra)
	if args.has("order-test"):
		order_test_at = float(args["order-test"])
	if args.has("tour"):
		_tour(str(args.tour))
	if args.has("perf"):
		_perf(float(args.perf), str(args.get("perf-out", "")))
	if args.has("validate-lwe"):
		live_validation = LiveValidation.new()
		live_validation.run(self,str(args["validate-lwe"]))
	if args.has("water-test"):
		atmosphere_validation=AtmosphereValidation.new(); atmosphere_validation.run(self,str(args["water-test"]))
	if args.has("ui-test"):
		ui_validation=NativeUIValidation.new(); ui_validation.run(self,str(args["ui-test"]))
	if args.has("surface-test"):
		surface_validation=SurfaceValidation.new(); surface_validation.run(self,str(args["surface-test"]))
	if args.has("mode"):
		start({"mode": args.mode, "url": args.get("server", "ws://127.0.0.1:8137/ws"), "name": args.get("name", "Native"), "seed": args.get("seed", ""), "map": args.get("map", ""), "match": args.get("match", "")})
	else:
		hud.show_lobby(false)
		hud.url_edit.text = str(args.get("server", ""))
		if args.has("server"): preferences.values.server=str(args.server)


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
	while not (world.ready_ and world.snapshot_count > 8 and terrain.dirty.is_empty() and settlements.version >= 0 and not settlements.is_building() and world.server_time >= wait):
		await get_tree().process_frame
	await get_tree().create_timer(1.0).timeout
	var shots := [["close", 9.0, 0.0], ["city", 16.0, 0.0], ["mid", 34.0, 0.0], ["far", 200.0, 0.0], ["seam", 30.0, -1.0]]
	if args.has("tour-sizes"):   # e.g. --tour-sizes=4,9,60 for focused captures
		shots = []
		for z in str(args["tour-sizes"]).split(","):
			shots.append(["z" + z, float(z), 0.0])
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


## --perf=SECONDS (with --battle): once the battle is staged and running, record frame time and
## per-subsystem cost at a close and an operational zoom; print and optionally save the summary.
func _perf(seconds: float, out: String) -> void:
	while not (world.ready_ and world.snapshot_count > 8 and battle.has("arena")):
		await get_tree().process_frame
	await get_tree().create_timer(10.0).timeout
	RenderingServer.viewport_set_measure_render_time(get_viewport().get_viewport_rid(), true)
	var report := {"units": world.units.size(), "render_scale": get_viewport().scaling_3d_scale}
	var zooms := []
	for z in str(args.get("perf-zooms", "14,40")).split(","): zooms.append(float(z))
	for zoom in zooms:
		cam.focus_tile(int(battle.arena), zoom)
		await get_tree().create_timer(1.0).timeout
		perf_samples = []
		await get_tree().create_timer(seconds).timeout
		var columns := ["frame_ms", "military_us", "squads_us", "combat_us", "civilians_us", "settlements_us", "terrain_us", "environment_us", "total_us", "gpu_ms", "render_cpu_ms"]
		var summary := {}
		for c in columns.size():
			var values: Array = perf_samples.map(func(row): return float(row[c]))
			values.sort()
			summary[columns[c]] = {"p50": snappedf(values[values.size() / 2], .1), "p95": snappedf(values[int(values.size() * .95)], .1)}
		summary["frames"] = perf_samples.size(); summary["units_visible"] = world.units.size(); summary["figures"] = squads.drawn
		report["zoom_%d" % int(zoom)] = summary
		perf_samples = null
		if args.has("perf-shots"):
			DirAccess.make_dir_recursive_absolute(str(args["perf-shots"]))
			get_viewport().get_texture().get_image().save_png("%s/perf-%d.png" % [str(args["perf-shots"]), int(zoom)])
	print("PERF ", JSON.stringify(report))
	if not out.is_empty():
		var f := FileAccess.open(out, FileAccess.WRITE); f.store_string(JSON.stringify(report, "  ")); f.close()
	get_tree().quit()


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
	out["district_handoffs_pending"] = settlements.retiring.size()
	out["composition"] = composition.stats()
	out["water"]={"active":environment.water.active,"steps":environment.water.simulation.steps,"solver_max_step_us":environment.water.simulation.max_step_us}
	if settlements.selected_building >= 0:
		out["selected_recipe"] = composition.explain_building(settlements.selected_building)
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
	composition.lod.set_quality(q)
	var vp := get_viewport()
	var e: Environment = environment.env.environment
	match q:
		"high", "ultra":
			environment.set_shadows_enabled(true)
			RenderingServer.directional_soft_shadow_filter_set_quality(RenderingServer.SHADOW_QUALITY_SOFT_HIGH)
			RenderingServer.directional_shadow_atlas_set_size(4096, true)
			e.ssao_enabled = true
			vp.msaa_3d = Viewport.MSAA_2X
		"low":
			environment.set_shadows_enabled(false)
			e.ssao_enabled = false
			vp.msaa_3d = Viewport.MSAA_DISABLED
			vp.screen_space_aa = Viewport.SCREEN_SPACE_AA_FXAA
		_:
			environment.set_shadows_enabled(true)
			RenderingServer.directional_soft_shadow_filter_set_quality(RenderingServer.SHADOW_QUALITY_SOFT_LOW)
			RenderingServer.directional_shadow_atlas_set_size(2048, true)
			e.ssao_enabled = false
			vp.msaa_3d = Viewport.MSAA_2X
	quality = q
	_apply_render_scale()


## High-density displays: the 3D world renders at a pixel budget per quality preset and is
## upscaled (AMD FSR), while the interface stays at native resolution. A Retina window otherwise
## shades four times the pixels of an ordinary one.
const RENDER_PIXELS := {"low": 1300000.0, "medium": 2100000.0, "high": 3700000.0, "ultra": 1e12}
func _apply_render_scale() -> void:
	var vp := get_viewport()
	var size := Vector2(vp.get_visible_rect().size) * float(DisplayServer.screen_get_scale())
	var window := DisplayServer.window_get_size()
	if window.x > 0: size = Vector2(window)
	var budget: float = RENDER_PIXELS.get(quality, RENDER_PIXELS.medium)
	var scale := clampf(sqrt(budget / maxf(size.x * size.y, 1.0)), 0.5, 1.0)
	vp.scaling_3d_mode = Viewport.SCALING_3D_MODE_FSR if scale < 0.99 else Viewport.SCALING_3D_MODE_BILINEAR
	vp.scaling_3d_scale = scale
	vp.fsr_sharpness = 0.3


## --hide=trees,clouds,water,smoke,shadows,buildings: switch layers off to find what the GPU pays for
func _debug_hide(what: PackedStringArray) -> void:
	environment.hide_trees = what.has("trees")
	environment.clouds.visible = not what.has("clouds")
	if what.has("shadows"):
		environment.set_shadows_enabled(false)
	for c in terrain.chunks.values():
		for m in c.winst:
			if what.has("water"):
				(m as Node3D).visible = false
	for d in settlements.districts.values():
		(d.node as Node3D).visible = not what.has("buildings")
		(d.fx as Node3D).visible = not what.has("buildings")
	settlements.plumes.visible = not what.has("smoke")
	military.visible = not what.has("units"); squads.visible = not what.has("units")


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
	if pending_mode!="rejoin":
		net.session={}; net._queue.clear(); net._pending.clear()
	if pending_mode == "rejoin":
		var s := _load_session()
		if s.is_empty():
			hud.show_lobby(true, "No earlier match to return to.")
			return
		net.session = s
	elif pending_mode in ["spectate","join"]:
		net.send({"t": pending_mode, "match": str(opts.get("match", "")), "name": str(opts.name)})
	else:
		var msg := {"t": "create", "mode": pending_mode, "name": str(opts.name), "ruleset":"native-v4"}
		if pending_mode == "observe":
			msg.ais = 3
		else:
			msg.ais = 1
		if str(opts.get("seed", "")) != "":
			msg.seed = int(opts.seed)
		if str(opts.get("map", "")) != "":
			msg.mapSize = str(opts.map)
		for key in ["ais","humans","difficulty","aiPersonality","fairPlay","rebels","style","rivals"]:
			if opts.has(key): msg[key]=opts[key]
		if args.has("bench"):
			# Seed fixes terrain, but the lobby otherwise chooses AI personalities with Math.random.
			# Pin them for repeatable cross-client benchmark populations without changing the server.
			msg.rivals = [{"personality": "warlord"}, {"personality": "merchant"}, {"personality": "builder"}]
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
			if pending_mode not in ["rejoin","join","spectate"] and not str(m.get("ruleset","legacy-v1")) in ["native-v3","native-v4"]:
				net.close(); shell.show_view("main")
				NativeUI.label(shell.content,"This server needs the native ruleset update. Choose an updated server in Settings to start a new campaign.",16,NativeUI.GOLD)
				return
			# Rejoining the same match (a dropped connection) keeps the player's view where it was.
			var same_match:=world.match_id!="" and str(m.get("match",""))==world.match_id and world.grid!=null
			var view:=Vector3(cam.focus.x,cam.size,cam.focus.z)
			world.apply_welcome(m)
			cam.on_world()
			if same_match:
				cam.focus=Vector3(view.x,cam.focus.y,view.z); cam.size=view.y; cam.goal_size=view.y
			else:
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
				# command-line starts (--mode) never went through the menu; show it on the card too
				if shell and shell.view!="connecting": shell.show_error(err)
			if err.contains("no longer exists") or err.contains("Invalid session"):
				_save_session({})
		"over":
			hud.show_toast("The match is over.", true)
		_:
			world.on_message(m)


func _process(dt: float) -> void:
	var focused:=get_viewport().gui_get_focus_owner()
	var typing:=focused is LineEdit or focused is TextEdit or focused is SpinBox
	var blocked:=(shell.is_blocking() or workspace.confirm.visible) if shell else true
	cam.input_enabled = world.ready_ and not blocked and not typing
	input.input_enabled=world.ready_ and not blocked and not typing
	command_tools.input_enabled=input.input_enabled
	hud.update(dt)
	if not world.ready_:
		return
	var t0 := Time.get_ticks_usec()
	world.advance_clock(dt)
	if order_test_at > 0.0 and world.snapshot_count > 3 and Time.get_ticks_msec() / 1000.0 > order_test_at:
		order_test_at = 0.0
		_run_order_test()
	if args.has("hide"):
		_debug_hide(str(args.hide).split(","))
	var t1 := Time.get_ticks_usec()
	terrain.update_view(cam.focus.x, cam.view_half_width())
	var t2 := Time.get_ticks_usec()
	environment.update(dt)
	var t3 := Time.get_ticks_usec()
	infra.update(dt)
	var t4 := Time.get_ticks_usec()
	settlements.update(dt, net.frame_work_us < 500)
	var t5 := Time.get_ticks_usec()
	military.update(dt)
	var t5b := Time.get_ticks_usec()
	squads.update(dt)
	var t6 := Time.get_ticks_usec()
	combat.update(dt)
	var t6b := Time.get_ticks_usec()
	civilians.update(dt)
	input.update(dt)
	var t7 := Time.get_ticks_usec()
	if perf_samples != null:
		var rid := get_viewport().get_viewport_rid()
		perf_samples.append([dt * 1000.0, t5b - t5, t6 - t5b, t6b - t6, t7 - t6b, t5 - t4, t2 - t1, t3 - t2, Time.get_ticks_usec() - t0, RenderingServer.viewport_get_measured_render_time_gpu(rid), RenderingServer.viewport_get_measured_render_time_cpu(rid) + RenderingServer.get_frame_setup_time_cpu()])
	diag.record_subsystems({"state": t1 - t0, "terrain": t2 - t1, "environment": t3 - t2, "infrastructure": t4 - t3, "settlements": t5 - t4, "military": t6 - t5, "combat+input": t7 - t6, "total": t7 - t0})


func _save_session(s: Dictionary) -> void:
	var f := FileAccess.open(session_file, FileAccess.WRITE)
	if f:
		f.store_string(JSON.stringify(s))
		f.close()


func _load_session() -> Dictionary:
	if not FileAccess.file_exists(session_file):
		return {}
	var f := FileAccess.open(session_file, FileAccess.READ)
	if f == null:
		return {}
	var d = JSON.parse_string(f.get_as_text())
	return d if typeof(d) == TYPE_DICTIONARY and d.has("match") else {}
