class_name WorldRenderer
extends Node3D
## Terrain: one ArrayMesh per 16x16-hex chunk built from the server's terrain geometry, plus a
## water mesh (sea, lakes, river ribbons) per chunk. Hex centres sit at their own height, corners at
## the mean of the three hexes that meet there, so the land is continuous and biomes blend at the
## corners. Fog of war is a per-hex bit texture read in the shader; weather (wet ground, cloud
## shadows) comes from EnvironmentRenderer. Each chunk is drawn at the image(s) of the wrapped world
## that the camera can see, so the east-west seam is never visible.

const CHUNK_BUDGET_MS := 3.0
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
	Color(0.62, 0.61, 0.60),  # peaks (bare rock; snow comes from height in the shader)
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
var max_build_ms := 0.0
var build_job := {}             # one chunk's arrays, filled incrementally across frames
var urban_mask := PackedByteArray()
var surface_fields:=WorldPresentationFields.new()
var fog_planes:Array=[]
var fog_material:ShaderMaterial
var territory:TerritoryField


func setup(w: WorldState) -> void:
	world = w
	terrain_mat = ShaderMaterial.new()
	terrain_mat.shader = _terrain_shader()
	terrain_mat.set_shader_parameter("ground_detail",load("res://assets/materials/ground_natural_albedo.jpg"))
	water_mat = ShaderMaterial.new()
	water_mat.shader = _water_shader()
	world.welcomed.connect(_on_welcome)
	world.geo_changed.connect(_on_geo)
	world.battlefield_terrain_changed.connect(_on_battlefield_terrain)
	world.vis_changed.connect(_on_vis)
	world.reset.connect(_on_welcome)
	world.econ_applied.connect(_on_economy)
	surface_fields.setup(world,[terrain_mat,water_mat])
	territory=TerritoryField.new(); territory.setup(world,terrain_mat); add_child(territory)


func _on_welcome() -> void:
	for c in chunks.values():
		for m in c.inst + c.winst:
			(m as Node).queue_free()
	chunks.clear()
	dirty.clear()
	build_job.clear()
	urban_mask=world.urban_bits.duplicate()
	chunks_built = 0
	last_build_ms = 0.0
	max_build_ms = 0.0
	# Presentation textures belong to this world, including when the same viewport rejoins.
	terrain_mat.set_shader_parameter("overlay_strength",0.0)
	terrain_mat.set_shader_parameter("battle_active",0.0)
	var g := world.grid
	var img := Image.create_from_data(g.w / 8, g.h, false, Image.FORMAT_R8, world.vis_bits)
	vis_tex = ImageTexture.create_from_image(img)
	known_tex = ImageTexture.create_from_image(Image.create_from_data(g.w, g.h, false, Image.FORMAT_R8, world.known_mask))
	for m in [terrain_mat, water_mat]:
		m.set_shader_parameter("vis_bits", vis_tex)
		m.set_shader_parameter("vis_on", 0.0 if world.spectator else 1.0)
	water_mat.set_shader_parameter("world_cells", Vector2(g.w, g.h))
	colors.resize(g.n)
	_setup_fog_backdrop()


func _on_vis(bits: PackedByteArray) -> void:
	if vis_tex == null:
		return
	vis_tex.update(Image.create_from_data(world.grid.w / 8, world.grid.h, false, Image.FORMAT_R8, bits))
	for m in [terrain_mat, water_mat]:
		m.set_shader_parameter("vis_on", 1.0)


func _on_geo(list: PackedInt32Array) -> void:
	for cid in list:
		dirty[cid] = int(dirty.get(cid, 0)) + 1
	if known_tex:
		known_tex.update(Image.create_from_data(world.grid.w, world.grid.h, false, Image.FORMAT_R8, world.known_mask))


func _on_battlefield_terrain(tiles:PackedInt32Array) -> void:
	for tile in tiles:
		var cid:=world._chunk_of(tile)
		dirty[cid]=int(dirty.get(cid,0))+1


