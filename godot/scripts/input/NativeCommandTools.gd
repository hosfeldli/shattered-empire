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
var legal_mesh: MeshInstance3D
var legal_view:=Vector3.INF
var hover_inflight:=false
var hover_queued:=-1
var hover_sent:=0
var growth_city:=-1
var legal_ready:=true      # false while the legal-site list for the active building is in flight
var blocked_tiles:={}
var blocked_edges:={}
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
var pending_sites:={}     # tile -> [type, msec]: accepted by the server, waiting for its building
var refused_sites:={}     # tile -> [reason, msec]: refused sites of a group placement
var footprint_mesh:MeshInstance3D
var cursor_tip:PanelContainer
var cursor_label:Label

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
	legal_mesh=MeshInstance3D.new()
	legal_mesh.cast_shadow=GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(legal_mesh)
	footprint_mesh=MeshInstance3D.new()
	footprint_mesh.cast_shadow=GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(footprint_mesh)
	var layer:=CanvasLayer.new(); layer.layer=5; add_child(layer)
	cursor_tip=PanelContainer.new(); cursor_tip.mouse_filter=Control.MOUSE_FILTER_IGNORE
	cursor_tip.add_theme_stylebox_override("panel",NativeUI.style(Color(NativeUI.PANEL,.92),Color(1,1,1,.14),8,6,true))
	cursor_label=Label.new(); cursor_label.add_theme_font_size_override("font_size",12); cursor_label.add_theme_color_override("font_color",NativeUI.TEXT)
	cursor_tip.add_child(cursor_label); layer.add_child(cursor_tip); cursor_tip.hide()
	cam.cancel_pressed.connect(cancel)
	world.welcomed.connect(cancel)
	world.reset.connect(cancel)
	world.welcomed.connect(func(): pending_sites.clear(); refused_sites.clear())
	world.econ_applied.connect(_reconcile_pending)


func activate(kind: String, option: Variant = "") -> void:
	cancel()
	if world.spectator:
		feedback.emit("Spectators cannot issue orders", false)
		return
	mode = kind; value = option
	status = "Click to place" if kind == "build" else "Draw a line, then press Enter to confirm"
	if mode == "build":
		var token := revision
		legal_ready=false
		_submit({"c": "placement", "type": value}, func(reply: Dictionary):
			if revision != token: return
			legal_ready=true
			valid_tiles.clear()
			for tile in reply.get("tiles", []): valid_tiles[int(tile)] = true
			_refresh_legal_sites()
			status = "%d legal sites · %s" % [valid_tiles.size(), "affordable" if reply.get("afford", false) else "will join the construction queue"]
			changed.emit())
	if kind=="build" and settlements!=null:
		if placement==null:
			placement=WorldPlacementPreview.new(); add_child(placement); placement.setup(world,cam,settlements)
		_preview_build(cam.pick_tile(get_viewport().get_mouse_position()))
	changed.emit()


func cancel() -> void:
	right_dragging=false
	revision += 1; hover_serial+=1; site_details.clear(); blocked_tiles.clear(); blocked_edges.clear(); hover_inflight=false; hover_queued=-1
	if terrain: terrain.terrain_mat.set_shader_parameter("farm_preview_active",0.0)
	if placement: placement.mesh=null; placement.tile=-1
	mode = "select"; points.clear(); preview.clear(); valid_tiles.clear(); drawing = false
	target_payload.clear(); target_enemy.clear()
	last_hover = -1
	if mesh: mesh.mesh = null
	if legal_mesh: legal_mesh.mesh=null
	if footprint_mesh: footprint_mesh.mesh=null
	if cursor_tip: cursor_tip.hide()
	legal_view=Vector3.INF
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
	elif event is InputEventMouseButton and not event.button_index in [MOUSE_BUTTON_LEFT, MOUSE_BUTTON_RIGHT]:
		return     # the wheel and middle button stay with the camera: zoom and pan while placing
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
					var sites:=points.filter(func(t):return valid_tiles.has(t) or not legal_ready)
					if sites.size()>1:
						var repeat_:bool=event.shift_pressed
						for site in sites: pending_sites[int(site)]=[str(value),Time.get_ticks_msec()]
						_submit({"c":"buildMany","type":value,"tiles":sites},func(reply):
							if reply.get("error")!=null:
								for site in sites: pending_sites.erase(int(site))
								feedback.emit(str(reply.error),false); _refresh_legal_sites(); return
							var many:Dictionary=reply.get("many",{})
							var reasons:={}
							for failed in many.get("failedTiles",[]):
								pending_sites.erase(int(failed[0])); refused_sites[int(failed[0])]=[str(failed[1]),Time.get_ticks_msec()]
								reasons[str(failed[1])]=true
							var text:="%d site%s placed"%[int(many.get("placed",sites.size())),"" if int(many.get("placed",0))==1 else "s"]
							if int(many.get("planned",0))>0: text+=" · %d wait for materials"%int(many.planned)
							if int(many.get("failed",0))>0: text+=" · %d refused: %s"%[int(many.failed),", ".join(reasons.keys())]
							feedback.emit(text,int(many.get("placed",0))>0)
							_refresh_legal_sites()
							if int(many.get("failed",0))==0 and not repeat_: cancel())
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
		elif mode == "target" and tile != last_hover and not drawing:
			last_hover = tile
			_target_hover(tile)


