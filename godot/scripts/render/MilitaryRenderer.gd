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
var recoils := {}        # unit id -> msec of its last direct-fire shot (recoil presentation)
var dug_in: MultiMeshInstance3D   # sandbag crescents under fortified ground troops (cosmetic)
var squads: SquadPresentation
var stack_now := {}      # unit id -> current eased offset inside a shared hex (presentation)
var stack_target := {}


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
	var mm:=MultiMesh.new(); mm.transform_format=MultiMesh.TRANSFORM_3D; mm.mesh=_dug_in_mesh(); mm.instance_count=256; mm.visible_instance_count=0
	dug_in=MultiMeshInstance3D.new(); dug_in.multimesh=mm; dug_in.cast_shadow=GeometryInstance3D.SHADOW_CASTING_SETTING_ON; add_child(dug_in)


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
	_stack_layout(dt)
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
		_update_dug_in()
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
		var p := world.unit_position(id) + (stack_now.get(id, Vector2.ZERO) as Vector2)
		var d: Dictionary = unit_def(u.type)
		var air: bool = bool(d.get("air", false)) or str(d.get("cat", "")) == "air"
		var x := g.near_x(p.x, cx)
		var y := _ground_for(id, p) + _bob(u, d)
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
		# direct-fire recoil: the hull rocks back and settles within a third of a second
		var kick:=0.0
		if recoils.has(id):
			var age:=(Time.get_ticks_msec()-int(recoils[id]))/1000.0
			if age>.35: recoils.erase(id)
			else: kick=sin(minf(age/.35,1.0)*PI)*.035*(1.0-age/.35)
		(r.mesh as Node3D).position=Vector3(-cos(float(r.yaw))*kick,0,sin(float(r.yaw))*kick)
		(r.mesh as Node3D).scale = Vector3(1,1.0 if animation=="cover" else float(pose.height_scale),1)
		if r.get("turret")!=null:
			(r.turret as Node3D).rotation.y=_target_yaw(u,p,float(r.yaw))
		(r.ring as Node3D).visible = selected.has(id)
		drawn += 1
	_draw_paths()
	_update_dug_in()


## Units sharing a hex (within the server's capacity) stand apart: each stationary ground unit
## takes a stable place around the hex centre by id; moving units travel the centre line. The
## offset eases, so arriving or leaving never jumps. Presentation only.
var stack_clock := 0.0
var cull_frame := 0

func _stack_layout(dt: float) -> void:
	stack_clock -= dt
	if stack_clock <= 0.0:
		stack_clock = 0.2
		_stack_targets()
	var ease := 1.0 - exp(-4.0 * dt)
	for id in stack_now.keys():
		if not world.units.has(id): stack_now.erase(id)
	for id in stack_target:
		var goal: Vector2 = stack_target[id]
		stack_now[id] = (stack_now.get(id, Vector2.ZERO) as Vector2).lerp(goal, ease)
	for id in stack_now.keys():
		if not stack_target.has(id):
			var now: Vector2 = (stack_now[id] as Vector2).lerp(Vector2.ZERO, ease)
			if now.length() < .002: stack_now.erase(id)
			else: stack_now[id] = now


