class_name NativeIntroCinematic
extends Control
## The opening cinematic, rendered by the game engine with the game's own models: a real 3D
## scene in its own world (the match world is untouched), shot by a moving camera in eight
## letterboxed beats. The connected old world at dusk; the afternoon the missiles flew; fallout,
## ash and the long winter over the ruins; the land healing; your people's settlement; the rivals
## and their armour on the border; the silo that still stands; the title at dawn. Space or Enter
## (or Esc) skips; the hint stays on screen. Shown on first launch and from the main menu.
signal finished

const LINES := [
	"Once, one connected world ran on light, steel and trust.",
	"When the trust failed, the missiles flew. In a single afternoon the great cities burned.",
	"Fallout drifted for years. The long winter that followed buried the roads, the fields and the old knowledge.",
	"Generations later the poisoned ground is healing. The survivors call this age the Reclamation.",
	"Your people hold a small settlement among the ruins: salvaged tools, a few fields, a handful of scouts.",
	"Others survived too. Some will share a border with you. Some will want what you build.",
	"And in the wasteland the old silos still stand. What was learned once can be learned again.",
	"SHATTERED EMPIRES",
]
const SUBTITLE := "Rebuild a civilization. Command its armies. Reshape a broken world."
const BEAT := 6.0
const HOME := Vector3(9, 0, 7)
const RIVAL := Vector3(-11, 0, -9)
const SILO := Vector3(8, 0, -13)
# camera keyframes per beat: [from position, from target, to position, to target]
const SHOTS := [
	[Vector3(-14, 9, 16), Vector3(0, 0, 0), Vector3(-8, 6, 11), Vector3(0, .5, 0)],
	[Vector3(-6, 12, 22), Vector3(0, 1, 0), Vector3(-2, 14, 24), Vector3(0, 2, 0)],
	[Vector3(6, 5, 9), Vector3(0, .3, 0), Vector3(-3, 4, 8), Vector3(0, .2, 0)],
	[Vector3(-4, 18, 18), Vector3(2, 0, 2), Vector3(4, 16, 20), Vector3(4, 0, 4)],
	[Vector3(15, 6, 15), Vector3(9, 0, 7), Vector3(12, 3.2, 10.5), Vector3(9, .3, 7)],
	[Vector3(-2, 7, 2), Vector3(-11, 0, -9), Vector3(-4, 5, -1), Vector3(-9, 0, -7)],
	[Vector3(12.5, 1.6, -8.5), Vector3(8, .6, -13), Vector3(10.5, 1.0, -10.2), Vector3(8, .9, -13)],
	[Vector3(0, 26, 26), Vector3(0, 0, 0), Vector3(0, 24, 22), Vector3(0, 0, -1)],
]

var clock := 0.0
var done := false
var title_font: Font
var view: SubViewport
var camera: Camera3D
var sun: DirectionalLight3D
var env: Environment
var ground_material: StandardMaterial3D
var old_city: Node3D
var ruins: Node3D
var home: Node3D
var rival: Node3D
var silo_light: OmniLight3D
var trees: Array[Node3D] = []
var tanks: Array[Node3D] = []
var missiles: Array = []     # [head, from, to, delay, flash light, fireball, smoke]
var ash: GPUParticles3D
var overlay: Control


func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_STOP
	title_font = load("res://assets/fonts/BarlowSemiCondensed-SemiBold.ttf")
	var container := SubViewportContainer.new(); container.stretch = true
	container.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); container.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(container)
	view = SubViewport.new(); view.own_world_3d = true; view.msaa_3d = Viewport.MSAA_4X
	container.add_child(view)
	_build_scene()
	overlay = Control.new(); overlay.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); overlay.mouse_filter = Control.MOUSE_FILTER_IGNORE
	overlay.draw.connect(_draw_overlay)
	add_child(overlay)