## Before the click: what the order would cover and what is known there (growth area, objective).
func _target_hover(tile: int) -> void:
	if tile < 0: return
	var c := str(target_payload.get("c", ""))
	if c == "cityGrowth":
		var info: Array = DecisionHelpers.growth_preview(world, int(target_payload.city), tile, str(target_payload.kind))
		_draw(world.grid.disk(tile, DecisionHelpers.GROWTH_RADIUS), bool(info[1]))
		status = target_title + " · " + str(info[0]) + (" · click to set the plan" if bool(info[1]) else "")
		changed.emit()
	elif c == "army":
		_draw([tile], true)
		status = target_title + " · " + DecisionHelpers.assess_objective(world, tile, str(target_payload.get("kind", "")))
		changed.emit()


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
			# a curved stroke deploys along the curve (thinned to at most 24 points)
			if points.size()>2:
				var path:=[]; var stride:=maxi(1,ceili(points.size()/24.0))
				for k in range(0,points.size(),stride): path.append(points[k])
				if path[-1]!=points[-1]: path.append(points[-1])
				if path.size()>24: path=path.slice(0,23)+[points[-1]]
				command.path=path
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
		blocked_tiles.clear(); blocked_edges.clear()
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
			var reasons:=[]
			for segment in plan.get("segments",[]):
				if segment.get("ok",true): continue
				if segment.has("t"): blocked_tiles[int(segment.t)]=true
				if segment.has("a") and segment.has("b"): blocked_edges["%s:%s"%[segment.a,segment.b]]=true
				var reason:=str(segment.get("reason","blocked ground"))
				if not reasons.has(reason): reasons.append(reason)
			if not reasons.is_empty(): status="Blocked: "+", ".join(reasons)+" · Red sections need a different route"
		if mode in ["road","bridge","trench"]: _tip_text(status.replace(" · ","\n"),error==null and blocked_tiles.is_empty() and blocked_edges.is_empty())
		var route:Array=plan.get("tiles",points)
		_draw(route, error == null)
		changed.emit())


func can_commit() -> bool:
	if points.is_empty() or preview.is_empty() or preview.get("error")!=null: return false
	var plan:Dictionary=preview.get("plan",preview.get("trench",{}))
	if mode=="trench": return int(plan.get("build",0))>0 and int(plan.get("invalid",0))==0
	if mode=="road": return int(plan.get("buildable",0))>0
	return true


func commit() -> void:
	if not can_commit(): return
	var command := _command(true)
	if command.is_empty(): return
	var token := revision
	# Invalidate the preview immediately so repeated Enter cannot duplicate a project.
	var previous_preview:=preview.duplicate(true)
	preview.clear(); revision += 1
	status="Submitting order…"; changed.emit()
	_submit(command, func(reply: Dictionary):
		var ok: bool = reply.get("error") == null
		if revision != token + 1: return
		if ok:
			# drawing tools stay open for the next road, bridge or trench (Esc or right-click closes)
			if mode in ["road","bridge","trench"]:
				feedback.emit("Order confirmed · draw the next one or press Esc",true)
				points.clear(); preview.clear(); blocked_tiles.clear(); blocked_edges.clear()
				if mesh: mesh.mesh=null
				status="Order confirmed · draw the next one, Esc to finish"; changed.emit()
			else:
				feedback.emit("Order confirmed",true); cancel()
		else:
			preview=previous_preview
			status="Order rejected: "+str(reply.error)+" · Adjust the route and retry"
			feedback.emit(status,false); _draw(preview.get("plan",preview.get("trench",{})).get("tiles",points),false); changed.emit())


