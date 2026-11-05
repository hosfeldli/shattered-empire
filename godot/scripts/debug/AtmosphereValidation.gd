class_name AtmosphereValidation
extends RefCounted
## Actual server terrain and water, followed by an explicitly labelled visual weather fixture.
class PresentationClock extends Node:
	var world:WorldState
	func _process(_dt:float) -> void:
		world.play_rate=1.0; world.paused=false
var app:Node
var checks:={}
var timings:Array[float]=[]
func request(command:Dictionary) -> Dictionary:
	var reply:=LiveValidation.Reply.new(); app.net.cmd(command,func(record):reply.received.emit(record)); return await reply.received
func frames(count:int,force_clock:=false) -> void:
	for frame in count:
		if force_clock: app.world.play_rate=1; app.world.paused=false
		if frame%60==0: print("ATMOSPHERE frames ",frame,"/",count)
		var before:=Time.get_ticks_usec()
		await app.get_tree().process_frame
		timings.append(float(Time.get_ticks_usec()-before)/1000.0)
func shot(directory:String,title:String) -> void:
	await RenderingServer.frame_post_draw
	app.get_viewport().get_texture().get_image().save_png(directory+"/"+title+".png")
func run(game:Node,directory:String) -> void:
	app=game; DirAccess.make_dir_recursive_absolute(directory)
	while app.world.snapshot_count<8: await app.get_tree().process_frame
	print("ATMOSPHERE received world")
	await request({"c":"speed","speed":0})
	var deadline:=Time.get_ticks_msec()+12000
	while not app.terrain.dirty.is_empty() and Time.get_ticks_msec()<deadline: await app.get_tree().process_frame
	checks.terrain_ready=app.terrain.dirty.is_empty()
	print("ATMOSPHERE terrain pending ",app.terrain.dirty.size())
	# Apply after network snapshots and before world rendering. A paused observer packet must not
	# unpredictably stop the visual test clock halfway through a capture.
	var clock_driver:=PresentationClock.new(); clock_driver.world=app.world; clock_driver.process_priority=-50; app.add_child(clock_driver)
	app.cam.set_process(false); app.cam.set_process_input(false); app.cam.set_process_unhandled_input(false)
	app.input.set_process(false); app.input.set_process_input(false); app.input.set_process_unhandled_input(false)
	app.shell.set_process_input(false)
	app.shell.world_hidden=true; app.command_dock.panel.hide()
	var world:WorldState=app.world
	var river:=-1; var score:=-INF; var coast:=-1
	for tile in world.grid.n:
		if not world.known[tile]: continue
		if world.is_river(tile) and world.flow_dir(tile)>=0:
			var next:=world.grid.nb[tile*6+world.flow_dir(tile)]
			if next>=0 and world.known[next]:
				var value:=float(world.flow_bucket(tile))*2.0-absf(world.height[tile]-world.height[next])*5.0
				if value>score: score=value; river=tile
		if coast<0 and world.is_sea(tile):
			for direction in 6:
				var neighbor:=world.grid.nb[tile*6+direction]
				if neighbor>=0 and world.known[neighbor] and not world.is_sea(neighbor): coast=tile; break
	checks.real_river=river>=0; checks.real_coast=coast>=0
	if river>=0:
		app.cam.focus_tile(river,6); await frames(120,true); await shot(directory,"river-close")
	if coast>=0:
		app.cam.focus_tile(coast,7); await frames(90,true); await shot(directory,"coast-before")
		var first:float=app.environment.water.micro.clock if app.environment.water.micro.supported else app.environment.water.simulation.clock
		await frames(90,true); await shot(directory,"coast-after")
		checks.surface_changes=first!=(app.environment.water.micro.clock if app.environment.water.micro.supported else app.environment.water.simulation.clock)
	await request({"c":"speed","speed":0})
	var fixture:Dictionary=world.wx.duplicate(true)
	var count:=int(fixture.get("cw",0))*int(fixture.get("ch",0)); var cloud:=PackedByteArray(); cloud.resize(count)
	for index in count:
		var x:=index%int(fixture.get("cw",1)); var y:=index/int(fixture.get("cw",1))
		cloud[index]=int(130+90*sin(float(x)*.7)*cos(float(y)*.9))
	var rain:=PackedByteArray(); rain.resize(count); rain.fill(100)
	fixture.cloud=Marshalls.raw_to_base64(cloud); fixture.rain=Marshalls.raw_to_base64(rain); fixture.wind=[.4,.85]
	app.composition.weather.apply(fixture); app.environment._on_weather(fixture)
	app.cam.size=20; app.cam.goal_size=20
	app.cam._apply()
	await frames(120,true); await shot(directory,"cloud-and-rain-fixture")
	app.cam.size=7; app.cam.goal_size=7
	app.cam._apply()
	await frames(120,true); await shot(directory,"rain-on-water-fixture")
	checks.fixed_step_bounded=app.environment.water.simulation.height.size()<=64*64
	checks.finite_surface=Array(app.environment.water.simulation.height).all(func(value):return is_finite(value) and absf(value)<=.075)
	checks.active_fluid=app.environment.water.micro.steps>0 or app.environment.water.simulation.steps>0
	if app.environment.water.micro.supported:
		var image:Image=app.environment.water.micro.texture.get_image()
		checks.micro_gpu_texture=image!=null and not image.is_empty() and image.get_width()==256
		if checks.micro_gpu_texture:
			var values:=image.get_data().to_float32_array(); var valid:=true; var maximum:=0.0; var wet_cells:=0
			for index in range(0,values.size(),4):
				valid=valid and is_finite(values[index]) and absf(values[index])<=.001501
				maximum=maxf(maximum,absf(values[index])); wet_cells+=1 if values[index+2]>.5 else 0
			checks.finite_surface=valid; checks.gpu_pressure_waves=maximum>0.00000001; checks.gpu_wet_boundary=wet_cells>0
	checks.shared_clouds=app.terrain.terrain_mat.get_shader_parameter("cloud_tex")==app.environment.cloud_mat.get_shader_parameter("cloud_tex")
	var timings_sorted:=timings.duplicate(); timings_sorted.sort()
	var result:={"checks":checks,"river_tile":river,"coast_tile":coast,"weather_fixture":"Last two images use controlled local cloud/rain values over actual server terrain; no server state is changed.","surface_resolution":WaterMicroSimulation.RESOLUTION if app.environment.water.micro.supported else app.environment.water.simulation.resolution,"solver_steps":app.environment.water.micro.steps if app.environment.water.micro.supported else app.environment.water.simulation.steps,"solver_max_step_us":app.environment.water.simulation.max_step_us,"frame_p95_ms":timings_sorted[int(timings_sorted.size()*.95)],"rendered":DisplayServer.get_name()!="headless"}
	var file:=FileAccess.open(directory+"/water-validation.json",FileAccess.WRITE); file.store_string(JSON.stringify(result,"  ")); file.close()
	print("ATMOSPHERE ",JSON.stringify(result)); app.get_tree().quit(1 if checks.values().has(false) else 0)