# ------------------------------------------------------------------ scene
func _build_scene() -> void:
	var world := Node3D.new(); view.add_child(world)
	env = Environment.new()
	env.background_mode = Environment.BG_COLOR; env.background_color = Color(.36, .42, .52)
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR; env.ambient_light_color = Color(.55, .6, .7); env.ambient_light_energy = .6
	env.fog_enabled = true; env.fog_light_color = Color(.55, .58, .64); env.fog_density = .012
	env.tonemap_mode = Environment.TONE_MAPPER_FILMIC; env.glow_enabled = true; env.glow_intensity = .9
	env.adjustment_enabled = true
	var we := WorldEnvironment.new(); we.environment = env; world.add_child(we)
	sun = DirectionalLight3D.new(); sun.rotation_degrees = Vector3(-28, -40, 0); sun.light_energy = 1.0; sun.light_color = Color(1.0, .78, .55)
	sun.shadow_enabled = true; world.add_child(sun)
	camera = Camera3D.new(); camera.fov = 48; camera.far = 300; world.add_child(camera)
	# rolling ground
	var st := SurfaceTool.new(); st.begin(Mesh.PRIMITIVE_TRIANGLES)
	var n := 80; var span := 80.0
	for z in n:
		for x in n:
			for q: Vector2 in [Vector2(x, z), Vector2(x + 1, z), Vector2(x, z + 1), Vector2(x + 1, z), Vector2(x + 1, z + 1), Vector2(x, z + 1)]:
				var p := Vector3(q.x / n * span - span * .5, 0, q.y / n * span - span * .5)
				p.y = _height(p.x, p.z)
				st.add_vertex(p)
	st.generate_normals()
	var ground := MeshInstance3D.new(); ground.mesh = st.commit(); world.add_child(ground)
	ground_material = StandardMaterial3D.new(); ground_material.albedo_color = Color(.36, .45, .3); ground_material.roughness = .95
	ground.material_override = ground_material
	old_city = _city(true); world.add_child(old_city)
	ruins = _city(false); world.add_child(ruins); ruins.visible = false
	home = _settlement(HOME, Color(.28, .5, .9), false); world.add_child(home); home.visible = false
	rival = _settlement(RIVAL, Color(.85, .3, .25), true); world.add_child(rival); rival.visible = false
	var silo := _model_building("missile_silo", "dev", Color(.8, .8, .78), Color.WHITE)
	silo.position = SILO + Vector3(0, _height(SILO.x, SILO.z), 0); silo.scale = Vector3.ONE * 1.6; world.add_child(silo)
	silo_light = OmniLight3D.new(); silo_light.light_color = Color(1.0, .3, .2); silo_light.omni_range = 3.0; silo_light.light_energy = 0.0
	silo_light.position = silo.position + Vector3(0, .6, 0); world.add_child(silo_light)
	# trees that return as the land heals
	var rng := RandomNumberGenerator.new(); rng.seed = 7
	var tree_mesh := _tree_mesh()
	for k in 140:
		var p := Vector3(rng.randf_range(-30, 30), 0, rng.randf_range(-24, 30))
		if p.distance_to(Vector3.ZERO) < 7.0 or p.distance_to(HOME) < 3.0 or p.distance_to(RIVAL) < 3.0 or p.distance_to(SILO) < 4.5: continue
		var tree := MeshInstance3D.new(); tree.mesh = tree_mesh; tree.position = p + Vector3(0, _height(p.x, p.z), 0)
		tree.rotation.y = rng.randf() * TAU; tree.set_meta("s", rng.randf_range(.7, 1.3)); tree.set_meta("d", rng.randf()); tree.scale = Vector3.ONE * .001
		world.add_child(tree); trees.append(tree)
	# armour on the border
	for k in 5:
		var tank := MeshInstance3D.new(); tank.mesh = _iso(MilitaryModelLibrary.build("tank" if k % 2 == 0 else "armored_car", Color(.85, .3, .25)))
		tank.scale = Vector3.ONE * 1.6; tank.set_meta("lane", k); world.add_child(tank); tank.visible = false; tanks.append(tank)
	# the strikes
	for k in 3:
		var target := Vector3([-2.5, 1.5, 3.0][k], 0, [1.0, -2.0, 2.5][k])
		var head := MeshInstance3D.new(); head.mesh = _sphere(.12); head.material_override = _emissive(Color(1, .95, .8), 6.0); world.add_child(head); head.visible = false
		var flash := OmniLight3D.new(); flash.light_color = Color(1.0, .75, .45); flash.omni_range = 26.0; flash.light_energy = 0.0; flash.position = target + Vector3(0, 2, 0); world.add_child(flash)
		var ball := MeshInstance3D.new(); ball.mesh = _sphere(1.0); ball.material_override = _emissive(Color(1.0, .55, .2), 4.0, true); ball.position = target; ball.visible = false; world.add_child(ball)
		var smoke := _smoke(); smoke.position = target; world.add_child(smoke)
		missiles.append([head, Vector3([-40.0, 30.0, 10.0][k], 22, -60), target, .15 + k * .22, flash, ball, smoke])
	ash = _ash(); world.add_child(ash)


