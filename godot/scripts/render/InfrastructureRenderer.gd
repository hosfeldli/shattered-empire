class_name InfrastructureRenderer
extends Node3D
## Roads, railways and bridges from the tile records (each hex carries its six road edges), draped
## over the terrain in one mesh per chunk. Through-hexes curve smoothly between their two edges;
## junctions meet on a shared pad. Each class has its own construction: dirt tracks with wheel
## ruts, paved roads with gravel shoulders, edge lines and a dashed centre line, divided highways
## with a raised median, and railways on ballast with sleepers and two rails. Where a road crosses
## a river or water it becomes a class-specific bridge (timber trestle, reinforced concrete deck,
## steel rail girder) with graded approach embankments on both banks. Bridge condition comes from
## the server for crossings in sight; road works in progress show their real segment and progress.
## Server traffic ([a, b, level] per busy edge) runs as trucks on roads and freight trains on rail.
## All of it is presentation of authoritative edges: nothing here adds a route or crossing.

const SQRT3 := HexGrid.SQRT3
const WIDTH := [0.0, 0.15, 0.19, 0.30, 0.15]
const MAT := ["", "soil", "asphalt", "asphalt", "ballast"]
const LIFT := 0.022
const MAX_TRUCKS := 400
const MAX_WAGONS := 240

var world: WorldState
var cam: CameraController
var chunks := {}        # chunk id -> { inst: MeshInstance3D, x0: float }
var dirty := {}
var trucks: MultiMeshInstance3D
var wagons: MultiMeshInstance3D
var works: MeshInstance3D
var works_version := -1


func setup(w: WorldState, c: CameraController) -> void:
	world = w
	cam = c
	world.tiles_changed.connect(_on_tiles)
	world.geo_changed.connect(_on_geo)
	world.welcomed.connect(_clear)
	world.reset.connect(_clear)
	world.econ_applied.connect(_on_econ)
	trucks = _batch(_truck_model(), MAX_TRUCKS)
	wagons = _batch(_wagon_model(), MAX_WAGONS)
	works = MeshInstance3D.new()
	works.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(works)


func _batch(mesh: Mesh, count: int) -> MultiMeshInstance3D:
	var instance := MultiMeshInstance3D.new()
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.use_colors = true
	mm.mesh = mesh
	mm.instance_count = count
	mm.visible_instance_count = 0
	instance.multimesh = mm
	add_child(instance)
	return instance


func _truck_model() -> ArrayMesh:
	var k := MeshKit.new()
	k.box("painted_metal", Vector3(0.03, 0.006, 0), Vector3(0.035, 0.045, 0.048), Color(0.82, 0.8, 0.76))
	k.box("glass", Vector3(0.049, 0.026, 0), Vector3(0.003, 0.018, 0.04))
	k.box("canvas", Vector3(-0.022, 0.006, 0), Vector3(0.07, 0.055, 0.052), Color(0.7, 0.68, 0.6))
	for x in [-0.04, 0.0, 0.035]:
		for z in [-0.026, 0.026]: k.cylinder("char", Vector3(x, 0.0, z), 0.01, 0.006, 6)
	return k.commit()


func _wagon_model() -> ArrayMesh:
	var k := MeshKit.new()
	k.box("painted_metal", Vector3(0, 0.014, 0), Vector3(0.11, 0.05, 0.05), Color(0.62, 0.42, 0.32))
	k.box("steel", Vector3(0, 0.004, 0), Vector3(0.115, 0.01, 0.04), Color(0.3, 0.3, 0.3))
	return k.commit()


func _clear() -> void:
	for c in chunks.values():
		(c.inst as Node).queue_free()
	chunks.clear()
	dirty.clear()
	works_version = -1
	if works: works.mesh = null


func _on_geo(list: PackedInt32Array) -> void:
	for cid in list:
		dirty[cid] = true


var bridge_keys := {}

func _on_econ() -> void:
	# bridge condition changes rebuild only the chunks that hold those crossings
	if world.bridges_version == works_version: return
	works_version = world.bridges_version
	var keys := bridge_keys.duplicate()
	keys.merge(world.bridge_condition)
	bridge_keys = world.bridge_condition.duplicate()
	for key in keys:
		var parts := str(key).split(":")
		dirty[world._chunk_of(int(parts[0]))] = true
		dirty[world._chunk_of(int(parts[1]))] = true
	_build_works()


