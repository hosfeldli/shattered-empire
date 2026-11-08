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

# Overhead clouds are a distant atmospheric cue, never a veil over close-up play.
static func cloud_opacity(camera_size:float) -> float:
	return .10*smoothstep(28.0,70.0,camera_size)

var water:=WaterDynamics.new()
var cloud_clock:=0.0
var previous_age:=0.0
var cloud_drift:=Vector2.ZERO
var wind_world:=Vector2.ZERO
var snow_mesh:SphereMesh
var rain_mesh:BoxMesh
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
var composition: WorldCompositionSystem
var wx_updates := 0
var props := {}            # chunk id -> { trees: MultiMeshInstance3D, rocks: MeshInstance3D, x0 }
var props_dirty := {}
var built_tiles := {}
var work_tiles:={}
var tree_mesh: ArrayMesh
var vegetation: Dictionary = RecipeRegistry.world_section("vegetation").get("soft", {})
var broadleaf_mesh: ArrayMesh
var tree_far: ArrayMesh          # low-detail tree models beyond close zoom (same silhouettes)
var broadleaf_far: ArrayMesh
var trees_detailed := true
var tree_count := 0
var shadows_allowed := true
var hide_trees := false
var effects_enabled:=true
var reduced_motion:=false


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
	e.background_color = Color(.034,.044,.046)
	e.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	e.ambient_light_color = Color(0.62, 0.67, 0.74)
	e.ambient_light_energy = 0.6
	e.fog_density=0.0
	e.tonemap_mode = Environment.TONE_MAPPER_FILMIC
	e.tonemap_exposure = 1.0
	e.ssao_enabled = true
	e.ssao_radius = 0.5
	e.ssao_intensity = 1.2
	env.environment = e
	add_child(env)
	water.setup(w,t)
	_make_clouds()
	_make_rain()
	tree_mesh = _tree_model()
	broadleaf_mesh = _broadleaf_model()
	tree_far = _tree_far()
	broadleaf_far = _broadleaf_far()
	world.weather_changed.connect(_on_weather)
	world.geo_changed.connect(_on_geo)
	world.battlefield_terrain_changed.connect(_on_battlefield_terrain)
	world.tiles_changed.connect(_on_tiles)
	world.econ_applied.connect(_on_econ)
	world.welcomed.connect(_clear)
	world.reset.connect(_clear)


func _clear() -> void:
	# a reload or new world starts from clean presentation state: no stale snow, flash or wind
	snow_level = 0.0; flash = 0.0
	RenderingServer.global_shader_parameter_set(&"snow_cover", 0.0)
	for p in props.values():
		(p.trees as Node).queue_free()
		if p.has("broad"): (p.broad as Node).queue_free()
		(p.rocks as Node).queue_free()
		(p.canopy as Node).queue_free()
	props.clear()
	tree_count = 0
	props_dirty.clear()
	built_tiles.clear()
	work_tiles.clear()
	# A rejoin can receive geometry before the next weather packet. Do not blend the old
	# world's clouds/wetness into the new visibility mask during that interval.
	cloud_clock=0; previous_age=0; cloud_drift=Vector2.ZERO; wind_world=Vector2.ZERO
	MaterialLibrary.bind_clouds({"cloud_ready":0.0})
	cloud_tex=null; cloud_prev=null; wet_tex=null; rain_img=null
	wx_cw=0; wx_ch=0; wind=Vector2.ZERO; off=Vector2.ZERO; off_prev=Vector2.ZERO; since=0.0
	rain.emitting=false
	for material in [terrain.terrain_mat,cloud_mat,terrain.water_mat]:
		material.set_shader_parameter("cloud_ready",0.0)
		material.set_shader_parameter("cloud_tex",null)
		material.set_shader_parameter("cloud_prev",null)
		material.set_shader_parameter("cloud_off",Vector2.ZERO)
		material.set_shader_parameter("cloud_off_prev",Vector2.ZERO)
		material.set_shader_parameter("cloud_blend",1.0)
	terrain.terrain_mat.set_shader_parameter("wet_tex",null)


func _on_geo(list: PackedInt32Array) -> void:
	for cid in list:
		props_dirty[cid] = true


func _on_battlefield_terrain(tiles:PackedInt32Array) -> void:
	for tile in tiles: props_dirty[world._chunk_of(tile)]=true


func _on_tiles(_tiles:PackedInt32Array,roads:PackedInt32Array) -> void:
	for tile in roads: props_dirty[world._chunk_of(tile)]=true


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
	var works:={}
	for record:Array in world.fw:
		if int(record[4])>0: works[int(record[0])]=record
	for tile in works:
		if not work_tiles.has(tile) or TrenchPresentation.routes(work_tiles[tile],world.grid)!=TrenchPresentation.routes(works[tile],world.grid): props_dirty[world._chunk_of(tile)]=true
	for tile in work_tiles:
		if not works.has(tile): props_dirty[world._chunk_of(tile)]=true
	work_tiles=works


