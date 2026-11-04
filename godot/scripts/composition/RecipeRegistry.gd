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
	"mine": "ext", "quarry": "ext", "lumber": "ext", "oil_well": "ext"}

var recipes: Array = []
var errors: Array[String] = []


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
