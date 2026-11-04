extends SceneTree
## Actual GPU regression: terrain must cover known, in-map sample points throughout close zoom,
## viewport changes and the wrapped seam. Run without --headless; writes evidence to --out=DIR.
var failures:=[]
var samples:=0


func _initialize() -> void: call_deferred("_run")


func _run() -> void:
	if DisplayServer.get_name()=="headless":
		print("TERRAIN_ZOOM_VISUAL skipped: requires a rendering display"); quit(); return
	DisplayServer.window_set_title("Shattered Empires — terrain GPU regression (temporary test)")
	var directory:="/tmp/se-terrain-zoom"
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--out="): directory=arg.trim_prefix("--out=")
	DirAccess.make_dir_recursive_absolute(directory)
	var world:=WorldState.new(); root.add_child(world)
	var terrain:=WorldRenderer.new(); root.add_child(terrain); terrain.setup(world)
	world.apply_welcome({"seed":4,"defs":{"W":64,"H":64},"world":{"wrap":true}})
	world.known.fill(1); world.known_mask.fill(255); world.vis_bits.fill(255)
	for tile in world.grid.n:
		world.geo[tile*6+1]=2
		world.height[tile]=.6+.4*sin((tile%64)*.12)*cos((tile/64)*.15)
	var chunks:=PackedInt32Array()
	for chunk in world.chunks_w*world.chunks_h: chunks.append(chunk)
	world.geo_changed.emit(chunks); world.vis_changed.emit(world.vis_bits)
	var camera:=CameraController.new(); root.add_child(camera); camera.setup(world); camera.set_process(false); camera.input_enabled=false
	camera.focus_tile(32*64+32,30)
	var light:=DirectionalLight3D.new(); root.add_child(light); light.rotation_degrees=Vector3(-60,-30,0); light.light_energy=1.2
	var sky:=WorldEnvironment.new(); var environment:=Environment.new()
	environment.background_mode=Environment.BG_COLOR; environment.background_color=Color(.02,.03,.04)
	environment.ambient_light_source=Environment.AMBIENT_SOURCE_COLOR; environment.ambient_light_color=Color.WHITE; environment.ambient_light_energy=.6
	sky.environment=environment; root.add_child(sky)
	while not terrain.dirty.is_empty():
		terrain.update_view(camera.focus.x,camera.view_half_width()); await process_frame
	for aspect in [Vector2i(1024,768),Vector2i(1440,900),Vector2i(700,1000)]:
		root.size=aspect
		for center in [world.grid.period*.5,.3,world.grid.period-.3]:
			camera.focus.x=center
			for zoom in [80.0,34.0,16.0,9.0,7.0,9.0,25.0,65.0,7.0]:
				camera.size=zoom; camera.goal_size=zoom; camera._apply()
				terrain.update_view(camera.focus.x,camera.view_half_width())
				await process_frame; await RenderingServer.frame_post_draw
				var image:=root.get_texture().get_image()
				for x in [0.12,.3,.5,.7,.88]:
					for y in [.15,.35,.5,.65,.85]:
						var pixel:=Vector2(image.get_width()*x,image.get_height()*y)
						var tile:=camera.pick_tile(pixel)
						if tile<0: continue
						var color:=image.get_pixelv(Vector2i(pixel))
						samples+=1
						if color.r<.04 and color.g<.05 and color.b<.06:
							failures.append({"aspect":aspect,"center":center,"zoom":zoom,"pixel":pixel,"tile":tile,"color":color})
				if not failures.is_empty(): image.save_png(directory+"/ground-hole.png"); break
			if not failures.is_empty(): break
		if not failures.is_empty(): break
	# Exercise the real eased camera path while chunks are invalidated in the middle of a zoom.
	if failures.is_empty():
		root.size=Vector2i(1280,900)
		for center in [world.grid.period*.5,.3,world.grid.period-.3]:
			for anchor in [Vector2(.15,.25),Vector2(.85,.75)]:
				camera.focus_tile(32*64+32,65); camera.focus.x=center
				camera.goal_size=7; camera.anchor_screen=Vector2(root.size)*anchor
				for frame in 30:
					camera._process(1.0/60.0)
					if frame==10: world.geo_changed.emit(chunks)
					terrain.update_view(camera.focus.x,camera.view_half_width())
					await process_frame; await RenderingServer.frame_post_draw
					var image:=root.get_texture().get_image()
					for x in [.15,.35,.5,.65,.85]:
						for y in [.15,.35,.5,.65,.85]:
							var pixel:=Vector2(image.get_width()*x,image.get_height()*y)
							var tile:=camera.pick_tile(pixel)
							if tile<0: continue
							var color:=image.get_pixelv(Vector2i(pixel)); samples+=1
							if color.r<.04 and color.g<.05 and color.b<.06:
								failures.append({"eased_frame":frame,"zoom":camera.size,"pixel":pixel,"tile":tile})
					if not failures.is_empty(): image.save_png(directory+"/ground-hole.png"); break
				if not failures.is_empty(): break
			if not failures.is_empty(): break
	var result:={"samples":samples,"failures":failures,"adapter":RenderingServer.get_video_adapter_name()}
	var file:=FileAccess.open(directory+"/terrain-zoom.json",FileAccess.WRITE); file.store_string(JSON.stringify(result,"  ")); file.close()
	print("TERRAIN_ZOOM_VISUAL ",JSON.stringify(result)); quit(0 if failures.is_empty() else 1)
