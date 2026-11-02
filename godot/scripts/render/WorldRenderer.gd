class_name WorldRenderer
extends Node3D
## Terrain: one ArrayMesh per 16x16-hex chunk built from the server's terrain geometry, plus a
## water mesh (sea, lakes, river ribbons) per chunk. Hex centres sit at their own height, corners at
## the mean of the three hexes that meet there, so the land is continuous and biomes blend at the
## corners. Fog of war is a per-hex bit texture read in the shader; weather (wet ground, cloud
## shadows) comes from EnvironmentRenderer. Each chunk is drawn at the image(s) of the wrapped world
## that the camera can see, so the east-west seam is never visible.

const CHUNK_BUDGET_MS := 5.0
const SQRT3 := HexGrid.SQRT3

## restrained natural palette per biome (terrain id)
const BIOME := [
	Color(0.30, 0.30, 0.26),  # deep sea floor
	Color(0.47, 0.45, 0.36),  # shallow sea floor
	Color(0.40, 0.52, 0.29),  # grassland
	Color(0.58, 0.55, 0.36),  # plains
	Color(0.27, 0.37, 0.22),  # forest floor
	Color(0.76, 0.68, 0.50),  # desert
	Color(0.55, 0.56, 0.50),  # tundra
	Color(0.35, 0.42, 0.32),  # marsh
	Color(0.50, 0.47, 0.34),  # hills
	Color(0.45, 0.42, 0.39),  # mountains
	Color(0.86, 0.87, 0.89),  # peaks
	Color(0.36, 0.20, 0.14),  # lava field
	Color(0.36, 0.33, 0.30),  # volcanic soil
]

var world: WorldState
var terrain_mat: ShaderMaterial
var water_mat: ShaderMaterial
var vis_tex: ImageTexture
var known_tex: ImageTexture
var chunks := {}               # chunk id -> { terrain: ArrayMesh, water: ArrayMesh, inst: [], winst: [], x0: float }
var dirty := {}                # chunk id -> true
var colors := PackedColorArray()
var cam_x := 0.0
var half_w := 100.0
var chunks_built := 0
var last_build_ms := 0.0


func setup(w: WorldState) -> void:
	world = w
	terrain_mat = ShaderMaterial.new()
	terrain_mat.shader = _terrain_shader()
	water_mat = ShaderMaterial.new()
	water_mat.shader = _water_shader()
	world.welcomed.connect(_on_welcome)
	world.geo_changed.connect(_on_geo)
	world.vis_changed.connect(_on_vis)
	world.reset.connect(_on_welcome)


func _on_welcome() -> void:
	for c in chunks.values():
		for m in c.inst + c.winst:
			(m as Node).queue_free()
	chunks.clear()
	dirty.clear()
	var g := world.grid
	var img := Image.create_from_data(g.w / 8, g.h, false, Image.FORMAT_R8, world.vis_bits)
	vis_tex = ImageTexture.create_from_image(img)
	known_tex = ImageTexture.create_from_image(Image.create_from_data(g.w, g.h, false, Image.FORMAT_R8, world.known_mask))
	for m in [terrain_mat, water_mat]:
		m.set_shader_parameter("vis_bits", vis_tex)
		m.set_shader_parameter("vis_on", 0.0 if world.spectator else 1.0)
	water_mat.set_shader_parameter("world_cells", Vector2(g.w, g.h))
	colors.resize(g.n)


func _on_vis(bits: PackedByteArray) -> void:
	if vis_tex == null:
		return
	vis_tex.update(Image.create_from_data(world.grid.w / 8, world.grid.h, false, Image.FORMAT_R8, bits))
	for m in [terrain_mat, water_mat]:
		m.set_shader_parameter("vis_on", 1.0)


func _on_geo(list: PackedInt32Array) -> void:
	for cid in list:
		dirty[cid] = true
	if known_tex:
		known_tex.update(Image.create_from_data(world.grid.w, world.grid.h, false, Image.FORMAT_R8, world.known_mask))


## called by the bootstrap every frame with the camera's view
func update_view(camera_x: float, view_half_width: float) -> void:
	cam_x = camera_x
	half_w = view_half_width
	_build_some()
	for c in chunks.values():
		_place(c)


