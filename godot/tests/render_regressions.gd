extends SceneTree
## A2 regressions: run with godot --headless --path godot -s res://tests/render_regressions.gd.

var failures: Array[String] = []
var checks := 0


func _initialize() -> void:
	call_deferred("_run")


func check(ok: bool, message: String) -> void:
	checks += 1
	if not ok:
		failures.append(message)
		push_error(message)


func _world() -> WorldState:
	var w := WorldState.new()
	w.apply_welcome({"defs": {"W": 32, "H": 16, "UNITS": {"militia": {"cat": "infantry"}}}, "world": {"wrap": true}})
	return w


func _run() -> void:
	for name_ in ["steel","canvas","bark","paving","ballast"]:
		var material:=MaterialLibrary.get_mat(name_) as ShaderMaterial
		check(material.get_shader_parameter("albedo_map")!=null,"missing baked material for "+name_)
	var civilians:=CivilianActivitySystem.new()
	var stance:=civilians._person(false); var step:=civilians._person(true)
	check(stance.get_surface_count()>0 and step.get_surface_count()>0 and stance.surface_get_arrays(0)[Mesh.ARRAY_VERTEX]!=step.surface_get_arrays(0)[Mesh.ARRAY_VERTEX],"walking poses must contain distinct geometry")
	civilians.free()
	var w := _world()
	root.add_child(w)
	var landscape:=EnvironmentRenderer.new(); landscape.world=w
	var road_tile:=100; var road_center:=w.grid.center(road_tile)
	w.road[road_tile]=1
	check(landscape._road_clearance(road_tile,road_center)<0.0,"trees were not cleared at the road center")
	check(landscape._road_clearance(road_tile,road_center+Vector2(0,.8))>.09,"road clearing removed distant forest")
	landscape._on_tiles(PackedInt32Array(),PackedInt32Array([road_tile]))
	check(landscape.props_dirty.has(w._chunk_of(road_tile)),"new roads did not invalidate forest decoration")
	w.road[road_tile]=0; landscape.free()
	var cam := CameraController.new()
	root.add_child(cam)
	cam.setup(w)
	cam.set_process(false)
	cam.input_enabled = false
	cam.focus = Vector3(20, 0, 12)
	var sound:=AudioDirector.new(); root.add_child(sound); sound.setup(w,cam); sound.set_process(false)
	w.ready_=true; w.known[100]=1; w.geo[100*6+1]=4
	var audio_tile:=w.grid.center(100); cam.focus=Vector3(audio_tile.x,0,audio_tile.y); cam.size=10
	sound._process(.5)
	var country:Dictionary=sound.beds.countryside
	check(float(country.gain)>0.0 and (country.player as AudioStreamPlayer).playing,"known forest did not produce outdoor ambience")
	# A town is heard only while it is in sight; a remembered (out-of-sight) record stays silent.
	w.buildings[9001]={"id":9001,"ty":"house","t":100,"o":w.civ_id+1,"d":1,"lv":2,"mem":1}
	sound._scan()
	check(float(sound.beds.city.target)==0.0,"a remembered building produced town ambience")
	w.buildings[9001].erase("mem"); w.vis_bits.fill(255)
	sound._scan()
	check(float(sound.beds.city.target)>0.0,"a visible town produced no town ambience")
	w.buildings.erase(9001); w.vis_bits.fill(0)
	w.known[100]=0
	sound._process(8.0)
	check(float(country.gain)<.002 and not (country.player as AudioStreamPlayer).playing,"unknown ground continued producing outdoor ambience")
	sound.stop(); sound.queue_free(); w.ready_=false; w.geo[100*6+1]=0
	cam.focus = Vector3(20, 0, 12)
	cam.size=34.0
	cam._pan_step(Vector2.RIGHT,1.0/60.0)
	check(cam.pan_velocity.x>0.0 and cam.pan_velocity.x<cam.size*CameraController.PAN_SPEED,"keyboard pan must accelerate smoothly")
	cam.focus=Vector3.ZERO; cam.pan_velocity=Vector2.ZERO
	for i in 60: cam._pan_step(Vector2.RIGHT,1.0/60.0)
	var travel_60:=cam.focus.x
	cam.focus=Vector3.ZERO; cam.pan_velocity=Vector2.ZERO
	for i in 30: cam._pan_step(Vector2.RIGHT,1.0/30.0)
	check(absf(cam.focus.x-travel_60)<0.001,"keyboard pan varies with frame rate")
	var before_release:=cam.pan_velocity.x
	cam._pan_step(Vector2.ZERO,1.0/60.0)
	check(cam.pan_velocity.x>0.0 and cam.pan_velocity.x<before_release,"keyboard pan must decelerate smoothly")
	cam.focus = Vector3(20, 0, 12); cam.pan_velocity=Vector2.ZERO
	var ratios: Array[float] = []
	for zoom in [7.0, 16.0, 34.0, 80.0, 220.0]:
		cam.size = zoom
		cam._apply()
		var centre := cam.to_screen(cam.focus)
		var dx := cam.to_screen(cam.focus + Vector3.RIGHT).distance_to(centre)
		var dz := cam.to_screen(cam.focus + Vector3.BACK).distance_to(centre)
		ratios.append(dz / dx)
	for ratio in ratios:
		check(absf(ratio - ratios[0]) < 0.001, "zoom must preserve the ground's projected proportions")
	cam.size = 7.0
	cam.goal_size = 12.0
	cam._apply()
	cam.anchor_screen = cam.get_viewport().get_visible_rect().size * 0.5 + Vector2(50, 10)
	var anchor_before := cam.ground_at(cam.anchor_screen)
	cam._process(1.0 / 60.0)
	check(cam.ground_at(cam.anchor_screen).distance_to(anchor_before) < 0.01, "fixed-pitch zoom must stay anchored under the cursor")
	var settlements := SettlementRenderer.new()
	root.add_child(settlements)
	settlements.setup(w, cam)
	var b := {"id": 1, "ty": "house", "o": 0, "t": 100, "d": 0, "st": "building", "p": 10, "hp": 100, "a": 0, "f": 0}
	var structure := settlements._structure_signature([b])
	var progress := settlements._progress_signature([b])
	b.p = 60
	b.a = 1
	b.f = 1
	check(structure == settlements._structure_signature([b]), "progress/fire/activity must not invalidate district structure")
	check(progress != settlements._progress_signature([b]), "progress visuals must invalidate independently")
	b.d = 1
	check(structure != settlements._structure_signature([b]), "completion must rebuild district structure")
	w.buildings = {1: b}
	w.buildings_version += 1
	settlements.update(0.016)
	while settlements.is_building():
		settlements.update(0.016)
	var rebuilt := settlements.rebuilt
	b.a = 0
	b.f = 0
	w.buildings_version += 1
	settlements.update(0.016)
	while settlements.is_building():
		settlements.update(0.016)
	check(settlements.rebuilt == rebuilt, "activity update rebuilt a completed building")
	check(settlements.building_at(100) == 1, "queued building remains selectable by hex")
	var completed:=[false]
	settlements.composition.scheduler.enqueue("district:rapid-test",1,GenerationScheduler.Priority.CRITICAL,func():return true,func():completed[0]=true)
	for frame in 12:
		w.buildings_version+=1
		settlements.update(.016)
	check(completed[0],"frequent economy snapshots starved queued district generation")
	var old_node:MeshInstance3D=settlements.districts["1"].node
	var old_mesh:=old_node.mesh
	var parcel:=settlements.parcel_transform(b)
	var other:=b.duplicate(true); other.id=2; other.t=101
	w.buildings[2]=other; w.buildings_version+=1
	settlements.update(.016,false)
	check(not old_node.is_queued_for_deletion() and old_node.visible and old_node.mesh==old_mesh,"district merge removed old buildings before replacements were ready")
	check(not (settlements.districts["1,2"].node as Node3D).visible,"partial replacement rendered over old buildings")
	while settlements.is_building(): settlements.update(.016)
	check(old_node.is_queued_for_deletion() and settlements.retiring.is_empty(),"finished district failed to retire its old batch")
	check((settlements.districts["1,2"].node as MeshInstance3D).visible and (settlements.districts["1,2"].node as MeshInstance3D).mesh!=null,"atomic district handoff left buildings hidden")
	check(settlements.parcel_transform(b)==parcel,"district merge changed existing parcel position/heading")
	check(settlements.parcel_transform(other)!=parcel,"different buildings share identical parcel variation")
	other.lv=3; other.hp=40; other.o=1
	check(settlements.parcel_transform(other).origin.length()<.07,"parcel variation escapes its authorized footprint")
	check(settlements.parcel_transform(b)==parcel,"neighbor upgrade or ownership change moved an existing building")
	cam.size=80.0; cam.focus.x=w.grid.center(100).x+w.grid.period*.5; cam._apply()
	settlements.update(.016,false)
	var copies:Array=settlements.districts["1,2"].get("copies",[])
	check(copies.any(func(pair):return (pair[0] as Node3D).visible),"wide seam view omitted the adjacent wrapped building image")
	check(copies.all(func(pair):return (pair[0] as MeshInstance3D).mesh==(settlements.districts["1,2"].node as MeshInstance3D).mesh),"wrapped buildings failed to share the stable district mesh")
	# Long games decode large snapshots every frame: building updates may be postponed, never stopped.
	w.buildings_version+=1
	for frame in 6: settlements.update(.016,false)
	check(settlements.version==w.buildings_version,"busy network frames starved building updates indefinitely")

	# Two positions across the cylinder seam must interpolate by the short path.
	w.snaps = [{"t": 0.0, "pos": {1: Vector3(127, -1, 0)}}, {"t": 1.0, "pos": {1: Vector3(96, -1, 0)}}]
	w.render_time = 0.5
	w.prepare_unit_frame()
	var p := w.unit_position(1)
	var a := w.grid.center(127)
	var z := w.grid.center(96)
	check(absf(w.grid.dx_wrap(a.x, p.x) - w.grid.dx_wrap(a.x, z.x) * 0.5) < 0.001, "interpolation took the long path across the seam")
	check(w.unit_position(1) == p, "cached bracket changed within one frame")
	w.units[1]={"id":1,"tile":127}; cam.follow_id=1
	cam.focus.x=p.x+w.grid.period-.5; cam.focus.z=p.y
	var follow_before:=absf(w.grid.dx_wrap(cam.focus.x,p.x))
	cam._follow_step(.2)
	check(absf(w.grid.dx_wrap(cam.focus.x,p.x))<follow_before,"follow camera did not take the short path across the seam")
	w.units.erase(1); cam._follow_step(.1)
	check(cam.follow_id<0,"follow camera retained a removed unit")
	w.render_time = 0.75
	check(w.unit_position(1) != p, "cached bracket did not follow render clock")

	var military := MilitaryRenderer.new()
	root.add_child(military)
	military.setup(w, cam)
	for id in 205:
		w.units[id] = {"id": id, "type": "militia", "owner": 0, "tile": 100, "next": -1, "prog": 0, "flags": 0}
		w.snaps[-1].pos[id] = Vector3(100, -1, 0)
	w._interp_time = -INF
	military.selected[2] = true
	military.update(0.016)
	check(military.batched and military.batches.size() == 1, "205 identical models must use one batch")
	check(military.draw_positions.size() == 205, "batching lost selectable positions")
	check(military.ring_batch.multimesh.visible_instance_count == 1, "batched selection ring missing")
	var mm: MultiMesh = military.batches.values()[0].multimesh
	military.update(0.016)
	check(military.batches.values()[0].multimesh == mm, "batch buffer should be reused between frames")
	w.units.erase(2)
	military.update(0.016)
	check(not military.selected.has(2), "removed batched unit stayed selected")
	for id in range(10, 205):
		w.units.erase(id)
	military.update(0.016)
	check(not military.batched and military.nodes.size() == 9, "small populations must return to individual models")
	var ground_before := military._ground_for(1, w.grid.center(100))
	w.known[100] = 1
	w.height[100] = 2.0
	w.geo_version += 1
	check(military._ground_for(1, w.grid.center(100)) > ground_before, "terrain changes must invalidate stationary unit height cache")
	var mask := PackedByteArray()
	mask.resize(32)
	mask[0] = 1
	var geo_data := PackedByteArray([180, 2, 0, 0, 0, 0])
	w.apply_geo({"chunks": [[0, 0, Marshalls.raw_to_base64(mask), Marshalls.raw_to_base64(geo_data)]]})
	check(is_equal_approx(w.height[0], w._tile_height(0)), "delta geometry must update its changed hex's height")
	check(w.height[100] == 2.0, "one-hex geometry delta must not rebuild all other heights")

	# Chunk arrays span frames and a geo update during generation must survive the commit.
	var terrain := WorldRenderer.new()
	root.add_child(terrain)
	terrain.setup(w)
	terrain._on_welcome()
	w.known.fill(1)
	for tile in w.grid.n:
		w.geo[tile * 6] = 2
	terrain._on_geo(PackedInt32Array([0]))
	terrain._begin_chunk(0)
	terrain._on_geo(PackedInt32Array([0]))
	check(int(terrain.build_job.revision) != int(terrain.dirty[0]), "geo arriving mid-build must mark a new revision")
	var slices := 0
	while not terrain.dirty.is_empty() and slices < 100:
		terrain._build_some()
		slices += 1
	check(terrain.dirty.is_empty() and terrain.build_job.is_empty(), "incremental chunk build did not drain")
	check(terrain.chunks_built == 2, "update received mid-build was discarded")
	var mesh: ArrayMesh = terrain.chunks[0].terrain
	check(mesh.surface_get_arrays(0)[Mesh.ARRAY_VERTEX].size() == 16 * 16 * 18, "incremental terrain lost vertices")
	var environment := EnvironmentRenderer.new()
	root.add_child(environment)
	environment.setup(w, cam, terrain)
	environment._on_geo(PackedInt32Array([0]))
	cam.size = 80
	environment.update(0.016)
	check(not environment.props[0].trees.visible and environment.props[0].canopy.visible, "far zoom must select canopy LOD")
	cam.size = 130
	environment.update(0.016)
	check(not environment.sun.shadow_enabled, "strategic zoom must disable sun shadows")
	cam.size = 20
	environment.update(0.016)
	check(environment.props[0].trees.visible and environment.sun.shadow_enabled, "near zoom must restore trees and shadows")
	environment.set_shadows_enabled(false)
	environment.update(0.016)
	check(not environment.sun.shadow_enabled, "low quality/debug shadow disable must survive zoom updates")
	var decode := NetworkClient.DecodeJob.new()
	decode.source = JSON.stringify({"t": "s", "units": Array(range(10000)), "time": 12.5})
	var task := WorkerThreadPool.add_task(decode.run)
	while not WorkerThreadPool.is_task_completed(task):
		await process_frame
	WorkerThreadPool.wait_for_task_completion(task)
	check(decode.value.time == 12.5 and decode.value.units.size() == 10000, "worker JSON decode changed snapshot data")
	check(decode.source.is_empty(), "worker should release its raw JSON after decoding")
	print("RENDER_TESTS ", JSON.stringify({"checks": checks, "failures": failures}))
	quit(0 if failures.is_empty() else 1)