func bridge_count() -> int:
	var n := 0
	for c in chunks.values():
		n += int(c.get("bridges", 0))
	return n


func _on_tiles(_tiles: PackedInt32Array, roads: PackedInt32Array) -> void:
	for i in roads:
		dirty[world._chunk_of(i)] = true
		for d in 6:
			var nb := world.grid.nb[i * 6 + d]
			if nb >= 0:
				dirty[world._chunk_of(nb)] = true


func update(_dt: float) -> void:
	if world.grid == null:
		return
	var t0 := Time.get_ticks_usec()
	for cid in dirty.keys():
		_build(cid)
		dirty.erase(cid)
		if Time.get_ticks_usec() - t0 > 3000:
			break
	var g := world.grid
	var cx := cam.focus.x
	for c in chunks.values():
		var mid: float = float(c.x0)
		(c.inst as Node3D).position = Vector3(g.near_x(mid, cx) - mid, 0, 0)
	if works.mesh:
		var anchor: float = float(works.get_meta("x0", 0.0))
		works.position = Vector3(g.near_x(anchor, cx) - anchor, 0, 0)
	_update_traffic()


func _edge(i: int, d: int) -> int:
	return (world.road[i] >> (d * 4)) & 15


func _wet(i: int) -> bool:
	return i >= 0 and (world.is_river(i) or world.is_sea(i) or world.is_lake(i))


func _build(cid: int) -> void:
	var g := world.grid
	var cs := world.chunk
	var cx := cid % world.chunks_w
	var cy := cid / world.chunks_w
	var kit := MeshKit.new()
	var nb_bridges := 0
	for lr in cs:
		var r := cy * cs + lr
		if r >= g.h:
			break
		for lq in cs:
			var q := cx * cs + lq
			if q >= g.w:
				break
			var i := r * g.w + q
			if world.road[i] == 0 or not world.known[i]:
				continue
			var c2 := g.center(i)
			var edges := []
			for d in 6:
				var e := _edge(i, d)
				if e & 7: edges.append([d, e & 7, (e & 8) != 0])
			if edges.is_empty(): continue
			if _wet(i):
				for edge in edges:
					_bridge(kit, i, c2, c2 + g.dir_vec[edge[0]] * (SQRT3 * 0.5), int(edge[1]), bool(edge[2]), int(edge[0]))
					nb_bridges += 1
				continue
			_land_roads(kit, i, c2, edges)
	var rec: Dictionary = chunks.get(cid, {})
	if rec.is_empty():
		var mi := MeshInstance3D.new()
		mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		add_child(mi)
		rec = {"inst": mi, "x0": (cx + 0.5) * cs * SQRT3}
		chunks[cid] = rec
	rec.bridges = nb_bridges
	(rec.inst as MeshInstance3D).mesh = kit.commit() if not kit.is_empty() else null


## One land hex's roads: a smooth curve when exactly two edges of one class meet (a through
## road), otherwise spokes into a shared junction pad. Ends toward a bridge rise as approaches.
func _land_roads(kit: MeshKit, i: int, c2: Vector2, edges: Array) -> void:
	var g := world.grid
	var half := SQRT3 * 0.5
	if edges.size() == 2 and int(edges[0][1]) == int(edges[1][1]) and not bool(edges[0][2]) and not bool(edges[1][2]):
		var a: Vector2 = c2 + g.dir_vec[edges[0][0]] * half
		var b: Vector2 = c2 + g.dir_vec[edges[1][0]] * half
		var pts: Array[Vector2] = []
		for k in 11:
			var t := k / 10.0
			pts.append(a.lerp(c2, t).lerp(c2.lerp(b, t), t))   # quadratic curve through the centre's pull
		_path(kit, pts, int(edges[0][1]), [_approach(i, int(edges[0][0])), _approach(i, int(edges[1][0]))])
		return
	var widest := 0
	for edge in edges:
		var ty := int(edge[1])
		if ty != 4: widest = maxi(widest, ty)
		var end: Vector2 = c2 + g.dir_vec[edge[0]] * half
		var pts: Array[Vector2] = []
		var reach := 0.5 if bool(edge[2]) else 1.0      # a destroyed segment stops short in debris
		for k in 7: pts.append(c2.lerp(end, reach * k / 6.0))
		_path(kit, pts, ty, [NAN, NAN if bool(edge[2]) else _approach(i, int(edge[0]))])
		if bool(edge[2]): _debris(kit, pts[-1], end, ty)
	# junction pad (or a turning area at a dead end) so segments meet cleanly
	var y := world.ground_height(c2.x, c2.y) + LIFT - 0.004
	var ty_pad := widest if widest > 0 else 4
	kit.cylinder(MAT[ty_pad], Vector3(c2.x, y - 0.006, c2.y), WIDTH[ty_pad] * 0.62, 0.008, 12, _tone(ty_pad), WIDTH[ty_pad] * 0.62)