## Stationary ground units sharing a hex take stable places around it; units travelling the same
## stretch (same hex and next hex) take parallel lanes, so vehicles never drive inside each other.
func _stack_targets() -> void:
	var by_tile := {}
	var by_edge := {}
	var g := world.grid
	for id in world.units:
		var u: Dictionary = world.units[id]
		if bool(unit_def(str(u.type)).get("air", false)): continue
		var next := int(u.get("next", -1))
		if next < 0:
			var tile := int(u.tile)
			if not by_tile.has(tile): by_tile[tile] = []
			(by_tile[tile] as Array).append(int(id))
		else:
			var key := "%d>%d" % [int(u.tile), next]
			if not by_edge.has(key): by_edge[key] = []
			(by_edge[key] as Array).append(int(id))
	stack_target.clear()
	for tile in by_tile:
		var ids: Array = by_tile[tile]
		if ids.size() < 2: continue
		ids.sort()
		for k in ids.size():
			var angle := TAU * k / ids.size() + .5
			stack_target[ids[k]] = Vector2(cos(angle), sin(angle)) * (.22 if ids.size() <= 3 else .3)
	for key in by_edge:
		var ids: Array = by_edge[key]
		if ids.size() < 2: continue
		ids.sort()
		var parts: PackedStringArray = str(key).split(">")
		var a := g.center(int(parts[0])); var b := g.center(int(parts[1]))
		var along := Vector2(g.dx_wrap(a.x, b.x), b.y - a.y).normalized()
		var side := Vector2(-along.y, along.x)
		for k in ids.size():
			# lanes side by side, and a short stagger along the road so columns do not stack
			stack_target[ids[k]] = side * (float(k) - (ids.size() - 1) * .5) * .11 - along * float(k % 2) * .06


## a slight suspension bob for moving ground vehicles
func _bob(u: Dictionary, d: Dictionary) -> float:
	if int(u.get("next", -1)) < 0 or not str(d.get("move", "")) in ["wheeled", "tracked"] or bool(d.get("air", false)): return 0.0
	return sin(world.render_time * 13.0 + int(u.id)) * .0035


func _ground_for(id: int, p: Vector2) -> float:
	var cache: Dictionary = ground_cache.get(id, {})
	if cache.is_empty() or cache.pos != p or int(cache.revision) != world.geo_version or int(cache.get("battlefield_revision",-1)) != world.battlefield_terrain_version:
		cache = {"pos": p, "revision": world.geo_version, "battlefield_revision":world.battlefield_terrain_version, "height": maxf(world.ground_height(p.x, p.y), 0.0)}
		ground_cache[id] = cache
	return float(cache.height)


## A shallow scrape and a crescent of sandbags facing the unit's front: how a fortified squad or
## gun crew reads at a glance. Presentation of the server's fortified flag only; the server alone
## decides cover. Vehicles and aircraft are skipped; hidden enemies are never drawn.
func _dug_in_mesh() -> ArrayMesh:
	var k:=MeshKit.new()
	k.cylinder("soil",Vector3(0,-.004,0),.2,.006,12,Color(.62,.52,.38),.2)
	for i in 7:
		var a:=-PI*.55+PI*1.1*float(i)/6.0
		var p:=Vector3(cos(a)*.2,0,sin(a)*.2)
		k.box("canvas",p,Vector3(.075,.032,.04),Color(.80,.75,.56),-a+PI*.5)
		k.box("canvas",p*.97+Vector3(0,.032,0),Vector3(.065,.026,.036),Color(.76,.71,.53),-a+PI*.5+.2)
	return k.commit()


func _update_dug_in() -> void:
	var mm:=dug_in.multimesh; var n:=0
	if cam.size>30.0: mm.visible_instance_count=0; return
	for id in draw_positions:
		if n>=mm.instance_count: break
		var u:Dictionary=world.units.get(id,{})
		if u.is_empty() or (int(u.get("flags",0))&32)==0 or int(u.get("next",-1))>=0: continue
		var d:=unit_def(str(u.type))
		if bool(d.get("air",false)) or str(d.get("move","")) in ["tracked","wheeled"] and str(d.get("cat",""))!="artillery": continue
		if int(u.owner)!=world.civ_id and not world.is_visible(int(u.tile)): continue
		var p:Vector3=draw_positions[id]
		var yaw:=float(motions.get(id,nodes.get(id,{})).get("yaw",0.0))
		mm.set_instance_transform(n,Transform3D(Basis(Vector3.UP,yaw),Vector3(p.x,world.ground_height(p.x,p.z),p.z)))
		n+=1
	mm.visible_instance_count=n


