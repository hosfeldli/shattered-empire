class_name InputController
extends Node
var commands:CommandRegistry
var preferences:NativePreferences
## Selection and orders. Left click selects your unit under the cursor (or the building on the
## picked hex), left-drag box-selects, Shift adds. Right click orders the selected units to the hex
## under the cursor (picked against the terrain, so hills and valleys resolve to the right hex);
## Ctrl + right click is an attack-move. H holds, T toggles defensive / aggressive stance, Escape
## cancels. Every order is an intent the server may refuse; nothing moves until it says so.

signal selection_changed
signal order_feedback(text: String, ok: bool)

var world: WorldState
var net: NetworkClient
var cam: CameraController
var military: MilitaryRenderer
var settlements: SettlementRenderer
var hud_rect_cb: Callable        # returns true when the screen point is over the HUD
var press_pos := Vector2(-1, -1)
var box_active := false
var box_rect := Rect2()
var marker: MeshInstance3D
var marker_t := 0.0
var marker_base := Vector3.ZERO
var last_order_ms := 0.0
var orders_sent := 0
var tools: NativeCommandTools
var move_formation := "line"
var input_enabled:=true
var selected_buildings:={}
var selected_army:=-1
var groups:={}
var last_group:=-1
var last_group_ms:=0
var right_press:=Vector2(-1,-1)
var right_tile:=-1
var right_drag:=false
var labels:NativeWorldLabels


func setup(w: WorldState, n: NetworkClient, c: CameraController, m: MilitaryRenderer, s: SettlementRenderer) -> void:
	world = w
	net = n
	cam = c
	military = m
	settlements = s
	cam.cancel_pressed.connect(cancel)
	var t := TorusMesh.new()
	t.inner_radius = 0.22
	t.outer_radius = 0.3
	t.rings = 16
	t.ring_segments = 4
	t.material = MaterialLibrary.glow(Color(0.6, 0.95, 0.6))
	marker = MeshInstance3D.new()
	marker.mesh = t
	marker.visible = false
	marker.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF


func attach_marker(parent: Node3D) -> void:
	parent.add_child(marker)


func cancel() -> void:
	selected_army=-1
	box_active = false
	press_pos = Vector2(-1, -1)
	right_press=Vector2(-1,-1); right_drag=false; selected_buildings.clear()
	if not military.selected.is_empty() or settlements.selected_building >= 0:
		military.selected.clear()
		settlements.selected_building = -1
		selection_changed.emit()


