class_name WildlifePresentation
extends Node3D
## Decorative life at close zoom: livestock grazing the fields of visible, working farms and a few
## bird flocks wheeling over known countryside. Purely cosmetic and bounded: no collision, cover,
## paths or information. Animals only appear on farms the viewer can currently see; flocks only
## over known land, keep clear of storms and scatter away from recent fighting.

const MAX_ANIMALS := 96
const FLOCKS := 3
const BIRDS_PER_FLOCK := 7
const ZOOM_LIMIT := 26.0

var world: WorldState
var cam: CameraController
var composition: WorldCompositionSystem
var audio: AudioDirector
var settlements: SettlementRenderer
var animals: MultiMeshInstance3D
var boats: MultiMeshInstance3D
var deer: MultiMeshInstance3D
var woods: Array = []          # [centre Vector2, tile] forest hexes in view
var beams: MultiMeshInstance3D
var wells: Array = []          # [site transform, phase]
var harbours: Array = []       # [water point Vector2, phase, fishing]
var birds: MultiMeshInstance3D
var farm_scan := 0.0
var farms: Array = []          # [id, center Vector2, ground y]
var time := 0.0


func setup(w: WorldState, camera: CameraController, comp: WorldCompositionSystem) -> void:
	world = w; cam = camera; composition = comp
	animals = _multimesh(_animal_mesh(), MAX_ANIMALS)
	birds = _multimesh(_bird_mesh(), FLOCKS * BIRDS_PER_FLOCK)
	boats = _multimesh(_boat_mesh(), 24)
	deer = _multimesh(_deer_mesh(), 24)
	beams = _multimesh(_beam_mesh(), 32)


func _multimesh(mesh: Mesh, count: int) -> MultiMeshInstance3D:
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.use_colors = true
	mm.mesh = mesh
	mm.instance_count = count
	mm.visible_instance_count = 0
	var node := MultiMeshInstance3D.new()
	node.multimesh = mm
	node.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(node)
	return node


func _animal_mesh() -> ArrayMesh:
	var k := MeshKit.new()
	k.box("canvas", Vector3(0, 0.022, 0), Vector3(0.07, 0.035, 0.034))          # body
	k.box("canvas", Vector3(0.042, 0.036, 0), Vector3(0.022, 0.02, 0.018))     # head
	for x in [-0.024, 0.024]:
		for z in [-0.011, 0.011]:
			k.box("char", Vector3(x, 0.0, z), Vector3(0.007, 0.022, 0.007))       # legs
	return k.commit()


func _bird_mesh() -> ArrayMesh:
	var k := MeshKit.new()
	# a shallow V of two thin wings; the flap is a per-instance vertical squash
	k.quad("char", Vector3(0, 0, -0.004), Vector3(0, 0, 0.004), Vector3(-0.035, 0.012, 0.03), Vector3(-0.035, 0.012, 0.022), Color(0.25, 0.25, 0.26), Vector3.UP)
	k.quad("char", Vector3(0, 0, 0.004), Vector3(0, 0, -0.004), Vector3(-0.035, 0.012, -0.03), Vector3(-0.035, 0.012, -0.022), Color(0.25, 0.25, 0.26), Vector3.UP)
	return k.commit()


func _process(dt: float) -> void:
	if world == null or not world.ready_ or world.grid == null or cam.size > ZOOM_LIMIT:
		for node in [animals, birds, boats, beams, deer]: node.multimesh.visible_instance_count = 0
		return
	time += dt * (0.0 if world.paused else 1.0)
	farm_scan -= dt
	if farm_scan <= 0.0:
		farm_scan = 0.6
		_scan_farms()
	_update_animals()
	_update_birds()
	_update_boats()
	_update_beams()
	_update_deer()