func update(dt: float) -> void:
	if world.grid == null:
		return
	var g := world.grid
	if composition: RenderingServer.global_shader_parameter_set(&"wind_vector", composition.weather.wind * (0.0 if reduced_motion else 1.0))
	_lightning(dt)
	_snow(dt)
	# Sun shadows follow the visible footprint and disappear once they are sub-pixel at map zoom.
	var shadow_size := float(composition.lod.presets.get(composition.lod.quality,{}).get("shadow_size",SHADOW_MAX_SIZE)) if composition else SHADOW_MAX_SIZE
	sun.shadow_enabled = shadows_allowed and cam.size < shadow_size
	sun.directional_shadow_max_distance = CameraController.DISTANCE + minf(cam.size * 0.75, 90.0)
	# clouds drift with the wind between authoritative updates, then cross-fade to the new field
	var visual_dt:=0.0 if world.paused or reduced_motion else dt*world.play_rate
	var overhead_opacity:=cloud_opacity(cam.size) if effects_enabled else 0.0
	clouds.visible=overhead_opacity>0.001
	since += visual_dt
	cloud_clock+=visual_dt
	if composition: wind_world=wind_world.lerp(composition.weather.wind_at_world(Vector2(cam.focus.x,cam.focus.z)),minf(1.0,dt*.6))
	cloud_drift+=wind*Vector2(g.period,g.depth)*visual_dt
	off += wind * visual_dt
	off_prev += wind * visual_dt
	var blend := clampf(since / .8, 0.0, 1.0)
	var toward_sun:=sun.global_transform.basis.z
	var cloud_parameters:={"cloud_shadow_strength":.16 if effects_enabled else 0.0,"cloud_age":since,"cloud_age_prev":since+previous_age,"cloud_off":off,"cloud_off_prev":off_prev,"cloud_blend":blend,"cloud_time":cloud_clock,"cloud_drift":cloud_drift,"cloud_light_slant":Vector2(toward_sun.x,toward_sun.z)/maxf(.2,toward_sun.y)}
	for material in [terrain.terrain_mat,cloud_mat,terrain.water_mat]:
		for key in cloud_parameters: material.set_shader_parameter(key,cloud_parameters[key])
	MaterialLibrary.bind_clouds(cloud_parameters)
	terrain.water_mat.set_shader_parameter("water_wind",wind_world)
	terrain.water_mat.set_shader_parameter("water_time",cloud_clock)
	terrain.water_mat.set_shader_parameter("water_detail",clampf((65.0-cam.size)/40.0,0,1))
	if composition: water.update(dt,cam,composition.weather)
	if terrain.known_tex:
		cloud_mat.set_shader_parameter("known_tex", terrain.known_tex)
		cloud_mat.set_shader_parameter("world_size", Vector2(g.period, g.depth))
	cloud_mat.set_shader_parameter("opacity",overhead_opacity)
	cloud_mat.set_shader_parameter("cloud_steps",9 if composition and composition.lod.quality in ["high","ultra"] else 6)
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
	# detailed crowns up close, low-poly crowns beyond (with hysteresis so it never flickers)
	var detailed := cam.size < (24.0 if trees_detailed else 20.0)
	var lod_changed := detailed != trees_detailed
	trees_detailed = detailed
	for p in props.values():
		if lod_changed:
			var conifers: MultiMesh = (p.trees as MultiMeshInstance3D).multimesh
			if conifers: conifers.mesh = tree_mesh if detailed else tree_far
			if p.has("broad") and (p.broad as MultiMeshInstance3D).multimesh: (p.broad as MultiMeshInstance3D).multimesh.mesh = broadleaf_mesh if detailed else broadleaf_far
		var trees := p.trees as MultiMeshInstance3D
		var canopy := p.canopy as MeshInstance3D
		trees.cast_shadow = tree_shadows
		# Camera distance is fixed by the orthographic boom, so zoom LOD is keyed to camera size.
		var tree_size := float(composition.lod.presets.get(composition.lod.quality,{}).get("tree_size",TREE_LOD_SIZE)) if composition else TREE_LOD_SIZE
		trees.visible = not hide_trees and cam.size < tree_size
		canopy.visible = not hide_trees and cam.size >= tree_size
		var x0: float = float(p.x0)
		var off_x := g.near_x(x0, f.x) - x0
		trees.position = Vector3(off_x, 0, 0)
		if p.has("broad"):
			var broad := p.broad as MultiMeshInstance3D
			broad.visible = trees.visible; broad.cast_shadow = tree_shadows; broad.position = trees.position
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
	previous_age=since
	since = 0.0
	var wa: Array = wx.get("wind", [0.0, 0.5])
	var ang := float(wa[0])
	var strength := float(wa[1])
	wind=Vector2(cos(ang),sin(ang))*Vector2(1,.6)*(.25+strength*.55)/Vector2(cw,ch)/5.0
	for m in [terrain.terrain_mat, cloud_mat,terrain.water_mat]:
		m.set_shader_parameter("cloud_tex", cloud_tex)
		m.set_shader_parameter("cloud_prev", cloud_prev)
		m.set_shader_parameter("weather_extent", extent)
		m.set_shader_parameter("cloud_ready",1.0)
		if composition and composition.weather.wind_texture:
			m.set_shader_parameter("cloud_velocity",composition.weather.wind_texture)
			m.set_shader_parameter("cloud_velocity_ready",1.0)
	MaterialLibrary.bind_clouds({"cloud_tex":cloud_tex,"cloud_prev":cloud_prev,"cloud_ready":1.0,"weather_extent":extent,"cloud_velocity":composition.weather.wind_texture if composition else null,"cloud_velocity_ready":1.0 if composition else 0.0})
	terrain.terrain_mat.set_shader_parameter("wet_tex", wet_tex)


