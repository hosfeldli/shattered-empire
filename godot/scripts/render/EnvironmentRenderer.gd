class_name EnvironmentRenderer
extends Node3D
## Light, sky and weather, plus the countryside's natural cover. Permanent daylight from one sun.
## The server's regional weather (cloud, rain, wetness on an 8-hex grid, and the wind) drives a
## moving cloud layer, cloud shadows and wet, darker, glossier ground in the terrain shader, and
## rain near the camera. Forests, scattered trees and ore deposits are placed per terrain chunk
## from the terrain geometry (deterministic per hex, never on a built hex).

const SQRT3 := HexGrid.SQRT3
const CLOUD_HEIGHT := 6.0
const FADE_S := 2.5
const TREE_LOD_SIZE := 60.0
const SHADOW_MAX_SIZE := 120.0

var world: WorldState
var cam: CameraController
var terrain: WorldRenderer
var sun: DirectionalLight3D
var env: WorldEnvironment
var clouds: MeshInstance3D
var cloud_mat: ShaderMaterial
var rain: GPUParticles3D
var cloud_tex: ImageTexture
var cloud_prev: ImageTexture
var wet_tex: ImageTexture
var rain_img: Image
var wind := Vector2.ZERO
var since := 0.0
var off := Vector2.ZERO
var off_prev := Vector2.ZERO
var wx_cw := 0
var wx_ch := 0
var wx_updates := 0
var props := {}            # chunk id -> { trees: MultiMeshInstance3D, rocks: MeshInstance3D, x0 }
var props_dirty := {}
var built_tiles := {}
var tree_mesh: ArrayMesh
var tree_count := 0
var shadows_allowed := true
var hide_trees := false


func setup(w: WorldState, c: CameraController, t: WorldRenderer) -> void:
	world = w
	cam = c
	terrain = t
	sun = DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-52.0, -135.0, 0.0)
	sun.light_color = Color(1.0, 0.96, 0.9)
	sun.light_energy = 1.3
	sun.shadow_enabled = true
	sun.directional_shadow_mode = DirectionalLight3D.SHADOW_ORTHOGONAL
	sun.shadow_bias = 0.03
	sun.shadow_normal_bias = 1.2
	add_child(sun)
	env = WorldEnvironment.new()
	var e := Environment.new()
	e.background_mode = Environment.BG_COLOR
	e.background_color = Color(0.11, 0.12, 0.13)
	e.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	e.ambient_light_color = Color(0.62, 0.67, 0.74)
	e.ambient_light_energy = 0.6
	e.tonemap_mode = Environment.TONE_MAPPER_FILMIC
	e.tonemap_exposure = 1.0
	e.ssao_enabled = true
	e.ssao_radius = 0.5
	e.ssao_intensity = 1.2
	env.environment = e
	add_child(env)
	_make_clouds()
	_make_rain()
	tree_mesh = _tree_model()
	world.weather_changed.connect(_on_weather)
	world.geo_changed.connect(_on_geo)
	world.econ_applied.connect(_on_econ)
	world.welcomed.connect(_clear)
	world.reset.connect(_clear)


func _clear() -> void:
	for p in props.values():
		(p.trees as Node).queue_free()
		(p.rocks as Node).queue_free()
		(p.canopy as Node).queue_free()
	props.clear()
	tree_count = 0
	props_dirty.clear()
	built_tiles.clear()


func _on_geo(list: PackedInt32Array) -> void:
	for cid in list:
		props_dirty[cid] = true


func _on_econ() -> void:
	var now := {}
	for b in world.buildings.values():
		now[int(b.t)] = true
	for t in now.keys():
		if not built_tiles.has(t):
			props_dirty[world._chunk_of(t)] = true
	for t in built_tiles.keys():
		if not now.has(t):
			props_dirty[world._chunk_of(t)] = true
	built_tiles = now


