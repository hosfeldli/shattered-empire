class_name SurfaceValidation
extends RefCounted
## Real authorized geography; agricultural/industrial and fog examples are labelled local
## presentation fixtures. No commands create entities or reveal hidden data on the server.
var app:Node
var checks:={}
var directory:String
var caption:Label

func request(command:Dictionary) -> Dictionary:
	var reply:=LiveValidation.Reply.new(); app.net.cmd(command,func(record):reply.received.emit(record)); return await reply.received

func frames(count:int) -> void:
	for frame in count: await app.get_tree().process_frame

func shot(name_:String,text:String) -> void:
	caption.text=text
	await frames(3)
	await RenderingServer.frame_post_draw
	app.get_viewport().get_texture().get_image().save_png(directory+"/"+name_+".png")
	print("SURFACE_CAPTURE ",name_)

func run(game:Node,out:String) -> void:
	app=game; directory=out; DirAccess.make_dir_recursive_absolute(out)
	while app.world.snapshot_count<8: await frames(1)
	var reply:=LiveValidation.Reply.new(); app.net.cmd({"c":"speed","speed":0},func(record):reply.received.emit(record)); await reply.received
	var deadline:=Time.get_ticks_msec()+30000
	while (not app.terrain.dirty.is_empty() or not app.terrain.build_job.is_empty()) and Time.get_ticks_msec()<deadline: await frames(1)
	checks.terrain_ready=app.terrain.dirty.is_empty() and app.terrain.build_job.is_empty()
	app.cam.set_process(false); app.cam.set_process_input(false); app.cam.set_process_unhandled_input(false)
	app.input.set_process(false); app.input.set_process_input(false); app.input.set_process_unhandled_input(false)
	app.shell.set_process_input(false); app.shell.world_hidden=false; app.command_dock.panel.hide()
	var layer:=CanvasLayer.new(); layer.layer=200; app.add_child(layer)
	caption=Label.new(); caption.theme=NativeUI.theme(); caption.position=Vector2(16,850); caption.add_theme_color_override("font_outline_color",Color.BLACK); caption.add_theme_constant_override("outline_size",6); layer.add_child(caption)
	await frames(6)
	checks.observer_replaces_player_controls=app.observer_bar.visible and not app.resource_strip.visible and not app.shell.navigation.visible
	checks.observer_bar_compact=app.observer_bar.size.y<60 and app.get_viewport().get_visible_rect().encloses(app.observer_bar.get_global_rect())
	(app.observer_bar.speeds[2] as Button).pressed.emit()
	deadline=Time.get_ticks_msec()+4000
	while float(app.world.observer.get("speed",0))!=2.0 and Time.get_ticks_msec()<deadline: await frames(1)
	checks.observer_speed_authoritative=float(app.world.observer.get("speed",0))==2.0
	(app.observer_bar.speeds[0] as Button).pressed.emit(); await frames(30)
	await shot("watching-controls","Watching AI · compact pause, speed and visibility controls")
	app.shell.world_hidden=true
	var world:WorldState=app.world
	var best:Array=[]; var visited:={}; var mountain:=-1; var elevation:=-INF
	for tile in world.grid.n:
		if not world.known[tile]: continue
		if world.height[tile]>elevation: elevation=world.height[tile]; mountain=tile
		if not world.is_lake(tile) or visited.has(tile): continue
		var component:=[tile]; visited[tile]=true; var cursor:=0
		while cursor<component.size():
			var cell:int=component[cursor]; cursor+=1
			for direction in 6:
				var neighbor:=world.grid.nb[cell*6+direction]
				if neighbor>=0 and world.known[neighbor] and world.is_lake(neighbor) and not visited.has(neighbor): visited[neighbor]=true; component.append(neighbor)
		if component.size()>best.size(): best=component
	checks.real_connected_lake=best.size()>1
	var lake:=-1
	if not best.is_empty():
		lake=int(best[best.size()/2]); var level:=world.water_level(lake); var consistent:=true; var submerged:=true; var shared:=0
		for tile:int in best:
			consistent=consistent and is_equal_approx(level,world.water_level(tile))
			for corner in 6:
				var water_count:=1
				for direction in HexGrid.CORNER_DIRS[corner]:
					var neighbor:=world.grid.nb[tile*6+int(direction)]
					if neighbor>=0 and world.known[neighbor] and world.is_lake(neighbor): water_count+=1
				if water_count>=2: shared+=1; submerged=submerged and world.corner_height(tile,corner)<level
		checks.shared_lake_height=consistent; checks.internal_lake_edges_submerged=submerged and shared>0
		app.cam.focus_tile(lake,7); await frames(60); await shot("lake-close","Actual server lake · one shared water surface")
		app.cam.focus_tile(lake,20); await frames(30); await shot("lake-region","Actual server lake · continuous across terrain chunks")
		app.cam.focus.x+=world.grid.period; app.cam._apply(); await frames(30); await shot("lake-wrapped","Same lake in the next world image")
	if mountain>=0:
		app.cam.focus_tile(mountain,14); await frames(30); await shot("mountain-relief","Actual server elevation · stronger physical relief")
		checks.real_mountain=world.elevation(mountain)>.5
	# A small connected district on already-received dry terrain, without altering the match.
	var site:=-1
	for tile in world.grid.n:
		if not world.known[tile] or world.is_sea(tile) or world.is_lake(tile) or world.is_river(tile) or world.biome(tile)!=2: continue
		var valid:=true
		for direction in 6:
			var neighbor:=world.grid.nb[tile*6+direction]
			if neighbor<0 or not world.known[neighbor] or world.is_sea(neighbor) or world.is_lake(neighbor) or world.is_river(neighbor): valid=false; break
		if valid: site=tile; break
	checks.district_site=site>=0
	if site>=0:
		app.net.message.disconnect(app._on_message)
		var original:Dictionary=world.buildings.duplicate(true)
		var local:=[site,world.grid.nb[site*6],world.grid.nb[site*6+1],world.grid.nb[site*6+2]]
		for type in ["farm","steel_mill","quarry"]:
			world.buildings=original.duplicate(true)
			for index in local.size(): world.buildings[900000+index]={"id":900000+index,"t":local[index],"ty":type,"o":world.civ_id,"d":1,"lv":1,"hp":100,"st":"healthy","p":100}
			world.buildings_version+=1; world.econ_applied.emit(); world.snapshot_applied.emit()
			app.cam.focus_tile(site,6); await frames(120); await shot(type+"-district","Local presentation fixture · four neighboring "+("farms" if type=="farm" else "quarries" if type=="quarry" else "industrial works"))
		var original_works:Array=world.fw.duplicate(true)
		world.buildings=original.duplicate(true)
		for index in [2,3]: world.buildings[900000+index]={"id":900000+index,"t":local[index],"ty":"bunker" if index==2 else "guard_post","o":world.civ_id,"d":1,"lv":1,"hp":100,"st":"operational","p":100}
		world.fw=[[site,world.civ_id,1,1,100,100,0,0,9],[local[1],world.civ_id,1,1,65,100,0,0,9]]; world.fw_version+=1
		world.buildings_version+=1; world.econ_applied.emit(); world.snapshot_applied.emit()
		app.cam.focus_tile(site,5); await frames(120); await shot("defensive-junction","Local presentation fixture · reinforced trench, work front, bunker and guard post")
		world.fw=original_works; world.fw_version+=1
		world.buildings=original; world.buildings_version+=1; world.econ_applied.emit(); world.snapshot_applied.emit()
		# Hide a portion of this already authorized world to exercise inward fog blending.
		var original_visibility:=world.vis_bits.duplicate(); var original_known:=world.known.duplicate(); var original_mask:=world.known_mask.duplicate()
		var center:=world.grid.center(site)
		for tile in world.grid.n:
			var p:=world.grid.center(tile); var dx:=absf(world.grid.near_x(p.x,center.x)-center.x)
			if dx>3.5: world.vis_bits[tile>>3]&=255^(1<<(tile&7))
			if dx>7.0: world.known[tile]=0; world.known_mask[tile]=0
		app.terrain.surface_fields.previous_known.fill(254)
		var chunks:=PackedInt32Array(); for cid in world.chunks_w*world.chunks_h: chunks.append(cid)
		app.terrain.surface_fields.update_geography(chunks); world.vis_changed.emit(world.vis_bits)
		app.cam.focus_tile(site,17); await frames(30); await shot("fog-boundary","Visibility fixture · only hides already received terrain")
		world.known=original_known; world.known_mask=original_mask; world.vis_bits=original_visibility
		app.terrain.surface_fields.update_geography(chunks); world.vis_changed.emit(world.vis_bits)
	var result:={"checks":checks,"lake_tile":lake,"lake_cells":best.size(),"mountain_tile":mountain,"district_tile":site,"fixture":"Districts and fog are local presentation fixtures on received server terrain. No simulation state is changed.","rendered":DisplayServer.get_name()!="headless"}
	var file:=FileAccess.open(directory+"/surface-validation.json",FileAccess.WRITE); file.store_string(JSON.stringify(result,"  ")); file.close()
	print("SURFACE_VALIDATION ",JSON.stringify(result)); app.get_tree().quit(1 if checks.values().has(false) else 0)