## Snow settles on roofs and open ground while it snows around the camera, and melts away slowly
## after; at strategic zoom (many regions at once) it fades out instead of painting everything.
var snow_level := 0.0
func _snow(dt: float) -> void:
	var want := 0.0
	if composition and effects_enabled:
		var tile := world.grid.tile_at(cam.focus.x, cam.focus.z)
		if tile >= 0: want = clampf(float(composition.weather.at_tile(tile).get("snow", 0.0)) * 1.4, 0.0, 1.0)
	snow_level = move_toward(snow_level, want, dt * (0.02 if want > snow_level else 0.01))
	RenderingServer.global_shader_parameter_set(&"snow_cover", snow_level * (1.0 - smoothstep(35.0, 70.0, cam.size)))


## Storm lightning over the camera's area: brief sky flashes (never with reduced motion) and a
## signal the soundscape answers with thunder after a light-speed-vs-sound delay.
signal lightning(strength: float, delay: float)
var flash := 0.0
var flash_wait := 3.0
var sun_energy := -1.0
func _lightning(dt: float) -> void:
	if sun_energy < 0.0: sun_energy = sun.light_energy
	flash = maxf(0.0, flash - dt * 7.0)
	sun.light_energy = sun_energy * (1.0 + flash * 1.6)
	if composition == null or world.paused or not effects_enabled: return
	var tile := world.grid.tile_at(cam.focus.x, cam.focus.z)
	if tile < 0: return
	var storm := float(composition.weather.at_tile(tile).get("storm", 0.0))
	if storm < 0.35:
		flash_wait = maxf(flash_wait, 2.0)
		return
	flash_wait -= dt * storm
	if flash_wait > 0.0: return
	flash_wait = randf_range(4.0, 14.0)
	var strength := randf_range(0.5, 1.0) * storm
	if not reduced_motion: flash = strength
	lightning.emit(strength, randf_range(0.6, 3.5))


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
	cloud_mat.shader=load("res://shaders/cloud_volume.gdshader")
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
	streak.material = MaterialLibrary.particle(Color(0.7, 0.75, 0.82), 0.22)
	rain_mesh=streak
	snow_mesh=SphereMesh.new(); snow_mesh.radius=.02; snow_mesh.height=.04; snow_mesh.radial_segments=4; snow_mesh.rings=2; snow_mesh.material=MaterialLibrary.particle(Color(.9,.94,.98),.65)
	rain.draw_pass_1 = streak
	rain.emitting = false
	add_child(rain)


func _update_rain(f:Vector3) -> void:
	var local_weather:=composition.weather.at_tile(world.grid.tile_at(f.x,f.z)) if composition else {}
	var r:=float(local_weather.get("rain",0.0))
	var snowing:=float(local_weather.get("snow",0.0))>.001
	# Weather fog must not wash out controls or tactical detail. Fog of war is handled
	# independently by the visibility shaders and remains authoritative.
	env.environment.fog_enabled=false
	env.environment.fog_density=0.0
	rain.emitting=effects_enabled and not reduced_motion and r>.10 and cam.size<24.0 and not world.paused
	if rain.emitting:
		rain.draw_pass_1=snow_mesh if snowing else rain_mesh
		rain.lifetime=2.5 if snowing else .75
		rain.amount_ratio=clampf(r*1.4,.1,1.0)*clampf((28.0-cam.size)/14.0,0,1)
		var material:=rain.process_material as ParticleProcessMaterial
		material.emission_box_extents=Vector3(cam.size*.9,.5,cam.size*.9)
		material.direction=Vector3(wind_world.x*.15,-1,wind_world.y*.15).normalized()
		material.gravity=Vector3(wind_world.x*.3,-.3 if snowing else -2.0,wind_world.y*.3)
		material.initial_velocity_min=1.0 if snowing else 8.0
		material.initial_velocity_max=2.0 if snowing else 11.0
		material.spread=18.0 if snowing else 3.0
		rain.position=Vector3(f.x,f.y+5.0,f.z)


# ------------------------------------------------------------------ natural cover
func _tree_model() -> ArrayMesh:
	# A spruce-like conifer: a tapering trunk and six whorls of foliage that narrow and shorten
	# toward a spire, each turned and slightly offset so the silhouette is ragged rather than a
	# stack of cones; lower whorls are darker (self-shading), new growth lighter at the tip.
	var k := MeshKit.new()
	k.cylinder("bark", Vector3.ZERO, 0.016, 0.09, 6, Color.WHITE, 0.008)
	var whorls := 6
	for i in whorls:
		var t := float(i) / (whorls - 1)
		var radius := lerpf(0.11, 0.028, pow(t, 0.85))
		var height := lerpf(0.085, 0.06, t)
		var y := 0.035 + i * 0.038
		var offset := Vector3(sin(i * 2.3) * 0.006, 0, cos(i * 1.7) * 0.006)
		k.set_frame(offset, i * 0.6)
		k.cone("foliage", Vector3(0, y, 0), radius, height, 9, Color(.66, .78, .64).lerp(Color(.96, 1.0, .9), t))
		k.set_frame(Vector3.ZERO, 0)
	k.cone("foliage", Vector3(0, 0.035 + whorls * 0.038, 0), 0.016, 0.05, 6, Color(.98, 1.0, .92))
	return _sway(k.commit())


