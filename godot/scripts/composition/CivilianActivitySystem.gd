class_name CivilianActivitySystem
extends Node3D
## Bounded decorative pedestrians and local traffic, derived from visible population/activity.
## They use dry parcels or real unbroken road edges and yield locally to military units.
var composition:WorldCompositionSystem
var world:WorldState
var camera:CameraController
var people:MultiMeshInstance3D
var people_step:MultiMeshInstance3D
var carts:MultiMeshInstance3D
var cars:MultiMeshInstance3D
var vans:MultiMeshInstance3D
var routes:Array=[]
var elapsed:=1.0
var drawn:=0
var vehicles_drawn:=0
var clock:=0.0
var actor_positions:Array=[]
const PEOPLE:=["civilian","civilian_bag","civilian_coat","civilian_pack"]
var people_batches:={}   # "variant|pose" -> MultiMeshInstance3D

func _batch(mesh:Mesh,count:int) -> MultiMeshInstance3D:
	var instance:=MultiMeshInstance3D.new(); var mm:=MultiMesh.new()
	mm.transform_format=MultiMesh.TRANSFORM_3D; mm.use_colors=true; mm.mesh=mesh
	mm.instance_count=count; mm.visible_instance_count=0; instance.multimesh=mm
	instance.cast_shadow=GeometryInstance3D.SHADOW_CASTING_SETTING_OFF; add_child(instance); return instance

func setup(system:WorldCompositionSystem,cam:CameraController) -> void:
	composition=system; world=system.world; camera=cam
	people=_batch(_person(false),200); people_step=_batch(_person(true),200)
	carts=_batch(_vehicle(false),64); cars=_batch(_vehicle(true),64); vans=_batch(_vehicle(true,true),32)
	world.welcomed.connect(_clear); world.reset.connect(_clear)

## Everyday people in the same figure style as the troops (FigureKit "civilian"); clothing colour
## varies per person through the instance colour.
func _person(step:bool) -> ArrayMesh:
	return FigureKit.mesh("civilian","walk_a" if step else "walk_b",Color.WHITE)

## Local traffic from the shared component library: modern cars and delivery vans, and light
## handcarts in the earliest era; the same models parked in the cities.
func _vehicle(motor:bool,van:=false) -> ArrayMesh:
	var kit:=MeshKit.new()
	if motor: kit.part("van" if van else "parked_car",Vector3.ZERO,0.0,1.15)
	else:
		kit.box("timber",Vector3(0,.016,0),Vector3(.06,.012,.04),Color(.8,.68,.5))
		kit.box("canvas",Vector3(-.004,.028,0),Vector3(.045,.018,.036),Color(.82,.76,.6))
		for z in [-.022,.022]: kit.cylinder("char",Vector3(0,0,z),.012,.004,8)
		kit.box("timber",Vector3(.045,.02,0),Vector3(.04,.004,.004))
	return kit.commit()

func _clear() -> void:
	routes.clear(); drawn=0; vehicles_drawn=0; elapsed=1.0; clock=0.0
	for instance in [people,people_step,carts,cars,vans]: instance.multimesh.visible_instance_count=0