func _height(x: float, z: float) -> float:
	return sin(x * .18) * .5 + cos(z * .15 + x * .05) * .45 + sin((x + z) * .07) * .6 - .3


## an old-world city (lit windows) or its ruins (the same blocks broken and dark)
func _city(alive: bool) -> Node3D:
	var kit := MeshKit.new()
	var rng := RandomNumberGenerator.new(); rng.seed = 42
	for gx in range(-4, 5):
		for gz in range(-4, 5):
			if rng.randf() < .12: continue
			var p := Vector3(gx * 1.25 + rng.randf_range(-.15, .15), 0, gz * 1.25 + rng.randf_range(-.15, .15))
			p.y = _height(p.x, p.z)
			var tall := absi(gx) + absi(gz) < 4
			kit.set_frame(p, rng.randf() * .2)
			if alive:
				kit.part("apartment_tall" if tall else "apartment_block", Vector3.ZERO, PI * .5 * float(rng.randi() % 2), (1.6 if tall else 1.3) * rng.randf_range(.9, 1.2), Color(.85, .85, .88))
			else:
				kit.component(AssetLibrary.residential(rng.randi() % 3), Transform3D(Basis().scaled(Vector3.ONE * 1.1), Vector3.ZERO), Color(.55, .52, .5), 1.0)
				if rng.randf() < .5: kit.box("concrete", Vector3(rng.randf_range(-.3, .3), 0, rng.randf_range(-.3, .3)), Vector3(.5, .12, .35), Color(.4, .38, .36), rng.randf() * 3.0)
	var node := Node3D.new()
	var mesh := MeshInstance3D.new(); mesh.mesh = _iso(kit.commit()); node.add_child(mesh)
	if alive:
		# lit windows and street lights: the old world at dusk
		var lights := MeshKit.new()
		for k in 260:
			var p := Vector3(rng.randf_range(-5.5, 5.5), 0, rng.randf_range(-5.5, 5.5))
			lights.box("glow:ffd88a", p + Vector3(0, _height(p.x, p.z) + rng.randf_range(.05, 1.4), 0), Vector3(.05, .05, .05))
		var glow := MeshInstance3D.new(); glow.mesh = lights.commit(); node.add_child(glow)
	return node


## a settlement of the Reclamation: town hall, homes, fields, and for the rival a fort and barracks
func _settlement(at: Vector3, team: Color, military: bool) -> Node3D:
	var node := Node3D.new()
	var y := _height(at.x, at.z)
	var hub := _model_building("town", "civic", Color(.9, .88, .84), team); hub.position = at + Vector3(0, y, 0); hub.scale = Vector3.ONE * 1.4; node.add_child(hub)
	var kit := MeshKit.new()
	var rng := RandomNumberGenerator.new(); rng.seed = int(at.x * 13 + at.z)
	for k in 7:
		var a := TAU * k / 7.0 + rng.randf() * .3; var r := rng.randf_range(1.4, 2.2)
		var p := at + Vector3(cos(a) * r, 0, sin(a) * r); p.y = _height(p.x, p.z)
		kit.set_frame(p, -a)
		kit.component(AssetLibrary.residential(k % 3), Transform3D(Basis(), Vector3.ZERO), Color(.95, .92, .88), 0.0)
	var homes := MeshInstance3D.new(); homes.mesh = _iso(kit.commit()); node.add_child(homes)
	var extras := [["farm", "civic", Vector3(2.8, 0, -.6)], ["lumber", "civic", Vector3(-2.6, 0, 1.2)]]
	if military: extras = [["fort", "modern", Vector3(2.6, 0, 1.4)], ["barracks", "modern", Vector3(-2.4, 0, -.8)], ["farm", "civic", Vector3(.4, 0, -2.8)]]
	for e in extras:
		var b := _model_building(str(e[0]), str(e[1]), Color(.88, .86, .82), team)
		var p: Vector3 = at + (e[2] as Vector3); p.y = _height(p.x, p.z)
		b.position = p; b.scale = Vector3.ONE * 1.3; node.add_child(b)
	return node


