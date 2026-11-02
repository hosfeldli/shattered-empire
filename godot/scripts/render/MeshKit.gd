class_name MeshKit
extends RefCounted
## Accumulates procedural geometry per library material and commits it as one ArrayMesh with one
## surface per material. Buildings of a district, a unit model or a chunk of roads are each one
## MeshKit, so they draw as a handful of batched surfaces. Faces are wound so the front is seen
## from outside (Godot: clockwise front faces); every quad checks its own orientation against an
## outward hint, so callers only describe shapes.

const FRONT_CLOCKWISE := true

var parts := {}   # material key -> [verts, normals, colors] as plain Arrays (by reference; packed arrays copy on write)
var basis := Basis()
var origin := Vector3.ZERO


func _part(mat: String) -> Array:
	if not parts.has(mat):
		parts[mat] = [[], [], []]
	return parts[mat]


## local frame for the next shapes (a building's position and heading)
func set_frame(pos: Vector3, yaw: float) -> void:
	origin = pos
	basis = Basis(Vector3.UP, yaw)


func xf(p: Vector3) -> Vector3:
	return origin + basis * p


func tri(mat: String, a: Vector3, b: Vector3, c: Vector3, col: Color, outward := Vector3.ZERO) -> void:
	var nrm := (c - a).cross(b - a)
	if not FRONT_CLOCKWISE:
		nrm = -nrm
	if outward != Vector3.ZERO and nrm.dot(outward) < 0.0:
		var t := b
		b = c
		c = t
		nrm = -nrm
	if nrm.length_squared() < 1e-12:
		return
	nrm = nrm.normalized()
	var p := _part(mat)
	var pv: Array = p[0]
	var pn: Array = p[1]
	var pc: Array = p[2]
	pv.append(a); pv.append(b); pv.append(c)
	pn.append(nrm); pn.append(nrm); pn.append(nrm)
	pc.append(col); pc.append(col); pc.append(col)


## a triangle with its own colour per vertex (smooth blends, e.g. water depth)
func tri_colors(mat: String, a: Vector3, b: Vector3, c: Vector3, ca: Color, cb: Color, cc: Color, outward: Vector3) -> void:
	var nrm := (c - a).cross(b - a)
	if not FRONT_CLOCKWISE:
		nrm = -nrm
	if nrm.dot(outward) < 0.0:
		var t := b
		b = c
		c = t
		var tc := cb
		cb = cc
		cc = tc
		nrm = -nrm
	if nrm.length_squared() < 1e-12:
		return
	nrm = nrm.normalized()
	var p := _part(mat)
	var pv: Array = p[0]
	var pn: Array = p[1]
	var pc: Array = p[2]
	pv.append(a); pv.append(b); pv.append(c)
	pn.append(nrm); pn.append(nrm); pn.append(nrm)
	pc.append(ca); pc.append(cb); pc.append(cc)


## a, b, c, d around the quad; outward tells which side is the front
func quad(mat: String, a: Vector3, b: Vector3, c: Vector3, d: Vector3, col: Color, outward: Vector3) -> void:
	tri(mat, a, b, c, col, outward)
	tri(mat, a, c, d, col, outward)


## axis-aligned box in the current frame: centre of its base at p
func box(mat: String, p: Vector3, size: Vector3, col := Color.WHITE, yaw := 0.0) -> void:
	var hx := size.x * 0.5
	var hz := size.z * 0.5
	var bb := basis * Basis(Vector3.UP, yaw)
	var o := origin + basis * p
	var v: Array[Vector3] = []
	for k in 8:
		var x := hx if (k & 1) != 0 else -hx
		var y := size.y if (k & 2) != 0 else 0.0
		var z := hz if (k & 4) != 0 else -hz
		v.append(o + bb * Vector3(x, y, z))
	var up := bb * Vector3.UP
	var ex := bb * Vector3.RIGHT
	var ez := bb * Vector3.BACK
	quad(mat, v[2], v[3], v[7], v[6], col, up)                 # top
	quad(mat, v[0], v[1], v[5], v[4], col * 0.9, -up)          # bottom
	quad(mat, v[1], v[3], v[7], v[5], col, ex)                 # +x
	quad(mat, v[0], v[2], v[6], v[4], col, -ex)                # -x
	quad(mat, v[4], v[5], v[7], v[6], col, ez)                 # +z
	quad(mat, v[0], v[1], v[3], v[2], col, -ez)                # -z


## gable roof over a w x l footprint (ridge along local z), eaves at height y0
func gable(mat: String, p: Vector3, w: float, l: float, rise: float, col := Color.WHITE, yaw := 0.0, overhang := 0.04) -> void:
	var bb := basis * Basis(Vector3.UP, yaw)
	var o := origin + basis * p
	var hw := w * 0.5 + overhang
	var hl := l * 0.5 + overhang
	var a := o + bb * Vector3(-hw, 0, -hl)
	var b := o + bb * Vector3(hw, 0, -hl)
	var c := o + bb * Vector3(hw, 0, hl)
	var d := o + bb * Vector3(-hw, 0, hl)
	var r0 := o + bb * Vector3(0, rise, -hl)
	var r1 := o + bb * Vector3(0, rise, hl)
	var ex := bb * Vector3.RIGHT
	var ez := bb * Vector3.BACK
	var up := bb * Vector3.UP
	quad(mat, b, c, r1, r0, col, ex + up)
	quad(mat, a, d, r1, r0, col * 0.92, -ex + up)
	tri(mat, a, b, r0, col * 0.85, -ez)
	tri(mat, d, c, r1, col * 0.85, ez)


