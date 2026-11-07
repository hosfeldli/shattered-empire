class_name LODManager
extends RefCounted
## Shared visual-only budgets. Every preset preserves authoritative objects and selection.

enum Scale { TACTICAL, OPERATIONAL, STRATEGIC }
const PRESETS := {
	"low": {"pedestrians": 24, "vehicles": 8, "puffs": 180, "battle_puffs": 120, "tree_size": 40.0, "shadow_size": 0.0},
	"medium": {"pedestrians": 80, "vehicles": 24, "puffs": 600, "battle_puffs": 400, "tree_size": 60.0, "shadow_size": 120.0},
	"high": {"pedestrians": 140, "vehicles": 40, "puffs": 900, "battle_puffs": 600, "tree_size": 80.0, "shadow_size": 140.0},
	"ultra": {"pedestrians": 200, "vehicles": 64, "puffs": 900, "battle_puffs": 600, "tree_size": 90.0, "shadow_size": 160.0}}
var quality := "medium"
var presets: Dictionary = RecipeRegistry.world_value("lod", "presets", PRESETS)
var tactical_max := float(RecipeRegistry.world_value("lod", "tactical_max_size", 16.0))
var operational_max := float(RecipeRegistry.world_value("lod", "operational_max_size", 72.0))
var particle_scale:=1.0


func set_quality(value: String) -> void:
	quality = value if presets.has(value) else "medium"


func scale_for(camera_size: float) -> int:
	return Scale.TACTICAL if camera_size <= tactical_max else Scale.OPERATIONAL if camera_size <= operational_max else Scale.STRATEGIC


func scale_name(camera_size: float) -> String:
	return ["tactical", "operational", "strategic"][scale_for(camera_size)]


func budget(kind: String, camera_size: float) -> int:
	var full := int(presets.get(quality, PRESETS.medium).get(kind, 0))
	if kind in ["puffs","battle_puffs"]: full=roundi(full*particle_scale)
	match scale_for(camera_size):
		Scale.STRATEGIC:
			return 0 if kind in ["pedestrians","vehicles"] else int(full * float(RecipeRegistry.world_value("lod", "strategic_share", 0.2)))
		Scale.OPERATIONAL:
			return int(full * float(RecipeRegistry.world_value("lod", "operational_share", 0.5)))
	return full
