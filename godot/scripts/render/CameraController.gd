class_name CameraController
extends Node3D
## Orthographic oblique camera with a fixed heading (north up, no free rotation). Zoomed in it looks
## across the land at an angle; zoomed out it tips toward straight down, like a map. WASD / arrows
## pan, the wheel zooms about the point under the cursor, middle-drag pans, Escape is passed to the
## input controller. The focus x is kept in the base image [0, period) by shifting it by exactly one
## period, and all content is drawn at the image nearest the camera, so the seam never jumps.

signal cancel_pressed

const MIN_SIZE := 7.0
const PITCH_NEAR := 50.0
const PITCH_FAR := 80.0
const DISTANCE := 300.0
const PAN_SPEED := 0.9          # view heights per second
const ZOOM_STEP := 1.15
const ZOOM_EASE := 14.0

var world: WorldState
var cam: Camera3D
var focus := Vector3(0, 0, 0)    # ground point the camera looks at (x in the base image)
var size := 34.0
var goal_size := 34.0
var max_size := 220.0
var anchor_screen := Vector2(-1, -1)
var dragging := false
var drag_last := Vector2.ZERO
var input_enabled := true
var recentred := 0


func setup(w: WorldState) -> void:
	world = w
	cam = Camera3D.new()
	cam.projection = Camera3D.PROJECTION_ORTHOGONAL
	cam.near = 1.0
	cam.far = 2000.0
	cam.current = true
	add_child(cam)
	_apply()


func on_world() -> void:
	var g := world.grid
	max_size = minf(g.depth * 0.95, g.period * 0.5)
	goal_size = clampf(goal_size, MIN_SIZE, max_size)
	size = goal_size


func focus_tile(i: int, zoom := -1.0) -> void:
	if world.grid == null or i < 0:
		return
	var c := world.grid.center(i)
	focus = Vector3(c.x, world.tile_height(i), c.y)
	if zoom > 0.0:
		size = clampf(zoom, MIN_SIZE, max_size)
		goal_size = size
	_apply()


func pitch_deg() -> float:
	var t := clampf(log(size / MIN_SIZE) / log(maxf(max_size / MIN_SIZE, 1.001)), 0.0, 1.0)
	return lerpf(PITCH_NEAR, PITCH_FAR, smoothstep(0.0, 1.0, t))


## half the width of the ground the camera sees (east-west)
func view_half_width() -> float:
	var vp := get_viewport().get_visible_rect().size
	return size * 0.5 * vp.x / maxf(vp.y, 1.0) + 2.0


func _apply() -> void:
	if cam == null:
		return
	var p := deg_to_rad(pitch_deg())
	cam.size = size
	var back := Vector3(0, sin(p), cos(p)) * DISTANCE
	cam.global_transform = Transform3D(Basis.looking_at(-back, Vector3.UP), focus + back)


func _process(dt: float) -> void:
	if world == null or world.grid == null:
		return
	if input_enabled:
		var v := Vector2.ZERO
		if Input.is_key_pressed(KEY_W) or Input.is_key_pressed(KEY_UP): v.y -= 1
		if Input.is_key_pressed(KEY_S) or Input.is_key_pressed(KEY_DOWN): v.y += 1
		if Input.is_key_pressed(KEY_A) or Input.is_key_pressed(KEY_LEFT): v.x -= 1
		if Input.is_key_pressed(KEY_D) or Input.is_key_pressed(KEY_RIGHT): v.x += 1
		if v != Vector2.ZERO:
			var sp := size * PAN_SPEED * dt * (2.0 if Input.is_key_pressed(KEY_SHIFT) else 1.0)
			var tilt := 1.0 / maxf(sin(deg_to_rad(pitch_deg())), 0.3)
			focus.x += v.normalized().x * sp
			focus.z += v.normalized().y * sp * tilt
	# eased zoom, keeping the ground under the anchor fixed on screen every frame
	if absf(goal_size - size) > 1e-3:
		var before := ground_at(anchor_screen) if anchor_screen.x >= 0.0 else Vector3.INF
		size = lerpf(size, goal_size, 1.0 - exp(-ZOOM_EASE * dt))
		if absf(goal_size - size) < 1e-3:
			size = goal_size
		_apply()
		if before != Vector3.INF:
			var after := ground_at(anchor_screen)
			if after != Vector3.INF:
				focus.x += world.grid.dx_wrap(after.x, before.x)
				focus.z += before.z - after.z
	_settle()
	_apply()