func _place(tile: int,repeat_:=false) -> void:
	if pending_sites.has(tile): return     # already submitted; never send a duplicate order
	# under heavy load the legal-site list can arrive late: until it does, a click places at once
	# and the server validates the site (its refusal is shown like any other)
	if not valid_tiles.has(tile) and legal_ready:
		feedback.emit(str(site_details.get("reason","Choose a valid building site")) if int(site_details.get("tile",-1))==tile else "Choose a valid building site", false); return
	var building_type := str(value)
	valid_tiles.erase(tile)
	pending_sites[tile]=[building_type,Time.get_ticks_msec()]
	_refresh_legal_sites()
	_submit({"c": "build", "tile": tile, "type": building_type, "plan": true}, func(reply: Dictionary):
		var ok: bool = reply.get("error") == null
		if not ok:
			pending_sites.erase(tile); refused_sites[tile]=[str(reply.error),Time.get_ticks_msec()]
		var built:Dictionary=reply.get("built",{})
		feedback.emit(("Site placed · waiting for materials" if bool(built.get("planned",false)) else "Construction site placed") if ok else str(reply.error), ok)
		if mode == "build" and value == building_type:
			if ok and not repeat_: cancel()
			else: activate("build", building_type))


## A submitted site stays marked until the server's building appears there (or a short timeout),
## so a click never looks like a fake success or silently vanishes.
func _reconcile_pending() -> void:
	if pending_sites.is_empty() and refused_sites.is_empty(): return
	var built:={}
	for building in world.buildings.values(): built[int(building.t)]=true
	var now:=Time.get_ticks_msec()
	for tile in pending_sites.keys():
		if built.has(int(tile)) or now-int(pending_sites[tile][1])>12000: pending_sites.erase(tile)
	for tile in refused_sites.keys():
		if now-int(refused_sites[tile][1])>6000: refused_sites.erase(tile)
	if mode=="build": _refresh_legal_sites()


func _preview_build(tile:int) -> void:
	if tile<0: return
	last_hover=tile; hover_serial+=1
	var token:=hover_serial; var type:=str(value)
	placement.show_building(type,tile)
	_draw([tile],valid_tiles.has(tile))
	status="Checking site…"
	# one site query in flight at a time; the latest hovered hex is checked when it returns
	if hover_inflight and Time.get_ticks_msec()-hover_sent<1500: hover_queued=tile; return
	hover_inflight=true; hover_queued=-1; hover_sent=Time.get_ticks_msec()
	_submit({"c":"placement","type":type,"tile":tile},func(reply):
		hover_inflight=false
		if hover_queued>=0 and mode=="build":
			var next:=hover_queued; hover_queued=-1
			if next!=tile: _preview_build(next); return
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
		_draw_footprint(valid,bool(site_details.get("queued",false)))
		_show_tip(type,valid,costs,missing)
		changed.emit())