func _build_some() -> void:
	if dirty.is_empty():
		return
	var t0 := Time.get_ticks_usec()
	# nearest chunks first, so the land around the camera appears before the rest
	var ids := dirty.keys()
	ids.sort_custom(func(a, b): return _chunk_dist(a) < _chunk_dist(b))
	for cid in ids:
		_build_chunk(cid)
		dirty.erase(cid)
		chunks_built += 1
		if (Time.get_ticks_usec() - t0) / 1000.0 > CHUNK_BUDGET_MS:
			break
	last_build_ms = (Time.get_ticks_usec() - t0) / 1000.0


func _chunk_dist(cid: int) -> float:
	var cx := cid % world.chunks_w
	var x := (cx + 0.5) * world.chunk * SQRT3
	return absf(world.grid.dx_wrap(cam_x, x))


func _tile_color(i: int) -> Color:
	var b := world.biome(i)
	var c: Color = BIOME[b] if b < BIOME.size() else BIOME[2]
	var hsh := float((i * 2654435761) & 0xffff) / 65535.0
	c = c * (0.94 + 0.12 * hsh)
	var fl := world.geo_flags(i)
	if fl & 32:           # ash fall
		c = c.lerp(Color(0.33, 0.31, 0.29), 0.5)
	if fl & 16:           # drought
		c = c.lerp(Color(0.62, 0.55, 0.38), 0.35)
	if world.is_urban(i):
		c = c.lerp(Color(0.48, 0.46, 0.42), 0.35)
	c.a = 1.0
	return c


func _corner_color(i: int, k: int) -> Color:
	var s := colors[i]
	var n := 1.0
	var pair: Array = HexGrid.CORNER_DIRS[k]
	for d: int in pair:
		var nb: int = world.grid.nb[i * 6 + d]
		if nb >= 0 and world.known[nb]:
			s += colors[nb]
			n += 1.0
	return s / n


func _corner_normal(i: int, k: int) -> Vector3:
	var g := world.grid
	var pair: Array = HexGrid.CORNER_DIRS[k]
	var d1: int = pair[0]
	var d2: int = pair[1]
	var h0 := world.height[i]
	var n1 := g.nb[i * 6 + d1]
	var n2 := g.nb[i * 6 + d2]
	var h1 := world.height[n1] if n1 >= 0 and world.known[n1] else h0
	var h2 := world.height[n2] if n2 >= 0 and world.known[n2] else h0
	var v1 := Vector3(g.dir_vec[d1].x * SQRT3, h1 - h0, g.dir_vec[d1].y * SQRT3)
	var v2 := Vector3(g.dir_vec[d2].x * SQRT3, h2 - h0, g.dir_vec[d2].y * SQRT3)
	var nrm := v1.cross(v2)
	if nrm.y < 0.0:
		nrm = -nrm
	return nrm.normalized()


