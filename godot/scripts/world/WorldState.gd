class_name WorldState
extends Node
## The client's mirror of what the server has told this viewer: nothing here is simulated. Holds
## the latest tile records, terrain geometry, economy and battlefield state, plus a short buffer
## of unit snapshots so movement can be drawn smoothly between the server's 5 Hz updates.

signal welcomed
signal reset
signal geo_changed(chunks: PackedInt32Array)
signal tiles_changed(tiles: PackedInt32Array, roads_changed: PackedInt32Array)
signal vis_changed(bits: PackedByteArray)
signal snapshot_applied
signal econ_applied
signal weather_changed(wx: Dictionary)
signal combat_events(ev: Array)
signal note(m: Dictionary)

## world-space heights (one unit = one hex radius)
const LAND_SCALE := 3.2
const SEA_SCALE := 1.4
const LAKE_DEPTH := 0.14
const RIVER_DEPTH := 0.07
const INTERP_DELAY := 0.25      # seconds of server time drawn behind the newest snapshot
const BUFFER := 10

const GEO_STRIDE := 6

var ready_ := false
var defs := {}
var civ_id := 0
var spectator := false
var sandbox := false
var civs: Array = []
var civ_by_id := {}
var start_tile := -1
var match_id := ""
var grid: HexGrid
var chunk := 16
var chunks_w := 0
var chunks_h := 0

# terrain geometry ('geo' capability), 6 bytes per hex, and which hexes are known
var geo := PackedByteArray()
var known := PackedByteArray()
var known_mask := PackedByteArray()   # 255 per known hex: a soft mask texture for clouds
var height := PackedFloat32Array()   # derived from geo per hex

# tile records (protocol 1): road edges, owner, flags, server colour
var terr := PackedByteArray()
var tile_owner := PackedInt32Array()
var road := PackedInt32Array()
var flags := PackedInt32Array()
var res := PackedByteArray()
var vis_bits := PackedByteArray()
var urban_bits := PackedByteArray()

var server_time := 0.0
var tick := 0
var units := {}                 # id -> latest unit record (Dictionary)
var paths := {}
var snaps: Array = []           # [{ t, at (local s), pos: { id: Vector3(tile, next, prog) } }]
var render_time := 0.0
var _interp_time := -INF
var _interp_s0: Dictionary = {}
var _interp_s1: Dictionary = {}
var _interp_f := 1.0
var _interp_single := true
var geo_version := 0
var play_rate := 1.0
var buildings := {}             # id -> Dictionary as sent
var buildings_version := 0
var cities := {}
var ruins: Array = []
var traffic: Array = []
var bf := {}
var bf_version := 0
var fw: Array = []
var fw_version := 0
var econ := {}
var wx := {}
var paused := false
var snapshot_count := 0
var last_snapshot_at := 0.0
var snapshot_intervals: Array = []


func apply_welcome(m: Dictionary) -> void:
	defs = m.get("defs", {})
	civ_id = int(m.get("civId", 0))
	spectator = bool(m.get("spectator", false))
	sandbox = bool(m.get("sandbox", false))
	match_id = str(m.get("match", ""))
	civs = m.get("civs", [])
	civ_by_id.clear()
	for c in civs:
		civ_by_id[int(c.id)] = c
	start_tile = int(m.get("start", -1)) if m.get("start") != null else -1
	paused = bool(m.get("paused", false))
	var world: Dictionary = m.get("world", {})
	var W := int(defs.get("W", 128))
	var H := int(defs.get("H", 128))
	var wraps: bool = world.get("wrap", true) != false
	if grid == null or grid.w != W or grid.h != H or grid.wrap != wraps:
		grid = HexGrid.new(W, H, wraps)
	chunks_w = ceili(W / float(chunk))
	chunks_h = ceili(H / float(chunk))
	_clear_map()
	ready_ = true
	welcomed.emit()


