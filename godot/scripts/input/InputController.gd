class_name InputController
extends Node
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
	box_active = false
	press_pos = Vector2(-1, -1)
	if not military.selected.is_empty() or settlements.selected_building >= 0:
		military.selected.clear()
		settlements.selected_building = -1
		selection_changed.emit()


func _unhandled_input(e: InputEvent) -> void:
	if world.grid == null:
		return
	if e is InputEventKey and e.pressed and not e.echo and e.keycode==KEY_P:
		net.cmd({"c":"pause","on":not world.paused},func(reply):order_feedback.emit("Paused" if reply.get("paused",false) else str(reply.get("error","Resumed")),reply.get("error")==null))
		get_viewport().set_input_as_handled()
		return
	if tools and tools.mode != "select":
		return
	if e is InputEventMouseButton:
		var mb := e as InputEventMouseButton
		if mb.button_index == MOUSE_BUTTON_LEFT:
			if mb.pressed:
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
			_order(mb.position, mb.ctrl_pressed or mb.meta_pressed)
			get_viewport().set_input_as_handled()
	elif e is InputEventMouseMotion and press_pos.x >= 0.0:
		var mm := e as InputEventMouseMotion
		if mm.position.distance_to(press_pos) > 6.0:
			box_active = true
			box_rect = Rect2(press_pos, Vector2.ZERO).expand(mm.position)
	elif e is InputEventKey and (e as InputEventKey).pressed and not (e as InputEventKey).echo:
		var k := (e as InputEventKey).keycode
		if k == KEY_H:
			_simple("hold", {})
		elif k == KEY_T:
			var any_def := false
			for id in military.selected.keys():
				if str(world.units.get(id, {}).get("stance", "")) == "defensive":
					any_def = true
			_simple("stance", {"stance": "aggressive" if any_def else "defensive"})


func _click_select(pos: Vector2, add: bool) -> void:
	var hits := military.units_near_screen(pos, 16.0)
	if not add:
		military.selected.clear()
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
				military.selected.clear()
	selection_changed.emit()


func _box_select(add: bool) -> void:
	if not add:
		military.selected.clear()
		settlements.selected_building = -1
	for id in military.units_in_rect(box_rect.abs()):
		military.selected[id] = true
	selection_changed.emit()


func _order(pos: Vector2, attack: bool) -> void:
	if military.selected.is_empty():
		return
	var t := cam.pick_tile(pos)
	if t < 0:
		return
	var ids := []
	for id in military.selected.keys():
		ids.append(int(id))
	var c := {"c": "move", "units": ids, "tile": t, "formation": move_formation}
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
	var sent_at := Time.get_ticks_msec()
	net.cmd(c, func(r: Dictionary):
		if r.has("error") and r.error != null:
			order_feedback.emit(str(r.error), false)
		else:
			var o: Dictionary = r.get("order", {})
			order_feedback.emit("%s acknowledged in %d ms%s" % ["Attack-move" if attack else "Move", Time.get_ticks_msec() - sent_at, (" (%d unreachable)" % int(o.unreachable)) if int(o.get("unreachable", 0)) > 0 else ""], true))
	var c2 := world.grid.center(t)
	marker_base = Vector3(c2.x, world.tile_height(t) + 0.05, c2.y)
	marker_t = 0.0
	marker.visible = true
	(marker.mesh as TorusMesh).material = MaterialLibrary.glow(Color(1.0, 0.55, 0.45) if attack else Color(0.6, 0.95, 0.6))


func _simple(c: String, extra: Dictionary) -> void:
	if military.selected.is_empty():
		return
	var ids := []
	for id in military.selected.keys():
		ids.append(int(id))
	var cmd := {"c": c, "units": ids}
	cmd.merge(extra)
	net.cmd(cmd, func(r: Dictionary):
		order_feedback.emit(str(r.error) if r.has("error") and r.error != null else "%s: %d units" % [c.capitalize(), ids.size()], not (r.has("error") and r.error != null)))


func update(dt: float) -> void:
	if marker.visible:
		marker_t += dt
		var x := world.grid.near_x(marker_base.x, cam.focus.x)
		marker.position = Vector3(x, marker_base.y, marker_base.z)
		marker.scale = Vector3.ONE * (1.0 + marker_t * 0.8)
		if marker_t > 0.9:
			marker.visible = false
