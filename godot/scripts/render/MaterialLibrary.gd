class_name MaterialLibrary
extends RefCounted
## The shared material library: every building, unit and prop is built from these few surfaces,
## so the world reads as one place. Restrained colours and tileable PBR detail,
## per-vertex tint for variety, one sun. Materials are created once and shared by all meshes.

## c: art-directed base colour · r: roughness · m: metallic · s: texture repeats per world unit
## (real-world scale) · w: weathering (grime/rust). Textured materials use CC0 photographic maps
## (assets/materials/SOURCES.md) with their own average colour factored out.
const SPECS := {
	"timber": {"c": Color(0.62, 0.48, 0.34), "r": 0.85, "s": 7.0, "w": 0.6},
	"brick": {"c": Color(0.66, 0.40, 0.31), "r": 0.9, "s": 9.0, "w": 0.7},
	"stone": {"c": Color(0.70, 0.67, 0.62), "r": 0.88, "s": 6.0, "w": 0.6},
	"concrete": {"c": Color(0.70, 0.69, 0.66), "r": 0.93, "s": 4.0, "w": 0.8},
	"steel": {"c": Color(0.52, 0.54, 0.57), "r": 0.42, "m": 0.75, "s": 3.0, "w": 0.6},
	"corrugated": {"c": Color(0.44, 0.46, 0.47), "r": 0.55, "m": 0.45, "s": 6.0, "w": 0.8},
	"painted_metal": {"c": Color(0.58, 0.60, 0.55), "r": 0.6, "m": 0.25, "s": 4.0, "w": 0.9},
	"glass": {"c": Color(0.30, 0.40, 0.47), "r": 0.06, "m": 0.25},
	"roof_tile": {"c": Color(0.64, 0.36, 0.26), "r": 0.8, "s": 7.0, "w": 0.5},
	"roof_slate": {"c": Color(0.38, 0.40, 0.43), "r": 0.7, "s": 7.0, "w": 0.5},
	"plaster": {"c": Color(0.84, 0.80, 0.71), "r": 0.92, "s": 5.0, "w": 0.8},
	"paving": {"c": Color(0.62, 0.61, 0.58), "r": 0.95, "s": 6.0, "w": 0.4},
	"asphalt": {"c": Color(0.33, 0.33, 0.34), "r": 0.9, "s": 3.0, "w": 0.3},
	"ballast": {"c": Color(0.50, 0.48, 0.45), "r": 1.0, "s": 5.0},
	"gravel": {"c": Color(0.55, 0.53, 0.50), "r": 1.0, "s": 4.0},
	"rubble": {"c": Color(0.52, 0.50, 0.47), "r": 1.0, "s": 4.0},
	"soil": {"c": Color(0.48, 0.38, 0.27), "r": 1.0, "s": 3.0},
	"skin": {"c": Color(0.74, 0.57, 0.46), "r": 0.75},
	"mud": {"c": Color(0.36, 0.29, 0.22), "r": 0.7, "s": 3.0},
	"composite": {"c": Color(0.78, 0.8, 0.82), "r": 0.45, "m": 0.05, "s": 3.0, "w": 0.3},
	"sand": {"c": Color(0.76, 0.67, 0.50), "r": 1.0, "s": 3.0},
	"snow": {"c": Color(0.90, 0.92, 0.95), "r": 0.6, "s": 2.0},
	"crop": {"c": Color(0.62, 0.62, 0.32), "r": 0.95},
	"grass": {"c": Color(0.40, 0.52, 0.30), "r": 1.0, "s": 3.0},
	"foliage": {"c": Color(0.24, 0.37, 0.20), "r": 0.95},
	"bark": {"c": Color(0.36, 0.27, 0.19), "r": 1.0, "s": 6.0},
	"rock": {"c": Color(0.50, 0.48, 0.45), "r": 0.95, "s": 2.0, "w": 0.3},
	"ore": {"c": Color(0.36, 0.30, 0.26), "r": 0.6, "m": 0.45, "s": 3.0},
	"canvas": {"c": Color(0.78, 0.72, 0.59), "r": 0.95, "s": 6.0, "w": 0.4},
	"char": {"c": Color(0.16, 0.15, 0.14), "r": 1.0, "s": 3.0},
	"olive": {"c": Color(0.40, 0.42, 0.31), "r": 0.75, "m": 0.15, "s": 4.0, "w": 0.7},
}