func _unhandled_input(e: InputEvent) -> void:
	if not input_enabled or world.grid == null:
		return
	if e is InputEventMouseButton and e.button_index==MOUSE_BUTTON_RIGHT and not e.pressed and right_press.x>=0:
		if right_drag and tools:
			tools.right_dragging=false; tools.points=[right_tile,cam.pick_tile(e.position)]; tools.drawing=false; tools.request_preview(); tools.commit()
		else: _order(e.position,e.ctrl_pressed or e.meta_pressed,e.shift_pressed)
		right_press=Vector2(-1,-1); right_drag=false; get_viewport().set_input_as_handled(); return
	if e is InputEventMouseMotion and right_press.x>=0 and e.position.distance_to(right_press)>8 and not military.selected.is_empty():
		if not right_drag:
			right_drag=true; tools.activate("deploy"); tools.right_dragging=true; tools.drawing=true; tools.points=[right_tile]
		tools._add_point(cam.pick_tile(e.position)); get_viewport().set_input_as_handled(); return
	if e is InputEventKey and e.pressed and not e.echo and _group_key(e): get_viewport().set_input_as_handled(); return
	if e is InputEventKey and e.pressed and not e.echo and (preferences.canonical_key(e.keycode) if preferences else e.keycode)==KEY_P:
		if world.spectator: commands.submit({"c":"speed","speed":0 if float(world.observer.get("speed",1))>0 else 1})
		else: commands.submit({"c":"pause","on":not world.paused},func(reply):order_feedback.emit("Paused" if reply.get("paused",false) else str(reply.get("error","Resumed")),reply.get("error")==null))
		get_viewport().set_input_as_handled()
		return
	if tools and tools.mode != "select":
		return
	if e is InputEventMouseButton:
		var mb := e as InputEventMouseButton
		if mb.button_index == MOUSE_BUTTON_LEFT:
			if mb.pressed:
				if mb.double_click:
					_select_same_type(mb.position,mb.ctrl_pressed or mb.meta_pressed); press_pos=Vector2(-1,-1); get_viewport().set_input_as_handled(); return
				press_pos = mb.position
				box_active = false
			else:
				if box_active:
					_box_select(mb.shift_pressed)
				elif press_pos.x >= 0.0:
					_click_select(mb.position, mb.shift_pressed)
				box_active = false
				press_pos = Vector2(-1, -1)
			get_viewport().set_input_as_handled()
		elif mb.button_index == MOUSE_BUTTON_RIGHT and mb.pressed:
			right_press=mb.position; right_tile=cam.pick_tile(labels.order_point(mb.position) if labels else mb.position); right_drag=false
			get_viewport().set_input_as_handled()
	elif e is InputEventMouseMotion and press_pos.x >= 0.0:
		var mm := e as InputEventMouseMotion
		if mm.position.distance_to(press_pos) > 6.0:
			box_active = true
			box_rect = Rect2(press_pos, Vector2.ZERO).expand(mm.position)
	elif e is InputEventKey and (e as InputEventKey).pressed and not (e as InputEventKey).echo:
		var k:int=preferences.canonical_key(e.keycode) if preferences else e.keycode
		if k == KEY_H:
			_simple("hold", {})
		elif k == KEY_T:
			var any_def := false
			for id in military.selected.keys():
				if str(world.units.get(id, {}).get("stance", "")) == "defensive":
					any_def = true
			_simple("stance", {"stance": "aggressive" if any_def else "defensive"})
		elif k==KEY_Q: select_combat(not e.shift_pressed)
		elif k==KEY_E or (k==KEY_A and (e.ctrl_pressed or e.meta_pressed)):
			tools.target_command({"c":"move","units":_owned_units(),"tile":"@map","attackMove":true,"formation":move_formation},"Attack-move","point",false,false)
		elif k==KEY_X: _simple("withdraw",{})
		elif k==KEY_G: _simple("army",{"op":"create"})
		elif k==KEY_F:
			var colonists:=_owned_units().filter(func(id):return world.units[id].type=="colonist")
			if not colonists.is_empty(): commands.submit({"c":"found","unit":colonists[0]})
			else:
				var shapes:Array=world.defs.get("FORMATIONS",{}).keys()
				if not shapes.is_empty(): move_formation=str(shapes[(shapes.find(move_formation)+1)%shapes.size()]); order_feedback.emit("Movement formation: "+move_formation,true)
		elif k==KEY_R: tools.activate("road",1)
		elif k==KEY_SPACE: center_selection()
		elif k in [KEY_EQUAL,KEY_PLUS,KEY_MINUS]:
			cam.goal_size=clampf(cam.goal_size*(1.15 if k==KEY_MINUS else 1.0/1.15),CameraController.MIN_SIZE,cam.max_size)
		elif world.spectator: _observer_key(k)


func _click_select(pos: Vector2, add: bool) -> void:
	selected_army=-1
	if labels:
		var banner:=labels.banner_at(pos)
		if not banner.is_empty(): labels.select_banner(banner,add); return
		var resource:=labels.marker_at(pos)
		if not resource.is_empty(): labels.app.resource_strip._open_resource(resource.good); return
	var hits := military.units_near_screen(pos, 16.0, false)
	if not add:
		military.selected.clear()
		selected_buildings.clear()
		settlements.selected_building = -1
	if not hits.is_empty():
		var id = hits[0]
		if add and military.selected.has(id):
			military.selected.erase(id)
		else:
			military.selected[id] = true
	else:
		var t := cam.pick_tile(pos)
		if t >= 0:
			var bid := settlements.building_at(t)
			if bid >= 0:
				settlements.selected_building = bid
				if add and selected_buildings.has(bid): selected_buildings.erase(bid)
				else: selected_buildings[bid]=true
				military.selected.clear()
	selection_changed.emit()


func _box_select(add: bool) -> void:
	selected_army=-1
	if not add:
		military.selected.clear()
		settlements.selected_building = -1
		selected_buildings.clear()
	if Input.is_key_pressed(KEY_CTRL) or Input.is_key_pressed(KEY_META):
		for building in world.buildings.values():
			if int(building.o)!=world.civ_id: continue
			var point:=world.grid.center(int(building.t)); var screen:=cam.to_screen(Vector3(world.grid.near_x(point.x,cam.focus.x),world.tile_height(int(building.t)),point.y))
			if box_rect.abs().has_point(screen): selected_buildings[int(building.id)]=true; settlements.selected_building=int(building.id)
		selection_changed.emit(); return
	for id in military.units_in_rect(box_rect.abs()):
		military.selected[id] = true
	selection_changed.emit()


