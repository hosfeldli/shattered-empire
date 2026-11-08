class_name CombatRenderer
extends Node3D
## The battlefield as the server reports it: persistent craters, scorched ground, wrecks, trench
## lines (fieldworks) and drifting smoke, rebuilt when the battlefield state changes; and the combat
## event stream (fire, launch, impact, hit, kill) as short-lived effects: muzzle flashes, tracers,
## shells on ballistic arcs, explosions and dust. Effects are cosmetic only; outcomes come from
## the server.

const SQRT3 := HexGrid.SQRT3
const MAX_FX := 220

var terrain:WorldRenderer
var world: WorldState
var cam: CameraController
var bf_version := -1
var fw_version := -1
var defense_version:=-1
var defense_signature:=""
var trench_geo_version:=-1
var field: MeshInstance3D       # craters, scorch, wrecks
var trenches: MeshInstance3D
var smoke: MultiMeshInstance3D
var field_anchor := Vector2.ZERO
var trench_anchor := Vector2.ZERO
var smoke_list: Array = []      # [x, z, density]
var fx: Array = []              # { node, t, life, kind, a: Vector3, b: Vector3, h }
var fx_pool: Array = []
var events_seen := 0
var flash_mesh: SphereMesh
var shell_mesh: SphereMesh
var composition: WorldCompositionSystem
var director: CombatPresentationDirector
var military: MilitaryRenderer
var squads: SquadPresentation
var dust_clock := 0.0
var smoke_field := SmokeField.new()
const DIRECT_FIRE := ["cannon", "fortgun"]
const ROCKETS := ["rockets", "missile", "warhead", "drone_strike", "aam"]
var audio: AudioDirector


func setup(w: WorldState, c: CameraController) -> void:
	world = w
	cam = c
	field = MeshInstance3D.new()
	field.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(field)
	trenches = MeshInstance3D.new()
	trenches.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(trenches)
	smoke = MultiMeshInstance3D.new()
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.use_colors = true
	var puff := SphereMesh.new()
	puff.radius = 0.25
	puff.height = 0.35
	puff.radial_segments = 16
	puff.rings = 8
	puff.material = MaterialLibrary.smoke(Color(0.62, 0.6, 0.57), 0.45)
	mm.mesh = puff
	mm.instance_count = 600
	mm.visible_instance_count = 0
	smoke.multimesh = mm
	smoke.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(smoke)
	flash_mesh = SphereMesh.new()
	flash_mesh.radius = 0.5
	flash_mesh.height = 1.0
	flash_mesh.radial_segments = 14
	flash_mesh.rings = 7
	shell_mesh = SphereMesh.new()
	shell_mesh.radius = 0.025
	shell_mesh.height = 0.05
	shell_mesh.radial_segments = 6
	shell_mesh.rings = 3
	shell_mesh.material = MaterialLibrary.get_mat("char")
	world.combat_events.connect(_on_events)
	world.welcomed.connect(_clear)
	world.reset.connect(_clear)


func _clear() -> void:
	bf_version = -1
	fw_version = -1
	defense_version=-1; defense_signature=""; trench_geo_version=-1
	trenches.mesh=null
	field.mesh=null; smoke_list.clear(); smoke_field.clear(); smoke.multimesh.visible_instance_count=0
	if terrain: terrain.terrain_mat.set_shader_parameter("trench_active",0.0)
	for e in fx:
		(e.node as MeshInstance3D).transparency = 0.0
		(e.node as Node3D).scale = Vector3.ONE
		(e.node as Node3D).visible = false
		fx_pool.append(e.node)
	fx.clear()


func update(dt: float) -> void:
	if world.grid == null:
		return
	if bf_version != world.bf_version:
		bf_version = world.bf_version
		_build_field()
	if defense_version!=world.buildings_version:
		defense_version=world.buildings_version
		var records:=[]
		for building:Dictionary in world.buildings.values():
			if building.ty in ["guard_post","bunker","fort","aa_battery"]: records.append([building.id,building.t,building.o,building.get("d",0),building.get("st","")=="ruined"])
		var next:=str(records)
		if next!=defense_signature: defense_signature=next; fw_version=-1
	if fw_version != world.fw_version or trench_geo_version!=world.geo_version:
		fw_version = world.fw_version
		trench_geo_version=world.geo_version
		_build_trenches()
	# Hiding the works must hide their terrain cut too, otherwise a debug/LOD hide leaves holes.
	if terrain: terrain.terrain_mat.set_shader_parameter("trench_active",1.0 if visible and not world.fw.is_empty() else 0.0)
	var g := world.grid
	var cx := cam.focus.x
	field.position = Vector3(g.near_x(field_anchor.x, cx) - field_anchor.x, 0, 0)
	trenches.position = Vector3(g.near_x(trench_anchor.x, cx) - trench_anchor.x, 0, 0)
	_update_smoke()
	_update_fx(dt)
	_vehicle_dust(dt)