## sawtooth industrial roof: n north-lit teeth across a w x l hall
func sawtooth(mat: String, glass: String, p: Vector3, w: float, l: float, rise: float, n: int, col := Color.WHITE, yaw := 0.0) -> void:
	var bb := basis * Basis(Vector3.UP, yaw)
	var o := origin + basis * p
	var step := l / n
	for k in n:
		var z0 := -l * 0.5 + step * k
		var z1 := z0 + step
		var a := o + bb * Vector3(-w * 0.5, 0, z0)
		var b := o + bb * Vector3(w * 0.5, 0, z0)
		var c := o + bb * Vector3(w * 0.5, rise, z1)
		var d := o + bb * Vector3(-w * 0.5, rise, z1)
		var e := o + bb * Vector3(w * 0.5, 0, z1)
		var f := o + bb * Vector3(-w * 0.5, 0, z1)
		quad(mat, a, b, c, d, col, bb * Vector3(0, 1, -0.6))
		quad(glass, f, e, c, d, col, bb * Vector3.BACK)
		tri(mat, b, e, c, col * 0.9, bb * Vector3.RIGHT)
		tri(mat, a, f, d, col * 0.9, bb * Vector3.LEFT)


func cylinder(mat: String, p: Vector3, radius: float, h: float, segs := 8, col := Color.WHITE, top_radius := -1.0) -> void:
	var o := origin + basis * p
	var rt := radius if top_radius < 0.0 else top_radius
	var up := basis * Vector3.UP
	for k in segs:
		var a0 := TAU * k / segs
		var a1 := TAU * (k + 1) / segs
		var d0 := basis * Vector3(cos(a0), 0, sin(a0))
		var d1 := basis * Vector3(cos(a1), 0, sin(a1))
		var mid := (d0 + d1).normalized()
		quad(mat, o + d0 * radius, o + d1 * radius, o + up * h + d1 * rt, o + up * h + d0 * rt, col, mid)
		if rt > 0.001:
			tri(mat, o + up * h, o + up * h + d0 * rt, o + up * h + d1 * rt, col, up)


func cone(mat: String, p: Vector3, radius: float, h: float, segs := 7, col := Color.WHITE) -> void:
	var o := origin + basis * p
	var up := basis * Vector3.UP
	var tip := o + up * h
	for k in segs:
		var a0 := TAU * k / segs
		var a1 := TAU * (k + 1) / segs
		var d0 := basis * Vector3(cos(a0), 0, sin(a0))
		var d1 := basis * Vector3(cos(a1), 0, sin(a1))
		tri(mat, o + d0 * radius, o + d1 * radius, tip, col, (d0 + d1).normalized() + up * (radius / maxf(h, 0.01)))


## flat hexagon (pointy-top) at height y, radius r, around p
func hex_plate(mat: String, p: Vector3, r: float, col := Color.WHITE, thickness := 0.0) -> void:
	var o := origin + basis * p
	var pts: Array[Vector3] = []
	for k in 6:
		var a := deg_to_rad(-90.0 + 60.0 * k)
		pts.append(o + Vector3(cos(a) * r, 0, sin(a) * r))
	for k in 6:
		tri(mat, o, pts[k], pts[(k + 1) % 6], col, Vector3.UP)
		if thickness > 0.0:
			var dn := Vector3.DOWN * thickness
			var side := ((pts[k] + pts[(k + 1) % 6]) * 0.5 - o).normalized()
			quad(mat, pts[k], pts[(k + 1) % 6], pts[(k + 1) % 6] + dn, pts[k] + dn, col * 0.85, side)


## a strip from a to b (world points) of the given width, lifted by y, following up = +Y
func strip(mat: String, a: Vector3, b: Vector3, width: float, col := Color.WHITE) -> void:
	var dir := b - a
	dir.y = 0.0
	if dir.length_squared() < 1e-8:
		return
	var side := dir.normalized().cross(Vector3.UP) * (width * 0.5)
	quad(mat, a - side, a + side, b + side, b - side, col, Vector3.UP)


func is_empty() -> bool:
	return parts.is_empty()


func commit() -> ArrayMesh:
	var mesh := ArrayMesh.new()
	for mat in parts.keys():
		var p: Array = parts[mat]
		if (p[0] as Array).is_empty():
			continue
		var arrays := []
		arrays.resize(Mesh.ARRAY_MAX)
		arrays[Mesh.ARRAY_VERTEX] = PackedVector3Array(p[0])
		arrays[Mesh.ARRAY_NORMAL] = PackedVector3Array(p[1])
		arrays[Mesh.ARRAY_COLOR] = PackedColorArray(p[2])
		mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
		mesh.surface_set_material(mesh.get_surface_count() - 1, _material_for(mat))
	return mesh


static func _material_for(key: String) -> Material:
	if key.begins_with("team:"):
		return MaterialLibrary.team(Color.html(key.substr(5)))
	if key.begins_with("glow:"):
		return MaterialLibrary.glow(Color.html(key.substr(5)))
	return MaterialLibrary.get_mat(key)