func _draw(tiles: Array, ok: bool) -> void:
	var kit := MeshKit.new()
	var color := "glow:e4bd76" if mode=="build" and bool(site_details.get("queued",false)) and ok else "glow:75d59b" if ok else "glow:ed766a"
	for tile in tiles:
		if int(tile) < 0 or int(tile) >= world.grid.n: continue
		var p := world.grid.center(int(tile))
		var x := world.grid.near_x(p.x, cam.focus.x)
		kit.set_frame(Vector3(x, world.tile_height(int(tile)) + .035, p.y), 0)
		var tile_color:String="glow:ed766a" if blocked_tiles.has(int(tile)) else color
		for k in 6:
			var a: Vector2 = world.grid.corners[k] * .86
			var b: Vector2 = world.grid.corners[(k+1)%6] * .86
			var start:=kit.xf(Vector3(a.x,0,a.y)); var end:=kit.xf(Vector3(b.x,0,b.y))
			start.y=world.ground_height(start.x,start.z)+.035; end.y=world.ground_height(end.x,end.z)+.035
			kit.strip(tile_color,start,end,.025)
	if mode in ["road","bridge"] and tiles.size()>1 and infrastructure:
		for index in range(tiles.size()-1):
			var first:=int(tiles[index]); var second:=int(tiles[index+1]); var a:=world.grid.center(first); var b:=world.grid.center(second)
			a.x=world.grid.near_x(a.x,cam.focus.x); b.x=a.x+world.grid.dx_wrap(a.x,b.x)
			var midpoint:Vector2=(a+b)*.5; kit.set_frame(Vector3.ZERO,0)
			if blocked_edges.has("%s:%s"%[first,second]):
				kit.strip("glow:ed766a",Vector3(a.x,world.tile_height(first)+.08,a.y),Vector3(b.x,world.tile_height(second)+.08,b.y),.08)
				continue
			# The exact class construction the finished road or bridge will have (timber, reinforced
			# or rail deck), previewed before confirmation.
			var road_type:int=int(value) if mode=="road" else int({"timber":1,"road":2,"rail":4}.get(str(value),2))
			infrastructure.preview_half(kit,first,second,road_type)
			infrastructure.preview_half(kit,second,first,road_type)
	elif mode=="trench" and tiles.size()>1:
		for index in range(tiles.size()-1):
			var a:=world.grid.center(int(tiles[index])); var b:=world.grid.center(int(tiles[index+1])); a.x=world.grid.near_x(a.x,cam.focus.x); b.x=a.x+world.grid.dx_wrap(a.x,b.x)
			var start:=Vector3(a.x,world.tile_height(int(tiles[index]))+.045,a.y); var finish:=Vector3(b.x,world.tile_height(int(tiles[index+1]))+.045,b.y)
			kit.strip("soil",start,finish,.14,Color(.5,.4,.3)); var side:Vector3=(finish-start).normalized().cross(Vector3.UP)*.13
			kit.strip("soil",start+side,finish+side,.09,Color(.85,.75,.6))
	mesh.mesh = kit.commit() if not kit.is_empty() else null


func _process(_dt:float) -> void:
	if cursor_tip and cursor_tip.visible:
		if mode=="select" or mode=="deploy" or mode=="target": cursor_tip.hide()
		else:
			var mouse:=get_viewport().get_mouse_position(); var bounds:=get_viewport().get_visible_rect().size
			cursor_tip.position=Vector2(minf(mouse.x+18,bounds.x-cursor_tip.size.x-8),minf(mouse.y+18,bounds.y-cursor_tip.size.y-8))
	if mode!="build" or world.grid==null or valid_tiles.is_empty(): return
	var view:=Vector3(cam.focus.x,cam.focus.z,cam.size)
	if legal_view==Vector3.INF or Vector2(view.x-legal_view.x,view.y-legal_view.y).length()>3.0 or absf(view.z-legal_view.z)>3.0:
		_refresh_legal_sites()


func _refresh_legal_sites() -> void:
	if not legal_mesh or not world.grid: return
	legal_view=Vector3(cam.focus.x,cam.focus.z,cam.size)
	var kit:=MeshKit.new(); var count:=0
	var radius:=cam.view_half_width()+3.0
	for raw in valid_tiles:
		var tile:=int(raw)
		if tile<0 or tile>=world.grid.n or world.known[tile]==0: continue
		var p:=world.grid.center(tile)
		p.x=world.grid.near_x(p.x,cam.focus.x)
		if absf(p.x-cam.focus.x)>radius or absf(p.y-cam.focus.z)>cam.size+3.0: continue
		# The authoritative buildable area as one continuous outline: only edges toward hexes that
		# are not legal sites are drawn, so overlapping cities, rivers and occupied hexes show as
		# real gaps in the area instead of a guessed circle. A faint inner mark keeps each site legible.
		for k in 6:
			var neighbor:=world.grid.nb[tile*6+posmod(1-k,6)]
			var a:Vector2=p+world.grid.corners[k]*.97; var b:Vector2=p+world.grid.corners[(k+1)%6]*.97
			if neighbor<0 or not valid_tiles.has(neighbor):
				kit.strip("glow:75d59b",Vector3(a.x,world.ground_height(a.x,a.y)+.025,a.y),Vector3(b.x,world.ground_height(b.x,b.y)+.025,b.y),.03)
		kit.cylinder("glow:75d59b",Vector3(p.x,world.ground_height(p.x,p.y)+.02,p.y),.05,.002,6,Color(1,1,1,.6))
		count+=1
		if count>=600: break
	for group in [[pending_sites,"glow:e4bd76",.035],[refused_sites,"glow:ed766a",.03]]:
		for raw in group[0]:
			var tile:=int(raw)
			if tile<0 or tile>=world.grid.n: continue
			var p:=world.grid.center(tile); p.x=world.grid.near_x(p.x,cam.focus.x)
			for k in 6:
				var a:Vector2=p+world.grid.corners[k]*.8; var b:Vector2=p+world.grid.corners[(k+1)%6]*.8
				kit.strip(str(group[1]),Vector3(a.x,world.ground_height(a.x,a.y)+.03,a.y),Vector3(b.x,world.ground_height(b.x,b.y)+.03,b.y),float(group[2]))
	legal_mesh.mesh=kit.commit() if not kit.is_empty() else null