func _routes() -> void:
	routes.clear()
	var ids:=composition.adapter.buildings.keys(); ids.sort()
	# Civilians take shelter where the server reports active fighting: the streets of a contested
	# district (and its neighbours) empty until the battle moves on.
	var sheltering:={}
	for record in world.bf.get("i",[]):
		if float(record[1])<1.0: continue
		var t:=int(record[0]); sheltering[t]=true
		for d in 6:
			var nb:=world.grid.nb[t*6+d]
			if nb>=0: sheltering[nb]=true
	for id in ids:
		var b:WorldStateAdapter.BuildingRecord=composition.adapter.buildings[id]
		if not b.complete or b.hp<35 or b.fire or b.lifecycle in ["ruined","planned"] or not world.is_visible(b.tile): continue
		if sheltering.has(b.tile): continue
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
		# Purpose: residents walk between their homes and a nearby working place (an active
		# workplace, the market, the campus or the civic hub) within two hexes, never across water.
		var destination:=_destination(b) if b.group=="res" else -1
		if destination>=0:
			var there:=world.grid.center(destination)
			var target:=Vector2(c.x+world.grid.dx_wrap(c.x,there.x),there.y)
			var toward:=(target-c).normalized()
			var trial_a:=c+toward*.3; var trial_z:=target-toward*.3
			if composition.sites.clear_of_water(b.tile,[trial_a,trial_z],.025) and not composition.sites.crosses_water(b.tile,trial_a,trial_z,.06): a=trial_a; z=trial_z; road_dir=-1
		if not composition.sites.clear_of_water(b.tile,[a,z],.025): continue
		var weather:=composition.weather.at_tile(b.tile)
		var intensity:=clampf(float(city.get("pop",0))/30.0,.25,1.0)
		intensity*=clampf(float(city.get("st",100))/70.0,.2,1.0)*(1.0-float(weather.rain)*.7)
		intensity*=1.0-clampf(float(city.get("dmg",0))/100.0,0,.9)
		var previous:={}
		for index in maxi(1,roundi(5*intensity)):
			var offset:=Vector2(0,rng.randf_range(-.025,.025))
			var person:={"a":a+offset,"b":z+offset,"tile":b.tile,"road":road_dir,"kind":0,"phase":rng.randf(),"speed":rng.randf_range(.1,.16),
				"tint":Color.from_hsv(rng.randf(),rng.randf_range(.15,.45),rng.randf_range(.55,1.0)),"variant":PEOPLE[rng.randi()%PEOPLE.size()],
				"lateral":rng.randf_range(-.06,.06),"pause":rng.randf_range(1.5,6.0),"gait":rng.randf_range(.9,1.12),"side":0.0}
			# some people walk in pairs: same timing, side by side
			if not previous.is_empty() and rng.randf()<.35:
				person.phase=previous.phase; person.speed=previous.speed; person.pause=previous.pause; person.lateral=previous.lateral; person.side=.028
			routes.append(person); previous=person
		if b.active or b.group in ["com","civ"]:
			var era:=int(world.civ_by_id.get(b.owner,{}).get("age",world.econ.get("age",0) if b.owner==world.civ_id else 0))
			routes.append({"a":a,"b":z,"tile":b.tile,"road":road_dir,"kind":2 if era>=1 and road_dir>=0 else 1,"phase":rng.randf()*2,"speed":rng.randf_range(.07,.11),"tint":[Color(.85,.85,.83),Color(.3,.33,.38),Color(.7,.25,.2),Color(.35,.45,.6),Color(.6,.62,.55)][rng.randi()%5]})
		if routes.size()>=264: break

## the nearest place a resident would walk to: an active workplace, market, campus or civic hub
func _destination(home:WorldStateAdapter.BuildingRecord) -> int:
	var best:=-1; var best_d:=99
	for id in composition.adapter.buildings:
		var other:WorldStateAdapter.BuildingRecord=composition.adapter.buildings[id]
		if other.tile==home.tile or other.owner!=home.owner or not other.complete or other.lifecycle in ["ruined","planned"]: continue
		if not (other.group in ["com","civ"] or other.active): continue
		var d:=world.grid.dist(home.tile,other.tile)
		if d<=2 and d<best_d: best_d=d; best=other.tile
	return best