func _on_economy() -> void:
	if urban_mask==world.urban_bits: return
	# Urban soil tint is presentation too. Without local invalidation, finishing a building
	# changes its ground only on the next reconnect, producing different before/after terrain.
	var affected:={}
	for byte in world.urban_bits.size():
		var changed:=int(world.urban_bits[byte]) ^ (int(urban_mask[byte]) if byte<urban_mask.size() else 0)
		if changed==0: continue
		for bit in 8:
			var tile:=byte*8+bit
			if (changed & (1<<bit))==0 or tile>=world.grid.n or world.known[tile]==0: continue
			affected[world._chunk_of(tile)]=true
			for dir in 6:
				var neighbor:=world.grid.nb[tile*6+dir]
				if neighbor>=0: affected[world._chunk_of(neighbor)]=true
	urban_mask=world.urban_bits.duplicate()
	for chunk in affected: dirty[chunk]=int(dirty.get(chunk,0))+1


## called by the bootstrap every frame with the camera's view
func update_view(camera_x: float, view_half_width: float) -> void:
	cam_x = camera_x
	half_w = view_half_width
	_build_some()
	if world.grid:
		for index in fog_planes.size(): fog_planes[index].position.x=world.grid.near_x(world.grid.period*.5,cam_x)+(index-1)*world.grid.period
	for c in chunks.values():
		_place(c)


func _build_some() -> void:
	if dirty.is_empty():
		return
	var t0 := Time.get_ticks_usec()
	# Upload a completed chunk in its own slice so mesh upload cannot stack on array generation.
	if not build_job.is_empty() and int(build_job.next) == (build_job.tiles as PackedInt32Array).size():
		var cid := int(build_job.cid)
		_commit_chunk()
		if int(dirty.get(cid, 0)) == int(build_job.revision):
			dirty.erase(cid)
		build_job.clear()
		chunks_built += 1
		last_build_ms = (Time.get_ticks_usec() - t0) / 1000.0
		max_build_ms = maxf(max_build_ms, last_build_ms)
		return
	if build_job.is_empty():
		# Choose only when starting a chunk. Sorting 256 entries every partial slice adds overhead.
		var ids := dirty.keys()
		ids.sort_custom(func(a, b): return _chunk_dist(a) < _chunk_dist(b))
		_begin_chunk(int(ids[0]))
	var tiles: PackedInt32Array = build_job.tiles
	while int(build_job.next) < tiles.size():
		_append_tile(tiles[int(build_job.next)])
		build_job.next += 1
		if (Time.get_ticks_usec() - t0) / 1000.0 >= CHUNK_BUDGET_MS:
			break
	last_build_ms = (Time.get_ticks_usec() - t0) / 1000.0
	max_build_ms = maxf(max_build_ms, last_build_ms)


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


func _begin_chunk(cid: int) -> void:
	var g := world.grid
	var cs := world.chunk
	var cx := cid % world.chunks_w
	var cy := cid / world.chunks_w
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
	build_job = {"cid": cid, "revision": dirty[cid], "tiles": tiles, "next": 0, "vt": [], "nt": [], "ct": [], "ut": [], "water": MeshKit.new()}


func _append_tile(i: int) -> void:
	var g := world.grid
	var vt: Array = build_job.vt
	var nt: Array = build_job.nt
	var ct: Array = build_job.ct
	var ut: Array = build_job.ut
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
		if world.visual_craters.has(i):
			_append_crater_triangle(i,c,pc[k],pc[k2],cn,pn[k],pn[k2],col,pcol[k],pcol[k2],uv)
			continue
		vt.append(c); vt.append(pc[k]); vt.append(pc[k2])
		nt.append(cn); nt.append(pn[k]); nt.append(pn[k2])
		ct.append(col); ct.append(pcol[k]); ct.append(pcol[k2])
		ut.append(uv); ut.append(uv); ut.append(uv)
	_water_for(i, c2, build_job.water)


## Subdivide only cratered hexes. The profile tapers to zero before every hex edge, so existing
## neighbors and chunk seams remain continuous without globally increasing terrain resolution.
func _append_crater_triangle(tile:int,c:Vector3,a:Vector3,b:Vector3,nc:Vector3,na:Vector3,nb:Vector3,cc:Color,ca:Color,cb:Color,uv:Vector2) -> void:
	const STEPS:=6
	for row in STEPS:
		for column in STEPS-row:
			var p0:=Vector2(float(row)/STEPS,float(column)/STEPS)
			var p1:=Vector2(float(row+1)/STEPS,float(column)/STEPS)
			var p2:=Vector2(float(row)/STEPS,float(column+1)/STEPS)
			for p in [p0,p1,p2]: _append_crater_vertex(tile,c,a,b,nc,na,nb,cc,ca,cb,uv,p)
			if row+column<STEPS-1:
				var p3:=Vector2(float(row+1)/STEPS,float(column+1)/STEPS)
				for p in [p1,p3,p2]: _append_crater_vertex(tile,c,a,b,nc,na,nb,cc,ca,cb,uv,p)


