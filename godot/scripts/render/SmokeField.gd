class_name SmokeField
extends RefCounted
## A bounded, cosmetic smoke simulation around the camera (warzone brief §11, §17). A fixed
## 2-D density grid in world space is fed only by authorized sources (server smoke records and
## visible combat events), advected by the shared regional wind with a little turbulence, diffused
## and left to decay. It never affects vision, cover or rules: the server's smoke does that.

const SIZE := 44            # cells per side
const CELL := 0.3           # world units per cell
const STEP := 1.0 / 20.0    # simulation step (s)

var density := PackedFloat32Array()
var scratch := PackedFloat32Array()
var origin := Vector2.ZERO  # world position of cell (0,0)
var accumulator := 0.0
var time := 0.0
var active := false


func _init() -> void:
	density.resize(SIZE * SIZE); scratch.resize(SIZE * SIZE)


func clear() -> void:
	density.fill(0.0); active = false


## Keep the grid centred on the camera; shift whole cells so existing smoke stays in place.
func recentre(focus: Vector2, period: float) -> void:
	var want := (focus - Vector2.ONE * SIZE * CELL * 0.5).snapped(Vector2.ONE * CELL)
	var delta := want - origin
	if period > 0.0: delta.x -= round(delta.x / period) * period
	var dx := int(round(delta.x / CELL)); var dy := int(round(delta.y / CELL))
	if dx == 0 and dy == 0: return
	if absi(dx) >= SIZE or absi(dy) >= SIZE:
		density.fill(0.0)
	else:
		scratch.fill(0.0)
		for y in SIZE:
			var sy := y + dy
			if sy < 0 or sy >= SIZE: continue
			for x in SIZE:
				var sx := x + dx
				if sx >= 0 and sx < SIZE: scratch[y * SIZE + x] = density[sy * SIZE + sx]
		var t := density; density = scratch; scratch = t
	origin += Vector2(dx, dy) * CELL


func cell_of(p: Vector2, period: float) -> Vector2i:
	var local := p - origin
	if period > 0.0: local.x -= round((local.x - SIZE * CELL * 0.5) / period) * period
	return Vector2i(int(floor(local.x / CELL)), int(floor(local.y / CELL)))


func add(p: Vector2, amount: float, radius_cells: int, period: float) -> void:
	var c := cell_of(p, period)
	for y in range(c.y - radius_cells, c.y + radius_cells + 1):
		for x in range(c.x - radius_cells, c.x + radius_cells + 1):
			if x < 0 or y < 0 or x >= SIZE or y >= SIZE: continue
			var falloff := 1.0 - Vector2(x - c.x, y - c.y).length() / float(radius_cells + 1)
			if falloff > 0.0: density[y * SIZE + x] = minf(1.5, density[y * SIZE + x] + amount * falloff)
	active = true


## sources: Array of [x, z, strength] (continuous emitters per second)
func step(dt: float, sources: Array, wind: Vector2, period: float) -> void:
	if not active and sources.is_empty(): return
	accumulator = minf(accumulator + dt, STEP * 3.0)
	while accumulator >= STEP:
		accumulator -= STEP; time += STEP
		for s in sources: add(Vector2(float(s[0]), float(s[1])), float(s[2]) * STEP * 1.6, 1, period)
		_advect(wind)
	var any := false
	for v in density:
		if v > 0.02: any = true; break
	active = any


func _advect(wind: Vector2) -> void:
	# semi-Lagrangian advection with gentle turbulence, then diffusion and decay
	var flow := wind * 0.45 / CELL * STEP
	for y in SIZE:
		for x in SIZE:
			var swirl := Vector2(sin(time * 0.7 + y * 0.45), cos(time * 0.6 + x * 0.4)) * 0.18 * STEP / CELL
			var src := Vector2(x, y) - flow - swirl
			var x0 := int(floor(src.x)); var y0 := int(floor(src.y)); var f := src - Vector2(x0, y0)
			var v := 0.0
			if x0 >= 0 and y0 >= 0 and x0 + 1 < SIZE and y0 + 1 < SIZE:
				var a := density[y0 * SIZE + x0]; var b := density[y0 * SIZE + x0 + 1]
				var c := density[(y0 + 1) * SIZE + x0]; var d := density[(y0 + 1) * SIZE + x0 + 1]
				v = lerpf(lerpf(a, b, f.x), lerpf(c, d, f.x), f.y)
			scratch[y * SIZE + x] = v
	for y in range(1, SIZE - 1):
		for x in range(1, SIZE - 1):
			var i := y * SIZE + x
			var blurred := (scratch[i] * 4.0 + scratch[i - 1] + scratch[i + 1] + scratch[i - SIZE] + scratch[i + SIZE]) / 8.0
			density[i] = maxf(0.0, blurred * (1.0 - 0.22 * STEP) - 0.004)
	for x in SIZE:
		density[x] = 0.0; density[(SIZE - 1) * SIZE + x] = 0.0
		density[x * SIZE] = 0.0; density[x * SIZE + SIZE - 1] = 0.0


## Render points: [world position (x, z), density] for cells worth drawing, strongest first.
func puffs(limit: int) -> Array:
	var out := []
	for y in SIZE:
		for x in SIZE:
			var v := density[y * SIZE + x]
			if v > 0.06: out.append([origin.x + (x + 0.5) * CELL, origin.y + (y + 0.5) * CELL, v, y * SIZE + x])
	if out.size() > limit:
		out.sort_custom(func(a, b): return a[2] > b[2])
		out.resize(limit)
	return out