func _local(t: int, anchor: Vector2) -> Vector3:
	var c := world.grid.center(t)
	return Vector3(anchor.x + world.grid.dx_wrap(anchor.x, c.x), world.tile_height(t), c.y)


# ------------------------------------------------------------------ persistent battlefield
func _build_field() -> void:
	var bf := world.bf
	var kit := MeshKit.new()
	var craters: Array = bf.get("c", [])
	var wrecks: Array = bf.get("w", [])
	var scorch: Array = bf.get("i", [])
	_collect_smoke(bf,wrecks)
	var first := -1
	for list in [craters, wrecks, scorch]:
		if not (list as Array).is_empty():
			first = int(list[0][0])
			break
	if first < 0:
		field.mesh = null
		return
	field_anchor = world.grid.center(first)
	# The continuous terrain scar field supplies disturbed soil; separate raised soil disks
	# duplicate it and make a battlefield look like a collection of molehills.
	# Physical crater depressions live in the locally rebuilt terrain, not raised marker meshes.
	for wr in wrecks:
		var t := int(wr[0])
		var p := _local(t, field_anchor)
		var rng := RandomNumberGenerator.new()
		rng.seed = t * 17 + int(str(wr[1]).hash() % 97)
		var off := Vector3(rng.randf_range(-0.4, 0.4), 0, rng.randf_range(-0.4, 0.4))
		var y := world.ground_height(p.x + off.x, p.z + off.z)
		kit.set_frame(Vector3(p.x + off.x, y, p.z + off.z), rng.randf() * TAU)
		_wreck(kit, str(wr[1]), int(wr[2]) == 1, rng)
	field.mesh = kit.commit() if not kit.is_empty() else null