func _append_crater_vertex(tile:int,c:Vector3,a:Vector3,b:Vector3,nc:Vector3,na:Vector3,nb:Vector3,cc:Color,ca:Color,cb:Color,uv:Vector2,p:Vector2) -> void:
	var weight:=1.0-p.x-p.y
	var vertex:=c*weight+a*p.x+b*p.y
	var normal:Vector3=(nc*weight+na*p.x+nb*p.y).normalized()
	var step:=.015
	var dx:float=(world.visual_crater_delta(tile,vertex.x+step,vertex.z)-world.visual_crater_delta(tile,vertex.x-step,vertex.z))/(2.0*step)
	var dz:float=(world.visual_crater_delta(tile,vertex.x,vertex.z+step)-world.visual_crater_delta(tile,vertex.x,vertex.z-step))/(2.0*step)
	vertex.y+=world.visual_crater_delta(tile,vertex.x,vertex.z)
	(build_job.vt as Array).append(vertex)
	(build_job.nt as Array).append(Vector3(normal.x-dx*normal.y,normal.y,normal.z-dz*normal.y).normalized())
	# vertex alpha carries the crater bowl (1 = level ground) so rain can pool in real hollows
	var tint:Color=cc*weight+ca*p.x+cb*p.y
	tint.a=1.0-world.crater_bowl(tile,vertex.x,vertex.z)
	(build_job.ct as Array).append(tint)
	(build_job.ut as Array).append(uv)


func _commit_chunk() -> void:
	var cid := int(build_job.cid)
	var cs := world.chunk
	var cx := cid % world.chunks_w
	var water: MeshKit = build_job.water
	var rec: Dictionary = chunks.get(cid, {})
	if rec.is_empty():
		rec = {"inst": [], "winst": [], "x0": cx * cs * SQRT3 - SQRT3, "w": (cs + 2) * SQRT3}
		chunks[cid] = rec
	var mesh: ArrayMesh = null
	if not (build_job.vt as Array).is_empty():
		var arrays := []
		arrays.resize(Mesh.ARRAY_MAX)
		arrays[Mesh.ARRAY_VERTEX] = PackedVector3Array(build_job.vt)
		arrays[Mesh.ARRAY_NORMAL] = PackedVector3Array(build_job.nt)
		arrays[Mesh.ARRAY_COLOR] = PackedColorArray(build_job.ct)
		arrays[Mesh.ARRAY_TEX_UV2] = PackedVector2Array(build_job.ut)
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
				s += _sea_color(nb) if nb >= 0 and world.known[nb] and world.is_sea(nb) else Color(0.25, 0.31, 0.29, 0.92)
			cols.append(s / 3.0)
		for k in 6:
			kit.tri_colors("water", centre, pts[k], pts[(k + 1) % 6], cc, cols[k], cols[(k + 1) % 6], Vector3.UP)
	elif world.is_lake(i):
		var level:=world.water_level(i); var col:=_lake_color(i)
		var center:=Vector3(c2.x,level,c2.y); var points:=[]; var colors_:=[]
		for corner in 6:
			var offset:=g.corners[corner]; points.append(Vector3(c2.x+offset.x,level,c2.y+offset.y))
			var color:=col; var count:=1.0
			for direction in HexGrid.CORNER_DIRS[corner]:
				var neighbor:=g.nb[i*6+int(direction)]
				if neighbor>=0 and world.known[neighbor] and world.is_lake(neighbor): color+=_lake_color(neighbor); count+=1
			colors_.append(color/count)
		for corner in 6: kit.tri_colors("water",center,points[corner],points[(corner+1)%6],col,colors_[corner],colors_[(corner+1)%6],Vector3.UP)
	elif world.is_river(i):
		var col:=Color(.16,.29,.30,.96)
		var sections:=RiverGeometry.ribbon(world,i)
		var left:Array[Vector3]=[]; var right:Array[Vector3]=[]
		for section in sections:
			var normal:Vector2=section.side
			var center:=_river_point(section.center)
			left.append(center+Vector3(normal.x,0,normal.y)); right.append(center-Vector3(normal.x,0,normal.y))
		for index in sections.size()-1:
			kit.quad("water",left[index],right[index],right[index+1],left[index+1],col,Vector3.UP)
		# A confluence shares one filled center; ribbons meet without triangular holes.
		if sections.is_empty(): kit.cylinder("water",Vector3(c2.x,world.ground_height(c2.x,c2.y)+.028,c2.y),RiverGeometry.width(world,i)*.45,.001,12,col,RiverGeometry.width(world,i)*.45)

