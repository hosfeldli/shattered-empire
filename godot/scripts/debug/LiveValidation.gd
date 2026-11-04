class_name LiveValidation
extends RefCounted
## Developer-only vertical-slice validation through real server commands and the native tools.
class Reply extends RefCounted:
	signal received(record: Dictionary)

var app: Node3D
var checks := {}
var details := {}


func request(command: Dictionary) -> Dictionary:
	var reply := Reply.new()
	app.net.cmd(command,func(record): reply.received.emit(record))
	return await reply.received


func run(game: Node3D, directory: String) -> void:
	app = game
	DisplayServer.window_set_title("Shattered Empires — native validation (temporary test match)")
	DirAccess.make_dir_recursive_absolute(directory)
	while app.world.snapshot_count<8: await app.get_tree().process_frame
	var w:WorldState=app.world
	print("LWE validation: placement and construction")
	var placement:=await request({"c":"placement","type":"house"})
	checks.placement=placement.get("tiles",[]).size()>0
	if checks.placement:
		var tile:=int(placement.tiles[0])
		var built:=await request({"c":"build","type":"house","tile":tile,"plan":true})
		checks.build=built.get("built",{}).get("id",-1)>=0
		details.build=built
		if checks.build:
			var id:=int(built.built.id)
			var until:=Time.get_ticks_msec()+30000
			while Time.get_ticks_msec()<until and (not w.buildings.has(id) or int(w.buildings[id].get("d",0))==0):
				await app.get_tree().process_frame
			checks.construction_completed=w.buildings.has(id) and int(w.buildings[id].get("d",0))==1
			checks.individual_selection=app.settlements.building_at(tile)==id
			app.settlements.selected_building=id
			app.cam.focus_tile(tile,9)
	var hub:Dictionary={}
	print("LWE validation: training and road")
	for building in w.buildings.values():
		if building.ty=="town" and int(building.o)==w.civ_id: hub=building; break
	if not hub.is_empty():
		var train:=await request({"c":"train","building":int(hub.id),"unit":"scout_buggy"})
		checks.training=train.get("error")==null; details.training=train
		var road:Dictionary={}
		for dir in 6:
			var target:=w.grid.nb[w.grid.nb[int(hub.t)*6+dir]*6+dir]
			app.command_tools.mode="road"; app.command_tools.value=1; app.command_tools.points=[int(hub.t),target]
			road=await request(app.command_tools._command(false))
			if road.get("plan",{}).get("buildable",false): break
		checks.road_preview=road.has("plan")
		if road.get("plan",{}).get("buildable",false):
			var committed:=await request(app.command_tools._command(true))
			checks.road_commit=committed.get("error")==null and committed.has("started")
			details.road=committed
	var trench:Dictionary={}
	print("LWE validation: trench")
	var attempts:=0
	for tile in w.grid.n:
		if w.known[tile]==0 or w.tile_owner[tile]!=w.civ_id or (w.urban_bits[tile>>3] & (1<<(tile&7)))!=0: continue
		attempts+=1
		app.command_tools.mode="trench"; app.command_tools.value="basic"; app.command_tools.points=[tile]
		trench=await request(app.command_tools._command(false))
		var legal:=false
		for segment in trench.get("trench",{}).get("segments",[]):
			if segment.get("ok",false) and not segment.get("skip",false): legal=true
		if legal:
			var committed:=await request(app.command_tools._command(true))
			checks.trench_commit=committed.get("error")==null and committed.has("started")
			details.trench=committed
			break
		if attempts>=12: break
	checks.trench_preview=trench.has("trench")
	var owned:=[]
	print("LWE validation: deployment")
	for unit in w.units.values():
		if int(unit.owner)==w.civ_id: owned.append(int(unit.id))
	if not owned.is_empty():
		app.military.selected.clear()
		for id in owned: app.military.selected[id]=true
		app.command_tools.mode="deploy"; app.command_tools.points=[w.start_tile,w.grid.nb[w.start_tile*6]]
		var deployed:=await request(app.command_tools._command(true))
		checks.deployment=deployed.get("deploy",{}).get("formation",0)>0
		details.deployment=deployed
	var bridge:=await request({"c":"bridgePlan","from":w.start_tile,"to":w.start_tile,"cls":"timber","commit":false})
	checks.bridge_error_feedback=bridge.get("error")!=null and bridge.get("t")=="bridgePlan"
	details.bridge=bridge
	var bridge_attempts:=0
	for tile in w.grid.n:
		if w.known[tile]==0 or not w.is_river(tile): continue
		for dir in 3:
			var a:=w.grid.nb[tile*6+dir]; var b:=w.grid.nb[tile*6+(dir+3)%6]
			if w.known[a]==0 or w.known[b]==0 or w.tile_owner[a]!=w.civ_id or w.tile_owner[b]!=w.civ_id or w.is_river(a) or w.is_river(b): continue
			bridge_attempts+=1
			bridge=await request({"c":"bridgePlan","from":a,"to":b,"cls":"timber","commit":false})
			if bridge.get("plan",{}).get("buildable",false):
				var built:=await request({"c":"bridgePlan","from":a,"to":b,"cls":"timber","commit":true})
				checks.bridge_commit=built.get("error")==null and built.has("started")
				details.bridge=built
				break
		if checks.has("bridge_commit") or bridge_attempts>=12: break
	details.bridge_fixture_available=checks.has("bridge_commit")
	if w.world_seed==4:
		checks.bridge_fixture=checks.has("bridge_commit")
	if checks.get("bridge_commit",false):
		var until:=Time.get_ticks_msec()+30000
		while Time.get_ticks_msec()<until and app.infra.bridge_count()==0: await app.get_tree().process_frame
		checks.bridge_rendered=app.infra.bridge_count()>0
	app.command_tools.cancel()
	app.command_panel.panel.visible=false
	app.workspace._refresh()
	await request({"c":"pause","on":true})
	if DisplayServer.get_name()!="headless" and not hub.is_empty():
		await _audit_city_ground(int(hub.t),directory)
	if not hub.is_empty():
		await _audit_reload(int(hub.t),directory)
		if DisplayServer.get_name()!="headless": await _audit_city_ground(int(hub.t),directory,"city_center_ground_after_reload")
	if app.args.has("validation-session-out"):
		var session_file:=FileAccess.open(str(app.args["validation-session-out"]),FileAccess.WRITE)
		session_file.store_string(JSON.stringify(app.net.session)); session_file.close()
	print("LWE validation: lenses and screenshots")
	for mode in [1,2,3,0]:
		app.strategic.mode=mode; app.strategic._dirty=true
		for frame in 120: await app.get_tree().process_frame
	checks.graph=app.composition.registry.errors.is_empty() and app.composition.graph.nodes.size()>0
	if DisplayServer.get_name()!="headless":
		for shot in [["district",9.0],["settlement",22.0],["strategic",120.0],["seam",28.0]]:
			app.cam.size=float(shot[1]); app.cam.goal_size=float(shot[1])
			if shot[0]=="seam": app.cam.focus.x=.5
			for frame in 30: await app.get_tree().process_frame
			app.get_viewport().get_texture().get_image().save_png(directory+"/"+shot[0]+".png")
	var out:={"checks":checks,"details":details,"composition":app.composition.stats(),"civilian_agents":app.civilians.drawn,
		"view":{"seed":w.world_seed,"tile":int(details.get("build",{}).get("built",{}).get("tile",w.start_tile)),"server_time":w.server_time,"camera_size":22,"pixels":[1280,900]}}
	var file:=FileAccess.open(directory+"/validation.json",FileAccess.WRITE)
	file.store_string(JSON.stringify(out,"  ")); file.close()
	print("LWE_LIVE ",JSON.stringify(checks))
	app.get_tree().quit(0 if not checks.values().has(false) else 1)


