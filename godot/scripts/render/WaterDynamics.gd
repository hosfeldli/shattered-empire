class_name WaterDynamics
extends RefCounted
## Flow atlas for all received water; a small moving surface simulation for the tactical view.
var world:WorldState
var terrain:WorldRenderer
var sites:SitePlanner
var simulation:=WaterSurfaceSimulation.new()
var micro:=WaterMicroSimulation.new()
var atlas:Image
var atlas_texture:ImageTexture
var revision:=-1
var mask_revision:=-1
var last_center:=Vector2.INF
var rng:=RandomNumberGenerator.new()
var rain_acc:=0.0
var atlas_dirty:={}
var active:=false
var blend:=0.0

func setup(w:WorldState,renderer:WorldRenderer) -> void:
	micro.setup()
	world=w; terrain=renderer; sites=SitePlanner.new(); sites.setup(w)
	w.welcomed.connect(clear); w.reset.connect(clear)
	w.geo_changed.connect(func(chunks:PackedInt32Array):
		for chunk in chunks: atlas_dirty[chunk]=true)
	clear()

func clear() -> void:
	micro.clear()
	atlas=null; atlas_texture=null; revision=-1; mask_revision=-1; last_center=Vector2.INF; blend=0
	atlas_dirty.clear()
	simulation.reset(); rng.seed=world.world_seed+7219
	terrain.water_mat.set_shader_parameter("fluid_active",0.0)
	terrain.terrain_mat.set_shader_parameter("river_bank_active",0.0)
	terrain.water_mat.set_shader_parameter("water_data_ready",0.0)

func _atlas() -> void:
	if revision==world.geometry_revision: return
	revision=world.geometry_revision
	if atlas==null:
		atlas=Image.create(world.grid.w,world.grid.h,false,Image.FORMAT_RGBA8)
		for chunk in world.chunks_w*world.chunks_h: atlas_dirty[chunk]=true
	for chunk in atlas_dirty:
		var cx:=int(chunk)%world.chunks_w; var cy:=int(chunk)/world.chunks_w
		for y in range(cy*world.chunk,mini((cy+1)*world.chunk,world.grid.h)):
			for x in range(cx*world.chunk,mini((cx+1)*world.chunk,world.grid.w)):
				var tile:=y*world.grid.w+x
				if not world.known[tile]: atlas.set_pixel(x,y,Color(0,0,0,0)); continue
				var kind:=1.0 if world.is_river(tile) else .5 if world.is_lake(tile) else 0.0
				var flow:=Vector2.ZERO
				if world.is_river(tile) and world.flow_dir(tile)>=0: flow=world.grid.dir_vec[world.flow_dir(tile)]
				var water:=world.is_river(tile) or world.is_lake(tile) or world.is_sea(tile)
				atlas.set_pixel(x,y,Color(flow.x*.5+.5,flow.y*.5+.5,kind,clampf(float(world.geo[tile*6+2])/80.0,.06,1.0) if water else 0))
	atlas_dirty.clear()
	if atlas_texture==null: atlas_texture=ImageTexture.create_from_image(atlas)
	else: atlas_texture.update(atlas)
	terrain.water_mat.set_shader_parameter("water_data",atlas_texture)
	terrain.water_mat.set_shader_parameter("water_data_ready",1.0)

func update(dt:float,camera:CameraController,weather:EnvironmentContext) -> void:
	if world.grid==null: return
	_atlas()
	active=camera.size<28.0
	blend=move_toward(blend,1.0 if active else 0.0,dt*2.0)
	terrain.water_mat.set_shader_parameter("fluid_active",blend)
	if not active and blend<=0: return
	var center:=Vector2(camera.focus.x,camera.focus.z)
	if last_center!=Vector2.INF: center.x=world.grid.near_x(center.x,last_center.x)
	last_center=center
	var shifted:=simulation.recenter(center)
	if not micro.supported and (shifted or mask_revision!=world.geometry_revision):
		var changed:=mask_revision!=world.geometry_revision
		mask_revision=world.geometry_revision; _mask([] if changed else Array(simulation.exposed))
	var wind:=weather.wind_at_world(center) if weather else Vector2.ZERO
	var delta:=0.0 if world.paused else minf(dt*world.play_rate,.066)
	var rain:float=weather.at_tile(world.grid.tile_at(center.x,center.y)).get("rain",0.0) if weather else 0.0
	rain_acc+=float(rain)*delta*45.0
	while rain_acc>=1:
		rain_acc-=1
		simulation.impulse(simulation.origin+Vector2(rng.randf(),rng.randf())*simulation.resolution*simulation.cell_size,-.10)
	if micro.supported:
		micro.update(delta,center,atlas_texture,Vector2(world.grid.w,world.grid.h),wind,float(rain))
		terrain.water_mat.set_shader_parameter("fluid_height",micro.texture)
		terrain.water_mat.set_shader_parameter("fluid_origin",micro.origin)
		terrain.water_mat.set_shader_parameter("fluid_extent",WaterMicroSimulation.EXTENT)
		terrain.water_mat.set_shader_parameter("fluid_texel",1.0/WaterMicroSimulation.RESOLUTION)
		terrain.water_mat.set_shader_parameter("fluid_scale",1.0)
		terrain.terrain_mat.set_shader_parameter("river_bank_field",micro.texture)
		terrain.terrain_mat.set_shader_parameter("river_bank_origin",micro.origin)
		terrain.terrain_mat.set_shader_parameter("river_bank_extent",WaterMicroSimulation.EXTENT)
		terrain.terrain_mat.set_shader_parameter("river_bank_active",blend)
	else:
		if simulation.advance(delta,wind): simulation.upload()
		if simulation.texture:
			terrain.water_mat.set_shader_parameter("fluid_height",simulation.texture)
			terrain.water_mat.set_shader_parameter("fluid_origin",simulation.origin)
			terrain.water_mat.set_shader_parameter("fluid_extent",float(simulation.resolution)*simulation.cell_size)
			terrain.water_mat.set_shader_parameter("fluid_texel",1.0/float(simulation.resolution))
			terrain.water_mat.set_shader_parameter("fluid_scale",.012)

func shutdown() -> void: micro.shutdown()

func _mask(indices:Array) -> void:
	if indices.is_empty(): indices=range(simulation.resolution*simulation.resolution)
	for index in indices:
		var x:int=int(index)%simulation.resolution; var y:int=int(index)/simulation.resolution
		var point:=simulation.origin+(Vector2(x,y)+Vector2.ONE*.5)*simulation.cell_size
		var tile:=world.grid.tile_at(point.x,point.y)
		var wet:=tile>=0 and world.known[tile] and (world.is_sea(tile) or world.is_lake(tile))
		var current:=Vector2.ZERO
		if tile>=0 and world.known[tile] and world.is_river(tile):
			for reach in sites.rivers(tile):
				var a:Vector2=reach.a; var b:Vector2=reach.b
				a.x=world.grid.near_x(a.x,point.x); b.x=a.x+world.grid.dx_wrap(reach.a.x,b.x)
				if point.distance_to(Geometry2D.get_closest_point_to_segment(point,a,b))<float(reach.width): wet=true; current=(b-a).normalized()*(.35+.12*world.flow_bucket(tile)); break
		simulation.wet[index]=1 if wet else 0
		simulation.current[index]=current
		if not wet: simulation.height[index]=0; simulation.velocity[index]=0
