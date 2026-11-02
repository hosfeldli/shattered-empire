class_name SettlementRenderer
extends Node3D
## Buildings and districts. Neighbouring finished buildings of compatible kinds and the same owner
## join into one district (the same grouping the PixiJS client uses, client/visual/DistrictMerge.js):
## a district is one ArrayMesh with shared ground (garden plots, works yard, paved square, aligned
## fields) and connecting structures across shared edges (terraces, pipe runs, rail spurs, paths).
## Every building is still its own selectable thing: picking works on the server's hex ids, and a
## selected building is outlined. All state shown here (level, progress, damage, fire, activity) is
## what the server sent; nothing is decided by the client.

const GROUP := {
	"house": "res",
	"farm": "farm",
	"market": "com", "port": "com",
	"town": "civ", "academy": "civ", "university": "civ", "comms_tower": "civ",
	"steel_mill": "ind", "munitions_plant": "ind", "motor_works": "ind", "heavy_assembly": "ind", "electronics_plant": "ind", "refinery": "ind", "power_plant": "ind", "fusion_plant": "ind", "robotics_complex": "ind", "drone_works": "ind", "salvage": "ind",
	"mine": "ext", "quarry": "ext", "lumber": "ext", "oil_well": "ext",
}
const SQRT3 := HexGrid.SQRT3

var world: WorldState
var cam: CameraController
var version := -1
var districts := {}          # district key (sorted member ids) -> { node: MeshInstance3D, anchor: Vector2, sig: String, smoke: [] }
var at_tile := {}            # tile -> building id
var district_of := {}        # building id -> district key
var selected_building := -1
var select_mark: MeshInstance3D
var ruin_inst: MeshInstance3D
var ruin_sig := ""
var ruin_anchor := Vector2.ZERO
var rebuilt := 0
var plumes: MultiMeshInstance3D   # all chimney and fire smoke: one batch, animated here
const MAX_PUFFS := 900


func setup(w: WorldState, c: CameraController) -> void:
	world = w
	cam = c
	var t := TorusMesh.new()
	t.inner_radius = 0.82
	t.outer_radius = 0.9
	t.rings = 6
	t.ring_segments = 4
	t.material = MaterialLibrary.glow(Color(0.98, 0.9, 0.55))
	select_mark = MeshInstance3D.new()
	select_mark.mesh = t
	select_mark.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	select_mark.visible = false
	add_child(select_mark)
	ruin_inst = MeshInstance3D.new()
	add_child(ruin_inst)
	plumes = MultiMeshInstance3D.new()
	plumes.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.use_colors = true
	var puff := SphereMesh.new()
	puff.radius = 0.05
	puff.height = 0.08
	puff.radial_segments = 6
	puff.rings = 3
	puff.material = MaterialLibrary.smoke(Color(1, 1, 1), 0.55)
	mm.mesh = puff
	mm.instance_count = MAX_PUFFS
	mm.visible_instance_count = 0
	plumes.multimesh = mm
	add_child(plumes)
	world.reset.connect(_clear)
	world.welcomed.connect(_clear)


func _clear() -> void:
	for d in districts.values():
		(d.node as Node).queue_free()
	districts.clear()
	version = -1


func update(_dt: float) -> void:
	if world.grid == null:
		return
	if version != world.buildings_version:
		version = world.buildings_version
		_rebuild()
	var cx := cam.focus.x
	var g := world.grid
	for d in districts.values():
		var a: Vector2 = d.anchor
		(d.node as Node3D).position = Vector3(g.near_x(a.x, cx) - a.x, 0, 0)
	ruin_inst.position = Vector3(g.near_x(ruin_anchor.x, cx) - ruin_anchor.x, 0, 0)
	_update_plumes()
	_update_mark()


## smoke from working chimneys and burning buildings: puffs rising, drifting and fading on a loop
func _update_plumes() -> void:
	var mm := plumes.multimesh
	var g := world.grid
	var cx := cam.focus.x
	var now := Time.get_ticks_msec() / 1000.0
	var n := 0
	for d in districts.values():
		for s in d.smoke:
			var base: Vector3 = s[0]
			var col: Color = s[1]
			var x0 := g.near_x(base.x, cx)
			for k in 6:
				if n >= MAX_PUFFS:
					break
				var u := fposmod(now * 0.22 + k / 6.0 + base.z * 0.37, 1.0)
				var p := Vector3(x0 + u * 0.35, base.y + u * 0.7, base.z - u * 0.08)
				var sc := 0.6 + u * 1.8
				mm.set_instance_transform(n, Transform3D(Basis().scaled(Vector3.ONE * sc), p))
				mm.set_instance_color(n, Color(col, (1.0 - u) * 0.8))
				n += 1
	mm.visible_instance_count = n