static var _cache := {}
static var _team := {}
static var _surface_shader:Shader
static var _wet_texture:Texture2D
static var _cloud_state:={}
static var _visibility_state:={}
static var _weather_extent:=Vector2(221.7,192.0)


static func get_mat(key: String) -> Material:
	if _cache.has(key):
		return _cache[key]
	var spec: Dictionary = SPECS.get(key, SPECS.concrete)
	if _surface_shader==null: _surface_shader=load("res://shaders/world_surface.gdshader")
	var m := ShaderMaterial.new()
	m.shader=_surface_shader
	m.set_shader_parameter("base_color",spec.c)
	m.set_shader_parameter("base_roughness",spec.get("r",.9))
	m.set_shader_parameter("base_metallic",spec.get("m",0.0))
	m.resource_name = key
	var texture_key:String={"ballast":"gravel","ore":"rock","char":"rubble","olive":"painted_metal"}.get(key,key)
	m.set_shader_parameter("texture_scale",float(spec.get("s",2.0)))
	m.set_shader_parameter("weathering",float(spec.get("w",0.0)))
	var path := "res://assets/materials/%s_" % texture_key
	var extension:="png" if ResourceLoader.exists(path+"albedo.png") else "jpg"
	if ResourceLoader.exists(path + "albedo."+extension):
		m.set_shader_parameter("albedo_map",load(path+"albedo."+extension))
		if ResourceLoader.exists(path+"normal."+extension): m.set_shader_parameter("normal_map",load(path+"normal."+extension))
		if ResourceLoader.exists(path+"roughness."+extension): m.set_shader_parameter("roughness_map",load(path+"roughness."+extension))
		m.set_shader_parameter("normal_strength",.45)
		m.set_shader_parameter("texture_normalize",2.0 if texture_key=="painted_metal" else 1.0)
		# military paint keeps its olive drab: the painted-metal map adds only wear, not its own colour
		m.set_shader_parameter("texture_mix",.3 if key=="olive" else .55 if texture_key in ["steel","canvas"] else .85)
		if key=="olive": m.set_shader_parameter("texture_normalize",1.0)
	if _wet_texture:
		m.set_shader_parameter("wet_map",_wet_texture)
		m.set_shader_parameter("weather_extent",_weather_extent)
		m.set_shader_parameter("weather_ready",1.0)
	for parameter in _cloud_state: m.set_shader_parameter(parameter,_cloud_state[parameter])
	for parameter in _visibility_state: m.set_shader_parameter(parameter,_visibility_state[parameter])
	_cache[key] = m
	return m


static func bind_weather(texture:Texture2D,extent:Vector2) -> void:
	_wet_texture=texture; _weather_extent=extent
	for material in _cache.values()+_team.values():
		if material is ShaderMaterial:
			material.set_shader_parameter("wet_map",texture)
			material.set_shader_parameter("weather_extent",extent)
			material.set_shader_parameter("weather_ready",1.0 if texture else 0.0)


static func bind_clouds(parameters:Dictionary) -> void:
	_cloud_state.merge(parameters,true)
	for material in _cache.values()+_team.values():
		if material is ShaderMaterial:
			for key in parameters: material.set_shader_parameter(key,parameters[key])

static func bind_visibility(parameters:Dictionary) -> void:
	_visibility_state=parameters
	for material in _cache.values()+_team.values():
		if material is ShaderMaterial:
			for key in parameters: material.set_shader_parameter(key,parameters[key])