func _lake_color(tile:int) -> Color:
	var depth:=maxf(0.0,world.water_level(tile)-world.height[tile])
	return Color(.17,.31,.30).lerp(Color(.07,.19,.25),clampf(depth/.65,0,1))

func _river_point(point:Vector2) -> Vector3:
	var tile:=world.grid.tile_at(point.x,point.y)
	var level:=world.water_level(tile) if tile>=0 and world.known[tile] else -1e6
	var y:=level+.012 if level> -1e6 and (world.is_sea(tile) or world.is_lake(tile)) else world.ground_height(point.x,point.y)+.028
	return Vector3(point.x,y,point.y)


func _sea_color(i: int) -> Color:
	var depth := world.geo[i * 6 + 2] / 255.0
	var col := Color(0.17, 0.33, 0.34).lerp(Color(0.05, 0.16, 0.24), clampf(depth * 2.2, 0.0, 1.0))
	col.a = lerpf(0.88, 0.96, clampf(depth * 2.0, 0.0, 1.0))
	return col


## the water (or river) surface a river reach runs into, for a smooth join
func _surface(nb: int, fallback: float) -> float:
	if nb < 0 or not world.known[nb]:
		return fallback
	var wl := world.water_level(nb)
	if wl > -1e6:
		return wl + 0.01
	return world.height[nb] + 0.05


## Keep stable images resident. Godot's mesh frustum culling decides what is on screen; zoom must
## never hide/reassign terrain instances using a separately estimated horizontal view width.
func _place(rec: Dictionary) -> void:
	var g := world.grid
	var offsets: Array[float] = []
	if g.wrap:
		var base := g.near_x(float(rec.x0) + float(rec.w) * 0.5, cam_x) - (float(rec.x0) + float(rec.w) * 0.5)
		for k in [-1, 0, 1]:
			offsets.append(base + k * g.period)
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
uniform sampler2D ground_detail : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
#include "res://shaders/weather_clouds.gdshaderinc"
#include "res://shaders/visibility_fields.gdshaderinc"
#include "res://shaders/territory_fields.gdshaderinc"
global uniform float snow_cover;
#include "res://shaders/development_fields.gdshaderinc"
uniform sampler2D strategic_overlay : filter_nearest, hint_default_black;
uniform float overlay_strength = 0.0;
uniform sampler2D battle_scar : filter_linear, repeat_enable, hint_default_black;
uniform vec2 battle_cells = vec2(128.0);
uniform float battle_active = 0.0;
uniform sampler2D trench_routes : filter_nearest, repeat_disable, hint_default_black;
uniform vec2 trench_cells=vec2(128.0);
uniform float trench_active=0.0;
uniform sampler2D river_bank_field : filter_linear,repeat_disable,hint_default_black;
uniform vec2 river_bank_origin=vec2(0);
uniform float river_bank_extent=10.0;
uniform float river_bank_active=0.0;

varying vec3 wpos;
varying vec2 tile;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
	vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
	return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float seen(vec2 t) {
	if (vis_on < 0.5) return 1.0;
	int q = int(t.x + 0.5);
	ivec2 cell=ivec2(q >> 3, int(t.y + 0.5));
	ivec2 bounds=textureSize(vis_bits,0);
	if (cell.x<0 || cell.y<0 || cell.x>=bounds.x || cell.y>=bounds.y) return 0.0;
	int b = int(texelFetch(vis_bits, cell, 0).r * 255.0 + 0.5);
	return float((b >> (q & 7)) & 1);
}