func _clear_map() -> void:
	_interp_time = -INF
	var n := grid.n
	geo = PackedByteArray(); geo.resize(n * GEO_STRIDE)
	known = PackedByteArray(); known.resize(n)
	known_mask = PackedByteArray(); known_mask.resize(n)
	height = PackedFloat32Array(); height.resize(n)
	terr = PackedByteArray(); terr.resize(n)
	tile_owner = PackedInt32Array(); tile_owner.resize(n); tile_owner.fill(-1)
	road = PackedInt32Array(); road.resize(n)
	flags = PackedInt32Array(); flags.resize(n)
	res = PackedByteArray(); res.resize(n)
	vis_bits = PackedByteArray(); vis_bits.resize(n / 8)
	urban_bits = PackedByteArray(); urban_bits.resize(n / 8)
	units.clear(); snaps.clear(); buildings.clear(); cities.clear(); ruins = []; traffic = []; bf = {}; fw = []
	buildings_version += 1
	bf_version += 1
	fw_version += 1


# ------------------------------------------------------------------ messages
func on_message(m: Dictionary) -> void:
	match str(m.get("t", "")):
		"s":
			if ready_:
				apply_snapshot(m)
		"geo":
			if ready_:
				apply_geo(m)
		"note":
			note.emit(m)
		"paused":
			paused = bool(m.get("on", false))


func apply_snapshot(m: Dictionary) -> void:
	_interp_time = -INF
	if m.get("reset", 0):
		_clear_map()
		reset.emit()
	if m.has("obs"):
		var follow := int(m.obs.get("follow", civ_id))
		civ_id = follow
		play_rate = float(m.obs.get("speed", 1))
	var now := Time.get_ticks_msec() / 1000.0
	if last_snapshot_at > 0.0:
		snapshot_intervals.append(now - last_snapshot_at)
		if snapshot_intervals.size() > 60:
			snapshot_intervals.pop_front()
	last_snapshot_at = now
	snapshot_count += 1
	server_time = float(m.get("time", server_time))
	tick = int(m.get("tick", tick))
	if m.has("tiles"):
		var changed := PackedInt32Array()
		var roads := PackedInt32Array()
		for t in m.tiles:
			var i := int(t[0])
			terr[i] = int(t[1])
			res[i] = int(t[3])
			var rd := int(t[4])
			if road[i] != rd:
				roads.append(i)
			road[i] = rd
			flags[i] = int(t[5])
			tile_owner[i] = int(t[8])
			changed.append(i)
		tiles_changed.emit(changed, roads)
	if m.has("vis"):
		var b := Marshalls.base64_to_raw(m.vis)
		if b.size() == vis_bits.size():
			vis_bits = b
			vis_changed.emit(vis_bits)
	# units: the full visible set every snapshot
	var pos := {}
	var seen := {}
	for a in m.get("units", []):
		var id := int(a[0])
		seen[id] = true
		var u: Dictionary = units.get(id, {})
		u.id = id
		u.owner = int(a[1])
		u.type = str(a[2])
		u.tile = int(a[3])
		u.next = int(a[4])
		u.prog = float(a[5]) / 100.0
		u.hp = int(a[6])
		u.flags = int(a[8])
		u.stance = a[9]
		u.cstat = a[10]
		u.morale = a[13]
		u.formation = int(a[16]) if a.size() > 16 and a[16] != null else 0
		units[id] = u
		pos[id] = Vector3(u.tile, u.next, u.prog)
	for id in units.keys():
		if not seen.has(id):
			units.erase(id)
	paths = m.get("paths", {})
	snaps.append({"t": server_time, "pos": pos})
	while snaps.size() > BUFFER:
		snaps.pop_front()
	if m.has("wx"):
		wx = m.wx
		weather_changed.emit(wx)
	if m.has("ev"):
		combat_events.emit(m.ev)
	if m.has("econ"):
		_apply_econ(m)
	snapshot_applied.emit()


func _apply_econ(m: Dictionary) -> void:
	econ = m.econ
	var bl := {}
	for b in m.get("buildings", []):
		bl[int(b.id)] = b
	buildings = bl
	buildings_version += 1
	var cl := {}
	for c in m.get("cities", []):
		cl[int(c.id)] = c
	cities = cl
	ruins = m.get("ruins", [])
	traffic = m.get("traffic", [])
	if m.has("bf"):
		bf = m.bf
		bf_version += 1
	if m.has("fw"):
		fw = m.fw
		fw_version += 1
	if m.has("urban"):
		var u := Marshalls.base64_to_raw(m.urban)
		if u.size() == urban_bits.size():
			urban_bits = u
	if m.has("civs"):
		for c in m.civs:
			civ_by_id[int(c.id)] = c
	econ_applied.emit()