func recoil(id:int) -> void:
	if world.units.has(id): recoils[id]=Time.get_ticks_msec()


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
	cull_frame += 1
	var view_half := cam.view_half_width()
	for id in world.units.keys():
		seen[id] = true
		var u: Dictionary = world.units[id]
		# static per-unit facts are cached (type, owner, batch keys, movement class); motion lives here too
		var info: Dictionary = motions.get(id, {})
		if info.is_empty() or info.get("type") != u.type or int(info.get("owner", -9)) != int(u.owner):
			info = _unit_info(u, info)
			motions[id] = info
		# off-screen units are refreshed only every tenth frame (they are not drawn meanwhile)
		if info.has("pos") and (cull_frame + int(id)) % 10 != 0:
			var last: Vector3 = info.pos
			if absf(g.near_x(last.x, cx) - cx) > view_half + 2.0 or absf(last.z - cam.focus.z) > cam.size + 2.0:
				draw_positions[id] = last
				continue
		var p: Vector2 = world.unit_position(id)
		var offset: Variant = stack_now.get(id)
		if offset != null: p += offset
		var x := g.near_x(p.x, cx)
		var y := _ground_for(id, p)
		var moving := int(u.next) >= 0
		if moving and info.vehicle: y += sin(world.render_time * 13.0 + int(id)) * .0035
		var height_scale := 1.0
		if info.air:
			var air_state: Array = u.get("air", [])
			if air_state.is_empty() or not int(air_state[0]) in [0, 7, 8]: y += 1.4
		elif (u.flags & 2) != 0:
			y = maxf(y, 0.02)
		if info.infantry: height_scale = lerpf(1.0, .52, clampf(float(u.get("supp", 0)) / 100.0, 0.0, 1.0))
		var moved := Vector2(g.dx_wrap(info.last.x, p.x), p.y - info.last.y)
		if moved.length_squared() > 1e-6:
			info.yaw = lerp_angle(float(info.yaw), atan2(-moved.y, moved.x), minf(1.0, dt * 8.0))
		info.last = p
		var pos := Vector3(x, y, p.y)
		draw_positions[id] = pos
		info.pos = pos
		var animation := _animation(u, info.def)
		var keys: Dictionary = info.keys
		var key: String = keys.get(animation, "")
		if key == "":
			key = info.base if animation == "idle" else info.base + "|" + animation
			keys[animation] = key
		var group: Dictionary = groups.get(key, {})
		if group.is_empty():
			group = {"unit": u, "xforms": [], "animation": animation, "custom": [] if animation.begins_with("gpu") else null}
			groups[key] = group
		var flat := animation in ["cover", "gpu", "gpu_low"]
		var basis := Basis(Vector3.UP, float(info.yaw))
		if not flat and height_scale != 1.0: basis = basis.scaled(Vector3(1, height_scale, 1))
		(group.xforms as Array).append(Transform3D(basis, pos))
		if group.custom != null:
			# per-instance soldier animation: seed, marching, gone to ground (suppressed) or kneeling (firing)
			var down := 1.0 if int(u.get("supp", 0)) > 60 else .45 if (int(u.get("flags", 0)) & 1) != 0 and not moving else 0.0
			(group.custom as Array).append(Color(info.seed, 1.0 if moving else 0.0, down, 0.0))
		if info.tracked:
			var turret_key: String = info.turret
			var turrets: Dictionary = groups.get(turret_key, {})
			if turrets.is_empty(): turrets = {"unit": u, "xforms": []}; groups[turret_key] = turrets
			(turrets.xforms as Array).append(Transform3D(Basis(Vector3.UP, _target_yaw(u, p, float(info.yaw)) if int(u.get("target", 0)) != 0 else float(info.yaw)), pos))
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
		var custom:Variant=info.get("custom")
		if mm == null:
			mm = MultiMesh.new()
			mm.transform_format = MultiMesh.TRANSFORM_3D
			mm.use_custom_data = custom != null
		if not meshes.has(key):
			var sample: Dictionary = info.unit
			meshes[key] = _build_turret(world.civ_color(int(sample.owner)),str(sample.type)) if str(key).begins_with("turret|") else _build_model(sample.type, world.civ_color(int(sample.owner)),str(info.get("animation","idle")))
		mm.mesh = meshes[key]
		var xforms: Array = info.xforms
		if mm.instance_count < xforms.size():
			mm.instance_count = maxi(xforms.size(), mm.instance_count * 2)
		_upload(mm, xforms, custom)
		batch.multimesh = mm
		batch.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON if cam.size < 20.0 else GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	_update_batched_rings()


