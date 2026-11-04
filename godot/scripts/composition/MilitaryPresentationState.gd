class_name MilitaryPresentationState
extends RefCounted
## Interpret received status; never infer firing or issue simulation actions.

static func pose(unit: Dictionary, moving: bool, definition: Dictionary) -> Dictionary:
	var air: Array = unit.get("air", [])
	var grounded: bool = not air.is_empty() and int(air[0]) in [0,7,8]
	var flying: bool = definition.get("air",false) and not grounded
	var suppression := clampf(float(unit.get("supp",0))/100.0,0,1)
	var infantry: bool = str(definition.get("cat","")) == "infantry"
	return {"grounded":grounded,"flying":flying,
		"height_scale":lerpf(1.0,.52,suppression) if infantry else 1.0,
		"state":"suppressed" if suppression>.5 else "moving" if moving else "idle",
		"damaged":int(unit.get("hp",100))<35}