func _scan_farms() -> void:
	farms.clear(); wells.clear(); harbours.clear(); woods.clear()
	var g := world.grid
	var focus := Vector2(cam.focus.x, cam.focus.z)
	var radius := cam.size * 0.9
	for b in world.buildings.values():
		if str(b.ty) != "farm" or int(b.get("d", 0)) != 1 or int(b.get("hp", 100)) < 40 or int(b.get("mem", 0)) == 1: continue
		var t := int(b.t)
		if not world.is_visible(t): continue
		var c := g.center(t)
		if Vector2(g.dx_wrap(focus.x, c.x), c.y - focus.y).length() > radius: continue
		farms.append([int(b.id), c, t])
		if farms.size() * 4 >= MAX_ANIMALS: break
	for b in world.buildings.values():
		var t := int(b.t)
		if int(b.get("mem", 0)) == 1 or int(b.get("d", 0)) != 1 or not world.is_visible(t): continue
		var c := g.center(t)
		if Vector2(g.dx_wrap(focus.x, c.x), c.y - focus.y).length() > radius: continue
		if str(b.ty) == "oil_well" and int(b.get("a", 0)) == 1 and int(b.get("hp", 100)) >= 35 and settlements and wells.size() < 32:
			var site: Dictionary = settlements.site_records.get(int(b.id), {})
			if site.get("valid", false): wells.append([site.transform, float(int(b.id) % 17)])
		elif str(b.ty) == "port" and harbours.size() < 16:
			for d in 6:
				var nb := g.nb[t * 6 + d]
				if nb >= 0 and world.is_sea(nb):
					harbours.append([g.center(nb), float(int(b.id) % 13), false]); break
	# fishing boats over visible fishing grounds
	var fq := g.tile_at(focus.x, focus.y)
	if fq >= 0 and (audio == null or audio.recent_fire < 1.0):
		# a few deer in quiet, visible woodland well away from roads and buildings
		for t in _nearby_tiles(fq, 4):
			if woods.size() >= 6: break
			if world.biome(t) != 4 or not world.is_visible(t) or world.road[t] != 0 or settlements and settlements.building_at(t) >= 0: continue
			var pick := RandomNumberGenerator.new(); pick.seed = hash([world.world_seed, t, "deer"])
			if pick.randf() < 0.18: woods.append([g.center(t), t])
	if fq >= 0:
		for t in _nearby_tiles(fq, 5):
			if harbours.size() >= 24: break
			if world.deposit(t) == 6 and world.is_visible(t) and world.is_sea(t):
				harbours.append([g.center(t), float(t % 11), true])


func _update_animals() -> void:
	var mm := animals.multimesh
	var g := world.grid
	var n := 0
	for farm in farms:
		var id: int = farm[0]
		var center: Vector2 = farm[1]
		var rng := RandomNumberGenerator.new()
		rng.seed = hash([id, "herd"])
		var cattle := rng.randf() < 0.45
		var herd_angle := rng.randf() * TAU
		for k in 4:
			var phase := rng.randf() * TAU
			var spot := Vector2.from_angle(herd_angle + rng.randf_range(-0.6, 0.6)) * rng.randf_range(0.36, 0.58)
			# slow wandering with long pauses while grazing
			var walk := sin(time * 0.045 + phase)
			var offset := Vector2(sin(time * 0.03 + phase), cos(time * 0.025 + phase * 1.7)) * 0.06
			var p := center + spot + offset
			var velocity := Vector2(cos(time * 0.03 + phase) * 0.03, -sin(time * 0.025 + phase * 1.7) * 0.025)
			var heading := atan2(-velocity.y, velocity.x) if absf(walk) > 0.3 else phase
			var x := g.near_x(p.x, cam.focus.x)
			var y := world.ground_height(p.x, p.y)
			var s := 1.25 if cattle else 1.0
			mm.set_instance_transform(n, Transform3D(Basis(Vector3.UP, heading).scaled(Vector3.ONE * s), Vector3(x, y, p.y)))
			mm.set_instance_color(n, Color(0.42, 0.3, 0.22) if cattle and k % 2 == 0 else Color(0.2, 0.18, 0.17) if cattle else Color(0.93, 0.91, 0.86))
			n += 1
	mm.visible_instance_count = n


func _update_birds() -> void:
	var mm := birds.multimesh
	var g := world.grid
	var n := 0
	var calm := audio == null or audio.recent_fire < 2.0
	for f in FLOCKS:
		# each flock circles a slowly wandering point near the camera for a while, then moves on
		var epoch := floori((time + f * 23.0) / 70.0)
		var rng := RandomNumberGenerator.new()
		rng.seed = hash([world.world_seed, f, epoch])
		var anchor := Vector2(cam.focus.x, cam.focus.z) + Vector2(rng.randf_range(-1, 1), rng.randf_range(-0.7, 0.7)) * cam.size * 0.45
		var tile := g.tile_at(anchor.x, anchor.y)
		if tile < 0 or not world.known[tile] or world.is_sea(tile) or not calm: continue
		if composition and float(composition.weather.at_tile(tile).get("storm", 0.0)) > 0.3: continue
		var life := fposmod(time + f * 23.0, 70.0)
		if life > 52.0: continue                       # flocks come and go
		var radius := rng.randf_range(1.2, 2.6)
		var speed := rng.randf_range(0.18, 0.3) * (1.0 if rng.randf() < 0.5 else -1.0)
		var altitude := world.ground_height(anchor.x, anchor.y) + rng.randf_range(1.0, 1.8)
		for k in BIRDS_PER_FLOCK:
			var lag := k * 0.05 + rng.randf() * 0.03
			var a := time * speed - lag
			var wobble := Vector2(sin(time * 1.3 + k), cos(time * 1.1 + k * 2.0)) * 0.12
			var p := anchor + Vector2(cos(a), sin(a)) * (radius + (k % 3) * 0.12) + wobble
			var tangent := Vector2(-sin(a), cos(a)) * signf(speed)
			var flap := 0.6 + 0.4 * sin(time * 9.0 + k * 1.7)
			var basis := Basis(Vector3.UP, atan2(-tangent.y, tangent.x)).scaled(Vector3(1.0, flap, 1.0) * 1.3)
			mm.set_instance_transform(n, Transform3D(basis, Vector3(g.near_x(p.x, cam.focus.x), altitude + sin(time * 0.7 + k) * 0.08, p.y)))
			mm.set_instance_color(n, Color(1, 1, 1))
			n += 1
	mm.visible_instance_count = n