func apply_geo(m: Dictionary) -> void:
	var cs := int(m.get("cs", chunk))
	if m.get("full", 0):
		known.fill(0)
		known_mask.fill(0)
		height.fill(0.0)
		geo_version += 1
	var stride := int(m.get("stride", GEO_STRIDE))
	var touched := {}
	var height_changed := false
	var W := grid.w
	for c in m.get("chunks", []):
		var cx := int(c[0])
		var cy := int(c[1])
		var mask := Marshalls.base64_to_raw(c[2])
		var data := Marshalls.base64_to_raw(c[3])
		var k := 0
		for cell in cs * cs:
			if (mask[cell >> 3] & (1 << (cell & 7))) == 0:
				continue
			var q := cx * cs + cell % cs
			var r := cy * cs + cell / cs
			var i := r * W + q
			for b in GEO_STRIDE:
				geo[i * GEO_STRIDE + b] = data[k * stride + b]
			var y := _tile_height(i)
			height_changed = height_changed or known[i] == 0 or height[i] != y
			height[i] = y
			known[i] = 1
			known_mask[i] = 255
			k += 1
			# a hex's shape changes its neighbours' corners: their chunks are rebuilt too
			touched[_chunk_of(i)] = true
			for d in 6:
				var nb := grid.nb[i * 6 + d]
				if nb >= 0:
					touched[_chunk_of(nb)] = true
	if height_changed:
		geo_version += 1
	if m.get("full", 0):
		for cid in chunks_w * chunks_h:
			touched[cid] = true
	var out := PackedInt32Array()
	for cid in touched.keys():
		out.append(cid)
	geo_changed.emit(out)


func _chunk_of(i: int) -> int:
	var q := i % grid.w
	var r := i / grid.w
	return (r / chunk) * chunks_w + (q / chunk)


# ------------------------------------------------------------------ terrain queries
func biome(i: int) -> int:
	return geo[i * GEO_STRIDE + 1]


func geo_flags(i: int) -> int:
	return geo[i * GEO_STRIDE + 3]


func deposit(i: int) -> int:
	return geo[i * GEO_STRIDE + 4] & 15


func flow_dir(i: int) -> int:
	return geo[i * GEO_STRIDE + 5] - 1


func flow_bucket(i: int) -> int:
	return geo[i * GEO_STRIDE + 4] >> 4


func elevation(i: int) -> float:
	return geo[i * GEO_STRIDE] / 127.5 - 1.0


func is_sea(i: int) -> bool:
	return biome(i) <= 1 and (geo_flags(i) & 2) == 0


func is_lake(i: int) -> bool:
	return (geo_flags(i) & 2) != 0


func is_river(i: int) -> bool:
	return (geo_flags(i) & 1) != 0


func is_visible(i: int) -> bool:
	return (vis_bits[i >> 3] & (1 << (i & 7))) != 0


func is_urban(i: int) -> bool:
	return (urban_bits[i >> 3] & (1 << (i & 7))) != 0


func _tile_height(i: int) -> float:
	var e := elevation(i)
	if is_sea(i):
		return minf(e, -0.03) * SEA_SCALE
	var y := maxf(e, 0.0) * LAND_SCALE + 0.05
	if is_lake(i):
		y -= LAKE_DEPTH
	elif is_river(i):
		y -= RIVER_DEPTH
	return y


## surface of standing water on hex i (sea level, lake level), or -INF on dry land
func water_level(i: int) -> float:
	if is_sea(i):
		return 0.0
	if is_lake(i):
		return height[i] + LAKE_DEPTH * 0.8
	return -INF


func tile_height(i: int) -> float:
	return height[i] if i >= 0 and known[i] else 0.0


## height at corner k of hex i: the mean of the (known) hexes that share it
func corner_height(i: int, k: int) -> float:
	var s := height[i]
	var c := 1
	var pair: Array = HexGrid.CORNER_DIRS[k]
	for d: int in pair:
		var nb: int = grid.nb[i * 6 + d]
		if nb >= 0 and known[nb]:
			s += height[nb]
			c += 1
	return s / c


