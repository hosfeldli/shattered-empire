class_name CityStreets
extends Node3D
## The settlement's street network. Every urban hex (the server's urban footprint, plus hexes
## holding homes, markets, campuses or the hub) is a city block; streets run along the hex edges
## between neighbouring blocks, so they meet at the block corners and form one continuous network
## that grows as the city grows. Street class follows the city's tier and distance to the hub:
## lanes in a town, kerbed streets with raised sidewalks in a city, avenues with a planted median
## around the centre of a metropolis. The outer edge of the built-up area gets a lighter ring lane.
## Urban blocks without a building become a park, a plaza or a parking court. Purely presentation:
## real roads stay the infrastructure layer's; these never grant a route or a crossing.

const SQRT3 := HexGrid.SQRT3
const URBAN_TYPES := ["house", "market", "academy", "university", "town"]
const SAMPLES := 8

var world: WorldState
var cam: CameraController
var composition: WorldCompositionSystem
var settlements: SettlementRenderer
var chunks := {}         # chunk id -> { inst, x0, sig }
var dirty := {}
var urban_blocks := {}   # tile -> owner of the block (for the current version)
var block_version := -1
var budget_us := 2500


func setup(w: WorldState, c: CameraController, shared: WorldCompositionSystem, s: SettlementRenderer) -> void:
	world = w; cam = c; composition = shared; settlements = s
	world.welcomed.connect(_clear); world.reset.connect(_clear)
	world.geo_changed.connect(func(list: PackedInt32Array): for cid in list: dirty[cid] = true)


func _clear() -> void:
	for rec in chunks.values(): (rec.inst as Node).queue_free()
	chunks.clear(); dirty.clear(); urban_blocks.clear(); block_version = -1


func is_block(tile: int) -> bool:
	return urban_blocks.has(tile)


## Recompute which hexes are city blocks; chunks whose blocks changed are rebuilt.
func _refresh_blocks() -> void:
	var next := {}
	for b in world.buildings.values():
		if str(b.ty) in URBAN_TYPES and int(b.get("d", 0)) == 1 and str(b.get("st", "")) != "ruined":
			next[int(b.t)] = int(b.get("o", -1))
	if world.grid and world.urban_bits.size() * 8 >= world.grid.n:
		for byte in world.urban_bits.size():
			var bits := int(world.urban_bits[byte])
			if bits == 0: continue
			for bit in 8:
				if bits & (1 << bit) == 0: continue
				var tile := byte * 8 + bit
				if tile < world.grid.n and world.known[tile] and not next.has(tile) and not _wet(tile): next[tile] = int(world.tile_owner[tile]) if tile < world.tile_owner.size() else -1
	var changed := {}
	for tile in next:
		if not urban_blocks.has(tile) or urban_blocks[tile] != next[tile]: changed[tile] = true
	for tile in urban_blocks:
		if not next.has(tile): changed[tile] = true
	urban_blocks = next
	for tile in changed:
		dirty[world._chunk_of(int(tile))] = true
		for d in 6:
			var nb := world.grid.nb[int(tile) * 6 + d]
			if nb >= 0: dirty[world._chunk_of(nb)] = true


func _wet(t: int) -> bool:
	return world.is_sea(t) or world.is_lake(t) or world.is_river(t)


func update(_dt: float) -> void:
	if world.grid == null: return
	if block_version != world.buildings_version:
		block_version = world.buildings_version
		_refresh_blocks()
	var t0 := Time.get_ticks_usec()
	for cid in dirty.keys():
		_build(int(cid)); dirty.erase(cid)
		if Time.get_ticks_usec() - t0 > budget_us: break
	var g := world.grid
	for rec in chunks.values():
		var x0: float = float(rec.x0)
		(rec.inst as Node3D).position = Vector3(g.near_x(x0, cam.focus.x) - x0, 0, 0)


## the class of the street on an edge: [width, sidewalk, median] by tier and distance to the hub
func _street_class(tile: int, other: int) -> Array:
	var best := {}; var best_d := 99
	for city in world.cities.values():
		var d := world.grid.dist(tile, int(city.t))
		if d < best_d: best_d = d; best = city
	var tier := int(best.get("ti", 0))
	var core: bool = best_d <= 1 or world.grid.dist(other, int(best.get("t", -1))) <= 1
	if tier >= 2 and core: return [.12, .03, true]
	if tier >= 1: return [.085, .026, false]
	return [.065, 0.0, false]