func _broadleaf_model() -> ArrayMesh:
	# A rounded deciduous tree: a trunk forking into two limbs and a crown of nine overlapping,
	# faceted lobes at varied heights, darker underneath and lighter where the sun catches the top.
	var k := MeshKit.new()
	k.cylinder("bark", Vector3.ZERO, 0.015, 0.075, 6, Color.WHITE, 0.01)
	k.box("bark", Vector3(0.012, 0.06, 0), Vector3(0.008, 0.045, 0.008), Color.WHITE, 0.0)
	k.box("bark", Vector3(-0.01, 0.06, 0.006), Vector3(0.008, 0.04, 0.008), Color.WHITE, 0.6)
	var lobes := [[Vector3(0, .1, 0), .07], [Vector3(.045, .09, .02), .052], [Vector3(-.04, .095, -.025), .055], [Vector3(.01, .085, -.05), .048],
		[Vector3(-.03, .088, .045), .05], [Vector3(.03, .13, -.015), .05], [Vector3(-.02, .135, .02), .048], [Vector3(.0, .155, .0), .04], [Vector3(.05, .115, .04), .04]]
	for lobe in lobes:
		var c: Vector3 = lobe[0]; var r: float = lobe[1]
		var shade := clampf((c.y - 0.08) / 0.08, 0.0, 1.0)
		var lower := Color(.68, .8, .6).lerp(Color(.85, .95, .74), shade)
		var upper := Color(.82, .93, .7).lerp(Color(1.0, 1.05, .85), shade)
		k.cylinder("foliage", c - Vector3(0, r * 0.6, 0), r * 0.62, r * 0.6, 8, lower, r)
		k.cylinder("foliage", c, r, r * 0.5, 8, upper, r * 0.6)
		k.cylinder("foliage", c + Vector3(0, r * 0.5, 0), r * 0.6, r * 0.25, 8, upper * 1.04, r * 0.15)
	return _sway(k.commit())


## low-detail versions for operational zoom: same height, crown shape and colours, few faces
func _tree_far() -> ArrayMesh:
	var k := MeshKit.new()
	k.cylinder("bark", Vector3.ZERO, 0.016, 0.07, 4, Color.WHITE, 0.01)
	k.cone("foliage", Vector3(0, 0.035, 0), 0.105, 0.14, 6, Color(.7, .8, .66))
	k.cone("foliage", Vector3(0, 0.13, 0), 0.07, 0.15, 6, Color(.9, .98, .86))
	return _sway(k.commit())


func _broadleaf_far() -> ArrayMesh:
	var k := MeshKit.new()
	k.cylinder("bark", Vector3.ZERO, 0.015, 0.075, 4, Color.WHITE, 0.01)
	k.cylinder("foliage", Vector3(0, 0.06, 0), 0.06, 0.05, 7, Color(.72, .84, .64), 0.085)
	k.cylinder("foliage", Vector3(0, 0.11, 0), 0.085, 0.05, 7, Color(.88, .98, .76), 0.03)
	return _sway(k.commit())


func _sway(mesh: ArrayMesh) -> ArrayMesh:
	# crowns sway in the wind; the trunk keeps the shared static surface material
	for surface in mesh.get_surface_count():
		var material := mesh.surface_get_material(surface)
		if material and material.resource_name == "foliage": mesh.surface_set_material(surface, MaterialLibrary.sway_foliage())
	return mesh


func _road_clearance(tile:int,point:Vector2) -> float:
	return InfrastructureRenderer.clearance(world,tile,point)


