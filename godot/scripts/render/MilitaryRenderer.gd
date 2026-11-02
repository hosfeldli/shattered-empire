class_name MilitaryRenderer
extends Node3D
## Units: one model per unit type and owner, built from the material library (olive drab, steel,
## canvas and the owner's colour on a band or flag). Positions come from WorldState's snapshot
## buffer, interpolated between server updates and drawn at the image nearest the camera. Facing
## follows movement. Selected units get a ring and, for your own, their server path.

var world: WorldState
var cam: CameraController
var nodes := {}          # id -> { node: Node3D, mesh: MeshInstance3D, ring: MeshInstance3D, last: Vector2, yaw: float, key: String }
var selected := {}       # id -> true
var meshes := {}         # "type|owner" -> ArrayMesh
var ring_mesh: TorusMesh
var path_mesh: ImmediateMesh
var path_inst: MeshInstance3D
var drawn := 0


func setup(w: WorldState, c: CameraController) -> void:
	world = w
	cam = c
	ring_mesh = TorusMesh.new()
	ring_mesh.inner_radius = 0.26
	ring_mesh.outer_radius = 0.31
	ring_mesh.rings = 24
	ring_mesh.ring_segments = 4
	ring_mesh.material = MaterialLibrary.glow(Color(0.95, 0.92, 0.6))
	path_mesh = ImmediateMesh.new()
	path_inst = MeshInstance3D.new()
	path_inst.mesh = path_mesh
	path_inst.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	path_inst.material_override = MaterialLibrary.glow(Color(0.9, 0.85, 0.5), 0.8)
	add_child(path_inst)
	world.reset.connect(_clear)
	world.welcomed.connect(_clear)


func _clear() -> void:
	for r in nodes.values():
		(r.node as Node).queue_free()
	nodes.clear()
	selected.clear()


func unit_def(type: String) -> Dictionary:
	var units: Dictionary = world.defs.get("UNITS", {})
	return units.get(type, {})


func update(dt: float) -> void:
	if world.grid == null:
		return
	var g := world.grid
	var cx := cam.focus.x
	for id in nodes.keys():
		if not world.units.has(id):
			(nodes[id].node as Node).queue_free()
			nodes.erase(id)
			selected.erase(id)
	drawn = 0
	for id in world.units.keys():
		var u: Dictionary = world.units[id]
		var key := "%s|%d" % [u.type, u.owner]
		var r: Dictionary = nodes.get(id, {})
		if r.is_empty() or r.key != key:
			if not r.is_empty():
				(r.node as Node).queue_free()
			r = _make(u, key)
			nodes[id] = r
		var p := world.unit_position(id)
		var d: Dictionary = unit_def(u.type)
		var air: bool = bool(d.get("air", false)) or str(d.get("cat", "")) == "air"
		var x := g.near_x(p.x, cx)
		var y := maxf(world.ground_height(x, p.y), 0.0)
		if air:
			y += 1.4
		elif (u.flags & 2) != 0:
			y = maxf(y, 0.02)   # afloat
		var moved := Vector2(g.dx_wrap(r.last.x, p.x), p.y - r.last.y)
		if moved.length_squared() > 1e-6:
			var want := atan2(-moved.y, moved.x)
			r.yaw = lerp_angle(float(r.yaw), want, minf(1.0, dt * 8.0))
		r.last = p
		var node: Node3D = r.node
		node.position = Vector3(x, y, p.y)
		(r.mesh as Node3D).rotation = Vector3(0, float(r.yaw), 0)
		(r.ring as Node3D).visible = selected.has(id)
		drawn += 1
	_draw_paths()