## Distance from a point to the drawn road centrelines of a hex minus half their width (the
## curve for through roads, otherwise the spokes), so vegetation clears exactly the corridor.
static func clearance(world: WorldState, tile: int, point: Vector2) -> float:
	var g := world.grid
	var c := g.center(tile)
	var local := Vector2(g.dx_wrap(c.x, point.x), point.y - c.y)
	var edges := []
	for d in 6:
		var e: int = (world.road[tile] >> (d * 4)) & 15
		if e & 7: edges.append([d, e & 7, (e & 8) != 0])
	var best := INF
	var half := SQRT3 * 0.5
	if edges.size() == 2 and int(edges[0][1]) == int(edges[1][1]) and not bool(edges[0][2]) and not bool(edges[1][2]):
		var a: Vector2 = g.dir_vec[edges[0][0]] * half; var b: Vector2 = g.dir_vec[edges[1][0]] * half
		var previous := a
		for k in range(1, 11):
			var t := k / 10.0
			var q := a.lerp(Vector2.ZERO, t).lerp(Vector2.ZERO.lerp(b, t), t)
			best = minf(best, local.distance_to(Geometry2D.get_closest_point_to_segment(local, previous, q)))
			previous = q
		return best - WIDTH[int(edges[0][1])] * 0.5
	for edge in edges:
		var end: Vector2 = g.dir_vec[edge[0]] * half
		best = minf(best, local.distance_to(Geometry2D.get_closest_point_to_segment(local, Vector2.ZERO, end)) - WIDTH[int(edge[1])] * 0.5)
	return best


## the deck height a road must climb to where it meets a bridge across edge d, or NAN on level land
func _approach(i: int, d: int) -> float:
	var nb := world.grid.nb[i * 6 + d]
	if not _wet(nb) or ((world.road[nb] >> (posmod(d + 3, 6) * 4)) & 7) == 0: return NAN
	return _deck(nb) * 0.5 + (world.tile_height(i) + 0.05) * 0.5


func _tone(ty: int) -> Color:
	return [Color.WHITE, Color(0.92, 0.84, 0.72), Color(0.92, 0.92, 0.92), Color(0.86, 0.86, 0.86), Color(0.9, 0.88, 0.84)][ty]


## Draw one road polyline (2D points) of class ty following the terrain. `ends` may give a fixed
## height for the first/last point (bridge approaches): the road grades up on an earth embankment.
func _path(kit: MeshKit, pts: Array[Vector2], ty: int, ends: Array = [NAN, NAN]) -> void:
	var w: float = WIDTH[ty]
	var p3: Array[Vector3] = []
	for k in pts.size():
		var y := world.ground_height(pts[k].x, pts[k].y) + LIFT
		var fixed: float = ends[0] if k == 0 else ends[1] if k == pts.size() - 1 else NAN
		# approaches ease up over the last third of the path
		if not is_nan(float(ends[0])) and k < pts.size() / 2:
			y = lerpf(float(ends[0]), y, smoothstep(0.0, 0.4, float(k) / (pts.size() - 1)))
		if not is_nan(float(ends[1])) and k >= pts.size() / 2:
			y = lerpf(float(ends[1]), y, smoothstep(0.0, 0.4, 1.0 - float(k) / (pts.size() - 1)))
		if not is_nan(fixed): y = fixed
		p3.append(Vector3(pts[k].x, y, pts[k].y))
	if not is_nan(float(ends[0])) or not is_nan(float(ends[1])): _embankment(kit, p3, w + 0.05)
	kit.set_frame(Vector3.ZERO, 0.0)
	match ty:
		1:
			_ribbon(kit, p3, w, 0.0, "soil", Color(0.92, 0.84, 0.72))
			for s in [-0.035, 0.035]: _ribbon(kit, p3, 0.016, s, "mud", Color(0.95, 0.9, 0.85), 0.002)
		2:
			_ribbon(kit, p3, w + 0.035, 0.0, "gravel", Color(0.9, 0.88, 0.84), -0.002)
			_ribbon(kit, p3, w, 0.0, "asphalt", Color(0.92, 0.92, 0.92))
			for s in [-1.0, 1.0]: _ribbon(kit, p3, 0.006, s * (w * 0.5 - 0.014), "concrete", Color(1.5, 1.5, 1.42), 0.002)
			_ribbon(kit, p3, 0.006, 0.0, "concrete", Color(1.45, 1.38, 1.0), 0.002, true)
		3:
			_ribbon(kit, p3, w + 0.045, 0.0, "gravel", Color(0.88, 0.86, 0.82), -0.002)
			_ribbon(kit, p3, w, 0.0, "asphalt", Color(0.86, 0.86, 0.86))
			_ribbon(kit, p3, 0.022, 0.0, "concrete", Color(1.15, 1.13, 1.08), 0.008)     # raised median
			for s in [-1.0, 1.0]:
				_ribbon(kit, p3, 0.006, s * (w * 0.5 - 0.014), "concrete", Color(1.5, 1.5, 1.42), 0.002)
				_ribbon(kit, p3, 0.005, s * w * 0.25, "concrete", Color(1.5, 1.5, 1.42), 0.002, true)
		4:
			_ribbon(kit, p3, w, 0.0, "ballast", Color(0.86, 0.84, 0.8))
			_sleepers(kit, p3)
			for s in [-0.03, 0.03]: _ribbon(kit, p3, 0.008, s, "steel", Color(1.1, 1.08, 1.05), 0.014)