func update(dt: float) -> void:
	if world.grid == null:
		return
	var g := world.grid
	# Sun shadows follow the visible footprint and disappear once they are sub-pixel at map zoom.
	sun.shadow_enabled = shadows_allowed and cam.size < SHADOW_MAX_SIZE
	sun.directional_shadow_max_distance = CameraController.DISTANCE + minf(cam.size * 0.75, 90.0)
	# clouds drift with the wind between authoritative updates, then cross-fade to the new field
	since += dt
	off += wind * dt
	off_prev += wind * dt
	var blend := clampf(since / FADE_S, 0.0, 1.0)
	for m in [terrain.terrain_mat, cloud_mat]:
		m.set_shader_parameter("cloud_off", off)
		m.set_shader_parameter("cloud_off_prev", off_prev)
		m.set_shader_parameter("cloud_blend", blend)
	if terrain.known_tex:
		cloud_mat.set_shader_parameter("known_tex", terrain.known_tex)
		cloud_mat.set_shader_parameter("world_size", Vector2(g.period, g.depth))
	cloud_mat.set_shader_parameter("opacity", lerpf(0.08, 0.32, clampf((cam.size - 10.0) / 80.0, 0.0, 1.0)))
	var f := cam.focus
	clouds.position = Vector3(f.x, CLOUD_HEIGHT, f.z)
	clouds.scale = Vector3.ONE * maxf(cam.size * 3.0, 60.0)
	_update_rain(f)
	var t0 := Time.get_ticks_usec()
	for cid in props_dirty.keys():
		_build_props(cid)
		props_dirty.erase(cid)
		if Time.get_ticks_usec() - t0 > 3000:
			break
	# tree shadows only where they read (close up); far out they cost much and show little
	var tree_shadows := GeometryInstance3D.SHADOW_CASTING_SETTING_ON if cam.size < 18.0 else GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	for p in props.values():
		var trees := p.trees as MultiMeshInstance3D
		var canopy := p.canopy as MeshInstance3D
		trees.cast_shadow = tree_shadows
		# Camera distance is fixed by the orthographic boom, so zoom LOD is keyed to camera size.
		trees.visible = not hide_trees and cam.size < TREE_LOD_SIZE
		canopy.visible = not hide_trees and cam.size >= TREE_LOD_SIZE
		var x0: float = float(p.x0)
		var off_x := g.near_x(x0, f.x) - x0
		trees.position = Vector3(off_x, 0, 0)
		(p.rocks as Node3D).position = Vector3(off_x, 0, 0)
		canopy.position = Vector3(off_x, 0, 0)


func set_shadows_enabled(enabled: bool) -> void:
	shadows_allowed = enabled
	sun.shadow_enabled = enabled and cam.size < SHADOW_MAX_SIZE


# ------------------------------------------------------------------ weather
func _on_weather(wx: Dictionary) -> void:
	var cw := int(wx.get("cw", 0))
	var ch := int(wx.get("ch", 0))
	if cw <= 0 or ch <= 0:
		return
	wx_updates += 1
	var cell := int(wx.get("cell", 8))
	var extent := Vector2(cw * cell * SQRT3, ch * cell * 1.5)
	var cloud := Image.create_from_data(cw, ch, false, Image.FORMAT_R8, Marshalls.base64_to_raw(wx.get("cloud", "")))
	var wet := Image.create_from_data(cw, ch, false, Image.FORMAT_R8, Marshalls.base64_to_raw(wx.get("wet", "")))
	rain_img = Image.create_from_data(cw, ch, false, Image.FORMAT_R8, Marshalls.base64_to_raw(wx.get("rain", "")))
	if cloud_tex == null or cw != wx_cw or ch != wx_ch:
		cloud_tex = ImageTexture.create_from_image(cloud)
		cloud_prev = ImageTexture.create_from_image(cloud)
		wet_tex = ImageTexture.create_from_image(wet)
		wx_cw = cw
		wx_ch = ch
	else:
		cloud_prev.update(cloud_tex.get_image())
		cloud_tex.update(cloud)
		wet_tex.update(wet)
	off_prev = off
	off = Vector2.ZERO
	since = 0.0
	var wa: Array = wx.get("wind", [0.0, 0.5])
	var ang := float(wa[0])
	var strength := float(wa[1])
	wind = Vector2(cos(ang), sin(ang)) * strength * 0.0025
	for m in [terrain.terrain_mat, cloud_mat]:
		m.set_shader_parameter("cloud_tex", cloud_tex)
		m.set_shader_parameter("cloud_prev", cloud_prev)
		m.set_shader_parameter("weather_extent", extent)
	terrain.terrain_mat.set_shader_parameter("wet_tex", wet_tex)


func rain_at(x: float, z: float) -> float:
	if rain_img == null:
		return 0.0
	var g := world.grid
	var q := int(g.base_x(x) / SQRT3) / 8
	var r := int(z / 1.5) / 8
	if r < 0 or r >= rain_img.get_height():
		return 0.0
	return rain_img.get_pixel(posmod(q, rain_img.get_width()), r).r


func wet_at(x: float, z: float) -> float:
	if wet_tex == null:
		return 0.0
	var img := wet_tex.get_image()
	var q := int(world.grid.base_x(x) / SQRT3) / 8
	var r := int(z / 1.5) / 8
	if r < 0 or r >= img.get_height():
		return 0.0
	return img.get_pixel(posmod(q, img.get_width()), r).r