func _build_props(cid: int) -> void:
	var g := world.grid
	var cs := world.chunk
	var cx := cid % world.chunks_w
	var cy := cid / world.chunks_w
	var xforms: Array[Transform3D] = []
	var broad_xforms: Array[Transform3D] = []
	var broad_cols: Array[Color] = []
	var cols: Array[Color] = []
	var rocks := MeshKit.new()
	var canopy := MeshKit.new()
	# authoritative battlefield intensity per hex: sustained fighting fells and shatters trees
	var scarred := {}
	for record in world.bf.get("i", []): scarred[int(record[0])] = float(record[1])
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
			# vegetation recipe (world.json "vegetation"): trees per biome and the chance a hex has any
			var per_hex: Dictionary = vegetation.get("trees_per_hex", {})
			var chance: Dictionary = vegetation.get("chance_per_hex", {})
			if per_hex.has(str(b)):
				n = int(per_hex[str(b)])
				if chance.has(str(b)) and rng.randf() >= float(chance[str(b)]): n = 0
			if world.is_river(i):
				n = mini(n, int(vegetation.get("river_cap", 4)))
			var woodland_neighbours := 6
			if b == 4:
				woodland_neighbours = 0
				for d in 6:
					var nb := g.nb[i * 6 + d]
					if nb >= 0 and world.biome(nb) == 4: woodland_neighbours += 1
			if b == 4:
				var quilt := Color(0.72, 0.86, 0.62).darkened(rng.randf_range(0.0, 0.16))
				if not work_tiles.has(i) and world.road[i]==0:
					# Distant canopy as overlapping irregular crowns: forest edges read as natural
					# woodland, never as a tiled hex quilt.
					var crown := RandomNumberGenerator.new()
					crown.seed = hash([world.world_seed, i, "canopy"])
					for clump in 6:
						var ca := crown.randf() * TAU
						var cd := 0.0 if clump == 0 else sqrt(crown.randf()) * 0.62
						var cx2 := c.x + cos(ca) * cd
						var cz2 := c.y + sin(ca) * cd
						var cr := crown.randf_range(0.30, 0.46)
						canopy.set_frame(Vector3(cx2, world.ground_height(cx2, cz2) + 0.05, cz2), crown.randf() * TAU)
						canopy.cylinder("foliage", Vector3.ZERO, cr, 0.02 + crown.randf() * 0.03, 9, quilt.darkened(crown.randf() * 0.1), cr * 0.86)
			# Woodland structure: a stable glade in roughly one forest hex in seven (never at the
			# forest edge), and species by altitude and climate: broadleaf mixes into low, warm
			# forest; high ground and cold country stay coniferous and smaller.
			var glade := Vector3.INF
			if b == 4 and woodland_neighbours >= 5 and posmod(hash([world.world_seed, i, "glade"]), 7) == 0:
				var ga := float(posmod(hash([i, "glade-a"]), 628)) / 100.0
				glade = Vector3(c.x + cos(ga) * .25, 0, c.y + sin(ga) * .25); glade.y = .22 + float(posmod(hash([i, "glade-r"]), 12)) / 100.0
			var altitude := world.height[i]
			var broad_share := 0.0 if b == 6 or altitude > 1.6 else clampf(.45 - altitude * .25, 0.0, .45)
			for k in n:
				var a := rng.randf() * TAU
				var d := sqrt(rng.randf()) * 0.82
				var x := c.x + cos(a) * d
				var z := c.y + sin(a) * d
				if glade != Vector3.INF and Vector2(x - glade.x, z - glade.z).length() < glade.y: continue
				if composition and not composition.sites.clear_of_water(i,[Vector2(x-.06,z-.06),Vector2(x+.06,z-.06),Vector2(x+.06,z+.06),Vector2(x-.06,z+.06)],.04): continue
				var y := world.ground_height(x, z)
				if y < 0.02:
					continue
				# forest edges thin out with younger trees; the interior stays dense and tall
				if b == 4 and k >= int(vegetation.get("edge_base_trees", 5)) + woodland_neighbours: continue
				var edge_min := float(vegetation.get("edge_scale_min", 0.78))
				var s := (rng.randf_range(0.95, 1.4) if b == 4 else rng.randf_range(0.75, 1.35)) * (0.8 if b == 7 else 1.0) * (edge_min + (1.0 - edge_min) * woodland_neighbours / 6.0 if b == 4 else 1.0)
				var girth:=rng.randf_range(.8,1.15)
				var transform:=Transform3D(Basis(Vector3.UP,rng.randf()*TAU).scaled(Vector3(s*girth,s*rng.randf_range(.85,1.3)/sqrt(girth),s*girth)),Vector3(x,y-.01,z))
				var tint:=Color(1,1,1).darkened(rng.randf()*.25).lerp(Color(.9,.95,.7),rng.randf()*.2)
				if work_tiles.has(i) and TrenchPresentation.distance_to_route(work_tiles[i],g,Vector2(x,z))<.22: continue
				if world.road[i]!=0 and _road_clearance(i,Vector2(x,z))<.09: continue
				if scarred.has(i):
					var keep := 1.0 - clampf(float(scarred[i]) * float(vegetation.get("battle_loss_per_stage", 0.333)), 0.0, float(vegetation.get("battle_loss_max", 0.85)))
					if float(posmod(hash([i, k, "scar"]), 1000)) / 1000.0 > keep:
						rocks.set_frame(Vector3.ZERO, 0.0)
						rocks.cylinder("bark", Vector3(x, y - 0.01, z), 0.017, 0.03 + 0.03 * float(posmod(hash([i, k]), 3)), 5, Color(0.45, 0.38, 0.3), 0.012)
						if posmod(hash([i, k, "log"]), 2) == 0:
							rocks.box("bark", Vector3(x + 0.05, y - 0.005, z), Vector3(0.12, 0.018, 0.018), Color(0.4, 0.34, 0.28), float(posmod(hash([i, k, "yaw"]), 628)) / 100.0)
						continue
				if altitude > 1.6 and b == 4: transform.basis = transform.basis.scaled(Vector3.ONE * .82)
				var conifer: bool = b in (vegetation.get("conifer_biomes", [4, 6]) as Array) and float(posmod(hash([i, k, "species"]), 1000)) / 1000.0 >= broad_share
				if conifer: xforms.append(transform); cols.append(tint)
				else: broad_xforms.append(transform); broad_cols.append(tint.lerp(Color(.95, .9, .7), .08 if b == 4 else 0.0))
			_undergrowth(rocks, i, c, b, woodland_neighbours, glade)
			_river_banks(rocks, i)
			_deposit(rocks, i, c, rng)
			_derelict(rocks, i, c)
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
		var broad := MultiMeshInstance3D.new()
		add_child(broad)
		rec = {"trees": mmi, "broad": broad, "rocks": mi, "canopy": far, "x0": (cx + 0.5) * cs * SQRT3}
		props[cid] = rec
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.use_colors = true
	mm.mesh = tree_mesh if trees_detailed else tree_far
	mm.instance_count = xforms.size()
	for k in xforms.size():
		mm.set_instance_transform(k, xforms[k])
		mm.set_instance_color(k, cols[k])
	tree_count += xforms.size() - int(rec.get("n", 0))
	rec.n = xforms.size()
	(rec.trees as MultiMeshInstance3D).multimesh = mm
	var bm := MultiMesh.new()
	bm.transform_format = MultiMesh.TRANSFORM_3D
	bm.use_colors = true
	bm.mesh = broadleaf_mesh if trees_detailed else broadleaf_far
	bm.instance_count = broad_xforms.size()
	for k in broad_xforms.size():
		bm.set_instance_transform(k, broad_xforms[k]); bm.set_instance_color(k, broad_cols[k])
	(rec.broad as MultiMeshInstance3D).multimesh = bm
	(rec.rocks as MeshInstance3D).mesh = rocks.commit() if not rocks.is_empty() else null
	(rec.canopy as MeshInstance3D).mesh = canopy.commit() if not canopy.is_empty() else null


