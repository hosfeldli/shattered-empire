class_name CropFields
extends Node3D
## Standing crops on farm hexes, so a farm reads as a farm: rows of grain laid along the estate's
## field direction (the same orientation as the farm parcels), clear of the farmstead and of water,
## swaying in the regional wind. Ripe gold on working farms, green on new or idle ones, and sparse
## stubble on damaged ones. Drawn only near the camera, in one batched MultiMesh per crop state;
## the cultivated ground itself comes from the terrain shader. Presentation only.

const ZOOM := 26.0
const MAX_TUFTS := 9000
const ROW := .075
const STEP := .055

var world: WorldState
var cam: CameraController
var settlements: SettlementRenderer
var ripe: MultiMeshInstance3D
var green: MultiMeshInstance3D
var key := ""
var drawn := 0


func setup(w: WorldState, c: CameraController, s: SettlementRenderer) -> void:
	world = w; cam = c; settlements = s
	ripe = _batch(_tuft(Color(1.45, 1.2, .62)))
	green = _batch(_tuft(Color(.95, 1.25, .7)))
	world.welcomed.connect(func(): key = "")


func _batch(mesh: Mesh) -> MultiMeshInstance3D:
	var instance := MultiMeshInstance3D.new()
	var mm := MultiMesh.new(); mm.transform_format = MultiMesh.TRANSFORM_3D; mm.mesh = mesh
	mm.instance_count = MAX_TUFTS; mm.visible_instance_count = 0
	instance.multimesh = mm; instance.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(instance)
	return instance


## a tuft of grain stalks with heads, on the wind-swayed crop surface
func _tuft(tint: Color) -> ArrayMesh:
	var k := MeshKit.new()
	for i in 5:
		var a := TAU * i / 5.0
		var p := Vector3(cos(a) * .008, 0, sin(a) * .008)
		k.box("crop", p, Vector3(.0025, .03 + .004 * (i % 2), .0025), tint * .9)
		k.box("crop", p + Vector3(0, .03 + .004 * (i % 2), 0), Vector3(.005, .009, .005), tint * 1.08)
	var mesh := k.commit()
	for surface in mesh.get_surface_count(): mesh.surface_set_material(surface, MaterialLibrary.sway("crop"))
	return mesh


func update(_dt: float) -> void:
	if world.grid == null: return
	if cam.size > ZOOM:
		ripe.multimesh.visible_instance_count = 0; green.multimesh.visible_instance_count = 0; drawn = 0; key = ""
		return
	var next := "%d:%d:%d:%d" % [world.buildings_version, roundi(cam.focus.x * 2.0), roundi(cam.focus.z * 2.0), roundi(cam.size)]
	if next == key: return
	key = next
	_rebuild()


func _rebuild() -> void:
	var g := world.grid
	var half := cam.view_half_width() + 1.0
	var gold: Array[Transform3D] = []; var young: Array[Transform3D] = []
	for b in world.buildings.values():
		if str(b.ty) != "farm" or str(b.get("st", "")) == "ruined": continue
		var t := int(b.t)
		var c := g.center(t)
		var x := g.near_x(c.x, cam.focus.x)
		if absf(x - cam.focus.x) > half or absf(c.y - cam.focus.z) > cam.size + 1.0: continue
		if world.is_river(t) or world.is_sea(t) or world.is_lake(t): continue
		var done := int(b.get("d", 0)) == 1
		var hp := int(b.get("hp", 100))
		var seat := settlements._estate_seat(b) if settlements else true
		var frame := settlements.parcel_transform(b) if settlements else Transform3D()
		var yaw := frame.basis.get_euler().y
		var along := Vector2(cos(yaw), -sin(yaw)); var across := Vector2(-along.y, along.x)
		var site: Dictionary = settlements.site_records.get(int(b.id), {}) if settlements else {}
		var house: Vector2 = Vector2(site.transform.origin.x, site.transform.origin.z) if site.has("transform") else c
		house.x = c.x + g.dx_wrap(c.x, house.x)
		var list := gold if done and int(b.get("a", 1)) == 1 else young
		var thin := 3 if hp < 50 else 1
		var rng := RandomNumberGenerator.new(); rng.seed = t * 2654435761
		for row in range(-10, 11):
			for step_ in range(-14, 15):
				if (row + step_) % thin != 0: continue
				var p: Vector2 = c + across * (row * ROW) + along * (step_ * STEP + rng.randf_range(-.01, .01))
				if p.distance_to(c) > .78 or g.tile_at(p.x, p.y) != t: continue
				if seat and p.distance_to(house) < .3: continue
				if absf((p - c).dot(across)) < .03: continue          # the farm track down the middle
				var y := world.ground_height(p.x, p.y)
				var s := rng.randf_range(.8, 1.15) * (1.0 if done else .55)
				list.append(Transform3D(Basis(Vector3.UP, rng.randf() * TAU).scaled(Vector3(s, s, s)), Vector3(x + p.x - c.x, y, p.y)))
		if gold.size() + young.size() >= MAX_TUFTS: break
	drawn = _fill(ripe.multimesh, gold) + _fill(green.multimesh, young)


func _fill(mm: MultiMesh, list: Array[Transform3D]) -> int:
	var count := mini(list.size(), MAX_TUFTS)
	MilitaryRenderer._upload(mm, list.slice(0, count))
	return count