func _update_mark() -> void:
	var b: Dictionary = world.buildings.get(selected_building, {})
	if b.is_empty():
		select_mark.visible = false
		return
	var c := world.grid.center(int(b.t))
	var x := world.grid.near_x(c.x, cam.focus.x)
	select_mark.visible = true
	select_mark.position = Vector3(x, world.tile_height(int(b.t)) + 0.03, c.y)


func building_at(tile: int) -> int:
	return int(at_tile.get(tile, -1))


# ------------------------------------------------------------------ districts
func _rebuild() -> void:
	var g := world.grid
	at_tile.clear()
	var members := {}            # tile -> building for district candidates
	for b in world.buildings.values():
		var t := int(b.t)
		at_tile[t] = int(b.id)
		if GROUP.has(b.ty) and int(b.get("d", 0)) == 1 and str(b.get("st", "")) != "planned":
			members[t] = b
	# union-find over hex adjacency per group and owner
	var parent := {}
	for t in members.keys():
		parent[t] = t
	for t in members.keys():
		var b: Dictionary = members[t]
		for d in 6:
			var nb := g.nb[int(t) * 6 + d]
			if nb < 0 or not members.has(nb):
				continue
			var o: Dictionary = members[nb]
			if GROUP[o.ty] == GROUP[b.ty] and int(o.o) == int(b.o):
				var ra = _find(parent, t)
				var rb = _find(parent, nb)
				if ra != rb:
					parent[ra] = rb
	var groups := {}
	for b in world.buildings.values():
		var t := int(b.t)
		var root = _find(parent, t) if parent.has(t) else "s%d" % int(b.id)
		if not groups.has(root):
			groups[root] = []
		(groups[root] as Array).append(b)
	var keep := {}
	district_of.clear()
	for list in groups.values():
		var ids := []
		for b in list:
			ids.append(int(b.id))
		ids.sort()
		var key := ",".join(ids.map(func(x): return str(x)))
		keep[key] = true
		for id in ids:
			district_of[id] = key
		var sig := _signature(list)
		var rec: Dictionary = districts.get(key, {})
		if not rec.is_empty() and rec.sig == sig:
			continue
		if rec.is_empty():
			var mi := MeshInstance3D.new()
			add_child(mi)
			rec = {"node": mi, "smoke": []}
			districts[key] = rec
		rec.sig = sig
		_build_district(rec, list)
		rebuilt += 1
	for key in districts.keys():
		if not keep.has(key):
			(districts[key].node as Node).queue_free()
			districts.erase(key)
	_build_ruins()


func _find(parent: Dictionary, x):
	while parent[x] != x:
		parent[x] = parent[parent[x]]
		x = parent[x]
	return x


func _signature(list: Array) -> String:
	var parts := PackedStringArray()
	for b in list:
		parts.append("%d:%s:%d:%s:%d:%d:%d:%d:%d:%d" % [int(b.id), b.ty, int(b.get("d", 0)), str(b.get("st", "")), int(b.get("lv", 1)), int(b.get("p", 0)) / 10, int(b.get("f", 0)), int(b.get("a", 0)), int(b.get("hp", 100)) / 25, int(b.get("ti", 0))])
	return "|".join(parts)


func _build_district(rec: Dictionary, list: Array) -> void:
	var g := world.grid
	var anchor := g.center(int(list[0].t))
	rec.anchor = anchor
	var kit := MeshKit.new()
	var by_tile := {}
	for b in list:
		by_tile[int(b.t)] = b
	var group: String = GROUP.get(list[0].ty, "") if list.size() > 1 else ""
	var smokes: Array = []
	for b in list:
		var t := int(b.t)
		var c2 := g.center(t)
		var lc := Vector3(anchor.x + g.dx_wrap(anchor.x, c2.x), world.tile_height(t), c2.y)
		var tint := _tint(b)
		kit.set_frame(lc, 0.0)
		_ground(kit, b, group)
		if int(b.get("d", 0)) == 0:
			_construction(kit, b, tint)
		else:
			_building(kit, b, tint, smokes, lc)
		# connections to district neighbours (each shared edge once)
		if group != "":
			for d in [0, 4, 5]:
				var nb: int = g.nb[t * 6 + d]
				if by_tile.has(nb):
					var c3 := g.center(nb)
					var lc2 := Vector3(lc.x + g.dx_wrap(c2.x, c3.x), world.tile_height(nb), c3.y)
					kit.set_frame(Vector3.ZERO, 0.0)
					_connect(kit, group, lc, lc2, b, by_tile[nb])
	var mi: MeshInstance3D = rec.node
	mi.mesh = kit.commit() if not kit.is_empty() else null
	# plumes in base-image coordinates (local x is relative to the district anchor, already wrapped)
	rec.smoke = smokes