func _make_clouds() -> void:
	var pm := PlaneMesh.new()
	pm.size = Vector2(1, 1)
	pm.subdivide_width = 1
	pm.subdivide_depth = 1
	clouds = MeshInstance3D.new()
	clouds.mesh = pm
	clouds.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	cloud_mat = ShaderMaterial.new()
	var s := Shader.new()
	s.code = """
shader_type spatial;
render_mode unshaded, blend_mix, depth_draw_never, cull_disabled, shadows_disabled;

uniform sampler2D cloud_tex : filter_linear, repeat_enable, hint_default_black;
uniform sampler2D cloud_prev : filter_linear, repeat_enable, hint_default_black;
uniform float cloud_blend = 1.0;
uniform vec2 cloud_off = vec2(0.0);
uniform vec2 cloud_off_prev = vec2(0.0);
uniform vec2 weather_extent = vec2(221.7, 192.0);
uniform float opacity = 0.5;
uniform sampler2D known_tex : filter_linear, repeat_enable, hint_default_black;
uniform vec2 world_size = vec2(221.7, 192.0);

varying vec3 wpos;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
	vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
	return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

void vertex() {
	wpos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	vec2 uv = vec2(wpos.x / weather_extent.x, wpos.z / weather_extent.y);
	float c = mix(texture(cloud_prev, uv - cloud_off_prev).r, texture(cloud_tex, uv - cloud_off).r, cloud_blend);
	float n = noise(wpos.xz * 0.12 + TIME * 0.01) * 0.65 + noise(wpos.xz * 0.37 - TIME * 0.015) * 0.35;
	float a = smoothstep(0.35, 0.9, c + (n - 0.5) * 0.3);
	// the sky is only drawn over land this viewer knows (the void beyond stays clean)
	a *= texture(known_tex, vec2(wpos.x / world_size.x, wpos.z / world_size.y)).r;
	ALBEDO = mix(vec3(0.97, 0.97, 0.96), vec3(0.72, 0.74, 0.78), a * 0.6);
	ALPHA = a * opacity;
}
"""
	cloud_mat.shader = s
	clouds.material_override = cloud_mat
	add_child(clouds)


func _make_rain() -> void:
	rain = GPUParticles3D.new()
	rain.amount = 3000
	rain.lifetime = 0.6
	rain.local_coords = false
	rain.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	rain.visibility_aabb = AABB(Vector3(-200, -20, -200), Vector3(400, 40, 400))
	var pm := ParticleProcessMaterial.new()
	pm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_BOX
	pm.emission_box_extents = Vector3(20, 0.5, 20)
	pm.direction = Vector3(0.1, -1, 0)
	pm.spread = 3.0
	pm.initial_velocity_min = 9.0
	pm.initial_velocity_max = 11.0
	pm.gravity = Vector3(0, -2, 0)
	rain.process_material = pm
	var streak := BoxMesh.new()
	streak.size = Vector3(0.012, 0.25, 0.012)
	streak.material = MaterialLibrary.smoke(Color(0.7, 0.75, 0.82), 0.22)
	rain.draw_pass_1 = streak
	rain.emitting = false
	add_child(rain)


func _update_rain(f: Vector3) -> void:
	var r := rain_at(f.x, f.z)
	# Rain streaks read close up; farther out wet ground and cloud carry the weather instead.
	rain.emitting = r > 0.15 and cam.size < 12.0
	if rain.emitting:
		rain.amount_ratio = clampf(r * 1.4, 0.1, 1.0)
		(rain.process_material as ParticleProcessMaterial).emission_box_extents = Vector3(cam.size * 0.9, 0.5, cam.size * 0.9)
		rain.position = Vector3(f.x, f.y + 5.0, f.z)


# ------------------------------------------------------------------ natural cover
func _tree_model() -> ArrayMesh:
	var k := MeshKit.new()
	k.cylinder("bark", Vector3.ZERO, 0.016, 0.06, 4, Color.WHITE, -1.0)
	k.cone("foliage", Vector3(0, 0.045, 0), 0.085, 0.26, 6)
	return k.commit()


