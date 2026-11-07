class_name StrategicPresentation
extends Control
var unit_labels:=true
var resource_markers:=true
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
	for title in ["Landscape", "Territory", "Supply", "Stability", "Traffic", "Fronts", "Tactical"]: selector.add_item(title)
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
	var density:={}; var fighting:={}; var defenses:={}
	for edge in world.traffic:
		for tile in [int(edge[0]),int(edge[1])]: density[tile]=maxf(float(density.get(tile,0)),float(edge[2])/9.0)
	for record in world.bf.get("i",[]): fighting[int(record[0])]=float(record[1])/3.0
	for record in world.fw: defenses[int(record[0])]=true
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
					4:
						if density.has(tile): color=Color(.95,.35,.08,clampf(float(density[tile]),.1,1))
					5:
						if fighting.has(tile): color=Color(.9,.2,.1,clampf(float(fighting[tile]),0,1))
					6:
						if defenses.has(tile): color=Color(.25,.7,.85,.9)
						elif fighting.has(tile): color=Color(.9,.45,.15,clampf(float(fighting[tile]),0,1))
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
	# Active battles the viewer knows about: crossed swords pulsing with the fighting's heat.
	if camera.size >= 26:
		var pulse := .5 + .5 * sin(Time.get_ticks_msec() / 260.0)
		for battle in world.battles:
			var tile := int(battle.get("t", -1))
			if tile < 0: continue
			var p := _point(tile)
			var heat := clampf(float(battle.get("heat", 1)) / 12.0, .25, 1.0)
			var r := 9.0 + 3.0 * pulse * heat
			draw_circle(p, r + 3, Color(.08, .06, .05, .55))
			var col := Color(.95, .42, .28).lerp(Color(1, .8, .45), pulse * .4)
			draw_line(p + Vector2(-r * .6, -r * .6), p + Vector2(r * .6, r * .6), col, 2.2, true)
			draw_line(p + Vector2(r * .6, -r * .6), p + Vector2(-r * .6, r * .6), col, 2.2, true)
			draw_arc(p, r + 1, 0, TAU, 24, Color(col, .5 + .3 * pulse), 1.2, true)
			if camera.size >= 45: _text(p + Vector2(r + 5, 4), str(battle.get("name", "Battle")), Color(.98, .78, .62), 12)
	for city in world.cities.values():
		var p := _point(int(city.t))
		var color := world.civ_color(int(city.o))
		if camera.size >= 72: draw_circle(p,4,color)
		var tier_names:=["","City","Metropolis","Megacity"]
		var tier:=int(city.get("ti",0))
		var title:=str(city.n)+(" ★" if int(city.get("cap",0))==1 else "")
		_text(p+Vector2(7,-5),title,Color(.95,.94,.86),15 if tier>=2 or int(city.get("cap",0))==1 else 14)
		if tier>0 and camera.size<90: _text(p+Vector2(7+title.length()*7.6,-5),tier_names[mini(tier,3)],Color(.78,.72,.55),11)
		if camera.size<40 and (int(city.o)==world.civ_id or world.spectator):
			var state:="%d people · %s homes"%[int(city.pop),str(city.get("h","—"))]
			if int(city.get("fs",0)): state+=" · FOOD SHORTAGE"
			elif int(city.get("iso",0)): state+=" · ISOLATED"
			_text(p+Vector2(7,13),state,Color(.95,.68,.45) if int(city.get("fs",0)) or int(city.get("iso",0)) else Color(.82,.85,.77),12)
			if camera.size<24: _text(p+Vector2(7,29),CityPresentation.work(world,city),NativeUI.MUTED,12)
