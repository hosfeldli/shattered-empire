class_name NativeCommandTools
extends Node3D
## Native construction/deployment tools. Previews and costs come from existing server commands.
## A preview token prevents an older reply from replacing a newer gesture or cancelled tool.

signal feedback(text: String, ok: bool)
signal changed
var commands:CommandRegistry
var preferences:NativePreferences
var settlements:SettlementRenderer
var infrastructure:InfrastructureRenderer
var terrain:WorldRenderer
var placement:WorldPlacementPreview
var site_details:={}
var hover_serial:=0
var target_confirm:=true
var keep_placing:=false
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
var status := "Select a tool, then draw on the map. Enter confirms; Esc cancels."
var formation := "line"
var input_enabled:=true
var road_auto:=true
var deployment:={"density":"auto","depth":"auto","behavior":"defend","reverse":false}
var target_payload:={}
var target_kind:="point"
var target_title:=""
var target_preview:=false
var target_enemy:={}
var right_dragging:=false

func target_command(command:Dictionary,title:String,kind:="point",server_preview:=false,require_confirmation:=true) -> void:
	cancel()
	if world.spectator: feedback.emit("Spectators cannot issue orders",false); return
	mode="target"; target_payload=command.duplicate(true); target_title=title; target_kind=kind; target_preview=server_preview; target_confirm=require_confirmation
	status=title.capitalize()+": choose a target on the map, then Enter confirms. Right click cancels."; changed.emit()


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
	status = "Click to place" if kind == "build" else "Draw a line, then press Enter to confirm"
	if mode == "build":
		var token := revision
		_submit({"c": "placement", "type": value}, func(reply: Dictionary):
			if revision != token: return
			valid_tiles.clear()
			for tile in reply.get("tiles", []): valid_tiles[int(tile)] = true
			status = "%d legal sites · %s" % [valid_tiles.size(), "affordable" if reply.get("afford", false) else "will join the construction queue"]
			changed.emit())
	if kind=="build" and settlements!=null:
		if placement==null:
			placement=WorldPlacementPreview.new(); add_child(placement); placement.setup(world,cam,settlements)
		_preview_build(cam.pick_tile(get_viewport().get_mouse_position()))
	changed.emit()


func cancel() -> void:
	right_dragging=false
	revision += 1; hover_serial+=1; site_details.clear()
	if terrain: terrain.terrain_mat.set_shader_parameter("farm_preview_active",0.0)
	if placement: placement.mesh=null; placement.tile=-1
	mode = "select"; points.clear(); preview.clear(); valid_tiles.clear(); drawing = false
	target_payload.clear(); target_enemy.clear()
	last_hover = -1
	if mesh: mesh.mesh = null
	status = "Select a tool, then draw on the map. Enter confirms; Esc cancels."
	changed.emit()


func _unhandled_input(event: InputEvent) -> void:
	if not input_enabled or mode == "select" or world.grid == null: return
	# InputController owns the right-drag gesture through release. Consuming its release here
	# leaves the placement tool stuck and prevents the deployment order from being submitted.
	if right_dragging and (event is InputEventMouseMotion or event is InputEventMouseButton and event.button_index==MOUSE_BUTTON_RIGHT): return
	if event is InputEventKey and event.pressed and not event.echo and event.keycode==KEY_BACKSPACE:
		if not points.is_empty(): points.pop_back(); preview.clear(); request_preview()
		get_viewport().set_input_as_handled(); return
	if event is InputEventKey and event.pressed and not event.echo and event.keycode==KEY_TAB and mode=="deploy":
		deployment.reverse=not deployment.reverse; request_preview(); get_viewport().set_input_as_handled(); return
	if event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_ENTER:
		commit()
		get_viewport().set_input_as_handled()
	elif event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_RIGHT and event.pressed:
			if mode=="road" and not points.is_empty(): points.pop_back(); preview.clear(); request_preview()
			else: cancel()
		elif event.button_index == MOUSE_BUTTON_LEFT:
			var tile := cam.pick_tile(event.position)
			if event.pressed:
				revision += 1; preview.clear()
				if not event.shift_pressed: points.clear()
				keep_placing=event.shift_pressed
				drawing = true; _add_point(tile)
				if mode=="target" and target_kind=="enemy":
					target_enemy.clear()
					for id in military.units_near_screen(event.position,18,false):
						if int(world.units[id].owner)!=world.civ_id: target_enemy={"kind":"unit","id":id}; break
					if target_enemy.is_empty():
						for building in world.buildings.values():
							if int(building.t)==tile and int(building.o)!=world.civ_id: target_enemy={"kind":"building","id":int(building.id)}; break
			elif drawing:
				_add_point(tile); drawing = false
				if mode=="build":
					var sites:=points.filter(func(t):return valid_tiles.has(t))
					if sites.size()>1:
						var repeat_:bool=event.shift_pressed
						_submit({"c":"buildMany","type":value,"tiles":sites},func(reply):
							feedback.emit("Construction sites queued" if reply.get("error")==null else str(reply.error),reply.get("error")==null)
							if reply.get("error")==null and not repeat_: cancel())
					elif sites.size()==1: _place(sites[0],event.shift_pressed)
					else: feedback.emit("Choose a valid building site",false)
				else:
					request_preview()
					if mode=="target" and not target_confirm and not target_preview: commit()
		get_viewport().set_input_as_handled()
	elif event is InputEventMouseMotion:
		var tile := cam.pick_tile(event.position)
		if drawing: _add_point(tile)
		elif mode == "build" and tile != last_hover:
			last_hover = tile
			_preview_build(tile)
		get_viewport().set_input_as_handled()