## Recognizable remains by recorded unit type (warzone brief §9): burnt, broken and settled,
## never a generic box. Burning wrecks (server state) glow at their core.
func _wreck(kit: MeshKit, type: String, burning: bool, rng: RandomNumberGenerator) -> void:
	var burnt := Color(0.42, 0.38, 0.34); var rust := Color(0.5, 0.36, 0.26)
	match type:
		"tank", "autonomous_tank", "sp_artillery", "mech_infantry":
			kit.box("char", Vector3(0, 0, 0), Vector3(0.3, 0.06, 0.17), burnt)
			for z in [-0.075, 0.075]: kit.box("char", Vector3(0, 0, z), Vector3(0.31, 0.035, 0.03), Color(0.3, 0.29, 0.28))
			if type != "mech_infantry":
				# the turret blown off and lying beside the hull, its barrel askew
				var thrown := Vector3(rng.randf_range(0.12, 0.2), 0, rng.randf_range(-0.16, 0.16))
				kit.box("char", thrown, Vector3(0.11, 0.045, 0.1), burnt, rng.randf() * TAU)
				kit.box("steel", thrown + Vector3(0.07, 0.02, 0.02), Vector3(0.16, 0.013, 0.013), Color(0.35, 0.33, 0.31), rng.randf_range(-0.6, 0.6))
			else:
				kit.box("char", Vector3(-0.02, 0.06, 0), Vector3(0.18, 0.04, 0.14), burnt)
		"armored_car", "air_defense", "scout_buggy", "supply_truck", "missile_battery":
			kit.box("char", Vector3(0, 0.02, 0), Vector3(0.24, 0.05, 0.12), rust, 0.08)
			for x in [-0.08, 0.08]:
				for z in [-0.065, 0.065]: kit.cylinder("char", Vector3(x, 0, z), 0.025, 0.012, 6, Color(0.2, 0.2, 0.2))
			if type == "supply_truck": kit.box("steel", Vector3(-0.05, 0.07, 0), Vector3(0.12, 0.012, 0.12), Color(0.45, 0.42, 0.38), 0.2)
		"helicopter":
			kit.box("char", Vector3(0, 0, 0), Vector3(0.22, 0.06, 0.07), burnt, 0.3)
			kit.box("char", Vector3(-0.17, 0.0, 0.03), Vector3(0.14, 0.02, 0.02), burnt, 0.6)
			kit.box("steel", Vector3(0.05, 0.065, 0.0), Vector3(0.3, 0.004, 0.02), Color(0.3, 0.3, 0.3), 1.1)
		"fighter", "bomber", "recon_drone", "oneway_drone":
			var s := 1.4 if type == "bomber" else 1.0 if type == "fighter" else 0.5
			kit.box("char", Vector3(0, 0, 0), Vector3(0.24 * s, 0.03, 0.05 * s), burnt)
			kit.box("char", Vector3(0.12 * s, 0, 0.12 * s), Vector3(0.1 * s, 0.01, 0.16 * s), burnt, 0.5)
			for k in 4: kit.box("steel", Vector3(rng.randf_range(-0.3, 0.3), 0, rng.randf_range(-0.25, 0.25)), Vector3(0.04, 0.008, 0.03), Color(0.5, 0.5, 0.5), rng.randf() * TAU)
		"field_gun":
			kit.box("char", Vector3(0, 0.0, 0), Vector3(0.1, 0.04, 0.12), burnt)
			kit.box("steel", Vector3(0.08, 0.03, 0), Vector3(0.18, 0.014, 0.014), Color(0.35, 0.33, 0.31), 0.35)
			kit.cylinder("char", Vector3(0, 0, 0.08), 0.03, 0.01, 8, Color(0.2, 0.2, 0.2))
		_:
			kit.box("char", Vector3(0, 0, 0), Vector3(0.22, 0.05, 0.13), burnt)
			kit.box("steel", Vector3(0.09, 0.06, 0.04), Vector3(0.12, 0.014, 0.014), Color(0.4, 0.38, 0.36), 0.7)
	for k in 3:   # small scattered debris; settled, not simulated
		kit.box("steel", Vector3(rng.randf_range(-0.25, 0.25), 0, rng.randf_range(-0.22, 0.22)), Vector3(0.03, 0.01, 0.025), Color(0.4, 0.38, 0.35), rng.randf() * TAU)
	if burning: kit.box("glow:ff7a2a", Vector3(0, 0.03, 0), Vector3(0.12, 0.05, 0.08), Color.WHITE)


## Irregular terrain-following marks are intentionally flat; true depressions require a shared
## terrain deformation field, not stacked cylinders pretending to be holes.
func _crater_mark(kit:MeshKit,center:Vector2,radius:float,rng:RandomNumberGenerator) -> void:
	var inner:=Color(.34,.29,.24); var outer:=Color(.64,.58,.48)
	var middle:=Vector3(center.x,world.ground_height(center.x,center.y)+.022,center.y)
	var rim:Array[Vector3]=[]
	var rotation:=rng.randf()*TAU
	for i in 9:
		var angle:=rotation+TAU*float(i)/9.0
		var point:=center+Vector2(cos(angle),sin(angle))*radius*rng.randf_range(.7,1.25)
		rim.append(Vector3(point.x,world.ground_height(point.x,point.y)+.022,point.y))
	for i in 9:
		kit.tri_colors("soil",middle,rim[i],rim[(i+1)%9],inner,outer,outer,Vector3.UP)


func _collect_smoke(bf:Dictionary,wrecks:Array) -> void:
	smoke_list.clear()
	for s in bf.get("s", []):
		var c := world.grid.center(int(s[0]))
		smoke_list.append([c.x, c.y, float(s[1]) / 10.0, int(s[0])])
	for wr in wrecks:
		if int(wr[2]) == 1:
			var c := world.grid.center(int(wr[0]))
			smoke_list.append([c.x, c.y, 0.5, int(wr[0])])