func _tint(b: Dictionary) -> Color:
	var st := str(b.get("st", ""))
	var hp := int(b.get("hp", 100))
	var c := Color.WHITE
	if st == "damaged" or hp < 50:
		c = Color(0.62, 0.58, 0.55)
	return c


func _era() -> int:
	return int(world.econ.get("age", 1))


func _rng(b: Dictionary) -> RandomNumberGenerator:
	var r := RandomNumberGenerator.new()
	r.seed = int(b.t) * 7919 + 17
	return r


# ------------------------------------------------------------------ ground and connections
func _ground(kit: MeshKit, b: Dictionary, group: String) -> void:
	var ty: String = b.ty
	var g: String = GROUP.get(ty, "")
	match g:
		"res":
			kit.hex_plate("grass", Vector3(0, 0.02, 0), 0.94, Color(0.95, 0.95, 0.92), 0.14)
		"civ", "com":
			kit.hex_plate("paving", Vector3(0, 0.025, 0), 0.94, Color(0.8, 0.79, 0.76), 0.14)
		"ind":
			kit.hex_plate("concrete", Vector3(0, 0.025, 0), 0.94, Color(0.7, 0.69, 0.67), 0.14)
		"ext":
			kit.hex_plate("soil", Vector3(0, 0.015, 0), 0.88, Color(0.85, 0.82, 0.78), 0.12)
		"farm":
			pass
		_:
			kit.hex_plate("paving", Vector3(0, 0.02, 0), 0.72, Color(0.92, 0.92, 0.9), 0.25)
	if group == "" and g == "res":
		# a lone house plot gets a hedge
		for k in 6:
			var a := deg_to_rad(-60.0 + 60.0 * k)
			kit.box("foliage", Vector3(cos(a) * 0.8, 0.02, sin(a) * 0.8), Vector3(0.05, 0.06, 0.8), Color(1, 1, 1), -a)


func _connect(kit: MeshKit, group: String, a: Vector3, b: Vector3, ba: Dictionary, bb: Dictionary) -> void:
	var mid := (a + b) * 0.5
	var dir := Vector2(b.x - a.x, b.z - a.z)
	var yaw := atan2(-dir.y, dir.x)
	var along := Vector3(dir.x, 0, dir.y).normalized()
	var across := along.cross(Vector3.UP)
	var y := maxf(a.y, b.y) + 0.02
	var rng := RandomNumberGenerator.new()
	rng.seed = int(ba.t) * 31 + int(bb.t)
	match group:
		"res":
			# a terrace of row houses straddling the shared edge, facing the street
			var walls := _wall_mat(rng)
			var n := 3
			for k in n:
				var off := (k - (n - 1) * 0.5) * 0.17
				var p := mid + across * off
				kit.box(walls, Vector3(p.x, y, p.z), Vector3(0.26, 0.17 + 0.05 * int(ba.get("lv", 1)), 0.15), Color(1, 1, 1).darkened(rng.randf() * 0.12), yaw)
				kit.gable(_roof_mat(rng), Vector3(p.x, y + 0.17 + 0.05 * int(ba.get("lv", 1)), p.z), 0.15, 0.26, 0.08, Color(1, 1, 1), yaw + PI * 0.5)
		"ind":
			# a pipe run on trestles and a rail spur between the plants
			var len := Vector2(b.x - a.x, b.z - a.z).length()
			kit.box("steel", Vector3(mid.x, y + 0.2, mid.z) + across * 0.25, Vector3(len, 0.035, 0.035), Color(0.9, 0.9, 0.9), yaw)
			for f in [-0.3, 0.0, 0.3]:
				var p: Vector3 = mid + along * (f * len) + across * 0.25
				kit.box("steel", Vector3(p.x, y, p.z), Vector3(0.025, 0.2, 0.025), Color(0.8, 0.8, 0.8))
			kit.box("ballast", Vector3(mid.x, y - 0.01, mid.z) - across * 0.2, Vector3(len, 0.02, 0.12), Color(1, 1, 1), yaw)
			kit.box("steel", Vector3(mid.x, y + 0.01, mid.z) - across * 0.23, Vector3(len, 0.012, 0.012), Color(0.7, 0.7, 0.7), yaw)
			kit.box("steel", Vector3(mid.x, y + 0.01, mid.z) - across * 0.17, Vector3(len, 0.012, 0.012), Color(0.7, 0.7, 0.7), yaw)
		"civ":
			var len := Vector2(b.x - a.x, b.z - a.z).length()
			kit.box("stone", Vector3(mid.x, y - 0.01, mid.z), Vector3(len, 0.02, 0.4), Color(0.95, 0.94, 0.9), yaw)
			for s in [-1.0, 1.0]:
				var p: Vector3 = mid + across * (0.3 * s)
				kit.cylinder("bark", Vector3(p.x, y, p.z), 0.015, 0.1, 5)
				kit.cone("foliage", Vector3(p.x, y + 0.08, p.z), 0.08, 0.2, 6)
		"com":
			var len := Vector2(b.x - a.x, b.z - a.z).length()
			for k in 3:
				var p := mid + along * ((k - 1) * len * 0.25) + across * 0.18
				kit.box("timber", Vector3(p.x, y, p.z), Vector3(0.14, 0.08, 0.1), Color(1, 1, 1), yaw)
				kit.gable("canvas", Vector3(p.x, y + 0.08, p.z), 0.12, 0.16, 0.05, _awning(rng), yaw)
		"ext":
			var len := Vector2(b.x - a.x, b.z - a.z).length()
			kit.box("soil", Vector3(mid.x, y - 0.015, mid.z), Vector3(len, 0.02, 0.16), Color(0.9, 0.85, 0.78), yaw)
		"farm":
			pass