## a visible sign of what lies in the ground (iron, coal, stone, oil, rare earths)
func _deposit(kit: MeshKit, i: int, c: Vector2, rng: RandomNumberGenerator) -> void:
	var dep := world.deposit(i)
	if dep == 0 or dep > 7:
		return
	var y := world.tile_height(i)
	kit.set_frame(Vector3(c.x, y, c.y), 0.0)
	match dep:
		6:   # fishing grounds: a rusted marker buoy and a line of net floats on the surface
			var level := world.water_level(i)
			if level <= -1e6: return
			var at := Vector3(rng.randf_range(-0.3, 0.3), level - y, rng.randf_range(-0.3, 0.3))
			kit.cylinder("steel", at, 0.025, 0.07, 8, Color(0.75, 0.38, 0.25))
			kit.cone("steel", at + Vector3(0, 0.07, 0), 0.02, 0.04, 6, Color(0.8, 0.75, 0.3))
			var dir := Vector3(cos(rng.randf() * TAU), 0, sin(rng.randf() * TAU))
			for k in 6:
				kit.cylinder("canvas", at + dir * (0.08 + k * 0.05) + Vector3(0, -0.004, 0), 0.008, 0.012, 6, Color(0.95, 0.6, 0.2))
		7:   # old-world ruins: a collapsed concrete frame, exposed rebar, rubble and a rusted car
			var at := Vector3(rng.randf_range(-0.2, 0.2), 0.0, rng.randf_range(-0.2, 0.2))
			var g0 := world.ground_height(c.x + at.x, c.y + at.z) - y - 0.01
			var yaw := rng.randf() * TAU
			var frame := Transform3D(Basis(Vector3.UP, yaw), at + Vector3(0, g0, 0))
			for col in 4:
				var p: Vector3 = frame * Vector3(-0.14 + (col % 2) * 0.28, 0, -0.1 + (col / 2) * 0.2)
				var h := 0.08 + rng.randf() * 0.2 if col != 3 else 0.04
				kit.box("concrete", p, Vector3(0.035, h, 0.035), Color(0.72, 0.7, 0.66))
				if h > 0.15: kit.box("steel", p + Vector3(0, h, 0), Vector3(0.006, 0.05, 0.006), Color(0.55, 0.32, 0.22))
			kit.box("concrete", frame * Vector3(0, 0.2, -0.1), Vector3(0.3, 0.025, 0.04), Color(0.7, 0.68, 0.64), yaw)       # surviving beam
			kit.box("concrete", frame * Vector3(0.04, 0.0, 0.03), Vector3(0.24, 0.03, 0.16), Color(0.66, 0.64, 0.6), yaw + 0.25)  # fallen slab
			for k in 5:
				kit.box("stone", frame * Vector3(rng.randf_range(-0.25, 0.25), 0, rng.randf_range(-0.22, 0.22)), Vector3(0.04 + rng.randf() * 0.04, 0.02 + rng.randf() * 0.03, 0.04), Color(0.68, 0.66, 0.62), rng.randf() * TAU)
			_car_hulk(kit, frame * Vector3(0.28, 0, 0.2), yaw + 1.1)
			kit.cone("foliage", frame * Vector3(-0.2, 0, 0.18), 0.07, 0.12, 6, Color(0.8, 0.9, 0.7))
		1:   # oil seep: stained ground, a small dark pool and a rusted old-world capped wellhead
			var spot := Vector3(rng.randf_range(-0.25, 0.25), 0.0, rng.randf_range(-0.25, 0.25))
			var ground := world.ground_height(c.x + spot.x, c.y + spot.z) - y
			kit.cylinder("soil", spot + Vector3(0, ground + 0.004, 0), 0.17, 0.004, 14, Color(0.62, 0.56, 0.47), 0.17)
			kit.cylinder("char", spot + Vector3(0.03, ground + 0.008, -0.02), 0.075, 0.003, 12, Color(0.55, 0.55, 0.6), 0.075)
			kit.cylinder("steel", spot + Vector3(-0.07, ground, 0.05), 0.022, 0.07, 8, Color(0.62, 0.42, 0.3))
			kit.box("steel", spot + Vector3(-0.07, ground + 0.07, 0.05), Vector3(0.06, 0.012, 0.014), Color(0.55, 0.38, 0.28))
			for k in 2:
				var barrel := spot + Vector3(0.09 + k * 0.045, ground, 0.07 - k * 0.03)
				kit.cylinder("steel", barrel, 0.017, 0.045, 8, Color(0.5, 0.36, 0.26) if k == 0 else Color(0.32, 0.38, 0.33))
		2, 3:
			# Iron: a rust-stained outcrop and weathered red scree. Coal: a dark layered seam
			# exposed in a low cut bank with black spoil. Visible geology, not a banner.
			var spot := Vector2(rng.randf_range(-0.25, 0.25), rng.randf_range(-0.25, 0.25))
			var g0 := world.ground_height(c.x + spot.x, c.y + spot.y) - y
			var yaw := rng.randf() * TAU
			var frame := Transform3D(Basis(Vector3.UP, yaw), Vector3(spot.x, g0 - 0.02, spot.y))
			var host := Color(.72, .68, .62) if dep == 3 else Color(.78, .6, .5)
			kit.box("rock", frame * Vector3.ZERO, Vector3(.26, .09, .1), host, yaw)
			for band in 3:
				var seam := Color(.18, .17, .17) if dep == 3 else Color(.72, .36, .24)
				kit.box("ore", frame * Vector3(0, .018 + band * .026, .051), Vector3(.24, .011 if dep == 3 else .008, .004), seam, yaw)
			kit.box("rock", frame * Vector3(-.09, 0, -.05), Vector3(.1, .13, .09), host.darkened(.08), yaw + .4)
			for k in 6:
				var p := frame * Vector3(rng.randf_range(-.18, .18), 0, rng.randf_range(.06, .22))
				var sz := rng.randf_range(.022, .05)
				kit.box("ore", Vector3(p.x, world.ground_height(c.x + p.x, c.y + p.z) - y - .008, p.z), Vector3(sz, sz * .7, sz), Color(.25, .23, .22) if dep == 3 else Color(.8, .48, .34), rng.randf() * TAU)
		4:
			# Rare earths: pale altered rock with glinting mineral veins in a small pit.
			var spot := Vector2(rng.randf_range(-0.25, 0.25), rng.randf_range(-0.25, 0.25))
			for k in 5:
				var p := Vector3(spot.x + rng.randf_range(-.14, .14), 0, spot.y + rng.randf_range(-.14, .14))
				var sz := rng.randf_range(.05, .09)
				var gy := world.ground_height(c.x + p.x, c.y + p.z) - y - .02
				kit.box("rock", Vector3(p.x, gy, p.z), Vector3(sz, sz * rng.randf_range(.6, 1.1), sz * .8), Color(.86, .86, .82), rng.randf() * TAU)
				kit.box("glass", Vector3(p.x, gy + sz * .5, p.z), Vector3(sz * .8, .006, .01), Color(.6, .85, .95), rng.randf() * TAU)
		5:
			# Stone: a pale exposed bedrock shelf and scattered boulders.
			var spot := Vector2(rng.randf_range(-0.25, 0.25), rng.randf_range(-0.25, 0.25))
			var gy := world.ground_height(c.x + spot.x, c.y + spot.y) - y
			kit.box("rock", Vector3(spot.x, gy - .03, spot.y), Vector3(.3, .07, .2), Color(1.18, 1.15, 1.08), rng.randf() * TAU)
			for k in 6:
				var p := Vector3(spot.x + rng.randf_range(-.28, .28), 0, spot.y + rng.randf_range(-.28, .28))
				var sz := rng.randf_range(.03, .07)
				kit.box("stone", Vector3(p.x, world.ground_height(c.x + p.x, c.y + p.z) - y - .01, p.z), Vector3(sz, sz * .8, sz), Color(1.2, 1.17, 1.1), rng.randf() * TAU)