## a strip along a 3D polyline with mitred sides, offset sideways by `offset`
func _ribbon(kit: MeshKit, p: Array[Vector3], width: float, offset: float, mat: String, color: Color, lift := 0.0, dashed := false) -> void:
	if p.size() < 2: return
	var sides: Array[Vector3] = []
	for k in p.size():
		var a: Vector3 = p[maxi(k - 1, 0)]; var b: Vector3 = p[mini(k + 1, p.size() - 1)]
		var t := Vector3(b.x - a.x, 0, b.z - a.z).normalized()
		sides.append(t.cross(Vector3.UP))
	for k in p.size() - 1:
		if dashed and k % 2 == 1: continue
		var l0: Vector3 = p[k] + sides[k] * (offset - width * 0.5) + Vector3(0, lift, 0)
		var r0: Vector3 = p[k] + sides[k] * (offset + width * 0.5) + Vector3(0, lift, 0)
		var l1: Vector3 = p[k + 1] + sides[k + 1] * (offset - width * 0.5) + Vector3(0, lift, 0)
		var r1: Vector3 = p[k + 1] + sides[k + 1] * (offset + width * 0.5) + Vector3(0, lift, 0)
		kit.quad(mat, l0, r0, r1, l1, color, Vector3.UP)


func _sleepers(kit: MeshKit, p: Array[Vector3]) -> void:
	var carry := 0.0
	for k in p.size() - 1:
		var a: Vector3 = p[k]; var b: Vector3 = p[k + 1]
		var length := Vector2(b.x - a.x, b.z - a.z).length()
		var yaw := atan2(-(b.z - a.z), b.x - a.x)
		var s := carry
		while s < length:
			var q := a.lerp(b, s / maxf(length, 0.0001))
			kit.box("timber", q + Vector3(0, 0.002, 0), Vector3(0.016, 0.008, 0.1), Color(0.58, 0.48, 0.38), yaw)
			s += 0.045
		carry = s - length


## earth fill under a raised approach, down to the real ground on both sides
func _embankment(kit: MeshKit, p: Array[Vector3], width: float) -> void:
	kit.set_frame(Vector3.ZERO, 0.0)
	for k in p.size() - 1:
		var a: Vector3 = p[k]; var b: Vector3 = p[k + 1]
		var t := Vector3(b.x - a.x, 0, b.z - a.z).normalized(); var side := t.cross(Vector3.UP) * (width * 0.5)
		for s in [-1.0, 1.0]:
			var top_a: Vector3 = a + side * s; var top_b: Vector3 = b + side * s
			var foot_a: Vector3 = top_a + side * s * 0.6; var foot_b: Vector3 = top_b + side * s * 0.6
			foot_a.y = world.ground_height(foot_a.x, foot_a.z) - 0.01; foot_b.y = world.ground_height(foot_b.x, foot_b.z) - 0.01
			if top_a.y - foot_a.y < 0.02 and top_b.y - foot_b.y < 0.02: continue
			kit.quad("soil", foot_a, foot_b, top_b, top_a, Color(0.8, 0.74, 0.62), side * s + Vector3.UP * 0.5)


