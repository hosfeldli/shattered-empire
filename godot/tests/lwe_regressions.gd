extends SceneTree

class FakeNetwork extends NetworkClient:
	var requests: Array = []
	func cmd(command: Dictionary, cb: Callable = Callable()) -> int:
		requests.append({"command":command,"cb":cb})
		return requests.size()

var checks := 0
var failures: Array[String] = []


func _initialize() -> void: call_deferred("_run")


func check(ok: bool, reason: String) -> void:
	checks += 1
	if not ok: failures.append(reason); push_error(reason)


func _run() -> void:
	for variant in 3:
		var surfaces := AssetLibrary.residential(variant)
		check(not surfaces.is_empty(), "authored residential asset missing")
		var materials := {}
		for surface in surfaces: materials[surface.material]=true
		check(materials.has("glass") and materials.has("stone") and materials.has("timber"), "authored detail material slots missing")
		var intact := MeshKit.new(); intact.component(surfaces,Transform3D.IDENTITY)
		var damaged := MeshKit.new(); damaged.component(surfaces,Transform3D.IDENTITY,Color.WHITE,.6)
		var mesh := intact.commit(); var ruin := damaged.commit()
		var full_count := 0; var damaged_count := 0
		for s in mesh.get_surface_count():
			var arrays := mesh.surface_get_arrays(s)
			var vertices: PackedVector3Array=arrays[Mesh.ARRAY_VERTEX]
			full_count+=vertices.size()
			check(vertices.size()%3==0 and arrays[Mesh.ARRAY_NORMAL].size()==vertices.size() and arrays[Mesh.ARRAY_TEX_UV].size()==vertices.size(), "component flatten lost complete triangles, normals or UVs")
		for s in ruin.get_surface_count(): damaged_count+=ruin.surface_get_arrays(s)[Mesh.ARRAY_VERTEX].size()
		check(damaged_count<full_count, "damage failed to remove authored upper geometry")
		check(mesh.get_aabb().size.y>.3 and mesh.get_aabb().size.x<.7, "authored model scale or glTF axes incorrect")
	var world:=WorldState.new(); root.add_child(world)
	world.apply_welcome({"seed":7,"defs":{"W":32,"H":16},"world":{"wrap":true}})
	world.known.fill(1)
	var composition:=WorldCompositionSystem.new(); composition.setup(world)
	world.cities={10:{"id":10,"t":100,"o":0,"pop":100,"st":90,"dmg":0}}
	world.buildings={1:{"id":1,"t":100,"ty":"house","o":0,"c":10,"d":1,"hp":100,"a":1}}
	world.buildings_version+=1; composition.sync()
	world.cities.clear(); world.buildings_version+=1; composition.sync()
	check(not composition.graph.edges["building:1"].has("belongs_to_city"), "removed settlement left a dangling city relationship")
	world.cities={10:{"id":10,"t":100,"o":0,"pop":100}}
	world.buildings_version+=1; composition.sync()
	check(composition.graph.edges["building:1"].belongs_to_city.has("city:10"), "reappearing settlement failed to restore membership")
	world.econ={"formations":[{"id":4,"units":[9],"line":[100,101]}]}
	world.units={9:{"id":9,"tile":100,"owner":0,"type":"rifle","hp":80,"formation":4}}
	composition.graph.sync_actors()
	check(composition.graph.edges["unit:9"].part_of_formation.has("formation:4"), "authoritative formation membership missing")
	world.econ.formations=[]; world.units.clear(); composition.graph.sync_actors()
	check(not composition.graph.nodes.has("unit:9") and not composition.graph.nodes.has("formation:4"), "lost visibility retained actor data")
	world.bf={"i":[[100,2],[101,3],[400,1]]}; world.bf_version+=1; composition.graph.sync_actors()
	check(composition.graph.nodes.has("battle:100") and composition.graph.nodes["battle:100"].data.tiles.size()==2, "adjacent battlefield intensity failed to form a continuous region")
	composition.weather.apply({"cw":4,"ch":2,"cell":8,"rain":Marshalls.raw_to_base64(PackedByteArray([255,0,0,0,0,0,0,0])),"wet":Marshalls.raw_to_base64(PackedByteArray([128,0,0,0,0,0,0,0])),"wind":[0,1]})
	check(composition.weather.at_tile(0).rain==1.0 and composition.weather.at_tile(8).rain==0.0, "weather regional sampling wrong")
	check(composition.weather.wind==Vector2.RIGHT, "shared wind direction wrong")
	var lod:=LODManager.new()
	check(lod.budget("pedestrians",150)==0 and lod.budget("pedestrians",10)>0, "strategic civilian detail exceeds budget")
	lod.set_quality("low"); check(lod.budget("pedestrians",10)==24, "low preset activity budget wrong")
	var pose:=MilitaryPresentationState.pose({"air":[0],"supp":90},false,{"air":true,"cat":"air"})
	check(pose.grounded and not pose.flying, "ready aircraft incorrectly airborne")
	pose=MilitaryPresentationState.pose({"supp":90},false,{"cat":"infantry"})
	check(pose.state=="suppressed" and pose.height_scale<.6, "suppressed infantry does not adopt cover posture")
	var camera:=CameraController.new(); root.add_child(camera); camera.setup(world)
	var network:=FakeNetwork.new()
	var military:=MilitaryRenderer.new()
	var tools:=NativeCommandTools.new(); root.add_child(tools); tools.setup(world,network,camera,military)
	tools.activate("build","house")
	var stale:Callable=network.requests[-1].cb
	tools.cancel(); stale.call({"tiles":[100],"afford":true})
	check(tools.valid_tiles.is_empty() and tools.mode=="select", "cancelled placement accepted a stale preview")
	tools.mode="road"; tools.value=2; tools.points=[100,102]
	check(tools._command(false)=={"c":"roadPlan","tiles":[100,102],"type":2,"auto":true,"commit":false}, "native road tool changed the server command contract")
	tools.request_preview()
	var road_reply:Callable=network.requests[-1].cb
	road_reply.call({"plan":{"tiles":[100,101,102],"buildable":1,"segments":[{"a":100,"b":101,"ok":true},{"a":101,"b":102,"ok":false,"reason":"impassable"}]}})
	check(tools.blocked_edges.has("101:102") and tools.status.contains("impassable") and tools.can_commit(),"road preview did not identify its blocked segment")
	tools.commit()
	var rejected:Callable=network.requests[-1].cb
	rejected.call({"error":"project limit reached"})
	check(tools.mode=="road" and tools.points.size()==2 and tools.status.contains("project limit reached") and tools.can_commit(),"rejected road order lost its editable preview")
	tools.mode="trench"; tools.points=[100,102]; tools.preview.clear()
	tools.request_preview()
	var trench_reply:Callable=network.requests[-1].cb
	trench_reply.call({"trench":{"tiles":[100,101,102],"build":2,"invalid":1,"segments":[{"t":100,"ok":true},{"t":101,"ok":false,"reason":"river"},{"t":102,"ok":true}]}})
	check(tools.blocked_tiles.has(101) and tools.status.contains("river") and not tools.can_commit(),"invalid trench is not identified or can still be committed")
	tools.mode="deploy"
	check(tools._command(true).c=="deploy", "native deployment does not use the existing server command")
	# A sloped, river-crossed authoritative parcel must produce dry, level visual sites.
	for tile in world.grid.n: world.geo[tile*6+1]=2
	world.height.fill(.4)
	world.height[100]=1.0
	for dir in 6: world.height[world.grid.nb[100*6+dir]]=.4+dir*.16
	world.geo_version+=1
	world.geometry_revision+=1
	var dry:=composition.sites.plan(100,Vector2.ZERO,.2,Vector2(.25,.2))
	check(dry.valid and dry.max_height>dry.min_height,"sloped site did not sample its footprint")
	check(dry.transform.origin.y>dry.min_height and dry.transform.origin.y<dry.max_height+.001,"building is not seated into its sampled terrain")
	check(dry.transform.origin.y-dry.min_height<=(dry.max_height-dry.min_height)*.25+.01,"building is propped above its slope instead of cut into it")
	var grounder:=SettlementRenderer.new(); grounder.world=world; grounder.site_records[1]=dry
	var support:=MeshKit.new(); support.origin=dry.transform.origin; support.basis=dry.transform.basis
	grounder._site_foundation(support,1)
	var vertices:Array=support.parts.get("stone",[[]])[0]
	check(not vertices.is_empty() and vertices.any(func(v):return absf(v.y-world.ground_height(v.x,v.z))<.025),"sloped foundations do not meet the sampled ground")
	grounder.free()
	for tile in [99,100,101]:
		world.geo[tile*6+3]=1; world.geo[tile*6+5]=1; world.geo[tile*6+4]=3<<4
	world.geo_version+=1
	world.geometry_revision+=1
	var bank:=composition.sites.plan(100,Vector2.ZERO,0,Vector2(.25,.2))
	check(bank.valid and bank.offset.length()>.2,"river building failed to move to a dry bank within its parcel")
	check(bank.valid and composition.sites.clear_of_water(100,bank.corners,.055),"building footprint overlaps the river channel")
	check(bank.valid and bank.corners.all(func(point):return world.grid.tile_at(point.x,point.y)==100),"river setback moved the building outside its authoritative hex")
	check(composition.sites.plan(100,Vector2.ZERO,0,Vector2(.25,.2))==bank,"river-aware placement is not deterministic")
	var old_channels:Array=composition.sites.rivers(100).duplicate(true)
	world.geo[100*6+5]=3; world.geo[100*6+4]=1<<4
	world.geometry_revision+=1
	check(composition.sites.rivers(100)!=old_channels,"flow-only update reused a stale building water setback")
	var center:=world.grid.center(100)
	check(composition.sites.crosses_water(100,center+Vector2(0,-.7),center+Vector2(0,.7)),"district connector would bridge a river without authority")
	world.known.fill(0); world.known[102]=1; world.geo_version+=1; world.geometry_revision+=1
	check(composition.sites.rivers(102).is_empty(),"unknown neighboring rivers leaked into visual siting")
	world.defs["UNITS"]={"test_tank":{"cat":"tracked"},"test_rifle":{"cat":"infantry"}}
	world.units={1:{"id":1,"type":"test_tank","owner":0,"tile":100,"next":-1,"flags":0,"hp":100,"target":2},
		2:{"id":2,"type":"test_rifle","owner":1,"tile":132,"next":-1,"flags":0,"hp":100},
		3:{"id":3,"type":"test_rifle","owner":0,"tile":100,"next":101,"flags":0,"hp":100}}
	var actors:=MilitaryRenderer.new(); root.add_child(actors); actors.setup(world,camera)
	camera.size=10; camera._apply()
	actors.update(.016)
	check(actors.nodes[1].turret!=null and absf(actors.nodes[1].turret.rotation.y-actors.nodes[1].mesh.rotation.y)>.1,"tracked turret does not aim independently at a received target")
	var actor_id:int=actors.nodes[3].node.get_instance_id()
	var first_pose:Mesh=actors.nodes[3].mesh.mesh
	world.render_time=.3; actors.update(.016)
	check(actors.nodes[3].node.get_instance_id()==actor_id and actors.nodes[3].mesh.mesh!=first_pose,"walk animation recreated the unit or failed to change pose")
	world.units[3].supp=90; actors.update(.016)
	check(actors.nodes[3].node.get_instance_id()==actor_id and actors.nodes[3].mesh.scale.y==1.0,"cover pose recreated the unit or was compressed twice")
	check(world.units.size()==3,"military presentation generated extra authoritative units")
	tools.cancel()
	# Reload must remove old knowledge and invalidate height-only caches even before new geo arrives.
	var previous_height_version:=world.geo_version
	world.wx={"cw":4}; world.econ={"formations":[{"id":4}]}; world.paths={"3":[100,101]}
	world.apply_snapshot({"t":"s","reset":1,"time":2,"units":[]})
	check(world.geo_version>previous_height_version and world.known.count(1)==0,"reload retained terrain knowledge or stale sampled-height caches")
	check(world.econ.is_empty() and world.wx.is_empty() and world.paths.is_empty(),"reload retained previous economic, weather or path state")
	check(composition.graph.nodes.is_empty() and composition.weather.wet_texture==null,"reload retained semantic relationships or shared surface weather")
	composition.reset(); network.free(); military.free()
	print("LWE_TESTS ",JSON.stringify({"checks":checks,"failures":failures}))
	quit(0 if failures.is_empty() else 1)