func _build_chunk(cid: int) -> void:
	var g := world.grid
	var cs := world.chunk
	var cx := cid % world.chunks_w
	var cy := cid / world.chunks_w
	var vt := PackedVector3Array()
	var nt := PackedVector3Array()
	var ct := PackedColorArray()
	var ut := PackedVector2Array()
	var water := MeshKit.new()
	var tiles := PackedInt32Array()
	for lr in cs:
		var r := cy * cs + lr
		if r >= g.h:
			break
		for lq in cs:
			var q := cx * cs + lq
			if q >= g.w:
				break
			var i := r * g.w + q
			if world.known[i]:
				tiles.append(i)
				colors[i] = _tile_color(i)
	# neighbours' colours feed the corner blend
	for i in tiles:
		for d in 6:
			var nb := g.nb[i * 6 + d]
			if nb >= 0 and world.known[nb]:
				colors[nb] = _tile_color(nb)
	for i in tiles:
		var c2 := g.center(i)
		var c := Vector3(c2.x, world.height[i], c2.y)
		var cn := Vector3.ZERO
		var pc: Array[Vector3] = []
		var pn: Array[Vector3] = []
		var pcol: Array[Color] = []
		for k in 6:
			var o := g.corners[k]
			pc.append(Vector3(c2.x + o.x, world.corner_height(i, k), c2.y + o.y))
			var nk := _corner_normal(i, k)
			pn.append(nk)
			cn += nk
			pcol.append(_corner_color(i, k))
		cn = cn.normalized()
		var uv := Vector2(i % g.w, i / g.w)
		var col := colors[i]
		for k in 6:
			var k2 := (k + 1) % 6
			# clockwise seen from above: centre, corner k, corner k + 1
			vt.append(c); vt.append(pc[k]); vt.append(pc[k2])
			nt.append(cn); nt.append(pn[k]); nt.append(pn[k2])
			ct.append(col); ct.append(pcol[k]); ct.append(pcol[k2])
			ut.append(uv); ut.append(uv); ut.append(uv)
		_water_for(i, c2, water)
	var rec: Dictionary = chunks.get(cid, {})
	if rec.is_empty():
		rec = {"inst": [], "winst": [], "x0": cx * cs * SQRT3 - SQRT3, "w": (cs + 2) * SQRT3}
		chunks[cid] = rec
	var mesh: ArrayMesh = null
	if not vt.is_empty():
		var arrays := []
		arrays.resize(Mesh.ARRAY_MAX)
		arrays[Mesh.ARRAY_VERTEX] = vt
		arrays[Mesh.ARRAY_NORMAL] = nt
		arrays[Mesh.ARRAY_COLOR] = ct
		arrays[Mesh.ARRAY_TEX_UV2] = ut
		mesh = ArrayMesh.new()
		mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
		mesh.surface_set_material(0, terrain_mat)
	var wmesh: ArrayMesh = null
	if not water.is_empty():
		wmesh = water.commit()
		for s in wmesh.get_surface_count():
			wmesh.surface_set_material(s, water_mat)
	rec.terrain = mesh
	rec.water = wmesh
	for m in rec.inst:
		(m as MeshInstance3D).mesh = mesh
	for m in rec.winst:
		(m as MeshInstance3D).mesh = wmesh
	_place(rec)


func _water_for(i: int, c2: Vector2, kit: MeshKit) -> void:
	var g := world.grid
	if world.is_sea(i):
		# depth colour blended at the corners, so the sea floor reads as a smooth gradient
		var cc := _sea_color(i)
		var centre := Vector3(c2.x, 0.0, c2.y)
		var pts: Array[Vector3] = []
		var cols: Array[Color] = []
		for k in 6:
			var o := g.corners[k]
			pts.append(Vector3(c2.x + o.x, 0.0, c2.y + o.y))
			var s := cc
			var pair: Array = HexGrid.CORNER_DIRS[k]
			for d: int in pair:
				var nb: int = g.nb[i * 6 + d]
				s += _sea_color(nb) if nb >= 0 and world.known[nb] and world.is_sea(nb) else Color(0.24, 0.42, 0.46, 0.6)
			cols.append(s / 3.0)
		for k in 6:
			kit.tri_colors("water", centre, pts[k], pts[(k + 1) % 6], cc, cols[k], cols[(k + 1) % 6], Vector3.UP)
	elif world.is_lake(i):
		var col := Color(0.18, 0.34, 0.40, 0.86)
		kit.hex_plate("water", Vector3(c2.x, world.water_level(i), c2.y), 1.0, col)
	elif world.is_river(i):
		var width := 0.2 + 0.07 * world.flow_bucket(i)
		var col := Color(0.22, 0.38, 0.43, 0.9)
		var y := world.height[i] + 0.05
		var c := Vector3(c2.x, y, c2.y)
		var fd := world.flow_dir(i)
		if fd >= 0:
			var m := c2 + g.dir_vec[fd] * (SQRT3 * 0.5)
			var ym := (y + _surface(g.nb[i * 6 + fd], y)) * 0.5
			kit.strip("water", c, Vector3(m.x, ym, m.y), width, col)
		# the upstream reaches flowing into this hex
		for d in 6:
			var nb := g.nb[i * 6 + d]
			if nb < 0 or not world.known[nb] or not world.is_river(nb):
				continue
			var nfd := world.flow_dir(nb)
			if nfd < 0 or g.nb[nb * 6 + nfd] != i:
				continue
			var m := c2 + g.dir_vec[d] * (SQRT3 * 0.5)
			var ym := maxf(y, world.height[nb] + 0.05) * 0.5 + y * 0.5
			kit.strip("water", Vector3(m.x, ym, m.y), c, width, col)
		kit.cylinder("water", Vector3(c2.x, y - 0.005, c2.y), width * 0.5, 0.005, 8, col)