func _debris(kit: MeshKit, start: Vector2, finish: Vector2, ty: int) -> void:
	kit.set_frame(Vector3.ZERO, 0.0)
	var rng := RandomNumberGenerator.new(); rng.seed = int(start.x * 1000.0) ^ int(start.y * 777.0)
	for k in 5:
		var p := start.lerp(finish, rng.randf_range(0.0, 0.6)) + Vector2(rng.randf_range(-0.05, 0.05), rng.randf_range(-0.05, 0.05))
		var mat := "asphalt" if ty in [2, 3] else "timber" if ty == 4 else "soil"
		kit.box(mat if k % 2 == 0 else "rubble", Vector3(p.x, world.ground_height(p.x, p.y), p.y), Vector3(0.05, 0.02 + rng.randf() * 0.02, 0.04), Color(0.7, 0.66, 0.6), rng.randf() * TAU)
	var c := start.lerp(finish, 0.3)
	kit.cylinder("char", Vector3(c.x, world.ground_height(c.x, c.y) + 0.003, c.y), 0.07, 0.002, 9, Color(0.5, 0.48, 0.46), 0.07)


## deck height of a bridge over wet hex i: clear of the water, at least level with its banks
func _deck(i: int) -> float:
	var wl := world.water_level(i)
	var base := world.height[i] + 0.05 if wl < -1e6 else wl
	var bank := base
	for d in 6:
		var nb := world.grid.nb[i * 6 + d]
		if nb >= 0 and world.known[nb] and not _wet(nb): bank = maxf(bank, world.tile_height(nb))
	return maxf(base + 0.16, minf(bank, base + 0.4) + 0.06)


