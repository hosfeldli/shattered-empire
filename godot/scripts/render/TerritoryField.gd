class_name TerritoryField
extends Node
## Builds the per-hex territory texture read by the terrain shader: last-known owner colour and a
## mask of neighbouring hexes held by someone else. Ownership comes only from tile records the
## server already sent to this viewer, so hidden conquests are not revealed. Updates are local:
## a changed tile repaints itself and its six neighbours.

var world: WorldState
var material: ShaderMaterial
var image: Image
var texture: ImageTexture
var pending := {}
var full_rebuild := true
var since := 0.0
var strength := 1.0


func setup(w: WorldState, terrain_material: ShaderMaterial) -> void:
	world = w
	material = terrain_material
	world.welcomed.connect(_reset)
	world.reset.connect(_reset)
	world.tiles_changed.connect(_on_tiles)


func _reset() -> void:
	image = null
	full_rebuild = true
	pending.clear()


func _on_tiles(tiles: PackedInt32Array, _roads: PackedInt32Array) -> void:
	if image == null or tiles.size() > world.grid.n / 4:
		full_rebuild = true
		return
	for t in tiles:
		pending[t] = true


func set_strength(value: float) -> void:
	strength = value
	if material: material.set_shader_parameter("territory_strength", value)


func _process(dt: float) -> void:
	if world == null or world.grid == null or world.tile_owner.size() != world.grid.n:
		return
	since += dt
	if since < 0.25 or (pending.is_empty() and not full_rebuild):
		return
	since = 0.0
	var g := world.grid
	if full_rebuild or image == null or image.get_width() != g.w or image.get_height() != g.h:
		image = Image.create(g.w, g.h, false, Image.FORMAT_RGBA8)
		for i in g.n:
			_paint(i)
		texture = ImageTexture.create_from_image(image)
		material.set_shader_parameter("territory_field", texture)
		material.set_shader_parameter("territory_ready", 1.0)
		material.set_shader_parameter("territory_strength", strength)
		full_rebuild = false
		pending.clear()
		return
	var touched := {}
	for t in pending:
		touched[t] = true
		for d in 6:
			var nb := g.nb[int(t) * 6 + d]
			if nb >= 0: touched[nb] = true
	pending.clear()
	for t in touched:
		_paint(int(t))
	texture.update(image)


func mask(i: int) -> int:
	var owner := world.tile_owner[i]
	if owner < 0: return 0
	var bits := 64
	for d in 6:
		var nb := world.grid.nb[i * 6 + d]
		if nb < 0 or world.tile_owner[nb] != owner: bits |= 1 << d
	return bits


func _paint(i: int) -> void:
	var g := world.grid
	var x := i % g.w
	var y := i / g.w
	var bits := mask(i)
	if bits == 0:
		image.set_pixel(x, y, Color(0, 0, 0, 0))
		return
	var c := world.civ_color(world.tile_owner[i])
	c.a = bits / 255.0
	image.set_pixel(x, y, c)