## the foliage surface with wind sway (trees); shares every parameter and later binding
static func sway_foliage() -> Material:
	if _cache.has("foliage_sway"): return _cache["foliage_sway"]
	var base:ShaderMaterial=get_mat("foliage")
	var m:=ShaderMaterial.new(); m.shader=load("res://shaders/foliage_sway.gdshader"); m.resource_name="foliage_sway"
	for uniform in base.shader.get_shader_uniform_list():
		var value:Variant=base.get_shader_parameter(uniform.name)
		if value!=null: m.set_shader_parameter(uniform.name,value)
	for parameter in _cloud_state: m.set_shader_parameter(parameter,_cloud_state[parameter])
	for parameter in _visibility_state: m.set_shader_parameter(parameter,_visibility_state[parameter])
	_cache["foliage_sway"]=m
	return m


## a civilization's colour, for flags, bands and markings (restrained: slightly desaturated)
## The animated-squad variant of a material ("steel", "team:3a7bd5", …): same look, with the
## per-soldier vertex animation switched on. Shares later weather/visibility bindings.
static func squad(key: String) -> Material:
	var cache_key := "squad:" + key
	if _cache.has(cache_key): return _cache[cache_key]
	var base: ShaderMaterial = (team(Color.html(key.substr(5))) if key.begins_with("team:") else get_mat(key)) as ShaderMaterial
	var m := base.duplicate() as ShaderMaterial
	m.set_shader_parameter("squad_anim", 1.0); m.resource_name = cache_key
	_cache[cache_key] = m
	return m


static func team(color: Color) -> Material:
	if _surface_shader==null: _surface_shader=load("res://shaders/world_surface.gdshader")
	var key := color.to_html(false)
	if _team.has(key):
		return _team[key]
	var m:=ShaderMaterial.new(); m.shader=_surface_shader; m.resource_name="team:"+key
	m.set_shader_parameter("base_color",color.lerp(Color(.5,.5,.5),.15)); m.set_shader_parameter("base_roughness",.7)
	if _wet_texture:
		m.set_shader_parameter("wet_map",_wet_texture); m.set_shader_parameter("weather_extent",_weather_extent); m.set_shader_parameter("weather_ready",1.0)
	for parameter in _cloud_state: m.set_shader_parameter(parameter,_cloud_state[parameter])
	for parameter in _visibility_state: m.set_shader_parameter(parameter,_visibility_state[parameter])
	_team[key] = m
	return m


## unshaded, emissive effect material (muzzle flashes, fires, selection marks)
static func glow(color: Color, alpha := 1.0) -> Material:
	var key := "glow_" + color.to_html(false) + str(alpha)
	if _cache.has(key):
		return _cache[key]
	var m := StandardMaterial3D.new()
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.albedo_color = Color(color, alpha)
	m.vertex_color_use_as_albedo = true
	if alpha < 1.0:
		m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	m.cull_mode = BaseMaterial3D.CULL_DISABLED
	_cache[key] = m
	return m


## soft translucent material (smoke, dust)
## plain translucent material for small weather particles (rain streaks, snow)
static func particle(color: Color, alpha: float) -> Material:
	var key := "particle_" + color.to_html(false) + str(alpha)
	if _cache.has(key):
		return _cache[key]
	var m := StandardMaterial3D.new()
	m.albedo_color = Color(color, alpha)
	m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	m.vertex_color_use_as_albedo = true
	m.roughness = 1.0
	_cache[key] = m
	return m


static func smoke(color: Color, alpha: float) -> Material:
	var key := "smoke_" + color.to_html(false) + str(alpha)
	if _cache.has(key):
		return _cache[key]
	var m := ShaderMaterial.new()
	m.shader = load("res://shaders/smoke_puff.gdshader")
	m.set_shader_parameter("tint", color)
	m.set_shader_parameter("opacity", alpha)
	_cache[key] = m
	return m
