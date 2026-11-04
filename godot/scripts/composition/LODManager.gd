class_name LODManager
extends RefCounted
## Shared visual-only budgets. Every preset preserves authoritative objects and selection.

enum Scale { TACTICAL, OPERATIONAL, STRATEGIC }
const PRESETS := {
	"low": {"pedestrians": 24, "puffs": 180, "battle_puffs": 120, "tree_size": 40.0, "shadow_size": 0.0},
	"medium": {"pedestrians": 80, "puffs": 600, "battle_puffs": 400, "tree_size": 60.0, "shadow_size": 120.0},
	"high": {"pedestrians": 140, "puffs": 900, "battle_puffs": 600, "tree_size": 80.0, "shadow_size": 140.0},
	"ultra": {"pedestrians": 200, "puffs": 900, "battle_puffs": 600, "tree_size": 90.0, "shadow_size": 160.0}}
var quality := "medium"


func set_quality(value: String) -> void:
	quality = value if PRESETS.has(value) else "medium"


func scale_for(camera_size: float) -> int:
	return Scale.TACTICAL if camera_size <= 16.0 else Scale.OPERATIONAL if camera_size <= 72.0 else Scale.STRATEGIC


func scale_name(camera_size: float) -> String:
	return ["tactical", "operational", "strategic"][scale_for(camera_size)]


func budget(kind: String, camera_size: float) -> int:
	var full := int(PRESETS[quality].get(kind, 0))
	match scale_for(camera_size):
		Scale.STRATEGIC:
			return 0 if kind == "pedestrians" else int(full * 0.2)
		Scale.OPERATIONAL:
			return int(full * 0.5)
	return full
