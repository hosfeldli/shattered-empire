extends SceneTree
var failures:Array=[]
var checks:=0
func check(ok:bool,reason:String) -> void:
	checks+=1
	if not ok: failures.append(reason)
func _initialize() -> void: call_deferred("run")
func run() -> void:
	var world:=WorldState.new(); root.add_child(world)
	world.apply_welcome({"defs":{"W":32,"H":16},"world":{"wrap":true}})
	world.known.fill(1); world.known_mask.fill(255); world.vis_bits.fill(255)
	var land:=ShaderMaterial.new(); var water:=ShaderMaterial.new()
	var fields:=WorldPresentationFields.new(); fields.setup(world,[land,water]); fields.reset()
	var tile:=100; var next:=world.grid.nb[tile*6]
	world.buildings={1:{"id":1,"t":tile,"ty":"farm","o":0,"d":1,"hp":100},2:{"id":2,"t":next,"ty":"farm","o":0,"d":1,"hp":100}}
	world.buildings_version+=1; fields.update_development()
	check(fields.farm_bytes[tile*4]==255,"completed farm missing from surface field")
	check((fields.farm_bytes[tile*4+1]&1)==0,"adjacent same-owner farms retain an internal boundary")
	check((fields.farm_bytes[next*4+1]&(1<<3))==0,"farm continuity is asymmetric")
	world.buildings[2].o=1; world.buildings_version+=1; fields.update_development()
	check((fields.farm_bytes[tile*4+1]&1)!=0,"opposing farms falsely merge across ownership")
	world.buildings.erase(2); world.buildings_version+=1; fields.update_development()
	check(fields.farm_bytes[next*4]==0,"removed farm leaves stale cultivated ground")
	world.vis_bits[tile>>3]&=255^(1<<(tile&7)); fields.update_visibility(world.vis_bits)
	check(fields.visibility_bytes[tile*4+1]==0,"fog field lights an unseen cell")
	check((fields.visibility_bytes[next*4+3]&(1<<3))!=0,"visible neighbor misses the inward fog edge")
	world.known[tile]=0; world.known_mask[tile]=0; fields.update_geography(PackedInt32Array([world._chunk_of(tile)]))
	check(fields.visibility_bytes[tile*4]==0,"unknown terrain is exposed by neighboring visibility")
	world.known.fill(1); world.known_mask.fill(255)
	# A lake's authorized beds differ, but the displayed water surface must not form tile steps.
	for index in [tile,next]: world.geo[index*WorldState.GEO_STRIDE+3]|=2
	world.height[tile]=.12; world.height[next]=.34
	check(is_equal_approx(world.water_level(tile),world.water_level(next)),"connected lake surfaces disagree")
	var shared_corners:=0
	for corner in 6:
		if 0 in HexGrid.CORNER_DIRS[corner]:
			var land_neighbor:=world.grid.nb[tile*6+int(HexGrid.CORNER_DIRS[corner][0])]
			if land_neighbor==next: land_neighbor=world.grid.nb[tile*6+int(HexGrid.CORNER_DIRS[corner][1])]
			world.height[land_neighbor]=5.0
			check(world.corner_height(tile,corner)<world.water_level(tile),"bank height opens a dry seam within a lake")
			shared_corners+=1
	check(shared_corners==2,"lake edge fixture is incomplete")
	var seam_left:=world.grid.w*8; var seam_right:=world.grid.nb[seam_left*6+3]
	for index in [seam_left,seam_right]: world.geo[index*WorldState.GEO_STRIDE+3]|=2
	world.height[seam_left]=.5; world.height[seam_right]=.7; world._lake_levels.clear()
	check(is_equal_approx(world.water_level(seam_left),world.water_level(seam_right)),"lake level splits at the wrapped world seam")
	world.known[seam_right]=0; world._lake_levels.clear()
	check(world.water_level(seam_left)<.7,"unknown terrain changes the authorized lake level")
	var low:=220; world.geo[low*WorldState.GEO_STRIDE]=int((.15+1.0)*127.5)
	world.geo[low*WorldState.GEO_STRIDE+1]=2
	var hill:=221; world.geo[hill*WorldState.GEO_STRIDE]=int((.65+1.0)*127.5); world.geo[hill*WorldState.GEO_STRIDE+1]=9
	check(world._tile_height(hill)-world._tile_height(low)>(world.elevation(hill)-world.elevation(low))*WorldState.LAND_SCALE,"mountain relief did not increase")
	world.defs.TECHS={"base":{"name":"Base","age":0,"cost":60,"req":[]},"industry":{"name":"Industry","age":0,"cost":100,"req":["base"]},"future":{"name":"Future","age":1,"cost":200,"req":["industry"]}}
	world.econ={"age":0,"techs":[],"researchRate":2,"techProgress":{"base":20}}
	var research:=ResearchPresentation.new(world)
	check(research.ready("base") and not research.ready("industry"),"research readiness ignores prerequisites")
	check(research.path("future")==["base","industry","future"],"research path does not preserve prerequisite order")
	check(research.estimate("base")=="~20s","research estimate discards saved progress")
	world.econ.techs=["base","industry"]
	check(not research.ready("future") and research.path("future")==["future"],"future research ignores era gating or repeats completed work")
	check(research.path("base").is_empty(),"completed research remains on the goal path")
	var trench_tile:=world.grid.w*10+12
	world.fw=[[trench_tile,0,1,0,100,100,0,0,9]]
	var anchor:=world.grid.center(trench_tile)
	check(TrenchPresentation.distance_to_route(world.fw[0],world.grid,anchor)<.001,"trench corridor does not clear its own center")
	check(TrenchPresentation.distance_to_route(world.fw[0],world.grid,anchor+Vector2(0,.4))>.3,"trench corridor clears unrelated scenery")
	world.buildings={}
	var plain:=TrenchPresentation.build(world,anchor)
	var defense_tile:=world.grid.nb[trench_tile*6]
	world.buildings={44:{"id":44,"t":defense_tile,"ty":"bunker","o":0,"d":1,"st":"operational"}}
	var joined:=TrenchPresentation.build(world,anchor)
	check(CatalogueValidation.new().vertices(joined.mesh)>CatalogueValidation.new().vertices(plain.mesh),"friendly defenses have no integrated trench access")
	check(joined.mask.get_image().get_pixel(trench_tile%world.grid.w,trench_tile/world.grid.w)==plain.mask.get_image().get_pixel(trench_tile%world.grid.w,trench_tile/world.grid.w),"decorative defense access invents functional trench topology")
	world.buildings[44].o=1
	var foreign:=TrenchPresentation.build(world,anchor)
	check(CatalogueValidation.new().signature(foreign.mesh)==CatalogueValidation.new().signature(plain.mesh),"trenches visually connect to an enemy defense")
	var city:={"id":999,"pop":85,"h":85,"gr":0,"development":{"on":true,"activity":"Old construction message"}}
	check(CityPresentation.work(world,city)=="Housing full · upgrade homes","city hides its growth constraint behind an old activity log")
	city.h=100; city.gr=1
	check(CityPresentation.work(world,city)=="Needs met · growing","city claims old construction is still active")
	print("SURFACE_FIELDS_TESTS ",JSON.stringify({"checks":checks,"failures":failures}))
	quit(0 if failures.is_empty() else 1)