func _build(cid: int) -> void:
	var g := world.grid
	var cs := world.chunk
	var cx := cid % world.chunks_w
	var cy := cid / world.chunks_w
	var kit := MeshKit.new()
	var corners := {}
	for lr in cs:
		var r := cy * cs + lr
		if r >= g.h: break
		for lq in cs:
			var q := cx * cs + lq
			if q >= g.w: break
			var t := r * g.w + q
			if not urban_blocks.has(t) or not world.known[t]: continue
			var c := g.center(t)
			# each shared edge is drawn once (directions 0, 4, 5); ring lanes on every outer edge
			for d in 6:
				var nb := g.nb[t * 6 + d]
				var inner := nb >= 0 and urban_blocks.has(nb)
				if inner and not d in [0, 4, 5]: continue
				if nb >= 0 and _wet(nb): continue
				# outer edges only carry an access lane where a building lies beyond (no city outline)
				if not inner and (nb < 0 or settlements == null or settlements.building_at(nb) < 0): continue
				var k := posmod(1 - d, 6)
				var a: Vector2 = _corner(c + g.corners[k]); var b: Vector2 = _corner(c + g.corners[(k + 1) % 6])
				if composition and composition.sites.crosses_water(t, a, b, .08): continue
				var style: Array = _street_class(t, nb) if inner else [.05, 0.0, false]
				_street(kit, a, b, style, inner, mini(t, nb) * 7 + maxi(t, nb))
				for p in [a, b]:
					var key := Vector2i(roundi(p.x * 100), roundi(p.y * 100))
					corners[key] = maxf(float(corners.get(key, 0.0)), float(style[0]))
			if settlements and settlements.building_at(t) < 0:
				_open_block(kit, t, c)
	# junctions where streets meet at block corners
	for key in corners:
		var p := Vector2(key.x / 100.0, key.y / 100.0)
		var w: float = corners[key]
		kit.set_frame(Vector3.ZERO, 0.0)
		kit.cylinder("asphalt", Vector3(p.x, world.ground_height(p.x, p.y) + .012, p.y), w * .62, .004, 10, Color(.9, .9, .9), w * .62)
	var rec: Dictionary = chunks.get(cid, {})
	if rec.is_empty():
		var mi := MeshInstance3D.new(); mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF; add_child(mi)
		rec = {"inst": mi, "x0": (cx + 0.5) * cs * SQRT3}
		chunks[cid] = rec
	(rec.inst as MeshInstance3D).mesh = kit.commit() if not kit.is_empty() else null


## a street along a block edge: carriageway, kerbs and raised sidewalks that follow the ground,
## optional planted median, and a streetlight on alternate edges
## A block corner moved by a small stable offset (the same for every hex sharing it), so streets
## stay joined but the plan loses its rigid hexagonal look.
func _corner(p: Vector2) -> Vector2:
	var key := Vector2i(roundi(p.x * 20.0), roundi(p.y * 20.0))
	var h := posmod(key.x * 73856093 ^ key.y * 19349663 ^ world.world_seed, 10007)
	var angle := float(h) / 10007.0 * TAU
	return p + Vector2(cos(angle), sin(angle)) * (.08 + float(h % 7) * .01)


func _street(kit: MeshKit, a: Vector2, b: Vector2, style: Array, inner: bool, seed: int) -> void:
	var width: float = style[0]; var walk: float = style[1]; var median: bool = style[2]
	var along := (b - a).normalized(); var side := Vector2(-along.y, along.x)
	# a gentle, stable bend along the street (zero at both corners, so junctions still meet)
	var bend := (float(posmod(seed * 2654435761, 1000)) / 1000.0 - .5) * .2
	var pts: Array[Vector3] = []
	for k in SAMPLES + 1:
		var f := float(k) / SAMPLES
		var p := a.lerp(b, f) + side * bend * sin(f * PI)
		pts.append(Vector3(p.x, world.ground_height(p.x, p.y) + .012, p.y))
	kit.set_frame(Vector3.ZERO, 0.0)
	_ribbon(kit, pts, side, 0.0, width, "asphalt" if inner else "gravel", Color(.9, .9, .9) if inner else Color(.95, .92, .86), 0.0)
	if walk > 0.0:
		for s in [-1.0, 1.0]:
			# kerb: a thin raised edge, then the sidewalk slab on top of it (never sunk into the ground)
			_ribbon(kit, pts, side, s * (width * .5 + .004), .008, "concrete", Color(1.15, 1.13, 1.08), .006, true)
			_ribbon(kit, pts, side, s * (width * .5 + .008 + walk * .5), walk, "paving", Color(1.05, 1.03, 1.0), .006)
	if median:
		_ribbon(kit, pts, side, 0.0, .022, "grass", Color(1.0, 1.1, .95), .006, true)
		for k in [2, 6]:
			var p: Vector3 = pts[k]
			kit.cylinder("bark", p + Vector3(0, .006, 0), .004, .03, 5)
			kit.cone("foliage", p + Vector3(0, .03, 0), .022, .05, 7, Color(.8, .95, .75))
	elif inner and posmod(seed * 31, 2) == 0:
		var mid: Vector3 = pts[SAMPLES / 2]
		var offset := side * (width * .5 + walk * .5 + .01)
		kit.part("streetlight", mid + Vector3(offset.x, .006 if walk > 0.0 else 0.0, offset.y), atan2(-side.y, side.x), 1.0)


