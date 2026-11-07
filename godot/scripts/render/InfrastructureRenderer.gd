class_name InfrastructureRenderer
extends Node3D
## Roads, railways and bridges from the tile records (each hex carries its six road edges), draped
## over the terrain in one mesh per chunk; where a road crosses a river or water it becomes a bridge
## deck on piers. Road traffic the server reports ([a, b, level] per busy edge) is drawn as trucks
## running along the roads: the economy's activity made visible.

const SQRT3 := HexGrid.SQRT3
const WIDTH := [0.0, 0.16, 0.19, 0.26, 0.15]
const MAT := ["", "soil", "asphalt", "asphalt", "ballast"]
const MAX_TRUCKS := 400

var world: WorldState
var cam: CameraController
var chunks := {}        # chunk id -> { inst: MeshInstance3D, x0: float }
var dirty := {}
var trucks: MultiMeshInstance3D


func setup(w: WorldState, c: CameraController) -> void:
	world = w
	cam = c
	world.tiles_changed.connect(_on_tiles)
	world.geo_changed.connect(_on_geo)
	world.welcomed.connect(_clear)
	world.reset.connect(_clear)
	trucks = MultiMeshInstance3D.new()
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.use_colors = true
	var k := MeshKit.new()
	k.box("steel", Vector3(0.025, 0.0, 0), Vector3(0.05, 0.05, 0.05), Color(0.8, 0.8, 0.82))
	k.box("canvas", Vector3(-0.03, 0.0, 0), Vector3(0.07, 0.06, 0.055))
	mm.mesh = k.commit()
	mm.instance_count = MAX_TRUCKS
	mm.visible_instance_count = 0
	trucks.multimesh = mm
	add_child(trucks)


func _clear() -> void:
	for c in chunks.values():
		(c.inst as Node).queue_free()
	chunks.clear()
	dirty.clear()


func _on_geo(list: PackedInt32Array) -> void:
	for cid in list:
		dirty[cid] = true


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
	_update_trucks()


func _edge(i: int, d: int) -> int:
	return (world.road[i] >> (d * 4)) & 15


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
			var wet := world.is_river(i) or world.is_sea(i) or world.is_lake(i)
			var types := 0
			for d in 6:
				var e := _edge(i, d)
				var ty := e & 7
				if ty == 0:
					continue
				types = maxi(types, ty)
				var broken := (e & 8) != 0
				var m := c2 + g.dir_vec[d] * (SQRT3 * 0.5)
				if wet:
					_bridge(kit, i, c2, m, ty, broken)
					nb_bridges += 1
				else:
					_road(kit, c2, m, ty, broken)
			if types > 0 and not wet:
				# a junction pad so segments meet cleanly
				var y := world.ground_height(c2.x, c2.y) + 0.025
				kit.cylinder(MAT[types], Vector3(c2.x, y - 0.01, c2.y), WIDTH[types] * 0.55, 0.01, 8)
	var rec: Dictionary = chunks.get(cid, {})
	if rec.is_empty():
		var mi := MeshInstance3D.new()
		mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		add_child(mi)
		rec = {"inst": mi, "x0": (cx + 0.5) * cs * SQRT3}
		chunks[cid] = rec
	rec.bridges = nb_bridges
	(rec.inst as MeshInstance3D).mesh = kit.commit() if not kit.is_empty() else null


## a road from the hex centre to the edge midpoint, in three draped pieces
func _road(kit: MeshKit, a: Vector2, b: Vector2, ty: int, broken: bool) -> void:
	var w: float = WIDTH[ty]
	var col := Color(0.55, 0.5, 0.45) if broken else Color(1, 1, 1)
	var prev := Vector3(a.x, world.ground_height(a.x, a.y) + 0.025, a.y)
	for k in range(1, 4):
		var p2 := a.lerp(b, k / 3.0)
		var p := Vector3(p2.x, world.ground_height(p2.x, p2.y) + 0.025, p2.y)
		if ty == 4:
			kit.strip("ballast", prev, p, w, col)
			var side := Vector3(p.x - prev.x, 0, p.z - prev.z).normalized().cross(Vector3.UP)
			for s in [-0.035, 0.035]:
				kit.strip("steel", prev + side * s + Vector3(0, 0.008, 0), p + side * s + Vector3(0, 0.008, 0), 0.012, col)
		else:
			kit.strip(MAT[ty], prev, p, w, col)
			if ty >= 2:
				kit.strip("concrete", prev + Vector3(0, 0.002, 0), p + Vector3(0, 0.002, 0), 0.008, Color(1.3, 1.3, 1.2))
		prev = p


## a bridge deck over water or a river: level, on piers, with parapets
func _bridge(kit: MeshKit, i: int, a: Vector2, b: Vector2, ty: int, broken: bool) -> void:
	var wl := world.water_level(i)
	var base := world.height[i] + 0.05 if wl < -1e6 else wl
	var nb_tile := world.grid.tile_at(b.x + (b.x - a.x) * 0.1, b.y + (b.y - a.y) * 0.1)
	var bank := world.tile_height(nb_tile) if nb_tile >= 0 else base
	var deck := maxf(base + 0.16, maxf(bank, world.height[i]) + 0.06)
	var w: float = WIDTH[ty] + 0.04
	var pa := Vector3(a.x, deck, a.y)
	var pb := Vector3(b.x, maxf(deck * 0.5 + (bank + 0.03) * 0.5, base + 0.1), b.y)
	if broken:
		pb = pa.lerp(pb, 0.45)
	kit.strip("concrete" if ty >= 2 else "timber", pa, pb, w, Color(1, 1, 1))
	kit.strip("asphalt" if ty >= 2 and ty != 4 else "timber", pa + Vector3(0, 0.004, 0), pb + Vector3(0, 0.004, 0), w * 0.8)
	var dir := Vector3(pb.x - pa.x, 0, pb.z - pa.z).normalized()
	var side := dir.cross(Vector3.UP) * (w * 0.5)
	for s in [-1.0, 1.0]:
		kit.strip("steel", pa + side * s + Vector3(0, 0.03, 0), pb + side * s + Vector3(0, 0.03, 0), 0.01, Color(0.85, 0.85, 0.85))
	# piers down to the riverbed
	var pier_top := deck - 0.01
	var bed := world.height[i] - 0.1
	kit.box("concrete", Vector3(a.x, bed, a.y), Vector3(0.05, pier_top - bed, w * 0.9), Color(0.9, 0.9, 0.88), atan2(-dir.z, dir.x))


func _update_trucks() -> void:
	var mm := trucks.multimesh
	var g := world.grid
	var now := Time.get_ticks_msec() / 1000.0
	var cx := cam.focus.x
	var n := 0
	for e in world.traffic:
		var a := int(e[0])
		var b := int(e[1])
		var lvl := mini(int(e[2]), 3)
		var ca := g.center(a)
		var cb := g.center(b)
		var dx := g.dx_wrap(ca.x, cb.x)
		var dz := cb.y - ca.y
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
			var y := world.ground_height(xx, z) + 0.035
			var yaw := atan2(dz, -dx) if back else atan2(-dz, dx)
			mm.set_instance_transform(n, Transform3D(Basis(Vector3.UP, yaw), Vector3(xx + side.x, y, z + side.y)))
			mm.set_instance_color(n, Color(1, 1, 1))
			n += 1
	mm.visible_instance_count = n
