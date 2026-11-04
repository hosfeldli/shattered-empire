class_name NativeMinimap
extends Control
## A clickable, fog-filtered map. Pixel work is sliced through the generation scheduler and never
## restarts a running image job merely because another snapshot arrived.
var world:WorldState
var camera:CameraController
var composition:WorldCompositionSystem
var texture:ImageTexture
var dirty:=true
var revision:=0


func setup(w:WorldState,cam:CameraController,system:WorldCompositionSystem) -> void:
	world=w; camera=cam; composition=system
	size=Vector2(208,144)
	mouse_filter=Control.MOUSE_FILTER_STOP
	world.welcomed.connect(_reset); world.reset.connect(_reset)
	world.tiles_changed.connect(func(_tiles,_roads):dirty=true)
	world.vis_changed.connect(func(_bits):dirty=true)
	world.geo_changed.connect(func(_chunks):dirty=true)


func _reset() -> void:
	texture=null; dirty=true; revision+=1


func _process(_dt:float) -> void:
	visible=world.ready_
	if not visible: return
	position=get_viewport_rect().size-size-Vector2(12,38)
	if dirty and not composition.scheduler.has_pending("minimap"):
		dirty=false; revision+=1
		var image:=Image.create(world.grid.w,world.grid.h,false,Image.FORMAT_RGBA8)
		var state:={"row":0}
		composition.scheduler.enqueue("minimap",revision,GenerationScheduler.Priority.LOW,func():
			var end:=mini(int(state.row)+4,world.grid.h)
			for y in range(int(state.row),end):
				for x in world.grid.w:
					var tile:=y*world.grid.w+x
					var color:=Color(.06,.07,.08)
					if world.known[tile]:
						color=world.tile_color[tile]
						if (world.vis_bits[tile>>3]&(1<<(tile&7)))==0: color=color.darkened(.55)
					image.set_pixel(x,y,color)
			state.row=end
			return end==world.grid.h,func(): texture=ImageTexture.create_from_image(image))
	queue_redraw()


func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO,size),Color(.06,.07,.08,.9))
	if texture: draw_texture_rect(texture,Rect2(Vector2.ZERO,size),false)
	draw_rect(Rect2(Vector2.ZERO,size),Color(.7,.7,.65),false,1)
	if world.grid==null: return
	var x:=world.grid.base_x(camera.focus.x)/world.grid.period*size.x
	var y:=camera.focus.z/world.grid.depth*size.y
	var half_x:=camera.view_half_width()/world.grid.period*size.x
	var half_y:=camera.size*.5/sin(deg_to_rad(CameraController.PITCH))/world.grid.depth*size.y
	for offset in [-size.x,0.0,size.x]:
		var frame:=Rect2(Vector2(x+offset-half_x,y-half_y),Vector2(2*half_x,2*half_y)).intersection(Rect2(Vector2.ZERO,size))
		if frame.has_area(): draw_rect(frame,Color(1,.95,.7,.8),false,1)


func _gui_input(event:InputEvent) -> void:
	var point:=Vector2.INF
	if event is InputEventMouseButton and event.button_index==MOUSE_BUTTON_LEFT and event.pressed: point=event.position
	elif event is InputEventMouseMotion and (event.button_mask&MOUSE_BUTTON_MASK_LEFT): point=event.position
	if point!=Vector2.INF:
		var x:=clampi(int(point.x/size.x*world.grid.w),0,world.grid.w-1)
		var y:=clampi(int(point.y/size.y*world.grid.h),0,world.grid.h-1)
		var tile:=y*world.grid.w+x
		if world.known[tile]: camera.focus_tile(tile)
		accept_event()