func _nearby_tiles(center: int, radius: int) -> Array:
	var out := [center]; var frontier := [center]; var seen := {center: true}
	for step in radius:
		var next := []
		for t in frontier:
			for d in 6:
				var nb := world.grid.nb[int(t) * 6 + d]
				if nb >= 0 and not seen.has(nb): seen[nb] = true; next.append(nb); out.append(nb)
		frontier = next
	return out


func _boat_mesh() -> ArrayMesh:
	var k := MeshKit.new()
	k.box("timber", Vector3(0, 0, 0), Vector3(0.12, 0.025, 0.045), Color(0.75, 0.62, 0.48))
	k.box("steel", Vector3(-0.02, 0.025, 0), Vector3(0.04, 0.03, 0.035), Color(0.9, 0.9, 0.86))
	k.box("steel", Vector3(-0.02, 0.055, 0), Vector3(0.004, 0.06, 0.004), Color(0.4, 0.4, 0.4))
	return k.commit()


func _beam_mesh() -> ArrayMesh:
	# walking beam pivoting at the origin, horse head at +x
	var k := MeshKit.new()
	k.box("steel", Vector3(0.0, -0.012, 0), Vector3(0.32, 0.025, 0.03), Color(0.92, 0.72, 0.22))
	k.box("steel", Vector3(0.16, -0.05, 0), Vector3(0.04, 0.08, 0.035), Color(0.35, 0.35, 0.35))
	return k.commit()


func _update_boats() -> void:
	var mm := boats.multimesh; var g := world.grid; var n := 0
	for h in harbours:
		if n >= mm.instance_count: break
		var c: Vector2 = h[0]; var phase: float = h[1]
		var a := time * (0.05 if h[2] else 0.08) + phase
		var p := c + Vector2(cos(a), sin(a) * 0.7) * (0.35 if h[2] else 0.28)
		var level := world.water_level(g.tile_at(p.x, p.y))
		if level <= -1e6: continue
		var heading := atan2(-cos(a) * 0.7, -sin(a))
		var bob := Basis(Vector3.FORWARD, sin(time * 1.3 + phase) * 0.05) * Basis(Vector3.UP, heading)
		mm.set_instance_transform(n, Transform3D(bob, Vector3(g.near_x(p.x, cam.focus.x), level + 0.01 + sin(time * 1.1 + phase) * 0.006, p.y)))
		mm.set_instance_color(n, Color(1, 1, 1)); n += 1
	mm.visible_instance_count = n


func _update_beams() -> void:
	var mm := beams.multimesh; var n := 0
	for w in wells:
		var frame: Transform3D = w[0]
		var pivot := frame * Vector3(0.01, 0.19, 0)
		pivot.x = world.grid.near_x(pivot.x, cam.focus.x)
		var rock := sin(time * 1.6 + float(w[1])) * 0.28
		var basis := frame.basis * Basis(Vector3.BACK, rock)
		mm.set_instance_transform(n, Transform3D(basis, pivot)); mm.set_instance_color(n, Color(1, 1, 1)); n += 1
	mm.visible_instance_count = n


func _deer_mesh() -> ArrayMesh:
	var k := MeshKit.new()
	var coat := Color(0.55, 0.40, 0.28)
	k.box("canvas", Vector3(0, 0.035, 0), Vector3(0.06, 0.028, 0.024), coat)
	k.box("canvas", Vector3(0.036, 0.058, 0), Vector3(0.016, 0.03, 0.014), coat)          # neck/head
	for x in [-0.022, 0.022]:
		for z in [-0.008, 0.008]: k.box("canvas", Vector3(x, 0.0, z), Vector3(0.006, 0.035, 0.006), coat.darkened(0.2))
	return k.commit()


func _update_deer() -> void:
	var mm := deer.multimesh; var g := world.grid; var n := 0
	for w in woods:
		var c: Vector2 = w[0]
		var rng := RandomNumberGenerator.new(); rng.seed = hash([int(w[1]), "herd"])
		for k in 3:
			if n >= mm.instance_count: break
			var phase := rng.randf() * TAU
			var spot := Vector2.from_angle(rng.randf() * TAU) * rng.randf_range(0.1, 0.5)
			var p := c + spot + Vector2(sin(time * 0.04 + phase), cos(time * 0.035 + phase)) * 0.08
			var heading := phase + sin(time * 0.05 + phase) * 1.2
			mm.set_instance_transform(n, Transform3D(Basis(Vector3.UP, heading), Vector3(g.near_x(p.x, cam.focus.x), world.ground_height(p.x, p.y), p.y)))
			mm.set_instance_color(n, Color(1, 1, 1)); n += 1
	mm.visible_instance_count = n
