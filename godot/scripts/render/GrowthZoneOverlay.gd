class_name GrowthZoneOverlay
extends Node3D
## The selected city's Guide Growth plan on the map: a soft outline over the planned area, in the
## colour of what will grow there (housing amber, industry steel blue, farming green). Shown only
## while that city is selected, so the world stays clean the rest of the time.
const COLORS := {"housing": "glow:e4bd76", "industry": "glow:8fb4d8", "farming": "glow:7fcf86"}
var world: WorldState
var cam: CameraController
var settlements: SettlementRenderer
var mesh: MeshInstance3D
var key := ""


func setup(w: WorldState, c: CameraController, s: SettlementRenderer) -> void:
	world = w; cam = c; settlements = s
	mesh = MeshInstance3D.new(); mesh.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF; add_child(mesh)


func update(_dt: float) -> void:
	var building: Dictionary = world.buildings.get(settlements.selected_building, {})
	var plan: Array = []
	if not building.is_empty() and str(building.ty) == "town" and int(building.o) == world.civ_id:
		plan = world.cities.get(int(building.get("c", -1)), {}).get("gz", [])
	var next := "" if plan.is_empty() else "%s:%d:%d" % [str(plan[0]), int(plan[1]), roundi(cam.focus.x / 20.0)]
	if next == key: return
	key = next
	if plan.is_empty(): mesh.mesh = null; return
	var tiles: Array = world.grid.disk(int(plan[1]), DecisionHelpers.GROWTH_RADIUS)
	var inside := {}
	for t in tiles: inside[int(t)] = true
	var kit := MeshKit.new()
	var color: String = COLORS.get(str(plan[0]), "glow:e4bd76")
	# only the outer edges of the area: one continuous outline, not a grid of hexes
	for t in tiles:
		var c := world.grid.center(int(t)); var x := world.grid.near_x(c.x, cam.focus.x)
		for d in 6:
			var n: int = world.grid.nb[int(t) * 6 + d]
			if inside.has(n): continue
			var k := posmod(1 - d, 6)
			var a: Vector2 = world.grid.corners[k]; var b: Vector2 = world.grid.corners[(k + 1) % 6]
			var pa := Vector3(x + a.x, 0, c.y + a.y); var pb := Vector3(x + b.x, 0, c.y + b.y)
			pa.y = world.ground_height(pa.x, pa.z) + .05; pb.y = world.ground_height(pb.x, pb.z) + .05
			kit.strip(color, pa, pb, .05)
	mesh.mesh = kit.commit()