## Forest floor and edges: low shrubs along woodland edges and in glades, fallen deadwood inside
## dense forest, and sedge tussocks in marsh. Decoration only; never on roads, water or sites.
func _undergrowth(kit: MeshKit, i: int, c: Vector2, b: int, woodland_neighbours: int, glade: Vector3) -> void:
	if not b in [2, 4, 7, 8] or world.road[i] != 0 or work_tiles.has(i): return
	var rng := RandomNumberGenerator.new(); rng.seed = hash([world.world_seed, i, "undergrowth"])
	var count := 0
	if b == 4: count = 2 + (6 - woodland_neighbours) + (4 if glade != Vector3.INF else 0)
	elif b == 7: count = 6
	elif rng.randf() < .3: count = 2
	kit.set_frame(Vector3.ZERO, 0.0)
	for k in count:
		var p := c + Vector2.from_angle(rng.randf() * TAU) * sqrt(rng.randf()) * .8
		if glade != Vector3.INF and k >= count - 4: p = Vector2(glade.x, glade.z) + Vector2.from_angle(rng.randf() * TAU) * glade.y * rng.randf_range(.6, 1.0)
		if world.grid.tile_at(p.x, p.y) != i: continue
		if composition and not composition.sites.clear_of_water(i, [p + Vector2(-.03, -.03), p + Vector2(.03, -.03), p + Vector2(.03, .03), p + Vector2(-.03, .03)], .02): continue
		var gy := world.ground_height(p.x, p.y)
		if gy < .02: continue
		if b == 7:
			for blade in 3: kit.cone("foliage", Vector3(p.x + (blade - 1) * .01, gy, p.y), .012, .05 + rng.randf() * .03, 4, Color(.78, .82, .5))
		else:
			var r := rng.randf_range(.025, .045)
			kit.cylinder("foliage", Vector3(p.x, gy - .005, p.y), r, r * .9, 7, Color(.62, .74, .5).darkened(rng.randf() * .2), r * .55)
	if b == 4 and woodland_neighbours >= 4 and posmod(hash([i, "deadwood"]), 3) == 0:
		var p := c + Vector2.from_angle(rng.randf() * TAU) * .4
		kit.box("bark", Vector3(p.x, world.ground_height(p.x, p.y) - .006, p.y), Vector3(.11, .012, .012), Color(.42, .38, .34), rng.randf() * TAU)


