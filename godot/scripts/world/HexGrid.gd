class_name HexGrid
extends RefCounted
## Odd-r offset hex grid (pointy-top hexes, odd rows shoved east): the server's layout
## (server/sim/hex.js). One world unit is one hex radius; X runs east, Z runs south, Y is up.
## The world is a cylinder: every x has images x + k * period. This is the single wrapped coordinate
## system of the client: base positions live in [0, period) and everything is drawn at the image
## nearest the camera, so recentring the camera by exactly one period never moves anything on screen.

const SQRT3 := 1.7320508075688772
const DIRS_EVEN := [Vector2i(1, 0), Vector2i(0, -1), Vector2i(-1, -1), Vector2i(-1, 0), Vector2i(-1, 1), Vector2i(0, 1)]
const DIRS_ODD := [Vector2i(1, 0), Vector2i(1, -1), Vector2i(0, -1), Vector2i(-1, 0), Vector2i(0, 1), Vector2i(1, 1)]
## neighbour directions: 0 E, 1 NE, 2 NW, 3 W, 4 SW, 5 SE (angle -60 * d degrees, z pointing south)
## the two neighbour directions that share corner k (corner k sits at angle -90 + 60k degrees)
const CORNER_DIRS := [[1, 2], [0, 1], [0, 5], [5, 4], [4, 3], [3, 2]]

var w: int
var h: int
var n: int
var wrap: bool
var period: float
var depth: float
var nb: PackedInt32Array
var corners: PackedVector2Array
var dir_vec: PackedVector2Array   # unit vectors toward each neighbour


func _init(width: int, height: int, wraps: bool) -> void:
	w = width
	h = height
	n = w * h
	wrap = wraps
	period = SQRT3 * w
	depth = 1.5 * h
	nb.resize(n * 6)
	for r in h:
		var dirs: Array = DIRS_ODD if (r & 1) == 1 else DIRS_EVEN
		for q in w:
			var i := r * w + q
			for d in 6:
				var o: Vector2i = dirs[d]
				var nq := q + o.x
				var nr := r + o.y
				var v := -1
				if nr >= 0 and nr < h:
					if wrap:
						v = nr * w + posmod(nq, w)
					elif nq >= 0 and nq < w:
						v = nr * w + nq
				nb[i * 6 + d] = v
	for k in 6:
		var a := deg_to_rad(-90.0 + 60.0 * k)
		corners.append(Vector2(cos(a), sin(a)))
	for d in 6:
		var a := deg_to_rad(-60.0 * d)
		dir_vec.append(Vector2(cos(a), sin(a)))


func q_of(i: int) -> int:
	return i % w


func r_of(i: int) -> int:
	return i / w


## base-image centre of hex i as (x, z)
func center(i: int) -> Vector2:
	var q := i % w
	var r := i / w
	return Vector2(SQRT3 * (q + 0.5 * (r & 1)), 1.5 * r)


func neighbor(i: int, d: int) -> int:
	return nb[i * 6 + d]


## the hex containing (x, z) in any image, or -1 beyond the north / south edge
func tile_at(x: float, z: float) -> int:
	var cx := SQRT3 / 3.0 * x - z / 3.0
	var cz := 2.0 / 3.0 * z
	var cy := -cx - cz
	var rx := roundf(cx)
	var ry := roundf(cy)
	var rz := roundf(cz)
	var dx := absf(rx - cx)
	var dy := absf(ry - cy)
	var dz := absf(rz - cz)
	if dx > dy and dx > dz:
		rx = -ry - rz
	elif dy > dz:
		ry = -rx - rz
	else:
		rz = -rx - ry
	var r := int(rz)
	if r < 0 or r >= h:
		return -1
	var q := int(rx) + (r - (r & 1)) / 2
	if wrap:
		q = posmod(q, w)
	elif q < 0 or q >= w:
		return -1
	return r * w + q


## x moved by whole periods to the image nearest ref
func near_x(x: float, ref: float) -> float:
	if not wrap:
		return x
	return x + period * roundf((ref - x) / period)


## x folded into the base image [0, period)
func base_x(x: float) -> float:
	return fposmod(x, period) if wrap else x


## signed shortest east-west difference b - a
func dx_wrap(a: float, b: float) -> float:
	var d := b - a
	if wrap:
		d -= period * roundf(d / period)
	return d


## hex distance (cube metric, shortest image)
## every hex within `radius` steps of `center` (center first)
func disk(center: int, radius: int) -> Array:
	var out := [center]; var seen := {center: true}; var frontier := [center]
	for _r in radius:
		var next := []
		for t in frontier:
			for d in 6:
				var n: int = nb[int(t) * 6 + d]
				if n >= 0 and not seen.has(n): seen[n] = true; out.append(n); next.append(n)
		frontier = next
	return out


func dist(a: int, b: int) -> int:
	var ar := a / w
	var br := b / w
	var ax := (a % w) - (ar - (ar & 1)) / 2
	var bx := (b % w) - (br - (br & 1)) / 2
	var best := _cube(ax - bx, ar - br)
	if wrap:
		best = mini(best, _cube(ax - bx - w, ar - br))
		best = mini(best, _cube(ax - bx + w, ar - br))
	return best


func _cube(dx: int, dy: int) -> int:
	return maxi(absi(dx), maxi(absi(dy), absi(-dx - dy)))