# ------------------------------------------------------------------ buildings
func _construction(kit: MeshKit, b: Dictionary, tint: Color) -> void:
	var p := clampf(float(b.get("p", 0)) / 100.0, 0.0, 1.0)
	kit.box("concrete", Vector3(0, 0.02, 0), Vector3(0.6, 0.03, 0.5), tint)
	var h := 0.05 + 0.3 * p
	kit.box("concrete", Vector3(0, 0.05, 0), Vector3(0.48, h * 0.8, 0.38), tint * 0.95)
	for x in [-0.27, 0.27]:
		for z in [-0.22, 0.22]:
			kit.box("timber", Vector3(x, 0.05, z), Vector3(0.018, h + 0.08, 0.018), tint)
	kit.box("timber", Vector3(0, 0.05 + h, -0.22), Vector3(0.56, 0.015, 0.015), tint)
	kit.box("timber", Vector3(0, 0.05 + h, 0.22), Vector3(0.56, 0.015, 0.015), tint)
	# a crane once the frame is up
	if p > 0.3:
		kit.box("steel", Vector3(0.36, 0.05, 0.3), Vector3(0.03, 0.55, 0.03), Color(0.95, 0.75, 0.3))
		kit.box("steel", Vector3(0.2, 0.6, 0.3), Vector3(0.45, 0.025, 0.025), Color(0.95, 0.75, 0.3))


func _wall_mat(rng: RandomNumberGenerator) -> String:
	var era := _era()
	if era <= 0:
		return "timber" if rng.randf() < 0.5 else "plaster"
	if era <= 2:
		return "brick" if rng.randf() < 0.65 else "plaster"
	return "concrete" if rng.randf() < 0.5 else "brick"


func _roof_mat(rng: RandomNumberGenerator) -> String:
	return "roof_tile" if rng.randf() < 0.6 else "roof_slate"


func _awning(rng: RandomNumberGenerator) -> Color:
	var opts := [Color(0.95, 0.9, 0.8), Color(0.75, 0.45, 0.35), Color(0.55, 0.62, 0.5), Color(0.6, 0.58, 0.7)]
	return opts[rng.randi() % opts.size()]


