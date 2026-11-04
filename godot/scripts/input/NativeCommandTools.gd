class_name NativeCommandTools
extends Node3D
## Native construction/deployment tools. Previews and costs come from existing server commands.
## A preview token prevents an older reply from replacing a newer gesture or cancelled tool.

signal feedback(text: String, ok: bool)
signal changed
var world: WorldState
var net: NetworkClient
var cam: CameraController
var military: MilitaryRenderer
var mode := "select"
var value: Variant = ""
var points: Array = []
var preview := {}
var valid_tiles := {}
var drawing := false
var revision := 0
var mesh: MeshInstance3D
var last_hover := -1
var status := "Select a tool, then draw on the map. Enter confirms a server preview; Esc cancels."
var formation := "line"


func setup(w: WorldState, n: NetworkClient, c: CameraController, m: MilitaryRenderer) -> void:
	world = w; net = n; cam = c; military = m
	mesh = MeshInstance3D.new()
	mesh.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(mesh)
	cam.cancel_pressed.connect(cancel)
	world.welcomed.connect(cancel)
	world.reset.connect(cancel)


func activate(kind: String, option: Variant = "") -> void:
	cancel()
	if world.spectator:
		feedback.emit("Spectators cannot issue orders", false)
		return
	mode = kind; value = option
	status = "Click to place" if kind == "build" else "Draw a line, then press Enter to confirm the server preview"
	if mode == "build":
		var token := revision
		net.cmd({"c": "placement", "type": value}, func(reply: Dictionary):
			if revision != token: return
			valid_tiles.clear()
			for tile in reply.get("tiles", []): valid_tiles[int(tile)] = true
			status = "%d legal sites · %s" % [valid_tiles.size(), "affordable" if reply.get("afford", false) else "will join the construction queue"]
			changed.emit())
	changed.emit()


func cancel() -> void:
	revision += 1
	mode = "select"; points.clear(); preview.clear(); valid_tiles.clear(); drawing = false
	last_hover = -1
	if mesh: mesh.mesh = null
	status = "Select a tool, then draw on the map. Enter confirms a server preview; Esc cancels."
	changed.emit()


func _unhandled_input(event: InputEvent) -> void:
	if mode == "select" or world.grid == null: return
	if event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_ENTER:
		commit()
		get_viewport().set_input_as_handled()
	elif event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_RIGHT and event.pressed:
			cancel()
		elif event.button_index == MOUSE_BUTTON_LEFT:
			var tile := cam.pick_tile(event.position)
			if event.pressed:
				if mode == "build":
					_place(tile)
				else:
					revision += 1; preview.clear(); points.clear(); drawing = true
					_add_point(tile)
			elif drawing:
				_add_point(tile); drawing = false; request_preview()
		get_viewport().set_input_as_handled()
	elif event is InputEventMouseMotion:
		var tile := cam.pick_tile(event.position)
		if drawing: _add_point(tile)
		elif mode == "build" and tile != last_hover:
			last_hover = tile
			_draw([tile], valid_tiles.has(tile))
		get_viewport().set_input_as_handled()


func _add_point(tile: int) -> void:
	if tile >= 0 and points.size() < 200 and (points.is_empty() or points[-1] != tile):
		points.append(tile)
		_draw(points, true)


func _command(commit_: bool) -> Dictionary:
	match mode:
		"road": return {"c": "roadPlan", "tiles": points.duplicate(), "type": int(value), "auto": true, "commit": commit_}
		"bridge": return {"c": "bridgePlan", "from": points[0], "to": points[-1], "cls": value, "commit": commit_}
		"trench": return {"c": "trenchPlan", "points": points.duplicate(), "type": value, "commit": commit_}
		"deploy": return {"c": "deploy", "units": military.selected.keys(), "line": [points[0], points[-1]], "mode": formation, "behavior": "defend"}
	return {}


func request_preview() -> void:
	if points.is_empty(): return
	if mode == "deploy":
		# The browser uses a shared JS deployment planner. Godot shows the requested frontage;
		# exact slots are assigned only by the authoritative deploy command.
		preview = {"frontage": points.duplicate()}
		status = "%d units · %s formation · Enter requests deployment along this frontage" % [military.selected.size(), formation]
		changed.emit()
		return
	var token := revision
	var command := _command(false)
	if command.is_empty(): return
	status = "Waiting for the server preview…"; changed.emit()
	net.cmd(command, func(reply: Dictionary):
		if token != revision: return
		preview = reply
		var error: Variant = reply.get("error")
		var plan: Dictionary = reply.get("plan", reply.get("trench", reply.get("deploy", {})))
		status = str(error) if error != null else JSON.stringify(plan, "  ")
		var route:Array=plan.get("tiles",points)
		_draw(route, error == null and plan.get("buildable", true) != false)
		changed.emit())


func commit() -> void:
	if points.is_empty() or preview.is_empty() or preview.get("error") != null: return
	var command := _command(true)
	if command.is_empty(): return
	var token := revision
	# Invalidate the preview immediately so repeated Enter cannot duplicate a project.
	preview.clear(); revision += 1
	net.cmd(command, func(reply: Dictionary):
		var ok: bool = reply.get("error") == null
		feedback.emit("Order accepted" if ok else str(reply.error), ok)
		if revision == token + 1: cancel())


func _place(tile: int) -> void:
	if not valid_tiles.has(tile):
		feedback.emit("Choose a server-approved site", false); return
	var building_type := str(value)
	valid_tiles.erase(tile)
	net.cmd({"c": "build", "tile": tile, "type": building_type, "plan": true}, func(reply: Dictionary):
		var ok: bool = reply.get("error") == null
		feedback.emit("Construction queued" if ok else str(reply.error), ok)
		if mode == "build" and value == building_type: activate("build", building_type))


func _draw(tiles: Array, ok: bool) -> void:
	var kit := MeshKit.new()
	var color := "glow:75d59b" if ok else "glow:ed766a"
	for tile in tiles:
		if int(tile) < 0 or int(tile) >= world.grid.n: continue
		var p := world.grid.center(int(tile))
		var x := world.grid.near_x(p.x, cam.focus.x)
		kit.set_frame(Vector3(x, world.tile_height(int(tile)) + .035, p.y), 0)
		for k in 6:
			var a: Vector2 = world.grid.corners[k] * .86
			var b: Vector2 = world.grid.corners[(k+1)%6] * .86
			var start:=kit.xf(Vector3(a.x,0,a.y)); var end:=kit.xf(Vector3(b.x,0,b.y))
			start.y=world.ground_height(start.x,start.z)+.035; end.y=world.ground_height(end.x,end.z)+.035
			kit.strip(color,start,end,.025)
	mesh.mesh = kit.commit() if not kit.is_empty() else null


func train(building: int, unit_type: String) -> void:
	net.cmd({"c": "train", "building": building, "unit": unit_type}, func(reply: Dictionary):
		feedback.emit("Training queued" if reply.get("error") == null else str(reply.error), reply.get("error") == null))
