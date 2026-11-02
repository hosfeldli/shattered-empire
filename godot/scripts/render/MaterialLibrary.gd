class_name MaterialLibrary
extends RefCounted
## The shared material library: every building, unit and prop is built from these few surfaces,
## so the world reads as one place. Stylized realism: restrained natural colours, no textures yet,
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


static func get_mat(key: String) -> Material:
	if _cache.has(key):
		return _cache[key]
	var spec: Dictionary = SPECS.get(key, SPECS.concrete)
	var m := StandardMaterial3D.new()
	m.albedo_color = spec.c
	m.vertex_color_use_as_albedo = true
	m.vertex_color_is_srgb = true
	m.roughness = spec.get("r", 0.9)
	m.metallic = spec.get("m", 0.0)
	m.resource_name = key
	_cache[key] = m
	return m


## a civilization's colour, for flags, bands and markings (restrained: slightly desaturated)
static func team(color: Color) -> Material:
	var key := color.to_html(false)
	if _team.has(key):
		return _team[key]
	var m := StandardMaterial3D.new()
	m.albedo_color = color.lerp(Color(0.5, 0.5, 0.5), 0.15)
	m.vertex_color_use_as_albedo = true
	m.roughness = 0.7
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
static func smoke(color: Color, alpha: float) -> Material:
	var key := "smoke_" + color.to_html(false) + str(alpha)
	if _cache.has(key):
		return _cache[key]
	var m := StandardMaterial3D.new()
	m.albedo_color = Color(color, alpha)
	m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	m.vertex_color_use_as_albedo = true
	m.roughness = 1.0
	m.shadow_to_opacity = false
	_cache[key] = m
	return m