func _building(kit: MeshKit, b: Dictionary, tint: Color, smokes: Array, lc: Vector3) -> void:
	var rng := _rng(b)
	var lv := int(b.get("lv", 1))
	var active := int(b.get("a", 0)) == 1
	var ty: String = b.ty
	match ty:
		"house":
			var walls := _wall_mat(rng)
			var roof := _roof_mat(rng)
			var floors := 1 + mini(lv, 3) - 1
			var h := 0.15 + 0.11 * (floors - 1)
			var n := 2 + mini(lv, 3)
			for k in n:
				var a := TAU * k / n + rng.randf() * 0.3
				var r := 0.42 + rng.randf() * 0.12
				var p := Vector3(cos(a) * r, 0.02, sin(a) * r)
				var yaw := -a + PI * 0.5
				var col := tint.darkened(rng.randf() * 0.15)
				kit.box(walls, p, Vector3(0.24, h, 0.16), col, yaw)
				kit.gable(roof, p + Vector3(0, h, 0), 0.16, 0.24, 0.09, tint, yaw + PI * 0.5)
				kit.box("glass", p + Vector3(0, h * 0.45, 0), Vector3(0.245, 0.04, 0.12), tint, yaw)
			kit.cone("foliage", Vector3(0.05, 0.02, 0.0), 0.12, 0.3, 7, tint)
		"town":
			var tier := int(b.get("ti", 1))
			var w := 0.5 + 0.08 * tier
			kit.box("stone", Vector3(0, 0.025, 0), Vector3(w, 0.28 + 0.04 * tier, 0.34), tint)
			kit.gable("roof_slate", Vector3(0, 0.305 + 0.04 * tier, 0), 0.34, w, 0.14, tint, PI * 0.5)
			kit.box("glass", Vector3(0, 0.14, 0.171), Vector3(w * 0.8, 0.08, 0.005), tint)
			kit.box("stone", Vector3(-w * 0.5 + 0.08, 0.025, -0.1), Vector3(0.13, 0.62 + 0.06 * tier, 0.13), tint * 1.03)
			kit.cone("roof_slate", Vector3(-w * 0.5 + 0.08, 0.645 + 0.06 * tier, -0.1), 0.1, 0.18, 4, tint)
			for k in 4:
				kit.cylinder("stone", Vector3(-0.15 + 0.1 * k, 0.025, 0.21), 0.018, 0.22, 6, tint)
			kit.box("steel", Vector3(0.22, 0.31, -0.08), Vector3(0.008, 0.25, 0.008))
			kit.box("team:" + world.civ_color(int(b.o)).to_html(false), Vector3(0.24, 0.48, -0.08), Vector3(0.05, 0.035, 0.004))
		"academy", "university":
			var big := 1.25 if ty == "university" else 1.0
			kit.box("stone", Vector3(0, 0.025, 0), Vector3(0.55 * big, 0.26, 0.3), tint)
			kit.box("glass", Vector3(0, 0.1, 0.152), Vector3(0.5 * big, 0.12, 0.005), tint)
			kit.box("stone", Vector3(0, 0.285, 0), Vector3(0.58 * big, 0.03, 0.33), tint)
			for k in 6:
				kit.cylinder("stone", Vector3(-0.2 * big + 0.08 * big * k, 0.025, 0.19), 0.016, 0.26, 6, tint)
			if ty == "university":
				kit.cylinder("roof_slate", Vector3(0, 0.315, 0), 0.12, 0.1, 10, tint, 0.0)
		"comms_tower":
			kit.box("concrete", Vector3(0, 0.025, 0), Vector3(0.2, 0.1, 0.2), tint)
			kit.cylinder("steel", Vector3(0, 0.1, 0), 0.06, 0.9, 4, tint, 0.012)
			kit.cylinder("steel", Vector3(0.05, 0.7, 0), 0.07, 0.02, 10, tint)
		"market":
			for k in 6:
				var a := TAU * k / 6.0
				var p := Vector3(cos(a) * 0.38, 0.03, sin(a) * 0.38)
				kit.box("timber", p, Vector3(0.14, 0.08, 0.12), tint, -a)
				kit.gable("canvas", p + Vector3(0, 0.08, 0), 0.12, 0.16, 0.05, _awning(rng), -a + PI * 0.5)
			kit.box("brick", Vector3(0, 0.03, 0), Vector3(0.3, 0.2, 0.22), tint)
			kit.gable("roof_tile", Vector3(0, 0.23, 0), 0.22, 0.3, 0.1, tint, PI * 0.5)
		"port":
			kit.box("timber", Vector3(0.5, 0.0, 0), Vector3(0.7, 0.04, 0.16), tint)
			kit.box("brick", Vector3(-0.2, 0.03, 0), Vector3(0.36, 0.18, 0.26), tint)
			kit.gable("roof_slate", Vector3(-0.2, 0.21, 0), 0.26, 0.36, 0.08, tint, PI * 0.5)
			kit.box("steel", Vector3(0.45, 0.04, 0.12), Vector3(0.03, 0.42, 0.03), Color(0.85, 0.6, 0.25))
			kit.box("steel", Vector3(0.55, 0.44, 0.12), Vector3(0.28, 0.025, 0.025), Color(0.85, 0.6, 0.25))
		"farm":
			_fields(kit, b, tint)
		"mine":
			kit.box("steel", Vector3(-0.1, 0.02, -0.05), Vector3(0.025, 0.5, 0.025), tint)
			kit.box("steel", Vector3(0.1, 0.02, -0.05), Vector3(0.025, 0.5, 0.025), tint)
			kit.box("steel", Vector3(0, 0.5, -0.05), Vector3(0.24, 0.05, 0.06), tint)
			kit.cylinder("steel", Vector3(0, 0.55, -0.05), 0.05, 0.01, 10, tint)
			kit.box("timber", Vector3(0.0, 0.02, 0.2), Vector3(0.3, 0.12, 0.16), tint)
			kit.gable("roof_slate", Vector3(0.0, 0.14, 0.2), 0.16, 0.3, 0.06, tint, PI * 0.5)
			kit.cone("rock", Vector3(0.35, 0.0, -0.25), 0.28, 0.24, 7, tint * Color(0.75, 0.72, 0.7))
			_ore_outcrop(kit, rng, tint)
		"quarry":
			for k in 3:
				kit.box("rock", Vector3(-0.1 + 0.08 * k, -0.06 * k, 0), Vector3(0.5 - 0.12 * k, 0.06, 0.45 - 0.1 * k), tint * (1.0 - 0.08 * k))
			kit.box("stone", Vector3(0.38, 0.02, 0.25), Vector3(0.16, 0.1, 0.12), tint)
		"lumber":
			kit.box("timber", Vector3(-0.1, 0.02, 0), Vector3(0.4, 0.16, 0.22), tint)
			kit.gable("roof_slate", Vector3(-0.1, 0.18, 0), 0.22, 0.4, 0.08, tint, PI * 0.5)
			for k in 4:
				kit.box("bark", Vector3(0.3, 0.02 + 0.035 * (k % 2), -0.15 + 0.08 * k), Vector3(0.3, 0.035, 0.035), tint)
		"oil_well":
			kit.box("steel", Vector3(0, 0.02, 0), Vector3(0.05, 0.22, 0.05), tint)
			kit.box("steel", Vector3(0.02, 0.24, 0), Vector3(0.34, 0.03, 0.03), tint)
			kit.box("char", Vector3(-0.14, 0.17, 0), Vector3(0.05, 0.08, 0.05), tint)
			kit.cylinder("steel", Vector3(0.3, 0.02, 0.25), 0.1, 0.16, 10, tint * Color(0.9, 0.9, 0.85))
		"steel_mill", "refinery", "munitions_plant", "electronics_plant", "motor_works", "heavy_assembly", "robotics_complex", "drone_works", "salvage":
			var w := 0.62 + (0.1 if ty in ["heavy_assembly", "steel_mill"] else 0.0)
			kit.box("brick" if _era() <= 2 else "concrete", Vector3(-0.05, 0.025, 0), Vector3(w, 0.2, 0.42), tint)
			kit.sawtooth("steel", "glass", Vector3(-0.05, 0.225, 0), w, 0.42, 0.08, 4, tint, PI * 0.5)
			var chim := Vector3(0.36, 0.025, -0.22)
			kit.cylinder("brick", chim, 0.05, 0.62, 8, tint, 0.04)
			if ty == "refinery":
				for k in 3:
					kit.cylinder("steel", Vector3(0.3, 0.025, 0.05 + 0.13 * k), 0.06, 0.18, 10, tint)
			if ty == "steel_mill":
				kit.cylinder("steel", Vector3(0.3, 0.025, 0.15), 0.09, 0.42, 10, tint * 0.8, 0.06)
			if active:
				smokes.append([lc + chim + Vector3(0, 0.64, 0), Color(0.55, 0.53, 0.5)])
		"power_plant":
			kit.box("concrete", Vector3(-0.2, 0.025, 0), Vector3(0.36, 0.22, 0.3), tint)
			for k in 2:
				var p := Vector3(0.2, 0.025, -0.18 + 0.36 * k)
				kit.cylinder("concrete", p, 0.16, 0.24, 12, tint, 0.11)
				kit.cylinder("concrete", p + Vector3(0, 0.24, 0), 0.11, 0.14, 12, tint, 0.13)
				if active:
					smokes.append([lc + p + Vector3(0, 0.4, 0), Color(0.86, 0.86, 0.86)])
		"fusion_plant":
			kit.box("concrete", Vector3(0, 0.025, 0), Vector3(0.6, 0.12, 0.5), tint)
			kit.cylinder("glass", Vector3(0, 0.145, 0), 0.22, 0.12, 14, tint, 0.12)
			kit.cylinder("glass", Vector3(0, 0.265, 0), 0.12, 0.08, 14, tint, 0.0)
		"barracks", "camp":
			if ty == "camp":
				for k in 4:
					var a := TAU * k / 4.0
					kit.gable("canvas", Vector3(cos(a) * 0.3, 0.02, sin(a) * 0.3), 0.14, 0.2, 0.12, tint, -a)
			else:
				for k in 2:
					kit.box("concrete", Vector3(-0.2 + 0.4 * k, 0.025, 0), Vector3(0.3, 0.14, 0.5), tint)
					kit.box("roof_slate", Vector3(-0.2 + 0.4 * k, 0.165, 0), Vector3(0.32, 0.02, 0.52), tint)
			kit.box("steel", Vector3(0, 0.02, 0.32), Vector3(0.008, 0.35, 0.008))
			kit.box("team:" + world.civ_color(int(b.o)).to_html(false), Vector3(0.025, 0.31, 0.32), Vector3(0.05, 0.035, 0.004))
		"guard_post":
			for x in [-0.08, 0.08]:
				for z in [-0.08, 0.08]:
					kit.box("timber", Vector3(x, 0.02, z), Vector3(0.025, 0.38, 0.025), tint)
			kit.box("timber", Vector3(0, 0.38, 0), Vector3(0.24, 0.1, 0.24), tint)
			kit.gable("roof_slate", Vector3(0, 0.48, 0), 0.24, 0.24, 0.08, tint)
		"bunker", "missile_silo":
			kit.box("concrete", Vector3(0, 0.0, 0), Vector3(0.4, 0.12, 0.34), tint * 0.92)
			kit.box("char", Vector3(0, 0.07, 0.171), Vector3(0.24, 0.025, 0.005), tint)
			if ty == "missile_silo":
				kit.cylinder("steel", Vector3(0.3, 0.0, 0.2), 0.12, 0.03, 12, tint)
		"fort":
			for k in 6:
				var a := deg_to_rad(-60.0 + 60.0 * k)
				kit.box("stone", Vector3(cos(a) * 0.62, 0.02, sin(a) * 0.62), Vector3(0.08, 0.18, 0.7), tint, -a)
				var ca := deg_to_rad(-90.0 + 60.0 * k)
				kit.cylinder("stone", Vector3(cos(ca) * 0.72, 0.02, sin(ca) * 0.72), 0.08, 0.24, 8, tint)
			kit.box("stone", Vector3(0, 0.02, 0), Vector3(0.3, 0.22, 0.3), tint)
		"airfield":
			kit.box("asphalt", Vector3(0, 0.02, 0), Vector3(1.5, 0.015, 0.2), tint)
			kit.box("paving", Vector3(0, 0.03, 0), Vector3(1.4, 0.005, 0.015), Color(1.6, 1.6, 1.5))
			kit.box("steel", Vector3(0, 0.02, 0.4), Vector3(0.4, 0.16, 0.26), tint)
			kit.gable("steel", Vector3(0, 0.18, 0.4), 0.26, 0.4, 0.08, tint, PI * 0.5)
		"aa_battery":
			kit.cylinder("canvas", Vector3(0, 0.02, 0), 0.22, 0.07, 10, tint * Color(0.8, 0.75, 0.6), 0.2)
			kit.box("steel", Vector3(0, 0.09, 0), Vector3(0.08, 0.06, 0.08), tint)
			kit.box("steel", Vector3(0.08, 0.15, 0), Vector3(0.2, 0.015, 0.015), tint, 0.0)
		"shield_generator":
			kit.box("concrete", Vector3(0, 0.02, 0), Vector3(0.4, 0.1, 0.4), tint)
			kit.cone("steel", Vector3(0, 0.12, 0), 0.18, 0.3, 10, tint)
		"depot":
			for k in 2:
				kit.box("steel", Vector3(-0.2 + 0.4 * k, 0.02, 0), Vector3(0.3, 0.16, 0.5), tint * Color(0.8, 0.82, 0.85))
				kit.gable("steel", Vector3(-0.2 + 0.4 * k, 0.18, 0), 0.3, 0.5, 0.07, tint)
			for k in 4:
				kit.box("timber", Vector3(0.0, 0.02, -0.3 + 0.2 * k), Vector3(0.08, 0.08, 0.08), tint)
		"wonder":
			kit.box("stone", Vector3(0, 0.02, 0), Vector3(0.7, 0.1, 0.7), tint)
			kit.cylinder("stone", Vector3(0, 0.12, 0), 0.14, 1.1, 4, tint, 0.02)
		_:
			kit.box("concrete", Vector3(0, 0.02, 0), Vector3(0.42, 0.2, 0.36), tint)
			kit.box("steel", Vector3(0, 0.22, 0), Vector3(0.44, 0.02, 0.38), tint)
	if int(b.get("f", 0)) == 1:
		smokes.append([lc + Vector3(0, 0.3, 0), Color(0.2, 0.18, 0.17)])
		kit.box("glow:ff8a2a", Vector3(0, 0.05, 0), Vector3(0.3, 0.12, 0.25), Color(1, 1, 1))


