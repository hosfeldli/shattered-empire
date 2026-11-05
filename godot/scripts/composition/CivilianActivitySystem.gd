class_name CivilianActivitySystem
extends Node3D
## Bounded decorative pedestrians and local traffic, derived from visible population/activity.
## They use dry parcels or real unbroken road edges and yield locally to military units.
var composition:WorldCompositionSystem
var world:WorldState
var camera:CameraController
var people:MultiMeshInstance3D
var carts:MultiMeshInstance3D
var cars:MultiMeshInstance3D
var routes:Array=[]
var elapsed:=1.0
var drawn:=0
var vehicles_drawn:=0
var clock:=0.0
var actor_positions:Array=[]

func _batch(mesh:Mesh,count:int) -> MultiMeshInstance3D:
	var instance:=MultiMeshInstance3D.new(); var mm:=MultiMesh.new()
	mm.transform_format=MultiMesh.TRANSFORM_3D; mm.use_colors=true; mm.mesh=mesh
	mm.instance_count=count; mm.visible_instance_count=0; instance.multimesh=mm
	instance.cast_shadow=GeometryInstance3D.SHADOW_CASTING_SETTING_OFF; add_child(instance); return instance

func setup(system:WorldCompositionSystem,cam:CameraController) -> void:
	composition=system; world=system.world; camera=cam
	var kit:=MeshKit.new()
	for x in [-.012,.012]: kit.box("char",Vector3(x,0,0),Vector3(.014,.035,.018))
	kit.box("canvas",Vector3(0,.03,0),Vector3(.043,.045,.025))
	kit.cylinder("plaster",Vector3(0,.075,0),.016,.024,6)
	for x in [-.029,.029]: kit.box("canvas",Vector3(x,.035,0),Vector3(.012,.035,.014))
	people=_batch(kit.commit(),200)
	carts=_batch(_vehicle(false),64); cars=_batch(_vehicle(true),64)
	world.welcomed.connect(_clear); world.reset.connect(_clear)

func _vehicle(motor:bool) -> ArrayMesh:
	var kit:=MeshKit.new()
	kit.box("steel" if motor else "timber",Vector3(0,.035,0),Vector3(.19,.055,.10),Color(.75,.73,.64))
	if motor:
		kit.box("steel",Vector3(.045,.09,0),Vector3(.07,.055,.09),Color(.68,.72,.67))
		kit.box("glass",Vector3(.081,.11,0),Vector3(.004,.025,.068))
	else:
		kit.box("timber",Vector3(-.015,.09,0),Vector3(.07,.05,.075))
		kit.box("timber",Vector3(.15,.05,0),Vector3(.12,.012,.018))
	for x in [-.063,.063]:
		for z in [-.057,.057]: kit.box("char",Vector3(x,.015,z),Vector3(.041,.045,.018))
	return kit.commit()

func _clear() -> void:
	routes.clear(); drawn=0; vehicles_drawn=0; elapsed=1.0; clock=0.0
	for instance in [people,carts,cars]: instance.multimesh.visible_instance_count=0