func _audit_city_ground(tile:int,directory:String,key:="city_center_ground") -> void:
	print("LWE validation: city-center ground and close zoom")
	var after_pause:int=app.world.snapshot_count+2
	while app.world.snapshot_count<after_pause or not app.terrain.dirty.is_empty(): await app.get_tree().process_frame
	var failures:=[]; var samples:=0
	var camera_processing:bool=app.cam.is_processing()
	app.cam.set_process(false)
	var trees_hidden:bool=app.environment.hide_trees
	app.environment.hide_trees=true
	var hidden:Array=[app.settlements,app.infra,app.military,app.combat,app.civilians,app.environment.clouds,app.environment.rain,app.input.marker,app.hud.root,app.command_panel.panel]
	for props in app.environment.props.values(): hidden.append_array([props.trees,props.rocks,props.canopy])
	var visibility:=[]
	for node in hidden: visibility.append(node.visible); node.visible=false
	app.cam.focus_tile(tile,34)
	var city_tiles:={tile:true}
	for radius in 3:
		for current in city_tiles.keys():
			for dir in 6:
				var neighbor:int=app.world.grid.nb[int(current)*6+dir]
				if neighbor>=0 and app.world.known[neighbor]: city_tiles[neighbor]=true
	for zoom in [34.0,16.0,9.0,7.0,9.0,7.0]:
		app.cam.goal_size=zoom
		app.cam.anchor_screen=app.get_viewport().get_visible_rect().size*Vector2(.52,.48)
		for frame in 12:
			app.cam._process(1.0/60.0)
			await app.get_tree().process_frame
			await RenderingServer.frame_post_draw
			var image:Image=app.get_viewport().get_texture().get_image()
			# Sample the rendered centers of known city hexes. A height-field ray can enter the
			# vertical frontier of a known tile from unexplored space without hitting its top mesh.
			for current in city_tiles:
				var t:=int(current)
				var center:Vector2=app.world.grid.center(t)
				var point:Vector2=app.cam.to_screen(Vector3(app.world.grid.near_x(center.x,app.cam.focus.x),app.world.tile_height(t),center.y))
				if not Rect2(Vector2(4,4),Vector2(image.get_size())-Vector2(8,8)).has_point(point): continue
				var color:=image.get_pixelv(Vector2i(point)); samples+=1
				if color.r<.18 and color.g<.18 and color.b<.18:
					var chunk:int=app.world._chunk_of(t)
					var record:Dictionary=app.terrain.chunks.get(chunk,{})
					var mesh:Mesh=record.get("terrain")
					var present:bool=mesh!=null and mesh.surface_get_arrays(0)[Mesh.ARRAY_TEX_UV2].has(Vector2(t%app.world.grid.w,t/app.world.grid.w))
					failures.append({"tile":t,"zoom":app.cam.size,"pixel":point,"color":color,"chunk":chunk,"dirty":app.terrain.dirty.has(chunk),"mesh_contains_tile":present,"focus":app.cam.focus})
			if not failures.is_empty(): image.save_png(directory+"/city-ground-hole.png"); break
		if not failures.is_empty(): break
	if failures.is_empty(): app.get_viewport().get_texture().get_image().save_png(directory+"/"+key+".png")
	for index in hidden.size(): hidden[index].visible=visibility[index]
	app.environment.hide_trees=trees_hidden
	app.cam.set_process(camera_processing)
	checks[key]=failures.is_empty() and samples>0
	details[key]={"samples":samples,"failures":failures}
	print("LWE city ground ",key," ",JSON.stringify(details[key]))


