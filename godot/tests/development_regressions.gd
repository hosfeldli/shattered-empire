extends SceneTree
var failures:Array=[]
var checks:=0
func check(ok:bool,reason:String) -> void:
	checks+=1
	if not ok: failures.append(reason)

func _initialize() -> void:
	call_deferred("run")

func run() -> void:
	var original:=MeshKit.new(); original.set_frame(Vector3(14,.4,9),.35)
	original.box("brick",Vector3.ZERO,Vector3(.4,.8,.4)); original.box("glass",Vector3(0,.4,.202),Vector3(.25,.25,.004))
	var before:=var_to_bytes(original.parts)
	var record:={"id":81,"t":42,"ty":"electronics_plant","hp":100,"st":"operational"}
	var intact:=MeshKit.new(); BuildingLifecycle.append(intact,original,record)
	check(var_to_bytes(intact.parts)==before,"intact structures changed during copying")
	var ruined:=MeshKit.new(); record.hp=0; record.st="ruined"
	BuildingLifecycle.append(ruined,original,record)
	var high:=0.0; var inverse:=original.basis.inverse()
	for part in ruined.parts.values():
		for vertex:Vector3 in part[0]: high=maxf(high,(inverse*(vertex-original.origin)).y)
	check(high<=.201,"ruined walls retain uncut spikes above the collapse plane")
	var again:=MeshKit.new(); BuildingLifecycle.append(again,original,record)
	check(var_to_bytes(ruined.parts)==var_to_bytes(again.parts),"damage appearance depends on generation order")
	check(var_to_bytes(original.parts)==before,"damage corrupted a shared construction template")
	record.hp=100; record.st="operational"
	var partial:=MeshKit.new(); BuildingLifecycle.append(partial,original,record,.65)
	var ceiling:=.8*(.65-.32)/.63
	for part in partial.parts.values():
		for vertex:Vector3 in part[0]: check((inverse*(vertex-original.origin)).y<=ceiling+.001,"unfinished geometry appears above its construction front")
	var complete:=MeshKit.new(); BuildingLifecycle.append(complete,original,record,1.0)
	check(var_to_bytes(complete.parts)==before,"completed construction does not match the final building")
	for type in MilitaryModelLibrary.TYPES:
		var mesh:=MilitaryModelLibrary.build(type,Color("567bc4"))
		check(mesh!=null and mesh.get_surface_count()>0,"missing role-specific unit model: "+type)
	_assets_and_lifecycle()
	_units_and_squads()
	_large_battle_rendering()
	print("DEVELOPMENT_TESTS ",JSON.stringify({"checks":checks,"failures":failures}))
	quit(0 if failures.is_empty() else 1)