## A strip along the polyline offset sideways; `lift` raises it and `walls` adds side faces so a
## kerb or median reads as a raised element rather than paint.
func _ribbon(kit: MeshKit, pts: Array[Vector3], side2: Vector2, offset: float, width: float, mat: String, color: Color, lift: float, walls := false) -> void:
	var side := Vector3(side2.x, 0, side2.y)
	for k in pts.size() - 1:
		var p0: Vector3 = pts[k] + side * offset + Vector3(0, lift, 0); var p1: Vector3 = pts[k + 1] + side * offset + Vector3(0, lift, 0)
		var l0 := p0 - side * width * .5; var r0 := p0 + side * width * .5
		var l1 := p1 - side * width * .5; var r1 := p1 + side * width * .5
		kit.quad(mat, l0, r0, r1, l1, color, Vector3.UP)
		if walls and lift > 0.0:
			var drop := Vector3(0, lift + .004, 0)
			kit.quad(mat, l0, l1, l1 - drop, l0 - drop, color * .85, -side)
			kit.quad(mat, r0, r1, r1 - drop, r0 - drop, color * .85, side)


## An urban block without a building, fitted to the block: a pocket park (most), a plaza only
## beside the civic centre, or a small parking court. Lawns and paving follow the hex outline.
func _open_block(kit: MeshKit, t: int, c: Vector2) -> void:
	var hub_d := 99
	for city in world.cities.values(): hub_d = mini(hub_d, world.grid.dist(t, int(city.t)))
	var choice := posmod(t * 7919 + world.world_seed, 10)
	var rng := RandomNumberGenerator.new(); rng.seed = t * 131
	var y := world.ground_height(c.x, c.y)
	kit.set_frame(Vector3.ZERO, 0.0)
	var plaza := hub_d == 1 and choice == 0     # rare: the hub has its own forecourt
	var parking := not plaza and choice == 9
	var ring: Array[Vector3] = []
	for k in 6:
		var p: Vector2 = c + (world.grid.corners[k] * (.5 if plaza else .66))
		ring.append(Vector3(p.x, world.ground_height(p.x, p.y) + .008, p.y))
	var centre := Vector3(c.x, y + .008, c.y)
	var surface := "paving" if plaza else "asphalt" if parking else "grass"
	var tone := Color(1.0, .98, .95) if plaza else Color(.9, .9, .9) if parking else Color(1.0, 1.08, .95)
	for k in 6: kit.tri(surface, centre, ring[k], ring[(k + 1) % 6], tone, Vector3.UP)
	kit.set_frame(centre, float(posmod(t, 6)) * PI / 3.0)
	if plaza:
		kit.cylinder("stone", Vector3.ZERO, .09, .03, 12, Color(.9, .88, .84))
		kit.cylinder("glass", Vector3(0, .028, 0), .075, .004, 12, Color(.5, .7, .8))
		for k in 6:
			var a := TAU * k / 6.0 + .3
			kit.box("timber", Vector3(cos(a) * .26, 0, sin(a) * .26), Vector3(.07, .012, .02), Color(.8, .7, .55), -a)
			kit.cylinder("bark", Vector3(cos(a + .5) * .42, 0, sin(a + .5) * .42), .006, .04, 5)
			kit.cone("foliage", Vector3(cos(a + .5) * .42, .035, sin(a + .5) * .42), .04, .08, 7, Color(.8, .95, .75))
	elif parking:
		for k in 5:
			kit.box("concrete", Vector3(-.3 + k * .15, .003, 0), Vector3(.004, .002, .3), Color(1.4, 1.4, 1.35))
			if rng.randf() < .7: kit.part("parked_car", Vector3(-.225 + k * .15, .002, rng.randf_range(-.08, .08)), PI * .5, 1.0, Color(.5, .55, .62).darkened(rng.randf() * .4))
	else:
		# winding path and loose groups of trees and shrubs
		var prev := Vector3(-.55, .004, 0)
		for k in range(1, 7):
			var p := Vector3(-.55 + k * .18, .004, sin(k * 1.3 + t) * .12)
			kit.strip("paving", kit.xf(prev), kit.xf(p), .045, Color(1.0, .97, .92))
			prev = p
		for k in 7:
			var p := Vector3(rng.randf_range(-.45, .45), 0, rng.randf_range(-.45, .45))
			if absf(p.z - sin((p.x + .55) / .18 * 1.3 + t) * .12) < .08: continue
			var r := rng.randf_range(.035, .055)
			kit.cylinder("bark", p, .006, .045, 5)
			kit.cylinder("foliage", p + Vector3(0, .04, 0), r, r * 1.1, 8, Color(.78, .93, .7).darkened(rng.randf() * .15), r * .4)
		if rng.randf() < .5: kit.box("timber", Vector3(.1, 0, .25), Vector3(.07, .012, .02), Color(.8, .7, .55))
