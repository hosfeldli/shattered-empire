class_name VisualIdentityCache
extends RefCounted
## Reconstructable, purpose-separated visual identity. Owner, HP, population, camera and time
## deliberately do not participate. Clearing this bounded cache never changes an identity.

const MAX_ENTRIES := 4096
var world_seed := 0
var _seeds := {}


func reset(seed_value: int) -> void:
	world_seed = seed_value
	_seeds.clear()


func seed_for(object_key: String, recipe: String, version: int, purpose: String) -> int:
	var key := JSON.stringify([world_seed, object_key, recipe, version, purpose])
	if _seeds.has(key):
		return int(_seeds[key])
	# Explicit 32-bit FNV-1a rather than a frame RNG or platform-dependent object hash.
	var hash_value: int = 2166136261
	for byte in key.to_utf8_buffer():
		hash_value = ((hash_value ^ int(byte)) * 16777619) & 0xffffffff
	var result := hash_value & 0x7fffffff
	if _seeds.size() >= MAX_ENTRIES:
		_seeds.clear()
	_seeds[key] = result
	return result


func rng_for(object_key: String, recipe: String, version: int, purpose: String) -> RandomNumberGenerator:
	var rng := RandomNumberGenerator.new()
	rng.seed = seed_for(object_key, recipe, version, purpose)
	return rng


func describe(object_key: String, recipe: String, version: int) -> Dictionary:
	return {"object": object_key, "world_seed": world_seed, "recipe": recipe, "recipe_version": version,
		"layout_seed": seed_for(object_key, recipe, version, "layout"),
		"roof_seed": seed_for(object_key, recipe, version, "roof"),
		"detail_seed": seed_for(object_key, recipe, version, "detail")}