## River banks: reeds along slow lowland reaches and water-worn stones on upland reaches, set
## just beyond the actual channel edge. Presentation only; no crossing is implied.
func _river_banks(kit: MeshKit, i: int) -> void:
	if not world.is_river(i) or world.road[i] != 0 or work_tiles.has(i): return
	var upland := world.biome(i) in [8, 9, 6] or world.height[i] > 1.4
	var rng := RandomNumberGenerator.new(); rng.seed = hash([world.world_seed, i, "banks"])
	kit.set_frame(Vector3.ZERO, 0.0)
	for segment in RiverGeometry.segments(world, i):
		var a: Vector2 = segment.a; var b: Vector2 = segment.b
		b.x = a.x + world.grid.dx_wrap(a.x, b.x)
		var along := b - a; var length := along.length()
		if length < .05: continue
		var side := Vector2(-along.y, along.x) / length
		for k in 3:
			var t := rng.randf_range(.1, .9)
			var s := 1.0 if rng.randf() < .5 else -1.0
			var p := a.lerp(b, t) + side * s * (float(segment.width) + rng.randf_range(.02, .06))
			if world.grid.tile_at(p.x, p.y) < 0: continue
			var gy := world.ground_height(p.x, p.y)
			if upland:
				var sz := rng.randf_range(.018, .035)
				kit.box("rock", Vector3(p.x, gy - .008, p.y), Vector3(sz, sz * .6, sz * .8), Color(.86, .84, .8), rng.randf() * TAU)
			else:
				for blade in 4:
					kit.cone("foliage", Vector3(p.x + rng.randf_range(-.015, .015), gy - .004, p.y + rng.randf_range(-.015, .015)), .007, .055 + rng.randf() * .035, 4, Color(.82, .84, .52))


## A rusted, wheel-less car hulk from before the collapse (decorative scenery only).
func _car_hulk(kit: MeshKit, p: Vector3, yaw: float) -> void:
	var rust := Color(0.52, 0.34, 0.24)
	kit.box("steel", p, Vector3(0.13, 0.035, 0.06), rust, yaw)
	kit.box("steel", p + Vector3(0, 0.035, 0), Vector3(0.07, 0.025, 0.055), rust.darkened(0.15), yaw)
	kit.box("char", p + Vector3(0, 0.037, 0), Vector3(0.072, 0.018, 0.057), Color(0.4, 0.4, 0.42), yaw)


## Rare deterministic remnants of the old world in open country: one rusted car hulk on roughly
## one tile in sixty, never on roads, building sites, trenches, water or mountains.
func _derelict(kit: MeshKit, i: int, c: Vector2) -> void:
	if world.road[i] != 0 or work_tiles.has(i) or built_tiles.has(i) or world.is_river(i) or world.is_sea(i) or world.is_lake(i): return
	if not world.biome(i) in [2, 3, 5, 6, 7]: return
	var rng := RandomNumberGenerator.new()
	rng.seed = hash([world.world_seed, i, "derelict"])
	if rng.randf() > 1.0 / 60.0: return
	var p := Vector2(c.x + rng.randf_range(-0.45, 0.45), c.y + rng.randf_range(-0.45, 0.45))
	kit.set_frame(Vector3.ZERO, 0.0)
	_car_hulk(kit, Vector3(p.x, world.ground_height(p.x, p.y) - 0.005, p.y), rng.randf() * TAU)


func _exit_tree() -> void:
	water.shutdown()