## Continuous terrain-aware defensive works; the shader cuts only the received route.
func _build_trenches() -> void:
	if terrain: terrain.terrain_mat.set_shader_parameter("trench_active",0.0)
	if world.fw.is_empty(): trenches.mesh=null; return
	trench_anchor=world.grid.center(int(world.fw[0][0]))
	var result:=TrenchPresentation.build(world,trench_anchor)
	trenches.mesh=result.mesh
	if terrain:
		terrain.terrain_mat.set_shader_parameter("trench_routes",result.mask)
		terrain.terrain_mat.set_shader_parameter("trench_cells",Vector2(world.grid.w,world.grid.h))
		terrain.terrain_mat.set_shader_parameter("trench_active",1.0)


func _update_smoke() -> void:
	# Close and operational views use the simulated smoke field; strategic views keep light puffs.
	if cam.size < 40.0:
		_update_smoke_field(); return
	smoke_field.clear()
	var mm := smoke.multimesh
	var g := world.grid
	var cx := cam.focus.x
	var now := Time.get_ticks_msec() / 1000.0
	var n := 0
	var cap := mm.instance_count if cam.size < 40.0 else 300 if cam.size < 100.0 else 120
	if composition: cap = mini(cap, composition.lod.budget("battle_puffs",cam.size))
	for s in smoke_list:
		var count := clampi(int(float(s[2]) * 6.0) + 1, 1, 6)
		for k in count:
			if n >= cap:
				break
			var ph := float(int(s[3]) % 101) * 0.37 + k * 1.7
			var drift := Vector2(sin(now * 0.13 + ph), cos(now * 0.11 + ph * 1.3)) * 0.35
			if composition: drift += composition.weather.wind * (k * .12)
			var x := g.near_x(float(s[0]) + drift.x, cx)
			var z := float(s[1]) + drift.y
			var y := maxf(world.ground_height(x, z), 0.0) + 0.15 + 0.12 * k + 0.05 * sin(now * 0.5 + ph)
			var sc := 0.7 + 0.5 * float(s[2]) + 0.15 * sin(now * 0.3 + ph)
			mm.set_instance_transform(n, Transform3D(Basis().scaled(Vector3(sc * 1.4, sc, sc * 1.4)), Vector3(x, y, z)))
			mm.set_instance_color(n, Color(1, 1, 1, clampf(float(s[2]), 0.3, 1.0)))
			n += 1
	mm.visible_instance_count = n


func _update_smoke_field() -> void:
	var g := world.grid
	var period := g.period if g.wrap else 0.0
	smoke_field.recentre(Vector2(cam.focus.x, cam.focus.z), period)
	var sources := []
	for s in smoke_list: sources.append([float(s[0]), float(s[1]), float(s[2])])
	var wind := composition.weather.wind_at_world(Vector2(cam.focus.x, cam.focus.z)) if composition else Vector2(.3, .1)
	smoke_field.step(get_process_delta_time() if is_inside_tree() else 1.0 / 60.0, sources, wind, period)
	var mm := smoke.multimesh
	var cap := mini(mm.instance_count, composition.lod.budget("battle_puffs", cam.size) if composition else 400)
	var n := 0
	var now := Time.get_ticks_msec() / 1000.0
	for p in smoke_field.puffs(cap):
		var x := g.near_x(float(p[0]), cam.focus.x); var z := float(p[1]); var v := float(p[2])
		var jitter := float(posmod(int(p[3]) * 7919, 100)) / 100.0
		var y := maxf(world.ground_height(x, z), 0.0) + 0.12 + v * 0.35 + 0.04 * sin(now * 0.6 + jitter * 6.0)
		var sc := 0.45 + minf(v, 1.0) * 0.9 + jitter * 0.2
		mm.set_instance_transform(n, Transform3D(Basis(Vector3.UP, jitter * TAU).scaled(Vector3(sc * 1.3, sc * 0.8, sc * 1.3)), Vector3(x + (jitter - .5) * .1, y, z)))
		mm.set_instance_color(n, Color(1, 1, 1, clampf(v, 0.15, 0.9)))
		n += 1
	mm.visible_instance_count = n


