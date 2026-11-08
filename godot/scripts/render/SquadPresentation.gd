class_name SquadPresentation
extends Node3D
## Individual soldiers inside one authoritative unit. The server knows a squad as one troop at one
## position; when that unit is drawn as several people, each figure moves on its own so a squad
## reads as people rather than a rigid block:
##   * every figure has its own place in the group, follow gain (some lead, some lag), gait rhythm
##     and facing; marching squads string out in loose pairs, halted squads spread into a
##     line, and under fire or when firing they go to ground and kneel or lie prone;
##   * figures wander a little and now and then shift position while halted, keep apart from each
##     other, step around standing water and building walls, and never leave the unit's footprint;
##   * crews stay around their gun or mortar and kneel once the weapon is deployed;
##   * casualties thin the group in line with the unit's health.
## Presentation only: position, cover, combat and orders remain the server's single unit. Motion
## is deterministic per figure (seeded by unit id), bounded and drawn in MultiMesh batches.

const ZOOM := 40.0           # beyond this the baked squad silhouette is used instead
const FOOTPRINT := 0.3
const MAX_UNITS := 220
## unit type -> [figure variant, figure count at full health, role]
const FIGURES := {
	"militia": ["militia", 4, "squad"], "rifle_squad": ["rifle", 6, "squad"], "special_forces": ["special", 4, "squad"],
	"exo_infantry": ["exo", 3, "squad"], "engineer": ["engineer", 3, "squad"], "mortar_team": ["crew", 3, "crew"],
	"field_gun": ["crew", 4, "crew"], "colonist": ["civilian", 3, "escort"],
}

var world: WorldState
var cam: CameraController
var military: MilitaryRenderer
var settlements: SettlementRenderer
var groups := {}             # unit id -> { anchor: Vector2 (base coords), figures: Array }
var batches := {}            # mesh key -> MultiMeshInstance3D
var clock := 0.0
var drawn := 0
var near := {}               # unit ids simulated here this frame (the renderer draws only their kit)
var frame := 0
const NEAR_CAP := 48         # in large battles only the squads nearest the camera are simulated
const NEAR_ZOOM := 24.0


func setup(w: WorldState, c: CameraController, m: MilitaryRenderer, s: SettlementRenderer = null) -> void:
	world = w; cam = c; military = m; settlements = s
	world.reset.connect(_clear); world.welcomed.connect(_clear)


func _clear() -> void:
	groups.clear()
	for b in batches.values(): (b as MultiMeshInstance3D).multimesh.visible_instance_count = 0


static func active(type: String, camera_size: float) -> bool:
	return FIGURES.has(type) and camera_size <= ZOOM


func update(dt: float) -> void:
	if world.grid == null: return
	if not world.paused: clock += dt
	var transforms := {}
	drawn = 0
	frame += 1
	near.clear()
	# Small engagements simulate every visible squad up to operational zoom. Large battles (the
	# renderer is batching) simulate only the nearest squads at close zoom; the rest are animated
	# on the GPU by the renderer, so a thousand troops stay affordable.
	var limit := ZOOM if not military.batched else NEAR_ZOOM
	if cam.size > limit:
		_flush(transforms); groups.clear(); return
	var cap := MAX_UNITS if not military.batched else NEAR_CAP
	var half := cam.view_half_width() + 1.0
	var candidates := []
	for id in military.draw_positions:
		var u: Dictionary = world.units.get(id, {})
		if u.is_empty() or not FIGURES.has(str(u.type)): continue
		var anchor3: Vector3 = military.draw_positions[id]
		var dx := absf(anchor3.x - cam.focus.x); var dz := absf(anchor3.z - cam.focus.z)
		if dx > half or dz > cam.size + 1.0: continue
		candidates.append([dx * dx + dz * dz, id])
	if candidates.size() > cap:
		candidates.sort_custom(func(a, b): return a[0] < b[0])
		candidates.resize(cap)
	var seen := {}
	for entry in candidates:
		var id: int = entry[1]
		seen[id] = true; near[id] = true
		_step_unit(id, world.units[id], military.draw_positions[id], dt, transforms)
	for id in groups.keys():
		if not seen.has(id): groups.erase(id)
	_flush(transforms)


func _unit_yaw(id: int) -> float:
	var record: Dictionary = military.nodes.get(id, military.motions.get(id, {}))
	return float(record.get("yaw", 0.0))