## Backlog E/F/G: authored components, civic compositions, construction stages and damage.
func _assets_and_lifecycle() -> void:
	for id in ComponentKit.IDS:
		var surfaces:=AssetLibrary.component(id)
		check(not surfaces.is_empty(),"component asset is missing or empty: "+id)
		check(ResourceLoader.exists("res://assets/components/%s.glb"%id),"component is not exported as glTF: "+id)
		var bounds:=BuildingLifecycle.bounds(ComponentKit.build(id))
		check(bounds.position.y>=-.001,"component pivot is not at its base: "+id)
	var manifest:Dictionary=JSON.parse_string(FileAccess.get_file_as_string("res://recipes/assets.json"))
	check((manifest.get("components",{}) as Dictionary).size()==ComponentKit.IDS.size(),"asset manifest does not list every component")
	# city tiers only ever add to the settlement hub
	var previous:=0
	for tier in 4:
		var kit:=MeshKit.new()
		CivicBuildingLibrary.compose(kit,{"id":1,"t":5,"ty":"town","ti":tier},"town",Color.WHITE,{"tier":tier,"team":Color.RED})
		var count:=0
		for part in kit.parts.values(): count+=(part[0] as Array).size()
		check(count>previous,"city tier %d does not add development"%tier)
		previous=count
	# one farmstead per estate: the seat has a barn, the other farms do not
	var seat:=MeshKit.new(); var field:=MeshKit.new()
	CivicBuildingLibrary.compose(seat,{"id":2,"t":6,"ty":"farm"},"farm",Color.WHITE,{"seat":true})
	CivicBuildingLibrary.compose(field,{"id":3,"t":7,"ty":"farm"},"farm",Color.WHITE,{"seat":false})
	check(seat.parts.has("corrugated") and (seat.parts.corrugated[0] as Array).size()>(field.parts.get("corrugated",[[]])[0] as Array).size()*2,"every farm repeats a barn")
	# mines follow their deposit: a headframe over iron or coal, an adit into bare rock
	var shaft:=MeshKit.new(); var adit:=MeshKit.new()
	CivicBuildingLibrary.compose(shaft,{"id":4,"t":8,"ty":"mine"},"mine",Color.WHITE,{"deposit":3})
	CivicBuildingLibrary.compose(adit,{"id":5,"t":9,"ty":"mine"},"mine",Color.WHITE,{"deposit":0})
	check(var_to_bytes(shaft.parts)!=var_to_bytes(adit.parts),"mines do not reflect their deposit")
	# construction: machinery only while a crew works; a site waiting for materials is quiet
	var building:=MeshKit.new(); building.box("concrete",Vector3.ZERO,Vector3(.4,.4,.3))
	var working:=MeshKit.new(); BuildingLifecycle.construction(working,building,{"id":9,"t":3,"cr":1.0},.5)
	var waiting:=MeshKit.new(); BuildingLifecycle.construction(waiting,building,{"id":9,"t":3,"cr":0.0,"qw":"materials"},.5)
	check(working.parts.has("painted_metal") and not waiting.parts.has("painted_metal"),"a stalled site shows working machinery")
	var early:=MeshKit.new(); BuildingLifecycle.construction(early,building,{"id":9,"t":3,"cr":1.0},.05)
	var early_top:=0.0
	for part in early.parts.values():
		for vertex:Vector3 in part[0]:
			if absf(vertex.x)<.15 and absf(vertex.z)<.1: early_top=maxf(early_top,vertex.y)
	check(early_top<.1,"site preparation already shows the building")
	# damage clusters on the side a recorded impact struck
	var block:=MeshKit.new()
	for x in range(-4,5):
		for y in range(1,8): block.box("concrete",Vector3(x*.05,y*.05,0),Vector3(.045,.045,.02))
	var hit_left:=MeshKit.new(); BuildingLifecycle.append(hit_left,block,{"id":12,"t":1,"ty":"house","hp":45,"_impacts":[Vector2(-.2,0)],"_skip_rubble":true})
	var left:=0; var right:=0
	for vertex:Vector3 in hit_left.parts.concrete[0]:
		if vertex.y>.06:
			if vertex.x<-.1: left+=1
			elif vertex.x>.1: right+=1
	check(left<right,"damage does not follow the recorded impact")
	# curved through roads and trenches: the vegetation corridor follows the drawn curve
	var grid:=HexGrid.new(8,8,true)
	var bits:=(1<<0)|(1<<2)
	var lines:=TrenchPresentation.centrelines(bits,grid)
	check(lines.size()==1 and (lines[0] as Array).size()==TrenchPresentation.CURVE_SAMPLES,"a through trench is not one continuous curve")
	check((lines[0][0] as Vector2).distance_to(grid.dir_vec[0]*HexGrid.SQRT3*.5)<.001,"trench curve does not meet its edge")
	check(is_equal_approx(TrenchPresentation.bay(0,grid,.5,1.0,true),1.6) and is_equal_approx(TrenchPresentation.bay(0,grid,.5,.5,true),1.0),"fire bays are not limited to finished through trenches")