func _order(pos: Vector2, attack: bool,queue:=false) -> void:
	if world.spectator: return
	if labels: pos=labels.order_point(pos)
	if military.selected.is_empty():
		var rally:=cam.pick_tile(pos)
		var facilities:=selected_buildings.keys()
		if facilities.is_empty() and settlements.selected_building>=0: facilities=[settlements.selected_building]
		for id in facilities:
			var building:Dictionary=world.buildings.get(id,{})
			if int(building.get("o",-1))==world.civ_id and world.defs.get("BUILDINGS",{}).get(building.get("ty",""),{}).has("trains") and rally>=0:
				commands.submit({"c":"rally","building":id,"tile":rally,"army":int(building.get("ra",0))})
		return
	var t := cam.pick_tile(pos)
	if t < 0:
		return
	if selected_army>=0:
		commands.submit({"c":"army","op":"order","id":selected_army,"kind":"attackMove" if attack else "move","tile":t,"radius":4})
		return
	var ids := []
	for id in _owned_units():
		ids.append(int(id))
	if ids.is_empty(): order_feedback.emit("Select your own units to issue orders",false); return
	var c := {"c": "move", "units": ids, "tile": t, "formation": move_formation}
	if queue: c.queue=true
	if attack:
		c.attackMove = true
	var target := {}
	for hit in military.units_near_screen(pos,16.0,false):
		var unit:Dictionary=world.units[hit]
		if int(unit.owner)!=world.civ_id and str(world.civ_by_id.get(int(unit.owner),{}).get("rel",{}).get("state",""))=="war":
			target={"kind":"unit","id":int(hit)}; break
	if target.is_empty():
		var bid:=settlements.building_at(t)
		var building:Dictionary=world.buildings.get(bid,{})
		if not building.is_empty() and int(building.o)!=world.civ_id and str(world.civ_by_id.get(int(building.o),{}).get("rel",{}).get("state",""))=="war":
			target={"kind":"building","id":bid}
	if not target.is_empty(): c={"c":"attack","units":ids,"target":target,"focus":attack}
	orders_sent += 1
	last_order_ms = Time.get_ticks_msec()
	commands.submit(c, func(r: Dictionary):
		if r.has("error") and r.error != null:
			order_feedback.emit(str(r.error), false)
		else:
			var o: Dictionary = r.get("order", {})
			if int(o.get("unreachable",0))>0: order_feedback.emit("%d units cannot reach that destination"%int(o.unreachable),false))
	var c2 := world.grid.center(t)
	marker_base = Vector3(c2.x, world.tile_height(t) + 0.05, c2.y)
	marker_t = 0.0
	marker.visible = true
	(marker.mesh as TorusMesh).material = MaterialLibrary.glow(Color(1.0, 0.55, 0.45) if attack else Color(0.6, 0.95, 0.6))


func _simple(c: String, extra: Dictionary) -> void:
	if world.spectator or military.selected.is_empty():
		return
	var ids := []
	for id in military.selected.keys():
		ids.append(int(id))
	var cmd := {"c": c, "units": ids}
	cmd.merge(extra)
	commands.submit(cmd, func(r: Dictionary):
		order_feedback.emit(str(r.error) if r.has("error") and r.error != null else "%s: %d units" % [c.capitalize(), ids.size()], not (r.has("error") and r.error != null)))

func _owned_units() -> Array:
	return military.selected.keys().filter(func(id):return world.units.has(id) and int(world.units[id].owner)==world.civ_id)

func select_combat(on_screen:=true) -> void:
	military.selected.clear(); selected_buildings.clear(); settlements.selected_building=-1
	var bounds:=get_viewport().get_visible_rect()
	for unit in world.units.values():
		if int(unit.owner)!=world.civ_id or world.defs.get("UNITS",{}).get(unit.type,{}).get("civilian",false): continue
		var point:Vector3=military.draw_positions.get(unit.id,Vector3.INF)
		if not on_screen or (point!=Vector3.INF and bounds.has_point(cam.to_screen(point))): military.selected[int(unit.id)]=true
	selection_changed.emit()

func center_selection() -> void:
	for id in military.selected:
		if world.units.has(id): cam.focus_tile(int(world.units[id].tile)); return
	if settlements.selected_building>=0 and world.buildings.has(settlements.selected_building): cam.focus_tile(int(world.buildings[settlements.selected_building].t)); return
	for city in world.cities.values():
		if int(city.o)==world.civ_id and int(city.get("cap",0)): cam.focus_tile(int(city.t)); return