## fields in rows aligned east-west, so neighbouring farms read as one stretch of countryside
func _fields(kit: MeshKit, b: Dictionary, tint: Color) -> void:
	var rows := 7
	for k in rows:
		var z := -0.78 + 1.56 * (k + 0.5) / rows
		var az := absf(z) + 0.5 * 1.56 / rows
		var half := 0.8 if az <= 0.5 else 0.8 * maxf(0.0, (1.0 - az) / 0.5)
		if half <= 0.05:
			continue
		var crop := Color(1, 1, 1).lerp(Color(0.85, 0.78, 0.55), float((int(b.t) + k) % 3) * 0.3)
		kit.box("crop" if k % 2 == 0 else "soil", Vector3(0, 0.0, z), Vector3(half * 2.0, 0.025, 1.56 / rows - 0.01), crop * tint)
	kit.box("timber", Vector3(0.12, 0.025, 0.05), Vector3(0.2, 0.12, 0.14), tint * Color(0.85, 0.55, 0.45))
	kit.gable("roof_slate", Vector3(0.12, 0.145, 0.05), 0.14, 0.2, 0.08, tint, PI * 0.5)
	kit.cylinder("concrete", Vector3(-0.02, 0.025, 0.08), 0.04, 0.2, 8, tint, 0.0)


