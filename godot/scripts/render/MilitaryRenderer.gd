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
var path_until:=0
const BATCH_THRESHOLD := 64
var batched := false
var batches := {}        # model key -> MultiMeshInstance3D
var motions := {}        # id -> { last: Vector2, yaw: float }
var draw_positions := {} # id -> Vector3, also used by picking and path drawing
var ring_batch: MultiMeshInstance3D
var ground_cache := {}


func setup(w: WorldState, c: CameraController) -> void:
	world = w
	cam = c
	ring_mesh = TorusMesh.new()
	ring_mesh.inner_radius = 0.26
	ring_mesh.outer_radius = 0.31
	ring_mesh.rings = 24
	ring_mesh.ring_segments = 4
	ring_mesh.material = MaterialLibrary.glow(Color(0.95, 0.92, 0.6))
	ring_batch = MultiMeshInstance3D.new()
	ring_batch.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(ring_batch)
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
	_clear_batches()
	meshes.clear()
	motions.clear()
	draw_positions.clear()
	ground_cache.clear()
	selected.clear()


func unit_def(type: String) -> Dictionary:
	var units: Dictionary = world.defs.get("UNITS", {})
	return units.get(type, {})


func update(dt: float) -> void:
	if world.grid == null:
		return
	world.prepare_unit_frame()
	var want_batched := world.units.size() > BATCH_THRESHOLD
	if want_batched != batched:
		batched = want_batched
		for r in nodes.values():
			(r.node as Node).queue_free()
		nodes.clear()
		_clear_batches()
		motions.clear()
	if batched:
		_update_batched(dt)
		_draw_paths()
		return
	var g := world.grid
	var cx := cam.focus.x
	for id in nodes.keys():
		if not world.units.has(id):
			(nodes[id].node as Node).queue_free()
			nodes.erase(id)
			ground_cache.erase(id)
			selected.erase(id)
	drawn = 0
	draw_positions.clear()
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
		var y := _ground_for(id, p)
		var pose := MilitaryPresentationState.pose(u, int(u.next)>=0, d)
		var animation:=_animation(u,d)
		var mesh_key:=key+("|"+animation if animation!="idle" else "")
		if not meshes.has(mesh_key): meshes[mesh_key]=_build_model(u.type,world.civ_color(int(u.owner)),animation)
		if (r.mesh as MeshInstance3D).mesh!=meshes[mesh_key]: (r.mesh as MeshInstance3D).mesh=meshes[mesh_key]
		if air and not pose.grounded:
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
		draw_positions[id] = node.position
		(r.mesh as Node3D).rotation = Vector3(0, float(r.yaw), 0)
		(r.mesh as Node3D).scale = Vector3(1,1.0 if animation=="cover" else float(pose.height_scale),1)
		if r.get("turret")!=null:
			(r.turret as Node3D).rotation.y=_target_yaw(u,p,float(r.yaw))
		(r.ring as Node3D).visible = selected.has(id)
		drawn += 1
	_draw_paths()


func _ground_for(id: int, p: Vector2) -> float:
	var cache: Dictionary = ground_cache.get(id, {})
	if cache.is_empty() or cache.pos != p or int(cache.revision) != world.geo_version:
		cache = {"pos": p, "revision": world.geo_version, "height": maxf(world.ground_height(p.x, p.y), 0.0)}
		ground_cache[id] = cache
	return float(cache.height)


func _clear_batches() -> void:
	for b in batches.values():
		(b as Node).queue_free()
	batches.clear()
	if ring_batch:
		ring_batch.multimesh = null


## Dense scenes use one MultiMesh per model/owner key. Positions remain authoritative snapshot
## interpolation; batching only changes how the same transforms reach the renderer.
func _update_batched(dt: float) -> void:
	var g := world.grid
	var cx := cam.focus.x
	var groups := {}
	var seen := {}
	draw_positions.clear()
	drawn = 0
	for id in world.units.keys():
		seen[id] = true
		var u: Dictionary = world.units[id]
		var p := world.unit_position(id)
		var d: Dictionary = unit_def(u.type)
		var air: bool = bool(d.get("air", false)) or str(d.get("cat", "")) == "air"
		var x := g.near_x(p.x, cx)
		var y := _ground_for(id, p)
		var pose := MilitaryPresentationState.pose(u,int(u.next)>=0,d)
		if air and not pose.grounded:
			y += 1.4
		elif (u.flags & 2) != 0:
			y = maxf(y, 0.02)
		var motion: Dictionary = motions.get(id, {"last": p, "yaw": 0.0})
		var moved := Vector2(g.dx_wrap(motion.last.x, p.x), p.y - motion.last.y)
		if moved.length_squared() > 1e-6:
			var want := atan2(-moved.y, moved.x)
			motion.yaw = lerp_angle(float(motion.yaw), want, minf(1.0, dt * 8.0))
		motion.last = p
		motions[id] = motion
		var pos := Vector3(x, y, p.y)
		draw_positions[id] = pos
		var key := "%s|%d" % [u.type, u.owner]
		var animation:=_animation(u,d)
		if animation!="idle": key+="|"+animation
		if not groups.has(key):
			groups[key] = {"unit": u, "xforms": [],"animation":animation}
		(groups[key].xforms as Array).append(Transform3D(Basis(Vector3.UP, float(motion.yaw)).scaled(Vector3(1,1.0 if animation=="cover" else float(pose.height_scale),1)), pos))
		if str(d.get("cat",""))=="tracked":
			var turret_key:="turret|%s|%d"%[u.type,int(u.owner)]
			if not groups.has(turret_key): groups[turret_key]={"unit":u,"xforms":[]}
			(groups[turret_key].xforms as Array).append(Transform3D(Basis(Vector3.UP,_target_yaw(u,p,float(motion.yaw))),pos))
		drawn += 1
	for id in motions.keys():
		if not seen.has(id):
			motions.erase(id)
			ground_cache.erase(id)
			selected.erase(id)
	for key in batches.keys():
		if not groups.has(key):
			# Keep the small alternate animation batches warm across walk cycles.
			(batches[key] as MultiMeshInstance3D).multimesh.visible_instance_count=0
			if batches.size()>groups.size()+24:
				(batches[key] as Node).queue_free(); batches.erase(key)
	for key in groups.keys():
		var batch: MultiMeshInstance3D = batches.get(key)
		var info: Dictionary = groups[key]
		if batch == null:
			batch = MultiMeshInstance3D.new()
			add_child(batch)
			batches[key] = batch
		var mm := batch.multimesh
		if mm == null:
			mm = MultiMesh.new()
			mm.transform_format = MultiMesh.TRANSFORM_3D
		if not meshes.has(key):
			var sample: Dictionary = info.unit
			meshes[key] = _build_turret(world.civ_color(int(sample.owner)),str(sample.type)) if str(key).begins_with("turret|") else _build_model(sample.type, world.civ_color(int(sample.owner)),str(info.get("animation","idle")))
		mm.mesh = meshes[key]
		var xforms: Array = info.xforms
		if mm.instance_count < xforms.size():
			mm.instance_count = maxi(xforms.size(), mm.instance_count * 2)
		mm.visible_instance_count = xforms.size()
		for k in xforms.size():
			mm.set_instance_transform(k, xforms[k])
		batch.multimesh = mm
	_update_batched_rings()