## keep the focus inside the map: north-south clamp, east-west fold by exact periods
func _settle() -> void:
	var g := world.grid
	if g.wrap:
		if focus.x >= g.period or focus.x < 0.0:
			focus.x = fposmod(focus.x, g.period)
			recentred += 1
	else:
		focus.x = clampf(focus.x, 0.0, g.period)
	focus.z = clampf(focus.z, 0.0, g.depth)
	focus.y = lerpf(focus.y, world.ground_height(focus.x, focus.z), 0.1)


func _unhandled_input(e: InputEvent) -> void:
	if not input_enabled or world == null or world.grid == null:
		return
	if e is InputEventMouseButton:
		var mb := e as InputEventMouseButton
		if mb.pressed and (mb.button_index == MOUSE_BUTTON_WHEEL_UP or mb.button_index == MOUSE_BUTTON_WHEEL_DOWN):
			var f := 1.0 / ZOOM_STEP if mb.button_index == MOUSE_BUTTON_WHEEL_UP else ZOOM_STEP
			goal_size = clampf(goal_size * pow(f, clampf(mb.factor, 0.1, 4.0) if mb.factor > 0.0 else 1.0), MIN_SIZE, max_size)
			anchor_screen = mb.position
			get_viewport().set_input_as_handled()
		elif mb.button_index == MOUSE_BUTTON_MIDDLE:
			dragging = mb.pressed
			drag_last = mb.position
			get_viewport().set_input_as_handled()
	elif e is InputEventMouseMotion and dragging:
		var mm := e as InputEventMouseMotion
		var a := ground_at(drag_last, focus.y)
		var b := ground_at(mm.position, focus.y)
		if a != Vector3.INF and b != Vector3.INF:
			focus.x -= b.x - a.x
			focus.z -= b.z - a.z
			_settle()
			_apply()
		drag_last = mm.position
		get_viewport().set_input_as_handled()
	elif e is InputEventMagnifyGesture:
		var g := e as InputEventMagnifyGesture
		goal_size = clampf(goal_size / maxf(g.factor, 0.01), MIN_SIZE, max_size)
		anchor_screen = g.position
	elif e is InputEventPanGesture:
		var pg := e as InputEventPanGesture
		focus.x += pg.delta.x * size * 0.02
		focus.z += pg.delta.y * size * 0.02
	elif e is InputEventKey and (e as InputEventKey).pressed and (e as InputEventKey).keycode == KEY_ESCAPE:
		cancel_pressed.emit()


## where a screen point's ray meets the horizontal plane y = plane_y (fast; for drags and zoom anchors)
func ground_at(screen: Vector2, plane_y := NAN) -> Vector3:
	if cam == null or screen.x < 0.0:
		return Vector3.INF
	var y := focus.y if is_nan(plane_y) else plane_y
	var o := cam.project_ray_origin(screen)
	var d := cam.project_ray_normal(screen)
	if absf(d.y) < 1e-5:
		return Vector3.INF
	var t := (y - o.y) / d.y
	return o + d * t


## the terrain surface under a screen point: march the ray over the height field, then refine.
## Returns Vector3.INF when the ray misses the map (beyond the north / south edge).
func pick_ground(screen: Vector2) -> Vector3:
	var o := cam.project_ray_origin(screen)
	var d := cam.project_ray_normal(screen)
	if d.y > -1e-4:
		return Vector3.INF
	var top := WorldState.LAND_SCALE + 0.5
	var t := (top - o.y) / d.y
	var t_end := (-WorldState.SEA_SCALE - 0.5 - o.y) / d.y
	var step := 0.2
	var prev_t := t
	var hit := -1.0
	while t <= t_end:
		var p := o + d * t
		var gy := maxf(world.ground_height(p.x, p.z), 0.0)   # water surfaces count as ground
		if p.y <= gy:
			hit = t
			break
		prev_t = t
		t += step
	if hit < 0.0:
		return o + d * ((0.0 - o.y) / d.y)
	var lo := prev_t
	var hi := hit
	for k in 8:
		var mid := (lo + hi) * 0.5
		var p := o + d * mid
		if p.y <= maxf(world.ground_height(p.x, p.z), 0.0):
			hi = mid
		else:
			lo = mid
	return o + d * hi


## the server's hex id under a screen point (robust over hills and valleys)
func pick_tile(screen: Vector2) -> int:
	var p := pick_ground(screen)
	if p == Vector3.INF:
		return -1
	return world.grid.tile_at(p.x, p.z)


## screen position of a world point, or (-1, -1) when it is behind the camera
func to_screen(p: Vector3) -> Vector2:
	if cam.is_position_behind(p):
		return Vector2(-1, -1)
	return cam.unproject_position(p)