## One buffer upload per batch instead of one renderer call per instance (large armies).
## Layout per instance: three transform rows, then custom data when enabled; the tail of the
## buffer beyond the visible count is left as it was.
static func _upload(mm: MultiMesh, xforms: Array, custom: Variant = null) -> void:
	var stride := 16 if mm.use_custom_data else 12
	# keep our own copy: reading MultiMesh.buffer copies the whole buffer back from the renderer
	var buffer: PackedFloat32Array = mm.get_meta("upload", PackedFloat32Array())
	if buffer.size() != mm.instance_count * stride: buffer.resize(mm.instance_count * stride)
	var i := 0
	for k in xforms.size():
		var t: Transform3D = xforms[k]
		buffer[i] = t.basis.x.x; buffer[i + 1] = t.basis.y.x; buffer[i + 2] = t.basis.z.x; buffer[i + 3] = t.origin.x
		buffer[i + 4] = t.basis.x.y; buffer[i + 5] = t.basis.y.y; buffer[i + 6] = t.basis.z.y; buffer[i + 7] = t.origin.y
		buffer[i + 8] = t.basis.x.z; buffer[i + 9] = t.basis.y.z; buffer[i + 10] = t.basis.z.z; buffer[i + 11] = t.origin.z
		if stride == 16:
			var c: Color = (custom as Array)[k]
			buffer[i + 12] = c.r; buffer[i + 13] = c.g; buffer[i + 14] = c.b; buffer[i + 15] = c.a
		i += stride
	mm.buffer = buffer
	mm.set_meta("upload", buffer)
	mm.visible_instance_count = xforms.size()


func _unit_info(u: Dictionary, previous: Dictionary) -> Dictionary:
	var d := unit_def(str(u.type))
	var cat := str(d.get("cat", ""))
	return {"type": u.type, "owner": int(u.owner), "def": d, "air": bool(d.get("air", false)) or cat == "air",
		"vehicle": str(d.get("move", "")) in ["wheeled", "tracked"] and not bool(d.get("air", false)), "infantry": cat == "infantry",
		"tracked": cat == "tracked", "base": "%s|%d" % [u.type, int(u.owner)], "turret": "turret|%s|%d" % [u.type, int(u.owner)], "keys": {},
		"seed": fposmod(float(u.id) * .618034, 1.0), "last": previous.get("last", world.unit_position(int(u.id))), "yaw": float(previous.get("yaw", 0.0))}


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
	# Squads near the camera are drawn as simulated people (SquadPresentation; the unit model keeps
	# only equipment). In large battles the rest are one shader-animated instance per unit.
	if SquadPresentation.FIGURES.has(str(unit.type)):
		if squads and squads.near.has(int(unit.id)): return "kit"
		if batched and cam.size<=60.0 and str(unit.type) in ["militia","rifle_squad","special_forces","exo_infantry"]: return "gpu" if cam.size<=24.0 else "gpu_low"
		if not batched and squads==null and SquadPresentation.active(str(unit.type),cam.size): return "kit"
	if str(definition.get("move","")) in ["wheeled","tracked"] and not bool(definition.get("air",false)) and cam.size<25.0 and int(unit.get("next",-1))>=0 and not world.paused:
		return "roll_%d"%posmod(int(world.render_time*7)+int(unit.id),2)
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