# ------------------------------------------------------------------ transient effects
func _on_events(ev: Array) -> void:
	var g := world.grid
	if director: ev=director.select(ev)
	if audio: audio.present(ev)
	var period := g.period if g.wrap else 0.0
	for e in ev:
		events_seen += 1
		var k := str(e.get("k", ""))
		var a := int(e.get("a", -1))
		var b := int(e.get("b", -1))
		# feed the smoke field from the same authorized, visible events
		if cam.size < 40.0:
			if k == "impact" and b >= 0:
				var at := g.center(b); smoke_field.add(at, 0.9 if float(e.get("r", 0)) > 0.0 else 0.45, 2, period)
			elif k in ["kill", "bkill"] and b >= 0:
				smoke_field.add(g.center(b), 1.0, 2, period)
			elif k in ["fire", "launch"] and a >= 0 and _weapon(e) in ["cannon", "fortgun", "howitzer", "mortar", "rockets"]:
				smoke_field.add(g.center(a), 0.35, 1, period)
		match k:
			"fire":
				var weapon := _weapon(e)
				if a >= 0:
					_spawn("flash", _source_point(e,0.12), Vector3.ZERO, 0.09, Color(1.0, 0.85, 0.45), 0.09)
					if cam.size<35: _spawn("smoke",_source_point(e,.12),Vector3.ZERO,1.5,Color(.58,.57,.54),.12)
				if a >= 0 and b >= 0 and g.dist(a, b) <= 3:
					# weapon-matched fire: single rifle tracers, machine-gun volleys, heavy cannon tracers
					var rounds := 1
					var tint := Color(1.0, 0.9, 0.6)
					var spacing := 0.07
					if weapon in ["mg", "mg_light"]: rounds = clampi(int(e.get("x", 4)), 3, 6)
					elif weapon in ["autocannon", "flak", "airburst"]: rounds = 3; tint = Color(1.0, 0.65, 0.3); spacing = 0.13
					# aim at the target's actual soldiers (or vehicle) with weapon spread; some rounds miss long
					var spread := .02 if weapon == "rifle" else .05 if weapon in ["mg", "mg_light"] else .03
					var source := _source_point(e,0.1)
					for shot in rounds:
						var aim := _aim_point(e, b, shot)
						aim += Vector3(randf_range(-spread, spread), randf_range(-spread * .4, spread * .6), randf_range(-spread, spread))
						if randf() < .25: aim = source.lerp(aim, 1.35)        # an overshoot ricochets past
						_spawn("tracer", source, aim, 0.15, tint, 0.0)
						if shot > 0 and not fx.is_empty(): fx[fx.size() - 1].t = -spacing * shot
					if weapon in ["flak", "airburst"]:
						for burst in 3: _spawn("smoke", _tile_point(b, 1.1 + burst * .15, burst + 5), Vector3.ZERO, 1.6, Color(.16, .15, .15), .09)
			"launch":
				if a >= 0:
					_spawn("flash", _source_point(e,0.15), Vector3.ZERO, 0.14, Color(1.0, 0.75, 0.35), 0.14)
					if cam.size<35: _spawn("smoke",_source_point(e,.14),Vector3.ZERO,2.2,Color(.52,.50,.47),.20)
				if b >= 0:
					var weapon := _weapon(e)
					if weapon in DIRECT_FIRE and a >= 0:
						# Tank and fortress guns fire flat: a fast straight shot, heavy muzzle blast,
						# ground dust thrown by the blast and recoil on the firing vehicle.
						var muzzle := _source_point(e, 0.1)
						var aim := _tile_point(b, 0.07)
						_spawn("flash", muzzle, Vector3.ZERO, 0.12, Color(1.0, 0.9, 0.55), 0.2)
						_spawn("dust", muzzle - Vector3(0, 0.07, 0), Vector3.ZERO, 1.1, Color(0.62, 0.56, 0.47), 0.22)
						_spawn("shell", muzzle, aim, clampf(float(g.dist(a, b)) * 0.06, 0.08, 0.35), Color.WHITE, 0.0)
						_spawn("tracer", muzzle, aim, 0.12, Color(1.0, 0.8, 0.45), 0.0)
						if military and int(e.get("sb", 0)) == 0: military.recoil(int(e.get("s", -1)))
						if cam.shake_enabled and muzzle.distance_to(cam.focus) < 10: cam.shake_time = maxf(cam.shake_time, .12)
					elif weapon in ROCKETS:
						# rockets and guided missiles fly a flatter, powered path and leave exhaust smoke
						var src := _source_point(e,0.15) if a >= 0 else _tile_point(b, 4.0)
						var flight := clampf(float(e.get("f", 1.0)), 0.3, 4.0)
						_spawn("rocket", src, _tile_point(b, 0.05), flight, Color.WHITE, minf(1.0, 0.25 + float(g.dist(maxi(a, 0), b)) * 0.08))
					else:
						var src := _source_point(e,0.15) if a >= 0 else _tile_point(b, 4.0)
						var flight := clampf(float(e.get("f", 1.0)), 0.3, 6.0)
						_spawn("shell", src, _tile_point(b, 0.05), flight, Color.WHITE, minf(3.0, 0.6 + float(g.dist(maxi(a, 0), b)) * 0.25))
			"impact":
				if b >= 0 and _weapon(e) in DIRECT_FIRE:
					var at := _tile_point(b, 0.08, int(e.get("p", 0)))
					_spawn("blast", at, Vector3.ZERO, 0.22, Color(1.0, 0.75, 0.4), 0.16)
					_spawn("dust", at, Vector3.ZERO, 1.3, Color(0.5, 0.45, 0.38), 0.24)
					if cam.size < 30: _spawn("smoke", at + Vector3(0, .04, 0), Vector3.ZERO, 1.8, Color(.4, .39, .37), .12)
				elif b >= 0:
					var big := float(e.get("r", 0)) > 0.0
					_spawn("blast", _tile_point(b, 0.08, int(e.get("p", 0))), Vector3.ZERO, 0.4 if big else 0.28, Color(1.0, 0.55, 0.2), 0.2 if big else 0.12)
					_spawn("dust", _tile_point(b, 0.1, int(e.get("p", 0))), Vector3.ZERO, 1.6, Color(0.55, 0.5, 0.44), 0.3)
					if big and cam.size<40:
						_spawn("dust", _tile_point(b, 0.08, int(e.get("p", 0))+7), Vector3.ZERO, 1.9, Color(0.47, 0.43, 0.38), 0.22)
						_spawn("smoke",_tile_point(b,.13,int(e.get("p",0))),Vector3.ZERO,2.6,Color(.36,.35,.34),.20)
						_spawn("flame",_tile_point(b,.1,int(e.get("p",0))),Vector3.ZERO,.35,Color(1.0,.28,.06),.13)
			"hit", "bhit":
				if b >= 0:
					_spawn("flash", _tile_point(b, 0.1, int(e.get("t", 0))), Vector3.ZERO, 0.08, Color(1.0, 0.95, 0.75), 0.06)
			"kill", "bkill":
				if b >= 0:
					_spawn("blast", _tile_point(b, 0.1), Vector3.ZERO, 0.55, Color(1.0, 0.48, 0.18), 0.26)
					_spawn("dust", _tile_point(b, 0.15), Vector3.ZERO, 2.4, Color(0.3, 0.28, 0.26), 0.45)
					if cam.size<40:
						_spawn("dust", _tile_point(b, 0.09, 17), Vector3.ZERO, 2.0, Color(0.46, 0.41, 0.35), 0.25)
						_spawn("smoke",_tile_point(b,.14),Vector3.ZERO,3.0,Color(.28,.28,.27),.25)
						_spawn("flame",_tile_point(b,.13),Vector3.ZERO,.75,Color(1.0,.28,.04),.14)


