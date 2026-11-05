class_name WorldPlacementPreview
extends MeshInstance3D
## Faithful final-appearance geometry, cached by proposed parcel and actual neighbor structure.
var world:WorldState
var camera:CameraController
var renderer:SettlementRenderer
var cache:={}
var tile:=-1
var origin_x:=0.0
var base_offset:=Vector3.ZERO
var generated:=0

func setup(w:WorldState,c:CameraController,s:SettlementRenderer) -> void:
	world=w; camera=c; renderer=s; cast_shadow=GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	world.reset.connect(clear); world.welcomed.connect(clear)

func clear() -> void:
	mesh=null; tile=-1; cache.clear()

func show_building(type:String,at:int) -> void:
	if at<0 or at>=world.grid.n: mesh=null; return
	var neighbors:=[]
	for direction in 6:
		var neighbor:=world.grid.nb[at*6+direction]
		var building:Dictionary=world.buildings.get(renderer.at_tile.get(neighbor,-1),{})
		neighbors.append([building.get("ty"),building.get("o"),building.get("d"),building.get("lv",1)])
	var key:=str([type,at,world.geometry_revision,neighbors])
	if not cache.has(key):
		if cache.size()>=32: cache.clear()
		var model:=renderer.preview_mesh(type,at)
		var offset:=Vector3.ZERO
		if model==null:
			model=renderer.preview_mesh(type,world.start_tile,false)
			var a:=world.grid.center(at); var b:=world.grid.center(world.start_tile)
			offset=Vector3(a.x-b.x,world.tile_height(at)-world.tile_height(world.start_tile),a.y-b.y)
		cache[key]={"mesh":model,"offset":offset}; generated+=1
	mesh=cache[key].mesh; base_offset=cache[key].offset; position=base_offset; tile=at
	origin_x=world.grid.center(at).x
	position.x+=world.grid.near_x(origin_x,camera.focus.x)-origin_x

func _process(_dt:float) -> void:
	if tile<0 or mesh==null: return
	# Only the wrapped copy moves as the camera pans; the parcel's recipe never changes.
	var center:=world.grid.center(tile)
	position.x=base_offset.x+world.grid.near_x(center.x,camera.focus.x)-center.x