func _routes() -> void:
	routes.clear()
	var ids:=composition.adapter.buildings.keys(); ids.sort()
	for id in ids:
		var b:WorldStateAdapter.BuildingRecord=composition.adapter.buildings[id]
		if not b.complete or b.hp<35 or b.fire or b.lifecycle in ["ruined","planned"] or not world.is_visible(b.tile): continue
		var city:Dictionary=world.cities.get(b.city,{})
		if city.is_empty() or float(city.get("pop",0))<=0: continue
		if b.group not in ["res","com","civ"] and not b.active: continue
		var c:=world.grid.center(b.tile); var x:=world.grid.near_x(c.x,camera.focus.x)
		if absf(x-camera.focus.x)>camera.view_half_width()+2 or absf(c.y-camera.focus.z)>camera.size+2: continue
		var rng:=composition.identities.rng_for("building:%d"%id,"activity.route",2,"pedestrians")
		var a:=c+Vector2(-.42,-.43); var z:=c+Vector2(.42,-.43); var road_dir:=-1
		for edge in composition.graph.contexts.get(id,{}).get("roads",[]):
			var neighbor:=int(edge.to)
			if edge.broken or not world.known[neighbor] or not world.is_visible(neighbor) or world.is_river(neighbor) or world.is_sea(neighbor) or world.is_lake(neighbor): continue
			var next:=world.grid.center(neighbor); var direction:=world.grid.dir_vec[int(edge.dir)]; var side:=Vector2(-direction.y,direction.x)*.12
			a=c+direction*.38+side; z=Vector2(c.x+world.grid.dx_wrap(c.x,next.x)*.8,lerpf(c.y,next.y,.8))+side; road_dir=int(edge.dir); break
		if not composition.sites.clear_of_water(b.tile,[a,z],.025): continue
		var weather:=composition.weather.at_tile(b.tile)
		var intensity:=clampf(float(city.get("pop",0))/30.0,.25,1.0)
		intensity*=clampf(float(city.get("st",100))/70.0,.2,1.0)*(1.0-float(weather.rain)*.7)
		intensity*=1.0-clampf(float(city.get("dmg",0))/100.0,0,.9)
		for index in maxi(1,roundi(5*intensity)):
			var offset:=Vector2(0,rng.randf_range(-.025,.025))
			routes.append({"a":a+offset,"b":z+offset,"tile":b.tile,"road":road_dir,"kind":0,"phase":rng.randf()*2,"speed":rng.randf_range(.12,.18),"tint":Color.from_hsv(rng.randf(),.22,.8)})
		if b.active or b.group in ["com","civ"]:
			var era:=int(world.civ_by_id.get(b.owner,{}).get("age",world.econ.get("age",0) if b.owner==world.civ_id else 0))
			routes.append({"a":a,"b":z,"tile":b.tile,"road":road_dir,"kind":2 if era>=1 else 1,"phase":rng.randf()*2,"speed":rng.randf_range(.07,.11),"tint":Color(.83,.80,.72)})
		if routes.size()>=264: break

func update(dt:float) -> void:
	var budget:=composition.lod.budget("pedestrians",camera.size)
	var vehicle_budget:=composition.lod.budget("vehicles",camera.size)
	if budget==0 or camera.size>48:
		for instance in [people,carts,cars]: instance.multimesh.visible_instance_count=0
		drawn=0; vehicles_drawn=0; return
	if not world.paused: clock+=dt
	elapsed+=dt
	if elapsed>=.75: elapsed=0; _routes()
	var occupied:={}
	var nearby:={}
	for route:Dictionary in routes: nearby[int(route.tile)]=true
	for unit:Dictionary in world.units.values():
		var tile:=int(unit.tile)
		if not nearby.has(tile): continue
		if not occupied.has(tile): occupied[tile]=[]
		occupied[tile].append(world.unit_position(int(unit.id)))
	drawn=0; vehicles_drawn=0; var cart_count:=0; var car_count:=0; actor_positions.clear()
	for route:Dictionary in routes:
		if not world.is_visible(route.tile): continue
		if route.road>=0 and (world.road[route.tile]>>(int(route.road)*4))&8: continue
		var vehicle:bool=route.kind!=0
		if vehicle and vehicles_drawn>=vehicle_budget or not vehicle and drawn>=budget: continue
		var phase:=fposmod(clock*float(route.speed)+float(route.phase),2.0)
		var point:Vector2=(route.a as Vector2).lerp(route.b,phase if phase<=1 else 2-phase)
		if occupied.get(route.tile,[]).any(func(unit_point):return Vector2(world.grid.dx_wrap(point.x,unit_point.x),point.y-unit_point.y).length()<.13): continue
		var x:=world.grid.near_x(point.x,camera.focus.x); var y:=world.ground_height(x,point.y)+.012
		var forward:Vector2=(route.b-route.a)*(1.0 if phase<1 else -1.0)
		var basis:=Basis(Vector3.UP,atan2(-forward.y,forward.x))
		if not vehicle: y+=sin(clock*12.0+float(route.phase)*6.0)*.003
		var transform:=Transform3D(basis,Vector3(x,y,point.y))
		if not vehicle:
			people.multimesh.set_instance_transform(drawn,transform); people.multimesh.set_instance_color(drawn,route.tint); drawn+=1
		elif route.kind==1:
			carts.multimesh.set_instance_transform(cart_count,transform); carts.multimesh.set_instance_color(cart_count,route.tint); cart_count+=1; vehicles_drawn+=1
		else:
			cars.multimesh.set_instance_transform(car_count,transform); cars.multimesh.set_instance_color(car_count,route.tint); car_count+=1; vehicles_drawn+=1
		actor_positions.append(transform.origin)
	people.multimesh.visible_instance_count=drawn; carts.multimesh.visible_instance_count=cart_count; cars.multimesh.visible_instance_count=car_count