## Half a bridge from wet hex i's centre to its edge midpoint toward direction d. Spans between two
## wet hexes meet at their mean deck height; spans onto a bank meet the graded approach.
func _bridge(kit: MeshKit, i: int, a: Vector2, b: Vector2, ty: int, broken: bool, d: int) -> void:
	var nb := world.grid.nb[i * 6 + d]
	var deck := _deck(i)
	var end := (deck + _deck(nb)) * 0.5 if _wet(nb) else deck * 0.5 + (world.tile_height(nb) + 0.05) * 0.5
	var key := "%d:%d" % [mini(i, nb), maxi(i, nb)]
	var condition := int(world.bridge_condition.get(key, 0 if broken else 100))
	var damaged := condition < 50 and not broken
	var pa := Vector3(a.x, deck, a.y)
	var pb := Vector3(b.x, end, b.y)
	if broken: pb = pa.lerp(pb, 0.45)
	var dir := Vector3(pb.x - pa.x, 0, pb.z - pa.z).normalized()
	var side := dir.cross(Vector3.UP)
	var yaw := atan2(-dir.z, dir.x)
	var tint := Color(0.72, 0.66, 0.6) if damaged else Color.WHITE
	var bed := world.height[i] - 0.1
	kit.set_frame(Vector3.ZERO, 0.0)
	match ty:
		1:   # timber trestle: plank deck, log trestle bents with cross bracing, post-and-rail sides
			var w := 0.2
			_slab(kit, pa, pb, w, 0.018, "timber", Color(0.86, 0.74, 0.58) * tint)
			for k in 3:
				var q: Vector3 = pa.lerp(pb, k / 2.0) if k < 2 or not broken else pa.lerp(pb, 0.9)
				for s in [-0.4, 0.4]:
					kit.cylinder("bark", Vector3(q.x, bed, q.z) + side * w * s, 0.012, q.y - bed, 6, Color(0.7, 0.6, 0.48))
				kit.box("timber", Vector3(q.x, (q.y + bed) * 0.5, q.z), Vector3(0.014, 0.012, w * 0.9), Color(0.7, 0.6, 0.48), yaw + 0.5)
			for s in [-1.0, 1.0]:
				_rail(kit, pa, pb, side * (w * 0.47 * s), 0.05, "timber", Color(0.78, 0.66, 0.5) * tint, 4)
		2, 3:   # reinforced concrete: thick deck slab, asphalt, parapets, round piers with caps
			var w: float = WIDTH[ty] + 0.06
			_slab(kit, pa, pb, w, 0.035, "concrete", Color(0.92, 0.92, 0.9) * tint)
			kit.strip("asphalt", pa + Vector3(0, 0.002, 0), pb + Vector3(0, 0.002, 0), w * 0.82, Color(0.9, 0.9, 0.9) * tint)
			for s in [-1.0, 1.0]:
				var gap: bool = damaged and s > 0
				var parapet_end := pa.lerp(pb, 0.5) if gap else pb
				_wall(kit, pa + side * (w * 0.47 * s), parapet_end + side * (w * 0.47 * s), 0.035, 0.014, Color(0.9, 0.9, 0.88) * tint)
			kit.cylinder("concrete", Vector3(pa.x, bed, pa.z), 0.035, deck - 0.035 - bed, 10, Color(0.86, 0.86, 0.84) * tint)
			kit.box("concrete", Vector3(pa.x, deck - 0.05, pa.z), Vector3(0.06, 0.016, w * 0.9), Color(0.86, 0.86, 0.84) * tint, yaw)
		4:   # rail: steel plate girders with stiffeners, sleepers and rails on the deck
			var w := 0.17
			_slab(kit, pa, pb, w, 0.02, "steel", Color(0.52, 0.5, 0.48) * tint)
			for s in [-1.0, 1.0]:
				_wall(kit, pa + side * (w * 0.5 * s), pb + side * (w * 0.5 * s), 0.06, 0.01, Color(0.46, 0.42, 0.4) * tint, -0.03, "steel")
			var p3: Array[Vector3] = [pa + Vector3(0, 0.002, 0), pb + Vector3(0, 0.002, 0)]
			_sleepers(kit, p3)
			for s in [-0.03, 0.03]: kit.strip("steel", pa + side * s + Vector3(0, 0.014, 0), pb + side * s + Vector3(0, 0.014, 0), 0.008, Color(1.1, 1.08, 1.05))
			kit.box("concrete", Vector3(pa.x, bed, pa.z), Vector3(0.05, deck - 0.04 - bed, w * 1.05), Color(0.84, 0.82, 0.8), yaw)
	if broken:
		# the collapsed span: a tilted deck section dropping into the water, twisted members
		var fallen := pb.lerp(Vector3(b.x, end, b.y), 0.5)
		var water := world.water_level(i) if world.water_level(i) > -1e6 else world.height[i]
		kit.box("concrete" if ty in [2, 3] else "timber" if ty == 1 else "steel", Vector3(fallen.x, water - 0.03, fallen.z), Vector3(0.22, 0.03, 0.14), Color(0.6, 0.58, 0.55), yaw + 0.35)
		kit.box("steel", pb + Vector3(0, -0.02, 0), Vector3(0.06, 0.006, 0.006), Color(0.45, 0.38, 0.33), yaw - 0.6)
	elif damaged:
		kit.cylinder("char", Vector3(pa.x, deck + 0.004, pa.z).lerp(pb, 0.6), 0.04, 0.002, 8, Color(0.4, 0.38, 0.36), 0.04)


## a deck slab with visible thickness between two points (top surface plus both side faces)
func _slab(kit: MeshKit, a: Vector3, b: Vector3, width: float, thickness: float, mat: String, color: Color) -> void:
	var dir := Vector3(b.x - a.x, 0, b.z - a.z).normalized()
	var side := dir.cross(Vector3.UP) * (width * 0.5)
	var down := Vector3(0, -thickness, 0)
	kit.quad(mat, a - side, a + side, b + side, b - side, color, Vector3.UP)
	kit.quad(mat, a + side, b + side, b + side + down, a + side + down, color * 0.85, side)
	kit.quad(mat, a - side, b - side, b - side + down, a - side + down, color * 0.85, -side)
	kit.quad(mat, a - side + down, a + side + down, b + side + down, b - side + down, color * 0.7, Vector3.DOWN)


## a parapet / girder wall from a to b: height above the deck, thickness, optional drop below it
func _wall(kit: MeshKit, a: Vector3, b: Vector3, height: float, thickness: float, color: Color, below := 0.0, mat := "concrete") -> void:
	var dir := Vector3(b.x - a.x, 0, b.z - a.z).normalized()
	var side := dir.cross(Vector3.UP) * (thickness * 0.5)
	var up := Vector3(0, height, 0); var lo := Vector3(0, below, 0)
	for s in [-1.0, 1.0]:
		kit.quad(mat, a + side * s + lo, b + side * s + lo, b + side * s + up, a + side * s + up, color, side * s)
	kit.quad(mat, a - side + up, a + side + up, b + side + up, b - side + up, color * 1.05, Vector3.UP)