func _step_unit(id: int, u: Dictionary, anchor3: Vector3, dt: float, transforms: Dictionary) -> void:
	var spec: Array = FIGURES[str(u.type)]
	var g := world.grid
	var anchor := Vector2(g.base_x(anchor3.x), anchor3.z)
	var group: Dictionary = groups.get(id, {})
	var full := int(spec[1])
	var count := clampi(ceili(full * clampf(float(u.get("hp", 100)) / 100.0, 0.0, 1.0)), 1, full)
	if group.is_empty():
		group = {"anchor": anchor, "figures": []}
		groups[id] = group
	# The anchor moved: figures keep their world position, so they trail and catch up naturally.
	var shift := Vector2(g.dx_wrap(group.anchor.x, anchor.x), anchor.y - group.anchor.y)
	if shift.length() > 2.0: shift = Vector2.ZERO           # a jump (reload, teleport): no streak
	group.anchor = anchor
	var anchor_velocity := shift / maxf(dt, 0.0001)
	var figures: Array = group.figures
	while figures.size() < count:
		var seed := int(id) * 977 + figures.size() * 131
		var rng := RandomNumberGenerator.new(); rng.seed = seed
		figures.append({"d": Vector2(rng.randf_range(-.05, .05), rng.randf_range(-.05, .05)), "v": Vector2.ZERO, "seed": seed,
			"gain": rng.randf_range(2.6, 4.6), "phase": rng.randf() * TAU, "yaw": _unit_yaw(id), "shift": Vector2.ZERO,
			"next_shift": rng.randf_range(4.0, 12.0), "cadence": rng.randf_range(.85, 1.15)})
	while figures.size() > count: figures.pop_back()
	var yaw := _unit_yaw(id)
	var basis := Basis(Vector3.UP, yaw)
	var moving := int(u.get("next", -1)) >= 0 or anchor_velocity.length() > .02
	var flags := int(u.get("flags", 0))
	var firing := (flags & 1) != 0
	var deployed := (flags & 64) != 0
	var suppressed := int(u.get("supp", 0)) > 60
	var role := str(spec[2])
	var face := yaw
	if firing: face = military._target_yaw(u, Vector2(anchor3.x, anchor3.z), yaw)
	var variant := str(spec[0])
	var color := world.civ_color(int(u.owner))
	var n := figures.size()
	# ground under the group as a plane (three samples per squad instead of one per soldier)
	var gx := g.near_x(anchor.x, cam.focus.x)
	var h0 := world.ground_height(gx, anchor.y)
	var slope := Vector2(world.ground_height(gx + .15, anchor.y) - h0, world.ground_height(gx, anchor.y + .15) - h0) / .15
	for i in n:
		var f: Dictionary = figures[i]
		f.d -= shift
		var seed := int(f.seed)
		# this figure's place in the group, in the unit frame (+X forward)
		var slot := _slot(role, i, n, moving, suppressed or firing)
		if not moving:
			f.next_shift = float(f.next_shift) - dt
			if float(f.next_shift) <= 0.0:
				var rng := RandomNumberGenerator.new(); rng.seed = seed + int(clock * 3.0)
				f.shift = Vector2(rng.randf_range(-.03, .03), rng.randf_range(-.03, .03))
				f.next_shift = rng.randf_range(6.0, 15.0)
			slot += f.shift
		var wander_amp := .006 if moving else .012
		slot += Vector2(sin(clock * .37 + seed), cos(clock * .29 + seed * 1.7)) * wander_amp
		var local3 := basis * Vector3(slot.x, 0, slot.y)
		var target := Vector2(local3.x, local3.z)
		# steering: spring toward the place with this figure's own gain, keep apart, bounded speed
		var desired: Vector2 = (target - (f.d as Vector2)) * float(f.gain)
		for j in n:
			if j == i: continue
			var away: Vector2 = f.d - (figures[j] as Dictionary).d
			var dist := away.length()
			if dist < .032 and dist > 1e-5: desired += away / dist * (.032 - dist) * 18.0
		var max_speed := .5 if moving else .22
		if desired.length() > max_speed: desired = desired.normalized() * max_speed
		f.v = (f.v as Vector2).lerp(desired, 1.0 - exp(-7.0 * dt))
		var next: Vector2 = f.d + f.v * dt
		if next.length() > FOOTPRINT: next = next.normalized() * FOOTPRINT
		var world_point := anchor + next
		# obstacle checks are staggered across frames (one figure in three each frame)
		if (frame + i) % 3 == 0 and _blocked(world_point, anchor): next = f.d          # step around water and walls
		f.d = next
		var velocity: Vector2 = f.v + anchor_velocity
		var speed := velocity.length()
		# facing: where it walks; at rest the unit's front (or its target), with a glance around
		var want := face + .35 * sin(clock * .21 + seed) + float(posmod(seed, 7) - 3) * .06
		if speed > .03: want = atan2(-velocity.y, velocity.x)
		f.yaw = lerp_angle(float(f.yaw), want, 1.0 - exp(-6.0 * dt))
		# pose
		var pose := "stand"
		if speed > .03:
			f.phase = float(f.phase) + speed * dt * 70.0 * float(f.cadence)
			pose = "walk_a" if sin(float(f.phase)) > 0.0 else "walk_b"
		elif suppressed and role != "escort": pose = "prone"
		elif (firing and role != "escort") or (role == "crew" and deployed): pose = "kneel"
		var x := g.near_x(world_point.x, cam.focus.x)
		var y := h0 + slope.dot(next)
		if (flags & 2) != 0: y = maxf(y, 0.02)
		var key := "%s|%s|%d" % [variant, pose, int(u.owner)]
		if not transforms.has(key): transforms[key] = {"variant": variant, "pose": pose, "color": color, "list": []}
		var scale := 1.0 + float(posmod(seed, 5)) * .025
		(transforms[key].list as Array).append([Transform3D(Basis(Vector3.UP, float(f.yaw)).scaled(Vector3.ONE * scale), Vector3(x, y, world_point.y)), Color(1, 1, 1).darkened(float(posmod(seed / 7, 4)) * .04)])
		drawn += 1