func _sea_color(i: int) -> Color:
	var depth := world.geo[i * 6 + 2] / 255.0
	var col := Color(0.22, 0.40, 0.45).lerp(Color(0.09, 0.20, 0.30), clampf(depth * 2.2, 0.0, 1.0))
	col.a = lerpf(0.66, 0.92, clampf(depth * 2.0, 0.0, 1.0))
	return col


## the water (or river) surface a river reach runs into, for a smooth join
func _surface(nb: int, fallback: float) -> float:
	if nb < 0 or not world.known[nb]:
		return fallback
	var wl := world.water_level(nb)
	if wl > -1e6:
		return wl + 0.01
	return world.height[nb] + 0.05


## show each chunk at the image(s) of the wrapped world inside the view
func _place(rec: Dictionary) -> void:
	var g := world.grid
	var offsets: Array[float] = []
	if g.wrap:
		var base := g.near_x(float(rec.x0) + float(rec.w) * 0.5, cam_x) - (float(rec.x0) + float(rec.w) * 0.5)
		for k in [-1, 0, 1]:
			var off: float = base + k * g.period
			var x0: float = float(rec.x0) + off
			if x0 + float(rec.w) >= cam_x - half_w and x0 <= cam_x + half_w:
				offsets.append(off)
	else:
		offsets.append(0.0)
	_ensure(rec, "inst", offsets.size(), rec.get("terrain"))
	_ensure(rec, "winst", offsets.size(), rec.get("water"))
	for k in offsets.size():
		(rec.inst[k] as Node3D).position = Vector3(offsets[k], 0, 0)
		(rec.winst[k] as Node3D).position = Vector3(offsets[k], 0, 0)
	for k in range(offsets.size(), rec.inst.size()):
		(rec.inst[k] as Node3D).visible = false
		(rec.winst[k] as Node3D).visible = false
	for k in offsets.size():
		(rec.inst[k] as Node3D).visible = rec.get("terrain") != null
		(rec.winst[k] as Node3D).visible = rec.get("water") != null


func _ensure(rec: Dictionary, key: String, count: int, mesh: Mesh) -> void:
	var list: Array = rec[key]
	while list.size() < count:
		var mi := MeshInstance3D.new()
		mi.mesh = mesh
		if key == "winst":
			mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		add_child(mi)
		list.append(mi)