func _build_props(cid: int) -> void:
	var g := world.grid
	var cs := world.chunk
	var cx := cid % world.chunks_w
	var cy := cid / world.chunks_w
	var xforms: Array[Transform3D] = []
	var cols: Array[Color] = []
	var rocks := MeshKit.new()
	var canopy := MeshKit.new()
	for lr in cs:
		var r := cy * cs + lr
		if r >= g.h:
			break
		for lq in cs:
			var q := cx * cs + lq
			if q >= g.w:
				break
			var i := r * g.w + q
			if not world.known[i] or built_tiles.has(i) or world.road[i] != 0 and world.biome(i) != 4:
				continue
			var b := world.biome(i)
			var rng := RandomNumberGenerator.new()
			rng.seed = i * 977 + 3
			var c := g.center(i)
			var n := 0
			match b:
				4: n = 9
				2: n = 2 if rng.randf() < 0.35 else 0
				7: n = 3
				8: n = 3 if rng.randf() < 0.5 else 0
				6: n = 1 if rng.randf() < 0.3 else 0
			if world.is_river(i):
				n = mini(n, 4)
			if b == 4:
				canopy.set_frame(Vector3(c.x, world.tile_height(i) + 0.055, c.y), 0.0)
				var quilt := Color(0.72, 0.86, 0.62).darkened(rng.randf_range(0.0, 0.16))
				canopy.hex_plate("foliage", Vector3.ZERO, 0.82, quilt, 0.025)
			for k in n:
				var a := rng.randf() * TAU
				var d := sqrt(rng.randf()) * 0.82
				var x := c.x + cos(a) * d
				var z := c.y + sin(a) * d
				var y := world.ground_height(x, z)
				if y < 0.02:
					continue
				var s := rng.randf_range(0.75, 1.35) * (0.8 if b == 7 else 1.0)
				xforms.append(Transform3D(Basis(Vector3.UP, rng.randf() * TAU).scaled(Vector3(s, s * rng.randf_range(0.9, 1.2), s)), Vector3(x, y - 0.01, z)))
				cols.append(Color(1, 1, 1).darkened(rng.randf() * 0.25).lerp(Color(0.9, 0.95, 0.7), rng.randf() * 0.2))
			_deposit(rocks, i, c, rng)
	var rec: Dictionary = props.get(cid, {})
	if rec.is_empty():
		var mmi := MultiMeshInstance3D.new()
		var mi := MeshInstance3D.new()
		var far := MeshInstance3D.new()
		mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		far.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		add_child(mmi)
		add_child(mi)
		add_child(far)
		rec = {"trees": mmi, "rocks": mi, "canopy": far, "x0": (cx + 0.5) * cs * SQRT3}
		props[cid] = rec
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.use_colors = true
	mm.mesh = tree_mesh
	mm.instance_count = xforms.size()
	for k in xforms.size():
		mm.set_instance_transform(k, xforms[k])
		mm.set_instance_color(k, cols[k])
	tree_count += xforms.size() - int(rec.get("n", 0))
	rec.n = xforms.size()
	(rec.trees as MultiMeshInstance3D).multimesh = mm
	(rec.rocks as MeshInstance3D).mesh = rocks.commit() if not rocks.is_empty() else null
	(rec.canopy as MeshInstance3D).mesh = canopy.commit() if not canopy.is_empty() else null


## a visible sign of what lies in the ground (iron, coal, stone, oil, rare earths)
func _deposit(kit: MeshKit, i: int, c: Vector2, rng: RandomNumberGenerator) -> void:
	var dep := world.deposit(i)
	if dep == 0 or dep >= 6:
		return
	var y := world.tile_height(i)
	kit.set_frame(Vector3(c.x, y, c.y), 0.0)
	match dep:
		1:   # oil seep
			kit.cylinder("char", Vector3(0.25, 0.01, 0.2), 0.18, 0.01, 10, Color(0.6, 0.6, 0.65), 0.18)
		2, 3, 4, 5:
			var col: Color = {2: Color(0.85, 0.55, 0.42), 3: Color(0.35, 0.33, 0.32), 4: Color(0.7, 0.8, 0.85), 5: Color(1.25, 1.22, 1.15)}[dep]
			var mat := "ore" if dep != 5 else "stone"
			var spot := Vector2(rng.randf_range(-0.3, 0.3), rng.randf_range(-0.3, 0.3))
			for k in 4:
				var p := Vector3(spot.x + rng.randf_range(-0.16, 0.16), -0.02, spot.y + rng.randf_range(-0.16, 0.16))
				var s := rng.randf_range(0.05, 0.1)
				kit.box(mat, Vector3(p.x, world.ground_height(c.x + p.x, c.y + p.z) - y - 0.02, p.z), Vector3(s, s * rng.randf_range(0.6, 1.2), s * 0.8), col, rng.randf() * TAU)
