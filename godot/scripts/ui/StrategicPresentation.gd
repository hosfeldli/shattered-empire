class_name StrategicPresentation
extends Control
## Native screen-space labels remain crisp through zoom. Strategic lenses tint terrain through a
## texture built cooperatively; the source is exclusively received tile and supply records.
var world: WorldState
var camera: CameraController
var composition: WorldCompositionSystem
var terrain: WorldRenderer
var mode := 0
var selector: OptionButton
var font: Font
var _revision := 0
var _dirty := true
var deposits := {}


func setup(w: WorldState, cam: CameraController, system: WorldCompositionSystem, renderer: WorldRenderer) -> void:
	world = w; camera = cam; composition = system; terrain = renderer
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	font = ThemeDB.fallback_font
	selector = OptionButton.new(); selector.position = Vector2(330,40)
	for title in ["Landscape", "Territory", "Supply", "Stability"]: selector.add_item(title)
	selector.item_selected.connect(func(index): mode = index; _dirty = true)
	add_child(selector)
	world.welcomed.connect(func(): deposits.clear(); _dirty = true)
	world.reset.connect(func(): deposits.clear(); _dirty = true)
	world.econ_applied.connect(func(): _dirty = true)
	world.tiles_changed.connect(func(_tiles,_roads): _dirty = true)
	world.geo_changed.connect(_geo)


func _geo(chunks: PackedInt32Array) -> void:
	for chunk in chunks:
		var list := []
		var x0 := (chunk % world.chunks_w)*world.chunk
		var y0 := (chunk / world.chunks_w)*world.chunk
		for y in range(y0,mini(y0+world.chunk,world.grid.h)):
			for x in range(x0,mini(x0+world.chunk,world.grid.w)):
				var tile := y*world.grid.w+x
				if world.known[tile] and world.deposit(tile)>0: list.append(tile)
		deposits[chunk] = list
	_dirty = true


func _process(_dt: float) -> void:
	selector.visible = world.ready_
	if not world.ready_: return
	if _dirty:
		_dirty = false
		_overlay()
	queue_redraw()


func _overlay() -> void:
	# Keep the landscape visible while a lens image is being prepared. A missing/default texture
	# must never replace the ground, and cancelling a lens must cancel its queued upload too.
	terrain.terrain_mat.set_shader_parameter("overlay_strength",0.0)
	if mode == 0:
		composition.scheduler.cancel("strategic-overlay")
		return
	_revision += 1
	var image := Image.create(world.grid.w,world.grid.h,false,Image.FORMAT_RGBA8)
	var job := {"row":0,"mode":mode}
	composition.scheduler.enqueue("strategic-overlay",_revision,GenerationScheduler.Priority.MEDIUM,func():
		var y := int(job.row)
		for x in world.grid.w:
			var tile := y*world.grid.w+x
			var color := Color.TRANSPARENT
			if world.known[tile]:
				match int(job.mode):
					1:
						if world.tile_owner[tile]>=0: color = world.civ_color(world.tile_owner[tile])
					2:
						if world.tile_owner[tile] == world.civ_id:
							color = Color(.2,.7,.35) if (world.supply_bits[tile>>3] & (1<<(tile&7))) else Color(.8,.25,.15)
					3:
						if world.tile_stability[tile]>=0: color = Color(.8,.25,.15).lerp(Color(.2,.7,.4),clampf(world.tile_stability[tile]/100.0,0,1))
			image.set_pixel(x,y,color)
		job.row += 1
		return int(job.row) == world.grid.h,
		func():
			if mode==int(job.mode):
				terrain.terrain_mat.set_shader_parameter("strategic_overlay",ImageTexture.create_from_image(image))
				terrain.terrain_mat.set_shader_parameter("overlay_strength",.55))


func _point(tile: int) -> Vector2:
	var c := world.grid.center(tile)
	return camera.to_screen(Vector3(world.grid.near_x(c.x,camera.focus.x),world.tile_height(tile)+.1,c.y))


func _text(point: Vector2, message: String, color: Color, pixels := 14) -> void:
	if not get_viewport_rect().grow(-8).has_point(point): return
	draw_string_outline(font,point,message,HORIZONTAL_ALIGNMENT_LEFT,-1,pixels,4,Color(0,0,0,.85))
	draw_string(font,point,message,HORIZONTAL_ALIGNMENT_LEFT,-1,pixels,color)


func _draw() -> void:
	if not world.ready_ or world.grid == null: return
	for city in world.cities.values():
		var p := _point(int(city.t))
		var color := world.civ_color(int(city.o))
		if camera.size >= 72: draw_circle(p,4,color)
		_text(p+Vector2(7,-5),str(city.n),Color(.95,.94,.86),14)
	if camera.size >= 72:
		# Aggregate only received units, without exposing hidden army membership.
		var groups := {}
		for unit in world.units.values():
			var key := "%d:%d" % [int(unit.owner),world._chunk_of(int(unit.tile))]
			if not groups.has(key): groups[key] = {"tile":int(unit.tile),"owner":int(unit.owner),"count":0}
			groups[key].count += 1
		for group in groups.values():
			var p := _point(group.tile)
			draw_rect(Rect2(p-Vector2(5,4),Vector2(10,8)),world.civ_color(group.owner))
			_text(p+Vector2(7,4),str(group.count),Color.WHITE,13)
	elif camera.size <= 25:
		var names := ["","Oil","Iron","Coal","Rare earth","Stone","Fish","Salvage"]
		for list in deposits.values():
			for tile in list:
				var resource := world.deposit(tile)
				if resource<names.size(): _text(_point(tile),names[resource],Color(.95,.84,.5),13)