func _terrain_shader() -> Shader:
	var s := Shader.new()
	s.code = """
shader_type spatial;
render_mode cull_back, diffuse_burley, specular_schlick_ggx;

uniform sampler2D vis_bits : filter_nearest;
uniform float vis_on = 1.0;
uniform sampler2D wet_tex : filter_linear, repeat_enable, hint_default_black;
uniform sampler2D cloud_tex : filter_linear, repeat_enable, hint_default_black;
uniform sampler2D cloud_prev : filter_linear, repeat_enable, hint_default_black;
uniform float cloud_blend = 1.0;
uniform vec2 cloud_off = vec2(0.0);
uniform vec2 cloud_off_prev = vec2(0.0);
uniform vec2 shadow_shift = vec2(-0.012, -0.012);
uniform vec2 weather_extent = vec2(221.7, 192.0);

varying vec3 wpos;
varying vec2 tile;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
	vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
	return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float seen(vec2 t) {
	int q = int(t.x + 0.5);
	int b = int(texelFetch(vis_bits, ivec2(q >> 3, int(t.y + 0.5)), 0).r * 255.0 + 0.5);
	return float((b >> (q & 7)) & 1);
}

void vertex() {
	wpos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
	tile = UV2;
}

void fragment() {
	vec3 base = pow(COLOR.rgb, vec3(2.2));   // vertex colours are sRGB
	vec3 wn = normalize((INV_VIEW_MATRIX * vec4(NORMAL, 0.0)).xyz);
	float slope = 1.0 - wn.y;
	float n = noise(wpos.xz * 1.3) * 0.55 + noise(wpos.xz * 5.0) * 0.3 + noise(wpos.xz * 17.0) * 0.15;
	base *= 0.9 + 0.2 * n;
	vec3 rock = vec3(0.43, 0.41, 0.38) * (0.88 + 0.24 * n);
	base = mix(base, rock, smoothstep(0.22, 0.42, slope) * step(0.05, wpos.y));
	float snow = smoothstep(1.55, 1.8, wpos.y + n * 0.25) * (1.0 - smoothstep(0.42, 0.65, slope));
	base = mix(base, vec3(0.87, 0.88, 0.9), snow);
	vec2 wuv = vec2(wpos.x / weather_extent.x, wpos.z / weather_extent.y);
	float wet = texture(wet_tex, wuv).r * step(0.0, wpos.y);
	base *= 1.0 - 0.3 * wet;
	float cl = mix(texture(cloud_prev, wuv - cloud_off_prev + shadow_shift).r, texture(cloud_tex, wuv - cloud_off + shadow_shift).r, cloud_blend);
	float shade = 1.0 - 0.3 * smoothstep(0.3, 0.75, cl);
	float v = mix(1.0, seen(tile), vis_on);
	vec3 remembered = mix(vec3(dot(base, vec3(0.3, 0.59, 0.11))), base, 0.45) * vec3(0.62, 0.65, 0.72);
	ALBEDO = mix(remembered, base, v) * shade;
	ROUGHNESS = mix(0.93, 0.35, wet);
	SPECULAR = 0.25 + 0.35 * wet;
}
"""
	return s


func _water_shader() -> Shader:
	var s := Shader.new()
	s.code = """
shader_type spatial;
render_mode blend_mix, cull_back, depth_draw_opaque, specular_schlick_ggx;

uniform sampler2D vis_bits : filter_nearest;
uniform float vis_on = 1.0;
uniform vec2 world_cells = vec2(128.0, 128.0);

varying vec3 wpos;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
	vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
	return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float seen(vec3 p) {
	// the hex under this point (water has no per-hex attribute): pointy-top odd-r conversion
	float cx = 0.57735 * p.x - p.z / 3.0;
	float cz = 2.0 / 3.0 * p.z;
	float cy = -cx - cz;
	vec3 r = round(vec3(cx, cy, cz));
	vec3 d = abs(r - vec3(cx, cy, cz));
	if (d.x > d.y && d.x > d.z) r.x = -r.y - r.z; else if (d.y > d.z) r.y = -r.x - r.z; else r.z = -r.x - r.y;
	int row = int(r.z);
	int col = int(r.x) + (row - (row & 1)) / 2;
	int w = int(world_cells.x);
	col = ((col % w) + w) % w;
	row = clamp(row, 0, int(world_cells.y) - 1);
	int b = int(texelFetch(vis_bits, ivec2(col >> 3, row), 0).r * 255.0 + 0.5);
	return float((b >> (col & 7)) & 1);
}

void vertex() {
	wpos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	float t = TIME;
	float n1 = noise(wpos.xz * 1.6 + vec2(t * 0.11, t * 0.07));
	float n2 = noise(wpos.xz * 4.1 - vec2(t * 0.05, t * 0.13));
	vec3 bump = vec3(n1 - 0.5, 0.0, n2 - 0.5) * 0.18;
	NORMAL = normalize(NORMAL + (VIEW_MATRIX * vec4(bump, 0.0)).xyz);
	float v = mix(1.0, seen(wpos), vis_on);
	vec3 col = pow(COLOR.rgb, vec3(2.2)) * (0.95 + 0.1 * n1);
	ALBEDO = mix(col * vec3(0.6, 0.64, 0.72), col, v);
	ALPHA = COLOR.a;
	ROUGHNESS = 0.22 + 0.1 * n2;
	METALLIC = 0.0;
	SPECULAR = 0.4;
}
"""
	return s