func _weapon(event: Dictionary) -> String:
	var keys: Array = world.defs.get("WEAPON_KEYS", [])
	var index := int(event.get("w", -1))
	return str(keys[index]) if index >= 0 and index < keys.size() else ""


## Use only an authorized, currently rendered source; fog-filtered events intentionally lack it.
func _source_point(event:Dictionary,lift:float) -> Vector3:
	var tile:=int(event.get("a",-1))
	var id:=int(event.get("s",-1))
	# a squad near the camera: the shot leaves one of its actual soldiers
	if int(event.get("sb",0))==0 and squads and id>=0:
		var figure=squads.figure_point(id,int(event.get("i",0))+events_seen,lift*.3)
		if figure!=null: return figure
	if tile>=0 and int(event.get("sb",0))==0 and military and military.draw_positions.has(id) and world.units.has(id):
		var unit:Dictionary=world.units[id]
		if world.grid.dist(int(unit.get("tile",-1)),tile)<=1:
			var pos:Vector3=military.draw_positions[id]
			var target:=int(event.get("b",-1))
			if target>=0:
				var end:=world.grid.center(target)
				var heading:=Vector2(world.grid.dx_wrap(pos.x,end.x),end.y-pos.z).normalized()
				pos.x+=heading.x*.08; pos.z+=heading.y*.08
			return pos+Vector3.UP*lift
	return _tile_point(tile,lift)