## The planned footprint of the preview (the same parcel the finished building will use), as a
## ground-following outline: green legal, amber legal but waiting for materials, red refused.
func _draw_footprint(valid:bool,queued:bool) -> void:
	footprint_mesh.mesh=null
	if placement==null or placement.site.is_empty(): return
	var corners:Array=placement.site.get("corners",[])
	if corners.is_empty() and placement.site.has("transform"):
		var frame:Transform3D=placement.site.transform; var half:Vector2=placement.site.get("half_size",Vector2(.4,.4))
		for q in [Vector2(-1,-1),Vector2(1,-1),Vector2(1,1),Vector2(-1,1)]:
			var p:=frame*Vector3(half.x*q.x,0,half.y*q.y); corners.append(Vector2(p.x,p.z))
	if corners.size()<3: return
	var color:="glow:75d59b" if valid and not queued else "glow:e4bd76" if valid else "glow:ed766a"
	var kit:=MeshKit.new()
	var anchor:float=world.grid.near_x((corners[0] as Vector2).x,cam.focus.x)-(corners[0] as Vector2).x
	for k in corners.size():
		var a:Vector2=corners[k]; var b:Vector2=corners[(k+1)%corners.size()]
		for part in 4:
			var p:=a.lerp(b,part/4.0); var q:=a.lerp(b,(part+1)/4.0)
			kit.strip(color,Vector3(p.x+anchor,world.ground_height(p.x,p.y)+.03,p.y),Vector3(q.x+anchor,world.ground_height(q.x,q.y)+.03,q.y),.018)
	footprint_mesh.mesh=kit.commit()


## a compact tooltip at the cursor: what, cost and time, or exactly why the site is refused
func _show_tip(type:String,valid:bool,costs:Array,missing:Array) -> void:
	var definition:Dictionary=world.defs.get("BUILDINGS",{}).get(type,{})
	var lines:=[str(definition.get("name",type.capitalize()))]
	var city:=_city_for(last_hover)
	if not city.is_empty(): lines[0]+=" · "+str(city.get("n","city"))
	if valid:
		lines.append(" · ".join(costs) if not costs.is_empty() else "No cost")
		lines.append("~%s s to build"%str(site_details.get("seconds","—")))
		if not missing.is_empty(): lines.append("Waits for "+", ".join(missing))
		lines.append("Click to place · Shift keeps placing")
	else:
		lines.append(str(site_details.get("reason","Not a legal site")))
	cursor_label.text="\n".join(lines)
	cursor_label.add_theme_color_override("font_color",NativeUI.TEXT if valid else NativeUI.BAD.lightened(.25))
	cursor_tip.show()
	cursor_tip.reset_size()


## the own city a site would belong to (nearest own city centre), for the placement tooltip
func _city_for(tile:int) -> Dictionary:
	if tile<0: return {}
	var best:={}; var best_d:=1<<30
	for city in world.cities.values():
		if int(city.get("o",-1))!=world.civ_id: continue
		var d:=world.grid.dist(tile,int(city.t))
		if d<best_d: best_d=d; best=city
	return best


func _tip_text(text:String,ok:bool) -> void:
	cursor_label.text=text
	cursor_label.add_theme_color_override("font_color",NativeUI.TEXT if ok else NativeUI.BAD.lightened(.25))
	cursor_tip.show(); cursor_tip.reset_size()


func train(building: int, unit_type: String) -> void:
	_submit({"c": "train", "building": building, "unit": unit_type}, func(reply: Dictionary):
		feedback.emit("Training queued" if reply.get("error") == null else str(reply.error), reply.get("error") == null))

func _submit(command:Dictionary,callback:=Callable()) -> void:
	if commands: commands.submit(command,callback)
	else: net.cmd(command,callback)