func _ore_outcrop(kit: MeshKit, rng: RandomNumberGenerator, tint: Color) -> void:
	for k in 4:
		var p := Vector3(rng.randf_range(-0.5, 0.5), 0.0, rng.randf_range(-0.5, 0.5))
		kit.box("ore", p, Vector3(0.08, 0.06 + rng.randf() * 0.06, 0.07), tint, rng.randf() * TAU)


# ------------------------------------------------------------------ ruins
func _build_ruins() -> void:
	var sig := str(world.ruins)
	if sig == ruin_sig:
		return
	ruin_sig = sig
	var g := world.grid
	var kit := MeshKit.new()
	if world.ruins.is_empty():
		ruin_inst.mesh = null
		return
	ruin_anchor = g.center(int(world.ruins[0][0]))
	for r in world.ruins:
		var t := int(r[0])
		var c2 := g.center(t)
		var lc := Vector3(ruin_anchor.x + g.dx_wrap(ruin_anchor.x, c2.x), world.tile_height(t), c2.y)
		var rng := RandomNumberGenerator.new()
		rng.seed = t
		var overgrown := (int(r[2]) & 4) != 0
		kit.set_frame(lc, 0.0)
		kit.hex_plate("soil", Vector3(0, 0.01, 0), 0.7, Color(0.7, 0.68, 0.64), 0.2)
		for k in 7:
			var p := Vector3(rng.randf_range(-0.4, 0.4), 0.01, rng.randf_range(-0.4, 0.4))
			kit.box("stone" if k % 2 == 0 else "char", p, Vector3(0.1 + rng.randf() * 0.1, 0.04 + rng.randf() * 0.08, 0.08 + rng.randf() * 0.1), Color(0.7, 0.68, 0.64), rng.randf() * TAU)
		kit.box("brick", Vector3(-0.15, 0.01, 0.1), Vector3(0.3, 0.18 + rng.randf() * 0.1, 0.04), Color(0.6, 0.55, 0.5), 0.3)
		if overgrown:
			kit.cone("foliage", Vector3(0.2, 0.01, -0.1), 0.12, 0.2, 6)
	ruin_inst.mesh = kit.commit()