## where a round is aimed: a figure of the target squad when simulated, the target unit's drawn
## position otherwise, or a spot on the hex
func _aim_point(e: Dictionary, tile: int, shot: int) -> Vector3:
	var target := int(e.get("t", -1))
	if target >= 0 and int(e.get("tb", 0)) == 0:
		if squads:
			var figure = squads.figure_point(target, shot * 7 + events_seen, .03)
			if figure != null: return figure
		if military and military.draw_positions.has(target): return (military.draw_positions[target] as Vector3) + Vector3.UP * .05
	return _tile_point(tile, 0.06, shot * 13 + int(e.get("i", 0)) % 7)


## a point on hex t (base image), jittered per salt so salvos spread
func _tile_point(t: int, lift: float, salt := 0) -> Vector3:
	var c := world.grid.center(t)
	var h := absi((t * 73 + salt * 151) % 1000) / 1000.0
	var h2 := absi((t * 37 + salt * 271) % 1000) / 1000.0
	var x := c.x + (h - 0.5) * 0.6
	var z := c.y + (h2 - 0.5) * 0.6
	return Vector3(x, maxf(world.ground_height(x, z), 0.0) + lift, z)


## Moving wheeled and tracked vehicles kick up a thin dust trail on dry, unpaved ground at close
## zoom (visible units only; rain and wet ground settle it). Presentation of real movement only.
func _vehicle_dust(dt: float) -> void:
	dust_clock -= dt
	if dust_clock > 0.0 or cam.size > 45.0 or military == null or world.paused: return
	dust_clock = 0.35
	var defs: Dictionary = world.defs.get("UNITS", {})
	var spawned := 0
	for id in military.draw_positions:
		if spawned >= 10 or cam.size > 24.0: break
		var u: Dictionary = world.units.get(id, {})
		if u.is_empty() or int(u.get("next", -1)) < 0: continue
		var d: Dictionary = defs.get(str(u.type), {})
		if bool(d.get("air", false)) or not str(d.get("move", "")) in ["wheeled", "tracked"]: continue
		var t := int(u.tile)
		if not world.is_visible(t) or world.road[t] != 0 or not world.biome(t) in [3, 5, 6, 8, 12]: continue
		if composition and float(composition.weather.at_tile(t).get("wet", 0.0)) > 0.3: continue
		var p: Vector3 = military.draw_positions[id]
		_spawn("smoke", p + Vector3(randf_range(-.04, .04), .02, randf_range(-.04, .04)), Vector3.ZERO, 1.4, Color(.72, .64, .5), .07)
		spawned += 1
	# contrails behind fast aircraft in flight (visible ones only)
	for id in military.draw_positions:
		if spawned >= 16: break
		var u: Dictionary = world.units.get(id, {})
		if u.is_empty() or int(u.get("next", -1)) < 0 or not str(u.type) in ["fighter", "bomber"]: continue
		if int(u.owner) != world.civ_id and not world.is_visible(int(u.tile)): continue
		var p: Vector3 = military.draw_positions[id]
		if p.y < world.ground_height(p.x, p.z) + .6: continue
		_spawn("smoke", p + Vector3(0, -.02, 0), Vector3.ZERO, 2.2, Color(.95, .95, .95), .035)
		spawned += 1