func _update_batched_rings() -> void:
	var xforms: Array[Transform3D] = []
	for id in selected.keys():
		if draw_positions.has(id):
			xforms.append(Transform3D(Basis.IDENTITY, (draw_positions[id] as Vector3) + Vector3(0, 0.03, 0)))
	var mm := ring_batch.multimesh
	if mm == null:
		mm = MultiMesh.new()
		mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.mesh = ring_mesh
	if mm.instance_count < xforms.size():
		mm.instance_count = maxi(xforms.size(), mm.instance_count * 2)
	mm.visible_instance_count = xforms.size()
	for k in xforms.size():
		mm.set_instance_transform(k, xforms[k])
	ring_batch.multimesh = mm


func _draw_paths() -> void:
	path_mesh.clear_surfaces()
	if Time.get_ticks_msec()>path_until: return
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
		if not draw_positions.has(id):
			continue
		var prev: Vector3 = draw_positions[id]
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
	var turret:MeshInstance3D
	if str(unit_def(u.type).get("cat",""))=="tracked":
		turret=MeshInstance3D.new()
		var turret_key:="turret|%s|%d"%[u.type,int(u.owner)]
		if not meshes.has(turret_key): meshes[turret_key]=_build_turret(world.civ_color(int(u.owner)),str(u.type))
		turret.mesh=meshes[turret_key]; node.add_child(turret)
	return {"node": node, "mesh": mi, "turret":turret,"ring": ring, "last": p, "yaw": 0.0, "key": key}


func _target_yaw(unit:Dictionary, position:Vector2, fallback:float) -> float:
	var target:Dictionary=world.units.get(int(unit.get("target",0)),{})
	if target.is_empty(): return fallback
	var point:=world.grid.center(int(target.tile))
	return atan2(-(point.y-position.y),world.grid.dx_wrap(position.x,point.x))


func _build_turret(color:Color,type:="tank") -> ArrayMesh:
	return MilitaryModelLibrary.turret(type,color)


func _animation(unit:Dictionary,definition:Dictionary) -> String:
	if unit.type=="helicopter" and not world.paused and cam.size<25: return "rotor_%d"%posmod(int(world.render_time*8),2)
	if str(definition.get("cat",""))!="infantry" and unit.type!="engineer" or cam.size>25.0: return "idle"
	if int(unit.get("supp",0))>60: return "cover"
	if int(unit.get("next",-1))>=0: return "walk_%d"%posmod(int(world.render_time*4)+int(unit.id),2)
	return "idle"


## a small readable model per unit class; forward is +X
func _build_model(type: String, team_color: Color, animation:="idle") -> ArrayMesh:
	return MilitaryModelLibrary.build(type,team_color,animation)


## own units whose drawn position projects within radius px of the screen point, nearest first
func units_near_screen(screen: Vector2, radius: float, own_only := true) -> Array:
	var out := []
	for id in draw_positions.keys():
		var u: Dictionary = world.units.get(id, {})
		if u.is_empty() or (own_only and int(u.owner) != world.civ_id):
			continue
		var s := cam.to_screen((draw_positions[id] as Vector3) + Vector3(0, 0.05, 0))
		var dd := s.distance_to(screen)
		if s.x >= 0.0 and dd <= radius:
			out.append([dd, id])
	out.sort_custom(func(a, b): return a[0] < b[0])
	return out.map(func(x): return x[1])


func units_in_rect(rect: Rect2) -> Array:
	var out := []
	for id in draw_positions.keys():
		var u: Dictionary = world.units.get(id, {})
		if u.is_empty() or int(u.owner) != world.civ_id:
			continue
		var s := cam.to_screen(draw_positions[id])
		if rect.has_point(s):
			out.append(id)
	return out