func _add_point(tile: int) -> void:
	if tile >= 0 and points.size() < 200 and (points.is_empty() or points[-1] != tile):
		points.append(tile)
		_draw(points, true)


func _command(commit_: bool) -> Dictionary:
	match mode:
		"target":
			var command:Dictionary=NativeWorkspace.bind_command(target_payload,{"map":points[-1],"tiles":points.duplicate(),"line":[points[0],points[-1]],"target":target_enemy.duplicate()})
			if target_preview: command.commit=commit_
			return command
		"road": return {"c": "roadPlan", "tiles": points.duplicate(), "type": int(value), "auto": road_auto, "commit": commit_}
		"bridge": return {"c": "bridgePlan", "from": points[0], "to": points[-1], "cls": value, "commit": commit_}
		"trench": return {"c": "trenchPlan", "points": points.duplicate(), "type": value, "commit": commit_}
		"deploy":
			var command:={"c":"deploy","units":military.selected.keys(),"line":[points[0],points[-1]],"mode":formation}
			command.merge(deployment,true); return command
	return {}


func request_preview() -> void:
	if points.is_empty(): return
	if mode=="target" and not target_preview:
		if target_kind=="enemy" and target_enemy.is_empty(): status="Choose a visible enemy unit or building"; preview.clear(); changed.emit(); return
		preview={"target":points[-1]}; status=target_title.capitalize()+" · Enter confirms · Esc cancels"; changed.emit(); return
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
	status = "Preparing preview…"; changed.emit()
	_submit(command, func(reply: Dictionary):
		if token != revision: return
		preview = reply
		if mode=="target":
			var outcome:Dictionary=reply.get("missile",reply.get("rebuild",{}))
			if outcome.get("inRange",true)==false or outcome.get("ok",true)==false: preview.error=outcome.get("why","Target unavailable or out of range")
			status=str(preview.error) if preview.get("error")!=null else "%s · %s · Enter confirms"%[target_title.capitalize(),"Flight %s seconds · interception %d%%"%[str(outcome.get("eta",0)),int(float(outcome.get("odds",0))*100)] if reply.has("missile") else "Preview ready"]
			_draw(points,preview.get("error")==null); changed.emit(); return
		var error: Variant = reply.get("error")
		var plan: Dictionary = reply.get("plan", reply.get("trench", reply.get("deploy", {})))
		if error!=null: status=str(error)
		else:
			var costs:=[]
			for good in plan.get("cost",{}): costs.append("%s %s"%[str(plan.cost[good]),str(good)])
			status="%s · %s · %s · Enter confirms · Esc cancels"%[mode.capitalize(),", ".join(costs) if not costs.is_empty() else "No resource cost","%s seconds"%str(plan.get("seconds",plan.get("time","—")))]
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
	_submit(command, func(reply: Dictionary):
		var ok: bool = reply.get("error") == null
		if not ok: feedback.emit(str(reply.error),false)
		if revision == token + 1: cancel())


func _place(tile: int,repeat_:=false) -> void:
	if not valid_tiles.has(tile):
		feedback.emit("Choose a valid building site", false); return
	var building_type := str(value)
	valid_tiles.erase(tile)
	_submit({"c": "build", "tile": tile, "type": building_type, "plan": true}, func(reply: Dictionary):
		var ok: bool = reply.get("error") == null
		feedback.emit("Construction queued" if ok else str(reply.error), ok)
		if mode == "build" and value == building_type:
			if ok and not repeat_: cancel()
			else: activate("build", building_type))


func _preview_build(tile:int) -> void:
	if tile<0: return
	last_hover=tile; hover_serial+=1
	var token:=hover_serial; var type:=str(value)
	placement.show_building(type,tile)
	_draw([tile],valid_tiles.has(tile))
	status="Checking site…"
	_submit({"c":"placement","type":type,"tile":tile},func(reply):
		if mode!="build" or token!=hover_serial or type!=value: return
		site_details=reply.get("site",{})
		if site_details.is_empty(): status="This server needs the placement preview update"; changed.emit(); return
		var valid:bool=site_details.get("valid",false)
		if terrain:
			terrain.terrain_mat.set_shader_parameter("farm_preview_active",1.0 if type=="farm" and valid else 0.0)
			terrain.terrain_mat.set_shader_parameter("farm_preview_cell",Vector2i(tile%world.grid.w,tile/world.grid.w))
			var links:=0
			for direction in 6:
				var neighbor:=world.grid.nb[tile*6+direction]
				if terrain.surface_fields.farms.has(neighbor) and int(terrain.surface_fields.farms[neighbor][0])==world.civ_id: links|=1<<direction
			terrain.terrain_mat.set_shader_parameter("farm_preview_links",links)
		if valid: valid_tiles[tile]=true
		else: valid_tiles.erase(tile)
		var costs:=[]; var missing:=[]
		for good in site_details.get("cost",{}): costs.append("%s %s"%[str(site_details.cost[good]),good])
		for good in site_details.get("missing",{}): missing.append("%s %s"%[str(snappedf(float(site_details.missing[good]),.1)),good])
		status=str(site_details.get("reason","Choose a legal site")) if not valid else " · ".join(costs)+" · ~%s sec"%str(site_details.get("seconds","—"))
		if valid and not missing.is_empty(): status+=" · Missing "+", ".join(missing)+"; click to queue"
		_draw([tile],valid)
		changed.emit())


func _draw(tiles: Array, ok: bool) -> void:
	var kit := MeshKit.new()
	var color := "glow:e4bd76" if mode=="build" and bool(site_details.get("queued",false)) and ok else "glow:75d59b" if ok else "glow:ed766a"
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
	if mode in ["road","bridge"] and tiles.size()>1 and infrastructure:
		for index in range(tiles.size()-1):
			var first:=int(tiles[index]); var second:=int(tiles[index+1]); var a:=world.grid.center(first); var b:=world.grid.center(second)
			a.x=world.grid.near_x(a.x,cam.focus.x); b.x=a.x+world.grid.dx_wrap(a.x,b.x)
			var midpoint:Vector2=(a+b)*.5; kit.set_frame(Vector3.ZERO,0)
			for side in [[first,a,midpoint],[second,b,midpoint]]:
				var wet:bool=world.is_river(side[0]) or world.is_sea(side[0]) or world.is_lake(side[0])
				var road_type:=int(value) if mode=="road" else 2
				if wet: infrastructure._bridge(kit,side[0],side[1],side[2],road_type,false)
				else: infrastructure._road(kit,side[1],side[2],road_type,false)
	elif mode=="trench" and tiles.size()>1:
		for index in range(tiles.size()-1):
			var a:=world.grid.center(int(tiles[index])); var b:=world.grid.center(int(tiles[index+1])); a.x=world.grid.near_x(a.x,cam.focus.x); b.x=a.x+world.grid.dx_wrap(a.x,b.x)
			var start:=Vector3(a.x,world.tile_height(int(tiles[index]))+.045,a.y); var finish:=Vector3(b.x,world.tile_height(int(tiles[index+1]))+.045,b.y)
			kit.strip("soil",start,finish,.14,Color(.5,.4,.3)); var side:Vector3=(finish-start).normalized().cross(Vector3.UP)*.13
			kit.strip("soil",start+side,finish+side,.09,Color(.85,.75,.6))
	mesh.mesh = kit.commit() if not kit.is_empty() else null


func train(building: int, unit_type: String) -> void:
	_submit({"c": "train", "building": building, "unit": unit_type}, func(reply: Dictionary):
		feedback.emit("Training queued" if reply.get("error") == null else str(reply.error), reply.get("error") == null))

func _submit(command:Dictionary,callback:=Callable()) -> void:
	if commands: commands.submit(command,callback)
	else: net.cmd(command,callback)