func _model_building(type: String, lib: String, tint: Color, team: Color) -> MeshInstance3D:
	var k := MeshKit.new(); var b := {"lv": 1, "ti": 0, "d": 1, "st": "operational", "ty": type, "t": 0, "id": 1, "o": 0, "a": 1}
	match lib:
		"civic": CivicBuildingLibrary.compose(k, b, type, tint, {})
		"modern": ModernBuildingLibrary.compose(k, b, type, tint, team)
		_: DevelopedBuildingLibrary.compose(k, b, type, tint)
	var m := MeshInstance3D.new(); m.mesh = _iso(k.commit()); return m


func _tree_mesh() -> Mesh:
	var k := MeshKit.new()
	k.cylinder("bark", Vector3.ZERO, .05, .35, 6)
	k.cone("foliage", Vector3(0, .25, 0), .32, .7, 8, Color(.7, .95, .65))
	k.cone("foliage", Vector3(0, .55, 0), .22, .5, 8, Color(.75, 1.0, .7))
	return _iso(k.commit())


## the game's materials, isolated from the match's visibility, weather and cloud fields
func _iso(mesh: Mesh) -> Mesh:
	if mesh == null: return mesh
	for s in mesh.get_surface_count():
		var material := mesh.surface_get_material(s)
		if material is ShaderMaterial:
			var copy: ShaderMaterial = material.duplicate()
			for param in ["visibility_ready", "weather_ready", "cloud_ready"]: copy.set_shader_parameter(param, 0.0)
			mesh.surface_set_material(s, copy)
	return mesh


func _sphere(r: float) -> SphereMesh:
	var s := SphereMesh.new(); s.radius = r; s.height = r * 2.0; s.radial_segments = 16; s.rings = 8; return s


func _emissive(color: Color, energy: float, transparent := false) -> StandardMaterial3D:
	var m := StandardMaterial3D.new(); m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.albedo_color = color; m.emission_enabled = true; m.emission = color; m.emission_energy_multiplier = energy
	if transparent: m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	return m


func _smoke() -> GPUParticles3D:
	var p := GPUParticles3D.new(); p.amount = 50; p.lifetime = 6.0; p.emitting = false
	var pm := ParticleProcessMaterial.new()
	pm.direction = Vector3(0, 1, 0); pm.spread = 18.0; pm.initial_velocity_min = 1.2; pm.initial_velocity_max = 2.4
	pm.gravity = Vector3(.2, .25, 0); pm.scale_min = .6; pm.scale_max = 1.5; pm.damping_min = .4; pm.damping_max = .8
	pm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_SPHERE; pm.emission_sphere_radius = .8
	var ramp := Gradient.new(); ramp.set_color(0, Color(.22, .18, .16, .7)); ramp.set_color(1, Color(.12, .12, .12, 0.0))
	var tex := GradientTexture1D.new(); tex.gradient = ramp; pm.color_ramp = tex
	p.process_material = pm
	var puff := _sphere(.5); var mat := StandardMaterial3D.new(); mat.vertex_color_use_as_albedo = true; mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED; puff.material = mat; p.draw_pass_1 = puff
	p.visibility_aabb = AABB(Vector3(-20, -2, -20), Vector3(40, 40, 40))
	return p


