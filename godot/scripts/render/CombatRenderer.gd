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
	puff.radial_segments = 8
	puff.rings = 4
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
	flash_mesh.radial_segments = 10
	flash_mesh.rings = 5
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
	field.mesh=null; smoke_list.clear(); smoke.multimesh.visible_instance_count=0
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
	for s in scorch:
		var t := int(s[0])
		var p := _local(t, field_anchor)
		var a := clampf(float(s[1]) / 3.0, 0.2, 1.0)
		var rng := RandomNumberGenerator.new()
		rng.seed = t * 59
		# churned, scorched ground: a few irregular dark patches rather than one plate
		for k in 3 + int(a * 3.0):
			var off := Vector3(rng.randf_range(-0.5, 0.5), 0, rng.randf_range(-0.5, 0.5))
			var y := world.ground_height(p.x + off.x, p.z + off.z)
			kit.set_frame(Vector3(p.x + off.x, y, p.z + off.z), rng.randf() * TAU)
			kit.cylinder("soil", Vector3(0, 0.0, 0), rng.randf_range(0.12, 0.28) * (0.6 + a * 0.5), 0.012, 9, Color(0.55, 0.5, 0.45).lerp(Color(0.3, 0.27, 0.25), a))
	for cr in craters:
		var t := int(cr[0])
		var depth := float(cr[1])
		var p := _local(t, field_anchor)
		var rng := RandomNumberGenerator.new()
		rng.seed = t * 131
		var n := clampi(int(depth * 4.0) + 2, 2, 9)
		for k in n:
			var off := Vector3(rng.randf_range(-0.55, 0.55), 0, rng.randf_range(-0.55, 0.55))
			var r := rng.randf_range(0.06, 0.12) * (0.8 + depth * 0.4)
			var y := world.ground_height(p.x + off.x, p.z + off.z)
			kit.set_frame(Vector3(p.x + off.x, y, p.z + off.z), 0.0)
			# raised rim and a dark pit
			kit.cylinder("soil", Vector3(0, -0.01, 0), r * 1.35, 0.035, 9, Color(0.8, 0.72, 0.62), r * 1.0)
			kit.cylinder("char", Vector3(0, 0.0, 0), r, 0.028, 9, Color(1, 1, 1), r * 0.6)
	for wr in wrecks:
		var t := int(wr[0])
		var p := _local(t, field_anchor)
		var rng := RandomNumberGenerator.new()
		rng.seed = t * 17 + int(str(wr[1]).hash() % 97)
		var off := Vector3(rng.randf_range(-0.4, 0.4), 0, rng.randf_range(-0.4, 0.4))
		var y := world.ground_height(p.x + off.x, p.z + off.z)
		kit.set_frame(Vector3(p.x + off.x, y, p.z + off.z), rng.randf() * TAU)
		kit.box("char", Vector3(0, 0, 0), Vector3(0.28, 0.06, 0.15), Color(0.9, 0.85, 0.8))
		kit.box("char", Vector3(-0.03, 0.06, 0.02), Vector3(0.12, 0.04, 0.1), Color(0.8, 0.75, 0.7), 0.4)
		kit.box("steel", Vector3(0.12, 0.08, 0.06), Vector3(0.16, 0.014, 0.014), Color(0.4, 0.38, 0.36), 0.7)
	field.mesh = kit.commit() if not kit.is_empty() else null


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


# ------------------------------------------------------------------ transient effects
func _on_events(ev: Array) -> void:
	var g := world.grid
	if director: ev=director.select(ev)
	if audio: audio.present(ev)
	for e in ev:
		events_seen += 1
		var k := str(e.get("k", ""))
		var a := int(e.get("a", -1))
		var b := int(e.get("b", -1))
		match k:
			"fire":
				if a >= 0:
					_spawn("flash", _tile_point(a, 0.12), Vector3.ZERO, 0.09, Color(1.0, 0.85, 0.45), 0.09)
					if cam.size<35: _spawn("smoke",_tile_point(a,.12),Vector3.ZERO,1.5,Color(.58,.57,.54),.12)
				if a >= 0 and b >= 0 and g.dist(a, b) <= 3:
					_spawn("tracer", _tile_point(a, 0.1), _tile_point(b, 0.06), 0.15, Color(1.0, 0.9, 0.6), 0.0)
			"launch":
				if a >= 0:
					_spawn("flash", _tile_point(a, 0.15), Vector3.ZERO, 0.14, Color(1.0, 0.75, 0.35), 0.14)
					if cam.size<35: _spawn("smoke",_tile_point(a,.14),Vector3.ZERO,2.2,Color(.52,.50,.47),.20)
				if b >= 0:
					var src := _tile_point(a, 0.15) if a >= 0 else _tile_point(b, 4.0)
					var flight := clampf(float(e.get("f", 1.0)), 0.3, 6.0)
					_spawn("shell", src, _tile_point(b, 0.05), flight, Color.WHITE, minf(3.0, 0.6 + float(g.dist(maxi(a, 0), b)) * 0.25))
			"impact":
				if b >= 0:
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


## a point on hex t (base image), jittered per salt so salvos spread
func _tile_point(t: int, lift: float, salt := 0) -> Vector3:
	var c := world.grid.center(t)
	var h := absi((t * 73 + salt * 151) % 1000) / 1000.0
	var h2 := absi((t * 37 + salt * 271) % 1000) / 1000.0
	var x := c.x + (h - 0.5) * 0.6
	var z := c.y + (h2 - 0.5) * 0.6
	return Vector3(x, maxf(world.ground_height(x, z), 0.0) + lift, z)


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
		"shell":
			node.mesh = shell_mesh
			node.material_override = null
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