## ground height under (x, z) in any image: the same triangles the terrain mesh is built from
func ground_height(x: float, z: float) -> float:
	var t := grid.tile_at(x, z)
	if t < 0 or not known[t]:
		return 0.0
	var c := grid.center(t)
	var dx := grid.dx_wrap(c.x, x)
	var dz := z - c.y
	var a := rad_to_deg(atan2(dz, dx))
	var k := posmod(int(floor((a + 90.0) / 60.0)), 6)
	var k2 := (k + 1) % 6
	var A := grid.corners[k]
	var B := grid.corners[k2]
	var det := A.x * B.y - A.y * B.x
	if absf(det) < 1e-6:
		return height[t]
	var u := (dx * B.y - dz * B.x) / det
	var v := (A.x * dz - A.y * dx) / det
	return (1.0 - u - v) * height[t] + u * corner_height(t, k) + v * corner_height(t, k2)


# ------------------------------------------------------------------ units over time
## advance the playback clock: it trails the newest snapshot by INTERP_DELAY and eases toward it
func advance_clock(dt: float) -> void:
	if snaps.is_empty():
		return
	var newest: float = snaps[-1].t
	var target := newest - INTERP_DELAY
	render_time += dt * (0.0 if paused else play_rate)
	var err := target - render_time
	if absf(err) > 1.5:
		render_time = target
	else:
		render_time += err * minf(1.0, dt * 2.5)
	render_time = minf(render_time, newest)


## where a unit is drawn now: interpolated between the two snapshots around the playback time
func prepare_unit_frame() -> void:
	if _interp_time == render_time:
		return
	_interp_time = render_time
	_interp_s0 = {}
	_interp_s1 = {}
	_interp_f = 1.0
	_interp_single = true
	var n := snaps.size()
	if n == 0:
		return
	var i1 := n - 1
	while i1 > 0 and float(snaps[i1 - 1].t) >= render_time:
		i1 -= 1
	_interp_s1 = snaps[i1]
	if i1 == 0:
		_interp_s0 = _interp_s1
		return
	_interp_single = false
	_interp_s0 = snaps[i1 - 1]
	var span := float(_interp_s1.t) - float(_interp_s0.t)
	_interp_f = clampf((render_time - float(_interp_s0.t)) / span, 0.0, 1.0) if span > 1e-4 else 1.0


func unit_position(id: int) -> Vector2:
	prepare_unit_frame()
	if _interp_s1.is_empty():
		return Vector2.ZERO
	var p1 := _pos_in(_interp_s1, id)
	if _interp_single:
		return p1 if p1.x > -1e8 else _latest_pos(id)
	if _interp_s0.pos.has(id) and _interp_s1.pos.has(id) and _interp_s0.pos[id] == _interp_s1.pos[id]:
		return p1
	var p0 := _pos_in(_interp_s0, id)
	if p1.x < -1e8:
		return p0 if p0.x > -1e8 else _latest_pos(id)
	if p0.x < -1e8:
		return p1
	return Vector2(p0.x + grid.dx_wrap(p0.x, p1.x) * _interp_f, lerpf(p0.y, p1.y, _interp_f))


func _latest_pos(id: int) -> Vector2:
	for k in range(snaps.size() - 1, -1, -1):
		var p := _pos_in(snaps[k], id)
		if p.x > -1e8:
			return p
	return Vector2.ZERO


func _pos_in(s: Dictionary, id: int) -> Vector2:
	var pos: Dictionary = s.pos
	if not pos.has(id):
		return Vector2(-1e9, 0)
	var v: Vector3 = pos[id]
	var a := grid.center(int(v.x))
	if v.y < 0 or v.z <= 0.0:
		return a
	var b := grid.center(int(v.y))
	return Vector2(a.x + grid.dx_wrap(a.x, b.x) * v.z, lerpf(a.y, b.y, v.z))


func civ_color(id: int) -> Color:
	var c = civ_by_id.get(id)
	if c == null:
		return Color(0.6, 0.6, 0.6)
	var col = c.get("color", "#999999")
	if typeof(col) == TYPE_STRING:
		return Color.html(col)
	return Color.hex((int(col) << 8) | 0xff)


func snapshot_rate() -> float:
	if snapshot_intervals.is_empty():
		return 0.0
	var s := 0.0
	for v in snapshot_intervals:
		s += v
	return snapshot_intervals.size() / maxf(s, 1e-3)