func _draw_paths() -> void:
	path_mesh.clear_surfaces()
	var any := false
	var g := world.grid
	for id in selected.keys():
		var u: Dictionary = world.units.get(id, {})
		if u.is_empty() or int(u.owner) != world.civ_id:
			continue
		var path: Array = world.paths.get(str(id), [])
		if path.is_empty():
			continue
		if not any:
			path_mesh.surface_begin(Mesh.PRIMITIVE_LINES)
			any = true
		var prev: Vector3 = (nodes[id].node as Node3D).position
		for t in path:
			var c := g.center(int(t))
			var x := g.near_x(c.x, prev.x)
			var p := Vector3(x, maxf(world.ground_height(x, c.y), 0.0) + 0.06, c.y)
			path_mesh.surface_add_vertex(prev + Vector3(0, 0.06, 0))
			path_mesh.surface_add_vertex(p)
			prev = p
	if any:
		path_mesh.surface_end()


func _make(u: Dictionary, key: String) -> Dictionary:
	var node := Node3D.new()
	add_child(node)
	var mi := MeshInstance3D.new()
	if not meshes.has(key):
		meshes[key] = _build_model(u.type, world.civ_color(int(u.owner)))
	mi.mesh = meshes[key]
	node.add_child(mi)
	var ring := MeshInstance3D.new()
	ring.mesh = ring_mesh
	ring.position = Vector3(0, 0.03, 0)
	ring.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	ring.visible = false
	node.add_child(ring)
	var p := world.unit_position(int(u.id))
	return {"node": node, "mesh": mi, "ring": ring, "last": p, "yaw": 0.0, "key": key}