## a post-and-rail fence along a deck edge
func _rail(kit: MeshKit, a: Vector3, b: Vector3, offset: Vector3, height: float, mat: String, color: Color, posts: int) -> void:
	for k in posts + 1:
		var q := a.lerp(b, float(k) / posts) + offset
		kit.box(mat, q, Vector3(0.01, height, 0.01), color)
	kit.strip(mat, a + offset + Vector3(0, height, 0), b + offset + Vector3(0, height, 0), 0.01, color)


## Road works under way (own projects only, from the server's project progress): survey stakes,
## graded earth, then base course and finally surfacing advance along the real segment; bridge
## segments raise piers and falsework first. Stalled projects show no machinery.
func _build_works() -> void:
	var kit := MeshKit.new()
	var g := world.grid
	if g == null: return
	var anchor := -1.0
	for record in world.road_works:
		var a := int(record[0]); var b := int(record[1]); var progress := float(record[2]) / 100.0
		if a < 0 or b < 0 or a >= g.n or b >= g.n: continue
		var pa := g.center(a); var pb := g.center(b)
		if anchor < 0.0: anchor = pa.x
		pa.x = anchor + g.dx_wrap(anchor, pa.x); pb.x = pa.x + g.dx_wrap(pa.x, pb.x)
		var bridge := bool(record[3]) or _wet(a) or _wet(b)
		var dir := (pb - pa).normalized(); var side := Vector2(-dir.y, dir.x)
		kit.set_frame(Vector3.ZERO, 0.0)
		for k in 5:   # survey stakes with flagging on both sides of the corridor
			for s in [-1.0, 1.0]:
				var q: Vector2 = pa.lerp(pb, k / 4.0) + side * 0.13 * s
				kit.box("timber", Vector3(q.x, world.ground_height(q.x, q.y), q.y), Vector3(0.008, 0.06, 0.008), Color(0.85, 0.75, 0.6))
				kit.box("canvas", Vector3(q.x, world.ground_height(q.x, q.y) + 0.055, q.y), Vector3(0.012, 0.008, 0.004), Color(1.0, 0.45, 0.2))
		if bridge:
			var mid := pa.lerp(pb, 0.5); var wet_tile := a if _wet(a) else b
			var top := _deck(wet_tile) if _wet(wet_tile) else world.tile_height(wet_tile) + 0.2
			var bed := world.tile_height(wet_tile) - 0.1
			kit.box("concrete", Vector3(mid.x, bed, mid.y), Vector3(0.05, (top - bed) * clampf(progress * 1.6, 0.1, 1.0), 0.12), Color(0.86, 0.86, 0.84))
			if progress > 0.5:
				_slab(kit, Vector3(pa.x, top, pa.y), Vector3(pa.x, top, pa.y).lerp(Vector3(pb.x, top, pb.y), (progress - 0.5) * 2.0), 0.18, 0.02, "concrete", Color(0.9, 0.9, 0.88))
			for k in 3:   # falsework scaffold
				var q := pa.lerp(pb, 0.3 + k * 0.2)
				kit.box("steel", Vector3(q.x, bed, q.y), Vector3(0.008, top - bed, 0.008), Color(0.95, 0.72, 0.2))
			continue
		var graded := pa.lerp(pb, clampf(progress * 1.4, 0.0, 1.0))
		var based := pa.lerp(pb, clampf((progress - 0.35) * 1.6, 0.0, 1.0))
		var surfaced := pa.lerp(pb, clampf((progress - 0.7) * 3.3, 0.0, 1.0))
		for stage in [[graded, "soil", Color(0.78, 0.68, 0.52), 0.2], [based, "gravel", Color(0.92, 0.9, 0.86), 0.17], [surfaced, "asphalt", Color(0.92, 0.92, 0.92), 0.15]]:
			var reach: Vector2 = stage[0]
			if reach.distance_to(pa) < 0.02: continue
			var pts: Array[Vector3] = []
			for k in 5:
				var q := pa.lerp(reach, k / 4.0)
				pts.append(Vector3(q.x, world.ground_height(q.x, q.y) + LIFT + 0.002, q.y))
			_ribbon(kit, pts, float(stage[3]), 0.0, str(stage[1]), stage[2])
		# a road roller working at the front of the surface
		var front := based if based.distance_to(pa) > 0.02 else graded
		var y := world.ground_height(front.x, front.y) + LIFT
		var yaw := atan2(-dir.y, dir.x)
		kit.box("painted_metal", Vector3(front.x, y + 0.012, front.y), Vector3(0.05, 0.03, 0.035), Color(0.95, 0.72, 0.2), yaw)
		kit.box("steel", Vector3(front.x, y, front.y) + Vector3(dir.x, 0, dir.y) * 0.035, Vector3(0.02, 0.022, 0.04), Color(0.4, 0.4, 0.4), yaw)
	works.set_meta("x0", anchor)
	works.mesh = kit.commit() if not kit.is_empty() else null


