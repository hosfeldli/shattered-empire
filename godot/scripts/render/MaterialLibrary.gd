class_name MaterialLibrary
extends RefCounted
## The shared material library: every building, unit and prop is built from these few surfaces,
## so the world reads as one place. Restrained colours and tileable PBR detail,
## per-vertex tint for variety, one sun. Materials are created once and shared by all meshes.

const SPECS := {
	"timber": {"c": Color(0.46, 0.34, 0.23), "r": 0.85},
	"brick": {"c": Color(0.56, 0.31, 0.24), "r": 0.9},
	"stone": {"c": Color(0.64, 0.61, 0.56), "r": 0.88},
	"concrete": {"c": Color(0.63, 0.62, 0.59), "r": 0.93},
	"steel": {"c": Color(0.47, 0.49, 0.52), "r": 0.42, "m": 0.75},
	"glass": {"c": Color(0.30, 0.40, 0.47), "r": 0.06, "m": 0.25},
	"roof_tile": {"c": Color(0.52, 0.29, 0.21), "r": 0.8},
	"roof_slate": {"c": Color(0.31, 0.33, 0.36), "r": 0.7},
	"plaster": {"c": Color(0.80, 0.76, 0.66), "r": 0.92},
	"paving": {"c": Color(0.50, 0.49, 0.46), "r": 0.95},
	"asphalt": {"c": Color(0.27, 0.27, 0.28), "r": 0.9},
	"ballast": {"c": Color(0.42, 0.40, 0.37), "r": 1.0},
	"soil": {"c": Color(0.42, 0.33, 0.23), "r": 1.0},
	"crop": {"c": Color(0.62, 0.62, 0.32), "r": 0.95},
	"grass": {"c": Color(0.36, 0.48, 0.27), "r": 1.0},
	"foliage": {"c": Color(0.24, 0.37, 0.20), "r": 0.95},
	"bark": {"c": Color(0.30, 0.22, 0.15), "r": 1.0},
	"rock": {"c": Color(0.43, 0.41, 0.39), "r": 0.95},
	"ore": {"c": Color(0.33, 0.27, 0.24), "r": 0.6, "m": 0.45},
	"canvas": {"c": Color(0.74, 0.68, 0.55), "r": 0.95},
	"char": {"c": Color(0.13, 0.12, 0.11), "r": 1.0},
	"olive": {"c": Color(0.33, 0.35, 0.25), "r": 0.75, "m": 0.15},
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
	var texture_key:String={"paving":"asphalt","ballast":"stone","ore":"rock","char":"rock","olive":"steel"}.get(key,key)
	var path := "res://assets/materials/%s_" % texture_key
	var extension:="png" if ResourceLoader.exists(path+"albedo.png") else "jpg"
	if ResourceLoader.exists(path + "albedo."+extension):
		m.set_shader_parameter("albedo_map",load(path+"albedo."+extension))
		if ResourceLoader.exists(path+"normal."+extension): m.set_shader_parameter("normal_map",load(path+"normal."+extension))
		if ResourceLoader.exists(path+"roughness."+extension): m.set_shader_parameter("roughness_map",load(path+"roughness."+extension))
		m.set_shader_parameter("normal_strength",.35)
		if texture_key in ["steel","canvas"]: m.set_shader_parameter("texture_mix",.45)
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