func _ash() -> GPUParticles3D:
	var p := GPUParticles3D.new(); p.amount = 1400; p.lifetime = 5.0; p.emitting = false
	var pm := ParticleProcessMaterial.new()
	pm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_BOX; pm.emission_box_extents = Vector3(26, .5, 26)
	pm.direction = Vector3(.2, -1, 0); pm.initial_velocity_min = .5; pm.initial_velocity_max = 1.2; pm.gravity = Vector3(.15, -.4, 0)
	pm.scale_min = .6; pm.scale_max = 1.2
	p.process_material = pm; p.position = Vector3(0, 10, 2)
	var flake := QuadMesh.new(); flake.size = Vector2(.05, .05)
	var mat := StandardMaterial3D.new(); mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED; mat.albedo_color = Color(.82, .8, .76)
	mat.billboard_mode = BaseMaterial3D.BILLBOARD_ENABLED; flake.material = mat; p.draw_pass_1 = flake
	p.visibility_aabb = AABB(Vector3(-30, -20, -30), Vector3(60, 40, 60))
	return p


# ------------------------------------------------------------------ playback
## Space, Enter or Esc skips (a stray click does not)
func _input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.keycode in [KEY_SPACE, KEY_ENTER, KEY_KP_ENTER, KEY_ESCAPE]:
		get_viewport().set_input_as_handled(); _finish()


func _finish() -> void:
	if done: return
	done = true
	finished.emit()
	queue_free()


func _phase(start: float, length := 1.0) -> float:
	return clampf((clock / BEAT - start) / length, 0.0, 1.0)


func _process(dt: float) -> void:
	clock += dt
	if clock > BEAT * LINES.size() + 2.0: _finish(); return
	if size.x > 0 and size.y > 0: view.size = Vector2i(size)
	var beat := clock / BEAT
	# camera: each beat glides between its two keyframes
	var index := mini(int(beat), SHOTS.size() - 1)
	var shot: Array = SHOTS[index]
	var t := clampf(beat - index, 0.0, 1.0); t = t * t * (3.0 - 2.0 * t)
	camera.position = (shot[0] as Vector3).lerp(shot[2], t)
	camera.look_at((shot[1] as Vector3).lerp(shot[3], t), Vector3.UP)
	# light and air: dusk, the strikes' glare, the grey winter, then a clear dawn
	var winter := _phase(1.6, .6) * (1.0 - _phase(3.0, 1.2))
	var healing := _phase(3.0, 1.5)
	env.background_color = Color(.36, .42, .52).lerp(Color(.2, .2, .22), winter).lerp(Color(.55, .66, .78), healing)
	env.fog_density = .012 + .05 * winter
	env.fog_light_color = Color(.55, .58, .64).lerp(Color(.42, .41, .4), winter)
	env.adjustment_saturation = 1.0 - .75 * winter
	sun.light_energy = 1.0 - .65 * winter + .25 * healing
	sun.light_color = Color(1.0, .78, .55).lerp(Color(.8, .8, .82), winter).lerp(Color(1.0, .92, .8), healing)
	ground_material.albedo_color = Color(.36, .45, .3).lerp(Color(.32, .31, .3), _phase(1.6, .6)).lerp(Color(.34, .47, .28), healing)
	# the strikes: warheads arc in, flash, a fireball swells and smoke columns rise
	var launch := beat - 1.0
	var struck := false
	for m in missiles:
		var head: MeshInstance3D = m[0]; var flash: OmniLight3D = m[4]; var ball: MeshInstance3D = m[5]; var smoke: GPUParticles3D = m[6]
		var f := clampf((launch - float(m[3])) / .45, 0.0, 1.0)
		head.visible = f > 0.0 and f < 1.0
		if head.visible:
			var a: Vector3 = m[1]; var b: Vector3 = m[2]; var mid := (a + b) * .5 + Vector3(0, 20, 0)
			head.position = a.lerp(mid, f).lerp(mid.lerp(b, f), f)
		var boom := clampf((launch - float(m[3]) - .45) / .5, 0.0, 1.0)
		ball.visible = boom > 0.0 and boom < 1.0
		if ball.visible:
			ball.scale = Vector3.ONE * (1.0 + boom * 7.0)
			(ball.material_override as StandardMaterial3D).albedo_color.a = (1.0 - boom) * .9
		if boom > .15: struck = true
		flash.light_energy = 40.0 * (1.0 - boom) if boom > 0.0 else 0.0
		smoke.emitting = boom > 0.0 and beat < 2.4
		smoke.visible = beat < 3.2
	old_city.visible = not struck
	ruins.visible = struck
	ash.emitting = winter > .05 and beat < 3.4
	ash.visible = beat < 3.9
	# the land heals: trees grow back
	for tree in trees:
		var g := clampf((beat - 3.1 - float(tree.get_meta("d")) * .9) / .6, 0.0, 1.0)
		tree.scale = Vector3.ONE * maxf(.001, g * float(tree.get_meta("s")))
	home.visible = beat > 3.8
	rival.visible = beat > 4.8
	# rival armour rolling toward the border
	for tank in tanks:
		tank.visible = beat > 5.0 and beat < 6.2
		if tank.visible:
			var lane := int(tank.get_meta("lane"))
			var p := RIVAL + Vector3(2.5 + (beat - 5.0) * 3.5 + lane * .2, 0, 2.0 + lane * .9)
			p.y = _height(p.x, p.z) + .02
			tank.position = p; tank.rotation.y = -.4
	silo_light.light_energy = (2.5 + 1.5 * sin(clock * 3.0)) * _phase(5.9, .3)
	overlay.queue_redraw()