## a small readable model per unit class; forward is +X
func _build_model(type: String, team_color: Color) -> ArrayMesh:
	var k := MeshKit.new()
	var d := unit_def(type)
	var cat: String = str(d.get("cat", "infantry"))
	var team := "team:" + team_color.to_html(false)
	var olive := Color(1, 1, 1)
	match cat:
		"infantry":
			# a squad in a loose wedge, the leader carrying the colours
			var spots := [Vector2(0.1, 0), Vector2(0, -0.09), Vector2(0, 0.09), Vector2(-0.1, -0.17), Vector2(-0.1, 0.17), Vector2(-0.12, 0)]
			for s: Vector2 in spots:
				k.box("olive", Vector3(s.x, 0, s.y), Vector3(0.045, 0.085, 0.045), olive)
				k.box("olive", Vector3(s.x, 0.085, s.y), Vector3(0.035, 0.03, 0.035), Color(0.8, 0.8, 0.75))
			k.box("timber", Vector3(0.1, 0, 0.03), Vector3(0.008, 0.2, 0.008))
			k.box(team, Vector3(0.1, 0.15, 0.06), Vector3(0.006, 0.05, 0.06))
		"tracked":
			k.box("steel", Vector3(0, 0, -0.075), Vector3(0.32, 0.05, 0.05), Color(0.45, 0.45, 0.45))
			k.box("steel", Vector3(0, 0, 0.075), Vector3(0.32, 0.05, 0.05), Color(0.45, 0.45, 0.45))
			k.box("olive", Vector3(0, 0.03, 0), Vector3(0.3, 0.06, 0.15), olive)
			k.box("olive", Vector3(-0.02, 0.09, 0), Vector3(0.13, 0.05, 0.11), olive * 0.95)
			k.box("steel", Vector3(0.12, 0.105, 0), Vector3(0.17, 0.016, 0.016))
			k.box(team, Vector3(-0.02, 0.14, 0), Vector3(0.1, 0.006, 0.09))
		"wheeled":
			for wx in [-0.08, 0.08]:
				for wz in [-0.065, 0.065]:
					k.box("char", Vector3(wx, 0, wz), Vector3(0.05, 0.045, 0.025))
			k.box("olive", Vector3(0, 0.025, 0), Vector3(0.24, 0.06, 0.12), olive)
			k.box("glass", Vector3(0.07, 0.085, 0), Vector3(0.05, 0.03, 0.1))
			k.box(team, Vector3(-0.04, 0.086, 0), Vector3(0.1, 0.006, 0.1))
		"artillery":
			k.box("olive", Vector3(0, 0, 0), Vector3(0.12, 0.05, 0.1), olive)
			k.box("char", Vector3(0, 0, -0.06), Vector3(0.06, 0.06, 0.02))
			k.box("char", Vector3(0, 0, 0.06), Vector3(0.06, 0.06, 0.02))
			k.box("steel", Vector3(0.12, 0.06, 0), Vector3(0.24, 0.02, 0.02))
			k.box("olive", Vector3(-0.13, 0, -0.03), Vector3(0.16, 0.015, 0.015))
			k.box("olive", Vector3(-0.13, 0, 0.03), Vector3(0.16, 0.015, 0.015))
			for s: Vector2 in [Vector2(-0.05, -0.12), Vector2(-0.1, 0.12)]:
				k.box("olive", Vector3(s.x, 0, s.y), Vector3(0.04, 0.08, 0.04), olive)
			k.box(team, Vector3(0, 0.05, 0), Vector3(0.06, 0.006, 0.06))
		"air":
			k.box("steel", Vector3(0, 0, 0), Vector3(0.36, 0.05, 0.06), Color(0.75, 0.77, 0.78))
			k.box("steel", Vector3(0.02, 0.02, 0), Vector3(0.1, 0.012, 0.42), Color(0.7, 0.72, 0.74))
			k.box("steel", Vector3(-0.15, 0.02, 0), Vector3(0.06, 0.01, 0.16), Color(0.7, 0.72, 0.74))
			k.box("glass", Vector3(0.12, 0.04, 0), Vector3(0.06, 0.02, 0.035))
			k.box(team, Vector3(0.02, 0.035, 0.17), Vector3(0.05, 0.004, 0.05))
			k.box(team, Vector3(0.02, 0.035, -0.17), Vector3(0.05, 0.004, 0.05))
		"civilian":
			k.box("canvas", Vector3(0, 0.03, 0), Vector3(0.2, 0.08, 0.11))
			k.box("timber", Vector3(0, 0, 0), Vector3(0.22, 0.03, 0.12))
			k.box("char", Vector3(-0.06, 0, -0.07), Vector3(0.05, 0.05, 0.015))
			k.box("char", Vector3(-0.06, 0, 0.07), Vector3(0.05, 0.05, 0.015))
			k.box(team, Vector3(0, 0.11, 0), Vector3(0.08, 0.006, 0.06))
		_:
			# support: engineers and supply trucks
			k.box("olive", Vector3(0.08, 0.02, 0), Vector3(0.08, 0.08, 0.11), olive)
			k.box("canvas", Vector3(-0.04, 0.02, 0), Vector3(0.16, 0.09, 0.12))
			for wx in [-0.08, 0.08]:
				for wz in [-0.065, 0.065]:
					k.box("char", Vector3(wx, 0, wz), Vector3(0.045, 0.04, 0.02))
			k.box(team, Vector3(-0.04, 0.115, 0), Vector3(0.12, 0.006, 0.08))
	return k.commit()


## own units whose drawn position projects within radius px of the screen point, nearest first
func units_near_screen(screen: Vector2, radius: float, own_only := true) -> Array:
	var out := []
	for id in nodes.keys():
		var u: Dictionary = world.units.get(id, {})
		if u.is_empty() or (own_only and int(u.owner) != world.civ_id):
			continue
		var s := cam.to_screen((nodes[id].node as Node3D).global_position + Vector3(0, 0.05, 0))
		var dd := s.distance_to(screen)
		if s.x >= 0.0 and dd <= radius:
			out.append([dd, id])
	out.sort_custom(func(a, b): return a[0] < b[0])
	return out.map(func(x): return x[1])


func units_in_rect(rect: Rect2) -> Array:
	var out := []
	for id in nodes.keys():
		var u: Dictionary = world.units.get(id, {})
		if u.is_empty() or int(u.owner) != world.civ_id:
			continue
		var s := cam.to_screen((nodes[id].node as Node3D).global_position)
		if rect.has_point(s):
			out.append(id)
	return out