func _audit_reload(tile:int,directory:String) -> void:
	print("LWE validation: reload terrain and visibility")
	var before_geo:PackedByteArray=app.world.geo.duplicate()
	var before_known:PackedByteArray=app.world.known.duplicate()
	var before_vis:PackedByteArray=app.world.vis_bits.duplicate()
	var before:Image
	if DisplayServer.get_name()!="headless": before=await _ground_image(tile)
	var connections:int=app.net.connections
	var epoch:int=app.world.world_epoch
	app.net.close()
	while app.net.state!="closed": await app.get_tree().process_frame
	app.net.connect_to(app.net.url)
	var until:=Time.get_ticks_msec()+15000
	while Time.get_ticks_msec()<until:
		if app.world.world_epoch>epoch and app.world.known==before_known and app.world.geo==before_geo and app.terrain.dirty.is_empty(): break
		await app.get_tree().process_frame
	checks.reload_geometry=app.world.world_epoch>epoch and app.net.connections>connections and app.world.known==before_known and app.world.geo==before_geo
	checks.reload_visibility=app.world.vis_bits==before_vis
	if before!=null:
		var after:Image=await _ground_image(tile)
		var failures:=[]; var samples:=0
		for current in app.world.grid.n:
			if app.world.known[current]==0 or app.world.is_sea(current) or app.world.is_lake(current): continue
			var center:Vector2=app.world.grid.center(current)
			var point:Vector2=app.cam.to_screen(Vector3(app.world.grid.near_x(center.x,app.cam.focus.x),app.world.tile_height(current),center.y))
			if not Rect2(Vector2(5,5),Vector2(after.get_size())-Vector2(10,10)).has_point(point): continue
			var a:=before.get_pixelv(Vector2i(point)); var b:=after.get_pixelv(Vector2i(point)); samples+=1
			if maxf(absf(a.r-b.r),maxf(absf(a.g-b.g),absf(a.b-b.b)))>.09:
				failures.append({"tile":current,"before":a,"after":b,"pixel":point})
		before.save_png(directory+"/reload-before.png"); after.save_png(directory+"/reload-after.png")
		checks.reload_rendering=samples>0 and failures.is_empty()
		details.reload_rendering={"samples":samples,"failures":failures}


func _ground_image(tile:int) -> Image:
	var processing:bool=app.cam.is_processing(); app.cam.set_process(false)
	var trees_hidden:bool=app.environment.hide_trees; app.environment.hide_trees=true
	var hidden:Array=[app.settlements,app.infra,app.military,app.combat,app.civilians,app.environment.clouds,app.environment.rain,app.input.marker,app.hud.root,app.command_panel.panel]
	var visibility:=[]
	for node in hidden: visibility.append(node.visible); node.visible=false
	app.cam.focus_tile(tile,9)
	for frame in 3: await app.get_tree().process_frame
	await RenderingServer.frame_post_draw
	var image:Image=app.get_viewport().get_texture().get_image()
	for index in hidden.size(): hidden[index].visible=visibility[index]
	app.environment.hide_trees=trees_hidden; app.cam.set_process(processing)
	return image
