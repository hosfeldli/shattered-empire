class_name RecipeRegistry
extends RefCounted
## Declarative composition rules. Hard validation precedes priority/soft preferences. The initial
## grammars reuse the existing MeshKit recipes; authored components can replace a grammar later.

const FILE := "res://recipes/buildings.json"
const GROUPS := {"house": "res", "farm": "farm", "market": "com", "port": "com",
	"town": "civ", "academy": "civ", "university": "civ", "comms_tower": "civ",
	"steel_mill": "ind", "munitions_plant": "ind", "motor_works": "ind", "heavy_assembly": "ind",
	"electronics_plant": "ind", "refinery": "ind", "power_plant": "ind", "fusion_plant": "ind",
	"robotics_complex": "ind", "drone_works": "ind", "salvage": "ind",
	"mine": "ext", "quarry": "ext", "lumber": "ext", "oil_well": "ext",
	"barracks": "mil"}

var recipes: Array = []
var errors: Array[String] = []

## World recipes (godot/recipes/world.json): versioned, declarative presentation rules read by
## renderers and composers. Loaded once, validated; a missing or invalid section falls back to the
## caller's default so a bad catalog can never break play. Hard constraints are reported, not tuned.
const WORLD_FILE := "res://recipes/world.json"
static var _world := {}
static var world_errors: Array[String] = []


static func world_section(name: String) -> Dictionary:
	if _world.is_empty(): _load_world()
	return _world.get(name, {})


static func world_value(name: String, key: String, fallback: Variant) -> Variant:
	var section := world_section(name)
	var soft: Dictionary = section.get("soft", {})
	if soft.has(key): return soft[key]
	var hard: Dictionary = section.get("hard", {})
	return hard.get(key, fallback)


static func _load_world() -> void:
	_world = {"_loaded": true}
	var file := FileAccess.open(WORLD_FILE, FileAccess.READ)
	if file == null: world_errors.append("Cannot open " + WORLD_FILE); return
	var data = JSON.parse_string(file.get_as_text())
	if not data is Dictionary or int(data.get("schema", 0)) != 1 or not data.get("sections") is Dictionary:
		world_errors.append("Invalid world recipe catalog"); return
	for name in data.sections:
		var section: Dictionary = data.sections[name]
		if str(section.get("id", "")) == "" or int(section.get("version", 0)) < 1:
			world_errors.append("World recipe %s needs an id and explicit version" % name); continue
		if not section.get("hard", {}) is Dictionary or not section.get("soft", {}) is Dictionary:
			world_errors.append("World recipe %s needs hard and soft rule tables" % name); continue
		_world[name] = section


static func world_versions() -> Dictionary:
	if _world.is_empty(): _load_world()
	var out := {}
	for name in _world:
		if name != "_loaded": out[name] = "%s@%d" % [_world[name].id, int(_world[name].version)]
	return out


func load_defaults() -> void:
	var file := FileAccess.open(FILE, FileAccess.READ)
	if file == null:
		errors.append("Cannot open " + FILE)
		return
	var data = JSON.parse_string(file.get_as_text())
	if not data is Dictionary or not data.get("recipes") is Array:
		errors.append("Invalid recipe catalog")
		return
	for recipe in data.recipes:
		register_recipe(recipe)


func register_recipe(recipe: Dictionary) -> bool:
	if str(recipe.get("id", "")) == "" or int(recipe.get("version", 0)) < 1:
		errors.append("Recipe requires an id and explicit version")
		return false
	if str(recipe.get("authority", "")) != "state_derived_visual":
		errors.append("Building grammar must be classified as state_derived_visual")
		return false
	for material in recipe.get("materials", []):
		if not MaterialLibrary.SPECS.has(material):
			errors.append("Unknown material: " + str(material))
			return false
	for existing in recipes:
		if existing.id == recipe.id:
			errors.append("Duplicate recipe id: " + str(recipe.id))
			return false
	recipes.append(recipe.duplicate(true))
	recipes.sort_custom(func(a, b):
		var pa := int(a.get("priority", 0))
		var pb := int(b.get("priority", 0))
		return pa > pb if pa != pb else str(a.id) < str(b.id))
	return true


func resolve_building(record, context: Dictionary) -> Dictionary:
	if record.id < 0 or record.tile < 0 or record.type == "":
		return {"valid": false, "reason": "Missing authoritative identity or site"}
	for recipe in recipes:
		var types: Array = recipe.get("types", [])
		if not types.has("*") and not types.has(record.type):
			continue
		var limits: Dictionary = recipe.get("preconditions", {})
		if record.level < int(limits.get("min_level", 1)):
			continue
		if limits.has("terrain_known") and bool(limits.terrain_known) != bool(context.get("terrain_known", false)):
			continue
		if limits.has("max_slope") and (not context.get("terrain_known", false) or float(context.get("slope", 0)) > float(limits.max_slope)):
			continue
		var out: Dictionary = recipe.duplicate(true)
		out["valid"] = true
		out["grammar"] = record.type if str(recipe.get("grammar", "")) == "$type" else str(recipe.get("grammar", "generic"))
		out["group"] = str(GROUPS.get(record.type, ""))
		out["matched"] = {"type": record.type, "level": record.level, "site_received": true,
			"terrain_known": context.get("terrain_known", false), "preconditions": limits.duplicate(true)}
		return out
	return {"valid": false, "reason": "No compatible recipe"}