func update(dt:float) -> void:
	var budget:=composition.lod.budget("pedestrians",camera.size)
	var vehicle_budget:=composition.lod.budget("vehicles",camera.size)
	if budget==0 or camera.size>48:
		for instance in [people,people_step,carts,cars,vans]: instance.multimesh.visible_instance_count=0
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
	var batches_now:={}
	drawn=0; vehicles_drawn=0; var standing_count:=0; var stepping_count:=0; var cart_count:=0; var car_count:=0; var van_count:=0; actor_positions.clear()
	for route:Dictionary in routes:
		if not world.is_visible(route.tile): continue
		if route.road>=0 and (world.road[route.tile]>>(int(route.road)*4))&8: continue
		var vehicle:bool=route.kind!=0
		if vehicle and vehicles_drawn>=vehicle_budget or not vehicle and drawn>=budget: continue
		if not vehicle:
			var placed:=_walker(route)
			var at:Vector2=placed[0]
			if occupied.get(route.tile,[]).any(func(unit_point):return Vector2(world.grid.dx_wrap(at.x,unit_point.x),at.y-unit_point.y).length()<.13): continue
			var wx:=world.grid.near_x(at.x,camera.focus.x)
			var key:=str(route.variant)+"|"+str(placed[2])
			if not batches_now.has(key): batches_now[key]=[]
			(batches_now[key] as Array).append([Transform3D(Basis(Vector3.UP,float(placed[1])),Vector3(wx,world.ground_height(wx,at.y)+float(placed[3]),at.y)),route.tint])
			drawn+=1; actor_positions.append(Vector3(wx,0,at.y))
			continue
		var phase:=fposmod(clock*float(route.speed)+float(route.phase),2.0)
		var point:Vector2=(route.a as Vector2).lerp(route.b,phase if phase<=1 else 2-phase)
		if occupied.get(route.tile,[]).any(func(unit_point):return Vector2(world.grid.dx_wrap(point.x,unit_point.x),point.y-unit_point.y).length()<.13): continue
		var x:=world.grid.near_x(point.x,camera.focus.x); var y:=world.ground_height(x,point.y)+.012
		var forward:Vector2=(route.b-route.a)*(1.0 if phase<1 else -1.0)
		var basis:=Basis(Vector3.UP,atan2(-forward.y,forward.x))
		var transform:=Transform3D(basis,Vector3(x,y,point.y))
		if route.kind==1:
			carts.multimesh.set_instance_transform(cart_count,transform); carts.multimesh.set_instance_color(cart_count,route.tint); cart_count+=1; vehicles_drawn+=1
		elif fposmod(float(route.phase),1.0)<.3 and van_count<32:
			vans.multimesh.set_instance_transform(van_count,transform); vans.multimesh.set_instance_color(van_count,route.tint); van_count+=1; vehicles_drawn+=1
		else:
			cars.multimesh.set_instance_transform(car_count,transform); cars.multimesh.set_instance_color(car_count,route.tint); car_count+=1; vehicles_drawn+=1
		actor_positions.append(transform.origin)
	people.multimesh.visible_instance_count=0; people_step.multimesh.visible_instance_count=0
	_flush_people(batches_now)
	carts.multimesh.visible_instance_count=cart_count; cars.multimesh.visible_instance_count=car_count; vans.multimesh.visible_instance_count=van_count


## One pedestrian's place on its errand: walk out (eased start and stop, a gently curved line),
## linger at the destination, walk back, linger at home. Stride frames follow the walking speed.
## Returns [position, facing, pose, lift].
func _walker(route:Dictionary) -> Array:
	var a:Vector2=route.a; var b:Vector2=route.b
	var travel:=1.0/maxf(float(route.speed),.01); var pause:=float(route.pause)
	var cycle:=2.0*travel+2.0*pause
	var t:=fposmod(clock+float(route.phase)*cycle,cycle)
	var u:=0.0; var direction:=1.0; var moving:=true
	if t<travel: u=t/travel
	elif t<travel+pause: u=1.0; moving=false
	elif t<2.0*travel+pause: u=1.0-(t-travel-pause)/travel; direction=-1.0
	else: u=0.0; moving=false
	var eased:=u*u*(3.0-2.0*u)
	var along:=b-a; var side:=Vector2(-along.y,along.x).normalized()
	var bend:=float(route.lateral)*sin(eased*PI)+float(route.side)
	var wiggle:=.004*sin(clock*1.3+float(route.phase)*17.0)
	var at:=a.lerp(b,eased)+side*(bend+wiggle)
	var facing:=atan2(-along.y*direction,along.x*direction)
	if not moving: facing+=1.2*sin(float(route.phase)*31.0)+.3*sin(clock*.4+float(route.phase)*9.0)
	var pose:="stand"; var lift:=0.0
	if moving and u>.02 and u<.98:
		var stride:=clock*7.5*float(route.gait)*(.6+.8*sin(eased*PI))
		pose="walk_a" if sin(stride)>0.0 else "walk_b"
		lift=absf(sin(stride))*.0018
	return [at,facing,pose,lift]


func _flush_people(lists:Dictionary) -> void:
	for key in people_batches:
		if not lists.has(key): (people_batches[key] as MultiMeshInstance3D).multimesh.visible_instance_count=0
	for key in lists:
		var batch:MultiMeshInstance3D=people_batches.get(key)
		if batch==null:
			var parts:=str(key).split("|")
			batch=_batch(FigureKit.mesh(parts[0],parts[1],Color.WHITE),64)
			people_batches[key]=batch
		var mm:=batch.multimesh; var list:Array=lists[key]
		if mm.instance_count<list.size():
			mm.visible_instance_count=0; mm.instance_count=maxi(list.size(),mm.instance_count*2)
		for index in list.size():
			mm.set_instance_transform(index,list[index][0]); mm.set_instance_color(index,list[index][1])
		mm.visible_instance_count=list.size()