## Backlog H: figures, vehicle animation frames and free-moving soldiers inside one unit.
func _units_and_squads() -> void:
	for variant in FigureKit.VARIANTS:
		for pose in FigureKit.POSES:
			var mesh:=FigureKit.mesh(variant,pose,Color.RED)
			check(mesh!=null and mesh.get_surface_count()>0,"missing figure %s/%s"%[variant,pose])
	for type in ["tank","armored_car","supply_truck","sp_artillery","missile_battery"]:
		var a:=MilitaryModelLibrary.build(type,Color.RED,"roll_0"); var b:=MilitaryModelLibrary.build(type,Color.RED,"roll_1")
		check(var_to_bytes(a.surface_get_arrays(0))!=var_to_bytes(b.surface_get_arrays(0)) or a.get_surface_count()!=b.get_surface_count() or _differs(a,b),"wheels or tracks do not animate: "+type)
	var kit:=MilitaryModelLibrary.build("rifle_squad",Color.RED,"kit"); var full:=MilitaryModelLibrary.build("rifle_squad",Color.RED,"idle")
	check(_vertex_count(kit)*4<_vertex_count(full),"the squad equipment model still contains its soldiers")
	# a live squad: figures move individually, stay inside the unit footprint, follow when it moves
	var world:=WorldState.new(); world.grid=HexGrid.new(32,32,true); world._clear_map()
	world.known.fill(1)
	for tile in world.grid.n: world.geo[tile*6]=140; world.geo[tile*6+1]=2
	for tile in world.grid.n: world.height[tile]=world._tile_height(tile)
	world.vis_bits.fill(255)
	var camera:=CameraController.new(); get_root().add_child(camera); camera.setup(world)
	camera.size=12.0; camera.focus=Vector3(world.grid.center(300).x,0,world.grid.center(300).y)
	var military:=MilitaryRenderer.new(); get_root().add_child(military); military.setup(world,camera)
	var squads:=SquadPresentation.new(); get_root().add_child(squads); squads.setup(world,camera,military)
	world.units[5]={"id":5,"owner":0,"type":"rifle_squad","tile":300,"next":-1,"hp":100,"flags":0,"supp":0}
	var anchor:=Vector3(world.grid.center(300).x,0,world.grid.center(300).y)
	military.draw_positions[5]=anchor
	for frame in 90: squads.update(1.0/30.0)
	var figures:Array=squads.groups[5].figures
	check(figures.size()==6,"a full-strength rifle squad is not six people")
	var offsets:=[]
	for f in figures:
		check((f.d as Vector2).length()<=SquadPresentation.FOOTPRINT+.001,"a figure left the unit footprint")
		offsets.append(f.d)
	var spacing_ok:=true
	for i in offsets.size():
		for j in range(i+1,offsets.size()):
			if (offsets[i] as Vector2).distance_to(offsets[j])<.012: spacing_ok=false
	check(spacing_ok,"figures overlap instead of keeping apart")
	var before:Array=offsets.duplicate()
	for frame in 60: squads.update(1.0/30.0)
	var moved_alone:=0
	for i in figures.size():
		if ((figures[i].d as Vector2)-(before[i] as Vector2)).length()>.0005: moved_alone+=1
	check(moved_alone>=3,"a halted squad is frozen in place")
	# the unit advances: figures trail and then catch up, at different rates
	military.draw_positions[5]=anchor+Vector3(.4,0,0); world.units[5].next=301
	squads.update(1.0/30.0)
	var lags:=[]
	for f in figures: lags.append((f.d as Vector2).x)
	check(lags.min()<-.2,"figures teleport with the unit instead of following")
	for frame in 20: squads.update(1.0/30.0)
	var spread:=[]
	for f in figures: spread.append((f.d as Vector2).x)
	check(spread.max()-spread.min()>.03,"a moving squad slides as one rigid block")
	world.units[5].hp=40; squads.update(1.0/30.0)
	check((squads.groups[5].figures as Array).size()==3,"casualties do not thin the squad")
	for node in [squads,military,camera]: node.queue_free()


func _vertex_count(mesh:ArrayMesh) -> int:
	var n:=0
	for surface in mesh.get_surface_count(): n+=(mesh.surface_get_arrays(surface)[Mesh.ARRAY_VERTEX] as PackedVector3Array).size()
	return n


func _differs(a:ArrayMesh,b:ArrayMesh) -> bool:
	for surface in mini(a.get_surface_count(),b.get_surface_count()):
		if a.surface_get_arrays(surface)[Mesh.ARRAY_VERTEX]!=b.surface_get_arrays(surface)[Mesh.ARRAY_VERTEX]: return true
	return false


## Backlog P5: one shader-animated instance per squad, buffered instance uploads, vehicle lanes.
func _large_battle_rendering() -> void:
	var squad:=MilitaryModelLibrary.build("rifle_squad",Color.RED,"gpu")
	var codes:={}; var figures:={}
	for surface in squad.get_surface_count():
		check(str(squad.surface_get_material(surface).resource_name).begins_with("squad:"),"animated squad surface uses a static material")
		for uv:Vector2 in squad.surface_get_arrays(surface)[Mesh.ARRAY_TEX_UV]:
			figures[int(floor(uv.x))]=true; codes[roundi(fposmod(uv.x,1.0)*10.0)]=true
	check(figures.size()==6,"the animated rifle squad does not hold six soldiers")
	check(codes.has(3) and codes.has(5) and codes.has(7) and codes.has(9),"legs and arms are not tagged for animation: %s"%str(codes.keys()))
	var low:=MilitaryModelLibrary.build("rifle_squad",Color.RED,"gpu_low")
	check(_vertex_count(low)*5<_vertex_count(squad)*2,"the wide-view squad is not much lighter: %d vs %d"%[_vertex_count(low),_vertex_count(squad)])
	var mm:=MultiMesh.new(); mm.transform_format=MultiMesh.TRANSFORM_3D; mm.use_custom_data=true; mm.instance_count=2
	var t:=Transform3D(Basis(Vector3(1,2,3),Vector3(4,5,6),Vector3(7,8,9)),Vector3(10,11,12))
	MilitaryRenderer._upload(mm,[t,t],[Color(.1,.2,.3,.4),Color(.5,.6,.7,.8)])
	var buffer:PackedFloat32Array=mm.get_meta("upload")
	check(buffer.size()==32 and buffer[0]==1.0 and buffer[1]==4.0 and buffer[3]==10.0 and buffer[11]==12.0 and is_equal_approx(buffer[28],.5),"instance buffer layout is wrong")
	check(mm.visible_instance_count==2,"uploaded instances are not visible")