## Preview one half of a planned segment with the same construction as the finished road/bridge.
func preview_half(kit: MeshKit, tile: int, toward: int, ty: int) -> void:
	var g := world.grid
	var d := -1
	for k in 6:
		if g.nb[tile * 6 + k] == toward: d = k
	if d < 0: return
	var c2 := g.center(tile)
	c2.x = g.near_x(c2.x, cam.focus.x)
	var edge := c2 + g.dir_vec[d] * (SQRT3 * 0.5)
	if _wet(tile): _bridge(kit, tile, c2, edge, ty, false, d); return
	var pts: Array[Vector2] = []
	for k in 7: pts.append(c2.lerp(edge, k / 6.0))
	_path(kit, pts, ty, [NAN, _approach(tile, d)])


func _edge_broken(a: int, b: int) -> bool:
	for d in 6:
		if world.grid.nb[a * 6 + d] == b: return (_edge(a, d) & 8) != 0 or (_edge(a, d) & 7) == 0
	return true


func _update_traffic() -> void:
	var mm := trucks.multimesh
	var wm := wagons.multimesh
	var g := world.grid
	var now := Time.get_ticks_msec() / 1000.0
	var cx := cam.focus.x
	var n := 0
	var w := 0
	for e in world.traffic:
		var a := int(e[0])
		var b := int(e[1])
		if a < 0 or b < 0 or a >= g.n or b >= g.n or _edge_broken(a, b): continue   # never across a destroyed span
		var lvl := mini(int(e[2]), 3)
		var rail := false
		for d in 6:
			if g.nb[a * 6 + d] == b: rail = (_edge(a, d) & 7) == 4
		var ca := g.center(a)
		var cb := g.center(b)
		var dx := g.dx_wrap(ca.x, cb.x)
		var dz := cb.y - ca.y
		if rail:
			# one freight train of a few wagons per busy rail edge, shuttling along it
			var f := fposmod(now * 0.12 + float(a % 89) * 0.07, 2.0)
			var u0 := 2.0 - f if f > 1.0 else f
			for k in mini(3 + lvl, 6):
				if w >= MAX_WAGONS: break
				var u := clampf(u0 - k * 0.07 * (1.0 if f <= 1.0 else -1.0), 0.0, 1.0)
				var x := g.near_x(ca.x + dx * u, cx); var z := ca.y + dz * u
				var y := world.ground_height(x, z) + LIFT + 0.016
				wm.set_instance_transform(w, Transform3D(Basis(Vector3.UP, atan2(-dz, dx)), Vector3(x, y, z)))
				wm.set_instance_color(w, Color(1, 1, 1).darkened(float(posmod(a * 7 + k, 4)) * 0.08))
				w += 1
			continue
		for k in lvl:
			if n >= MAX_TRUCKS:
				break
			var f := fposmod(now * 0.35 + k / float(lvl) + float(a % 97) * 0.13, 2.0)
			var back := f > 1.0
			var u := 2.0 - f if back else f
			var x := ca.x + dx * u
			var z := ca.y + dz * u
			var xx := g.near_x(x, cx)
			var side := Vector2(-dz, dx).normalized() * (0.035 if back else -0.035)
			var y := world.ground_height(xx, z) + LIFT + 0.008
			var yaw := atan2(dz, -dx) if back else atan2(-dz, dx)
			mm.set_instance_transform(n, Transform3D(Basis(Vector3.UP, yaw), Vector3(xx + side.x, y, z + side.y)))
			mm.set_instance_color(n, Color(1, 1, 1))
			n += 1
	mm.visible_instance_count = n
	wm.visible_instance_count = w