void vertex() {
	wpos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
	tile = UV2;
}

void fragment() {
	if (trench_active>.5) {
		ivec2 cell=ivec2(tile+vec2(.5));
		vec4 route=texelFetch(trench_routes,clamp(cell,ivec2(0),ivec2(trench_cells)-ivec2(1)),0);
		if (route.a>.5 && route.r>.01) {
			vec2 center=vec2(1.7320508*(float(cell.x)+.5*mod(float(cell.y),2.0)),1.5*float(cell.y));
			vec2 local=wpos.xz-center;
			float period=trench_cells.x*1.7320508;
			local.x-=round(local.x/period)*period;
			int bits=int(route.g*255.0+.5);
			float nearest=100.0;
			for (int d=0;d<6;d++) if ((bits & (1<<d))!=0) {
				float angle=-float(d)*1.04719755; vec2 endpoint=vec2(cos(angle),sin(angle))*.8660254;
				float along=clamp(dot(local,endpoint)/dot(endpoint,endpoint),0.0,1.0);
				nearest=min(nearest,length(local-endpoint*along));
			}
			if (nearest<.043+.03*route.r) discard;
		}
	}
	vec3 base = pow(COLOR.rgb, vec3(2.2));   // vertex colours are sRGB
	vec3 wn = normalize((INV_VIEW_MATRIX * vec4(NORMAL, 0.0)).xyz);
	float slope = 1.0 - wn.y;
	vec3 weights = pow(abs(wn), vec3(4.0)); weights /= max(dot(weights, vec3(1.0)), 0.0001);
	float n = (noise(wpos.zy * 5.0)*weights.x + noise(wpos.xz * 5.0)*weights.y + noise(wpos.xy * 5.0)*weights.z)*0.45 + noise(wpos.xz * 1.3)*0.55;
	base *= 0.9 + 0.2 * n;
	// Wrapped world-space sampling avoids a discontinuity at the horizontal map seam.
	vec2 ground_uv=vec2(wpos.x/weather_extent.x*max(1.0,round(weather_extent.x*.7)),wpos.z*.7);
	vec3 surface=texture(ground_detail,ground_uv).rgb;
	float micro=clamp(dot(surface,vec3(.299,.587,.114))*5.0,.6,1.35);
	base*=mix(1.0,micro,.42*weights.y);
	float river_margin=0.0;
	if (river_bank_active>.0) {
		float period=weather_extent.x;
		vec2 relative=wpos.xz-river_bank_origin;
		relative.x-=round((relative.x-river_bank_extent*.5)/period)*period;
		vec2 uv=relative/river_bank_extent;
		if (all(greaterThan(uv,vec2(0))) && all(lessThan(uv,vec2(1)))) {
			vec4 bank=texture(river_bank_field,uv);
			river_margin=bank.a;
			float fade=smoothstep(.0,.1,min(min(uv.x,uv.y),min(1.0-uv.x,1.0-uv.y)));
			base=mix(base,vec3(.12,.105,.075),bank.a*(1.0-bank.b)*fade*river_bank_active*.45);
		}
	}
	base=developed_ground(base,wpos.xz,river_margin);
	vec3 rock = vec3(0.43, 0.41, 0.38) * (0.88 + 0.24 * n);
	base = mix(base, rock, smoothstep(0.22, 0.42, slope) * step(0.05, wpos.y));
	float snow = smoothstep(3.8, 4.5, wpos.y + n * 0.3) * (1.0 - smoothstep(0.35, 0.6, slope));
	base = mix(base, vec3(0.72, 0.74, 0.77), snow);
	vec2 wuv = vec2(wpos.x / weather_extent.x, wpos.z / weather_extent.y);
	float wet = texture(wet_tex, wuv).r * step(0.0, wpos.y);
	vec2 battle_uv = vec2(wpos.x/1.7320508 - .5*mod(floor(wpos.z/1.5+.5),2.0), wpos.z/1.5);
	// Warzone material field: scar colour follows the ground it damages (soil, rock/scree, sand,
	// wetland mud, urban rubble); scorch blackens, tracks rut the soil, and rain pools in bowls.
	vec4 field = texture(battle_scar,(battle_uv+vec2(.5))/battle_cells) * battle_active * step(.01,wpos.y);
	vec4 cls_texel = texelFetch(battle_scar, clamp(ivec2(battle_uv+vec2(.5)), ivec2(0), ivec2(battle_cells)-ivec2(1)), 0);
	int ground_class = int(round(cls_texel.a*4.0));
	vec3 scar_color = vec3(.24,.20,.15);
	if (ground_class==1) scar_color = vec3(.40,.38,.35);
	else if (ground_class==2) scar_color = vec3(.58,.50,.37);
	else if (ground_class==3) scar_color = vec3(.15,.14,.11);
	else if (ground_class==4) scar_color = vec3(.42,.41,.39);
	float scar = field.r;
	base = mix(base,scar_color*(0.8+0.3*n),scar*.8);
	base = mix(base,vec3(.06,.055,.05)*(0.85+0.3*n),smoothstep(.05,.9,field.g)*.75);
	float ruts = smoothstep(.55,.95,abs(sin(dot(wpos.xz,vec2(.83,.56))*38.0+noise(wpos.xz*2.0)*3.0)));
	base = mix(base,scar_color*1.1,field.b*(.35+.45*ruts)*(ground_class==4?0.0:1.0));
	wet = max(wet,scar*wet);
	float pooled = smoothstep(.25,.75,1.0-COLOR.a) * smoothstep(.2,.6,wet) * battle_active;
	base = mix(base,vec3(.10,.12,.12),pooled*.85);
	base *= 1.0 - 0.3 * wet;
	base = mix(base, vec3(.80,.82,.85)*(.92+.1*n), snow_cover*(1.0-smoothstep(.15,.4,slope))*step(.01,wpos.y)*.8);
	base = territory_tint(base, wpos.xz);
	// hillshade grows with zoom-out so ridges and massifs keep their form at strategic scale
	float relief = clamp(dot(wn, normalize(vec3(-.55,.72,-.42))), 0.0, 1.0);
	base *= mix(1.0, .62 + .62 * relief, clamp((fog_view_size - 25.0) / 90.0, 0.0, .85) * smoothstep(.04, .25, slope));
	float shade = cloud_shadow(wpos);
	vec2 knowledge=surface_visibility(wpos.xz);
	ALBEDO=remembered_surface(base,knowledge.y)*shade;
	// An inactive lens may still have the default 1x1 texture. Out-of-range texelFetch is
	// undefined (and NaN * 0 can poison the terrain colour even with a zero-strength lens).
	if (overlay_strength > 0.0) {
		ivec2 bounds=textureSize(strategic_overlay,0);
		ivec2 sample_tile=clamp(ivec2(tile+vec2(.5)),ivec2(0),bounds-ivec2(1));
		vec4 overlay=texelFetch(strategic_overlay,sample_tile,0);
		ALBEDO=mix(ALBEDO,overlay.rgb,overlay.a*overlay_strength);
	}
	ALBEDO*=knowledge.x;
	EMISSION=fog_ink(wpos.xz)*(1.0-knowledge.x);
	ROUGHNESS = mix(0.93, 0.35, wet);
	SPECULAR = (0.25 + 0.35 * wet)*knowledge.x;
}
"""
	return s


func _water_shader() -> Shader:
	return load("res://shaders/living_water.gdshader")

func _setup_fog_backdrop() -> void:
	for plane:MeshInstance3D in fog_planes: plane.queue_free()
	fog_planes.clear()
	if fog_material==null:
		fog_material=ShaderMaterial.new(); fog_material.shader=load("res://shaders/fog_backdrop.gdshader")
	fog_material.set_shader_parameter("visibility_cells",Vector2(world.grid.w,world.grid.h))
	var mesh:=PlaneMesh.new(); mesh.size=Vector2(world.grid.period,world.grid.depth+2); mesh.material=fog_material
	for index in 3:
		var plane:=MeshInstance3D.new(); plane.mesh=mesh; plane.position=Vector3(world.grid.period*(index-.5),-2.5,world.grid.depth*.5)
		plane.cast_shadow=GeometryInstance3D.SHADOW_CASTING_SETTING_OFF; add_child(plane); fog_planes.append(plane)