func _select_same_type(pos:Vector2,whole_map:bool) -> void:
	selected_army=-1
	var on_unit_badge:=labels!=null and not labels.banner_at(pos).is_empty()
	var tile:=cam.pick_tile(pos); var bid:=settlements.building_at(tile)
	# A unit parked on a building must not steal the building's double-click. Its explicit
	# unit badge remains available when the player intends to select matching troops.
	if bid>=0 and not on_unit_badge and int(world.buildings[bid].o)==world.civ_id:
		selected_buildings.clear(); military.selected.clear()
		for building in world.buildings.values():
			if int(building.o)!=world.civ_id or building.ty!=world.buildings[bid].ty: continue
			var p:=world.grid.center(int(building.t))
			if whole_map or get_viewport().get_visible_rect().has_point(cam.to_screen(Vector3(world.grid.near_x(p.x,cam.focus.x),world.tile_height(int(building.t)),p.y))): selected_buildings[int(building.id)]=true
		settlements.selected_building=bid; selection_changed.emit(); return
	if labels: pos=labels.order_point(pos)
	var hits:=military.units_near_screen(pos,18)
	if not hits.is_empty():
		var type:String=world.units[hits[0]].type; military.selected.clear(); selected_buildings.clear(); settlements.selected_building=-1
		for unit in world.units.values():
			if int(unit.owner)!=world.civ_id or unit.type!=type: continue
			if whole_map or (military.draw_positions.has(unit.id) and get_viewport().get_visible_rect().has_point(cam.to_screen(military.draw_positions[unit.id]))): military.selected[int(unit.id)]=true
	else:
		tile=cam.pick_tile(pos); bid=settlements.building_at(tile)
		if bid<0: return
		selected_buildings.clear(); military.selected.clear()
		for building in world.buildings.values():
			if int(building.o)!=world.civ_id or building.ty!=world.buildings[bid].ty: continue
			var p:=world.grid.center(int(building.t))
			if whole_map or get_viewport().get_visible_rect().has_point(cam.to_screen(Vector3(world.grid.near_x(p.x,cam.focus.x),world.tile_height(int(building.t)),p.y))): selected_buildings[int(building.id)]=true
		settlements.selected_building=bid
	selection_changed.emit()

func _group_key(event:InputEventKey) -> bool:
	if event.keycode<KEY_1 or event.keycode>KEY_9: return false
	var key:=int(event.keycode-KEY_0)
	if event.ctrl_pressed or event.meta_pressed:
		groups[key]={"units":_owned_units(),"buildings":selected_buildings.keys()}
		if groups[key].buildings.is_empty() and settlements.selected_building>=0: groups[key].buildings=[settlements.selected_building]
		order_feedback.emit("Control group %d assigned"%key,true); return true
	if not groups.has(key): return true
	if not event.shift_pressed: military.selected.clear(); selected_buildings.clear(); settlements.selected_building=-1
	for id in groups[key].units:
		if world.units.has(id) and int(world.units[id].owner)==world.civ_id: military.selected[id]=true
	for id in groups[key].buildings:
		if world.buildings.has(id) and int(world.buildings[id].o)==world.civ_id: selected_buildings[id]=true; settlements.selected_building=int(id)
	if last_group==key and Time.get_ticks_msec()-last_group_ms<400: center_selection()
	last_group=key; last_group_ms=Time.get_ticks_msec(); selection_changed.emit(); return true

func _observer_key(key:Key) -> void:
	if key==KEY_V: commands.submit({"c":"fog","on":not bool(world.observer.get("fog",false))})
	elif key in [KEY_BRACKETLEFT,KEY_BRACKETRIGHT]:
		var ids:Array=world.civ_by_id.keys(); var index:=ids.find(world.civ_id)
		if not ids.is_empty(): commands.submit({"c":"follow","civ":ids[posmod(index+(-1 if key==KEY_BRACKETLEFT else 1),ids.size())]})
	elif key in [KEY_COMMA,KEY_PERIOD]:
		var speeds:=[0,1,2,4,8]; var index:=speeds.find(int(world.observer.get("speed",1)))
		commands.submit({"c":"speed","speed":speeds[clampi(index+(-1 if key==KEY_COMMA else 1),0,4)]})


func update(dt: float) -> void:
	if marker.visible:
		marker_t += dt
		var x := world.grid.near_x(marker_base.x, cam.focus.x)
		marker.position = Vector3(x, marker_base.y, marker_base.z)
		marker.scale = Vector3.ONE * (1.0 + marker_t * 0.8)
		if marker_t > 0.9:
			marker.visible = false