func _draw_overlay() -> void:
	var s := size
	var bar := s.y * .11
	overlay.draw_rect(Rect2(0, 0, s.x, bar), Color(0, 0, 0, .94)); overlay.draw_rect(Rect2(0, s.y - bar, s.x, bar), Color(0, 0, 0, .94))
	var index := mini(int(clock / BEAT), LINES.size() - 1)
	var local := clock / BEAT - float(index)
	var last := index == LINES.size() - 1
	var alpha := clampf(local * 2.5, 0.0, 1.0) * (1.0 if last else clampf((1.0 - local) * 3.0, 0.0, 1.0))
	if last:
		overlay.draw_rect(Rect2(0, s.y * .48 - 78, s.x, 150), Color(.01, .02, .03, .6 * alpha))
		var title := str(LINES[index]); var w := title_font.get_string_size(title, HORIZONTAL_ALIGNMENT_LEFT, -1, 64).x
		overlay.draw_string(title_font, Vector2((s.x - w) * .5, s.y * .48), title, HORIZONTAL_ALIGNMENT_LEFT, -1, 64, Color(.93, .8, .55, alpha))
		var sw := title_font.get_string_size(SUBTITLE, HORIZONTAL_ALIGNMENT_LEFT, -1, 20).x
		overlay.draw_string(title_font, Vector2((s.x - sw) * .5, s.y * .48 + 44), SUBTITLE, HORIZONTAL_ALIGNMENT_LEFT, -1, 20, Color(.88, .9, .89, alpha * .95))
	else:
		var text := str(LINES[index]); var tw := title_font.get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1, 24).x
		overlay.draw_string(title_font, Vector2((s.x - tw) * .5, s.y - bar * .45), text, HORIZONTAL_ALIGNMENT_LEFT, -1, 24, Color(.92, .92, .9, alpha))
	if index == 4 and home.visible and not camera.is_position_behind(HOME):
		var p := camera.unproject_position(HOME + Vector3(0, 2.2, 0))
		overlay.draw_string(title_font, p + Vector2(-44, 0), "Your people", HORIZONTAL_ALIGNMENT_LEFT, -1, 20, Color(.95, .85, .6, alpha))
	var hint := "Space or Enter to skip"
	var hw := title_font.get_string_size(hint, HORIZONTAL_ALIGNMENT_LEFT, -1, 13).x
	overlay.draw_string(title_font, Vector2(s.x - hw - 24, bar * .6), hint, HORIZONTAL_ALIGNMENT_LEFT, -1, 13, Color(.8, .8, .78, .65))