## Place of figure i of n in the unit frame (+X forward, +Z right).
static func _slot(role: String, i: int, n: int, moving: bool, down: bool) -> Vector2:
	match role:
		"crew":
			var around := [Vector2(-.1, -.07), Vector2(-.1, .07), Vector2(-.15, 0), Vector2(-.04, .11)]
			return around[i % around.size()] * (1.0 if not moving else 1.15)
		"escort":
			var beside := [Vector2(.02, .12), Vector2(.02, -.12), Vector2(-.2, .03)]
			return beside[i % beside.size()]
	if moving:
		# loose pairs strung out behind the leader
		return Vector2(.07 - float(i / 2) * .07, (-.035 if i % 2 == 0 else .035) + (.012 if (i / 2) % 2 == 1 else 0.0))
	# halted: a loose line abreast; under fire or engaging, spread wider and slightly staggered
	var spacing := .075 if down else .055
	return Vector2(-.02 - float(i % 2) * (.05 if down else .03), (float(i) - (n - 1) * .5) * spacing)


## water and building cores are not walked into (presentation; the server owns movement)
func _blocked(point: Vector2, anchor: Vector2) -> bool:
	var tile := world.grid.tile_at(point.x, point.y)
	if tile < 0 or not world.known[tile]: return false
	var anchor_tile := world.grid.tile_at(anchor.x, anchor.y)
	if (world.is_sea(tile) or world.is_lake(tile)) and not (world.is_sea(anchor_tile) or world.is_lake(anchor_tile)): return true
	if settlements and settlements.building_at(tile) >= 0:
		var c := world.grid.center(tile)
		if Vector2(world.grid.dx_wrap(c.x, point.x), point.y - c.y).length() < .2 and tile != anchor_tile: return true
	return false


func _flush(transforms: Dictionary) -> void:
	for key in batches:
		if not transforms.has(key): (batches[key] as MultiMeshInstance3D).multimesh.visible_instance_count = 0
	for key in transforms:
		var info: Dictionary = transforms[key]
		var batch: MultiMeshInstance3D = batches.get(key)
		if batch == null:
			batch = MultiMeshInstance3D.new()
			var mm := MultiMesh.new(); mm.transform_format = MultiMesh.TRANSFORM_3D; mm.use_colors = true
			mm.mesh = FigureKit.mesh(str(info.variant), str(info.pose), info.color)
			batch.multimesh = mm
			batch.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
			add_child(batch); batches[key] = batch
		var mm := batch.multimesh
		var list: Array = info.list
		if mm.instance_count < list.size():
			mm.visible_instance_count = 0
			mm.instance_count = maxi(list.size(), mm.instance_count * 2)
		# one buffer upload: transform rows then colour (16 floats per figure)
		var buffer: PackedFloat32Array = mm.get_meta("upload", PackedFloat32Array())
		if buffer.size() != mm.instance_count * 16: buffer.resize(mm.instance_count * 16)
		var i := 0
		for entry in list:
			var t: Transform3D = entry[0]; var c: Color = entry[1]
			buffer[i] = t.basis.x.x; buffer[i + 1] = t.basis.y.x; buffer[i + 2] = t.basis.z.x; buffer[i + 3] = t.origin.x
			buffer[i + 4] = t.basis.x.y; buffer[i + 5] = t.basis.y.y; buffer[i + 6] = t.basis.z.y; buffer[i + 7] = t.origin.y
			buffer[i + 8] = t.basis.x.z; buffer[i + 9] = t.basis.y.z; buffer[i + 10] = t.basis.z.z; buffer[i + 11] = t.origin.z
			buffer[i + 12] = c.r; buffer[i + 13] = c.g; buffer[i + 14] = c.b; buffer[i + 15] = c.a
			i += 16
		mm.buffer = buffer
		mm.set_meta("upload", buffer)
		mm.visible_instance_count = list.size()