func _spawn(kind: String, a: Vector3, b: Vector3, life: float, col: Color, size: float) -> void:
	if kind in ["dust","explosion"] and cam.shake_enabled and a.distance_to(cam.focus)<12: cam.shake_time=maxf(cam.shake_time,.2)
	if fx.size() >= MAX_FX:
		return
	var node: MeshInstance3D
	if fx_pool.is_empty():
		node = MeshInstance3D.new()
		node.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		add_child(node)
	else:
		node = fx_pool.pop_back()
	match kind:
		"shell", "rocket":
			node.mesh = shell_mesh
			node.material_override = null if kind == "shell" else MaterialLibrary.glow(Color(1.0, 0.8, 0.5), 0.95)
		"tracer":
			var bm := BoxMesh.new()
			bm.size = Vector3(1, 0.012, 0.012)
			node.mesh = bm
			node.material_override = MaterialLibrary.glow(col, 0.9)
		"dust", "smoke":
			node.mesh = flash_mesh
			node.material_override = MaterialLibrary.smoke(col, 0.32 if kind=="smoke" else 0.5)
		_:
			node.mesh = flash_mesh
			node.material_override = MaterialLibrary.glow(col, 0.7)
	node.visible = true
	fx.append({"node": node, "t": 0.0, "life": life, "kind": kind, "a": a, "b": b, "h": size})


func _update_fx(dt: float) -> void:
	var g := world.grid
	var cx := cam.focus.x
	var keep: Array = []
	var trail: Array = []
	for e in fx:
		e.t += dt
		var node: MeshInstance3D = e.node
		var u := clampf(float(e.t) / float(e.life), 0.0, 1.0)
		var a: Vector3 = e.a
		var b: Vector3 = e.b
		var shift := g.near_x(a.x, cx) - a.x
		match str(e.kind):
			"shell":
				var bx := a.x + g.dx_wrap(a.x, b.x)
				var p := Vector3(lerpf(a.x, bx, u), lerpf(a.y, b.y, u) + 4.0 * float(e.h) * u * (1.0 - u), lerpf(a.z, b.z, u))
				node.position = p + Vector3(shift, 0, 0)
				node.scale = Vector3.ONE
			"rocket":
				var bx := a.x + g.dx_wrap(a.x, b.x)
				var p := Vector3(lerpf(a.x, bx, u), lerpf(a.y, b.y, u) + 4.0 * float(e.h) * u * (1.0 - u), lerpf(a.z, b.z, u))
				node.position = p + Vector3(shift, 0, 0)
				node.scale = Vector3.ONE * 0.8
				if u < 1.0 and posmod(int(e.t * 60.0), 3) == 0: trail.append(p)
			"tracer":
				var bx := a.x + g.dx_wrap(a.x, b.x)
				var d := Vector3(bx - a.x, b.y - a.y, b.z - a.z)
				var head := u * 1.3
				var p0 := a + d * clampf(head - 0.3, 0.0, 1.0)
				var p1 := a + d * clampf(head, 0.0, 1.0)
				var seg := p1 - p0
				node.position = (p0 + p1) * 0.5 + Vector3(shift, 0, 0)
				if seg.length() > 1e-4:
					node.basis = Basis(Vector3.UP, atan2(-seg.z, seg.x)).scaled(Vector3(seg.length(), 1, 1))
				else:
					node.scale = Vector3(0.001, 0.001, 0.001)
			"dust":
				var s := float(e.h) * (0.6 + u * 1.6)
				node.position = a + Vector3(shift, u * 0.25, 0)
				node.scale = Vector3(s, s * 0.6, s)
				node.transparency = u
			"smoke":
				var wind:=composition.weather.wind_at_world(Vector2(a.x,a.z)) if composition else Vector2.ZERO
				var drift:=wind*float(e.t)*.12
				var s:=float(e.h)*(.65+u*1.4)
				node.position=a+Vector3(shift+drift.x,u*.35,drift.y)
				node.scale=Vector3(s*1.2,s*.85,s*1.2)
				node.transparency=smoothstep(.35,1.0,u)
			"flame":
				var s:=float(e.h)*(1.0-u)*(.8+.2*sin(float(e.t)*35.0))
				node.position=a+Vector3(shift,u*.12,0)
				node.scale=Vector3(s*.65,s*1.4,s*.65)
				node.transparency=u*.85
			_:
				var s := float(e.h) * (0.5 + u * 0.9)
				node.position = a + Vector3(shift, 0, 0)
				node.scale = Vector3.ONE * s
				node.transparency = u * 0.8
		if float(e.t) >= float(e.life):
			node.visible = false
			node.transparency = 0.0
			node.scale = Vector3.ONE
			fx_pool.append(node)
		else:
			keep.append(e)
	fx = keep
	for point in trail: _spawn("smoke", point, Vector3.ZERO, 1.2, Color(.72, .71, .69), .05)
