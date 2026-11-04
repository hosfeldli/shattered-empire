class_name CivilianActivitySystem
extends Node3D
## Bounded decorative agents with stable destinations. Routes stay within a parcel, or follow an
## actual unbroken road edge; they never extend gameplay connectivity or reveal hidden economy.
var composition: WorldCompositionSystem
var world: WorldState
var camera: CameraController
var people: MultiMeshInstance3D
var routes: Array = []
var elapsed := 1.0
var drawn := 0


func setup(system: WorldCompositionSystem, cam: CameraController) -> void:
	composition = system; world = system.world; camera = cam
	people = MultiMeshInstance3D.new()
	var mm := MultiMesh.new(); mm.transform_format = MultiMesh.TRANSFORM_3D; mm.use_colors = true
	var kit := MeshKit.new()
	kit.cylinder("canvas", Vector3(0,.015,0), .014, .045, 5)
	kit.cylinder("plaster", Vector3(0,.06,0), .012, .018, 5)
	mm.mesh = kit.commit(); mm.instance_count = 200; mm.visible_instance_count = 0
	people.multimesh = mm; people.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(people)
	world.welcomed.connect(_clear); world.reset.connect(_clear)


func _clear() -> void:
	routes.clear(); drawn = 0; elapsed = 1.0
	people.multimesh.visible_instance_count = 0


func _routes() -> void:
	routes.clear()
	var ids := composition.adapter.buildings.keys(); ids.sort()
	for id in ids:
		var b: WorldStateAdapter.BuildingRecord = composition.adapter.buildings[id]
		if not b.complete or b.hp < 35 or b.fire or b.lifecycle in ["ruined","planned"]: continue
		var city: Dictionary = world.cities.get(b.city, {})
		if city.is_empty() or float(city.get("pop", 0)) <= 0: continue
		if b.group not in ["res","com","civ"] and not b.active: continue
		var c := world.grid.center(b.tile)
		var x := world.grid.near_x(c.x, camera.focus.x)
		if absf(x-camera.focus.x) > camera.view_half_width()+2 or absf(c.y-camera.focus.z) > camera.size+2: continue
		var rng := composition.identities.rng_for("building:%d" % id,"activity.route",1,"pedestrians")
		var a := Vector2(c.x-.18,c.y-.3)
		var z := Vector2(c.x+.25,c.y-.3)
		for edge in composition.graph.contexts.get(id, {}).get("roads", []):
			if edge.broken or world.known[int(edge.to)] == 0: continue
			var next := world.grid.center(int(edge.to))
			z = Vector2(c.x+world.grid.dx_wrap(c.x,next.x)*.8,next.y)
			a = c
			break
		var weather := composition.weather.at_tile(b.tile)
		var intensity := clampf(float(city.get("pop",0))/25.0, .1, 1.0)
		intensity *= clampf(float(city.get("st",100))/70.0,.1,1.0) * (1.0-float(weather.rain)*.7)
		intensity *= (1.0-clampf(float(city.get("dmg",0))/100.0,0,.9))
		for k in maxi(1,int(3*intensity)):
			routes.append({"a":a,"b":z,"tile":b.tile,"phase":rng.randf(),"speed":rng.randf_range(.035,.065),"tint":Color.from_hsv(rng.randf(),.24,.75)})
		if routes.size() >= 200: break


func update(dt: float) -> void:
	var budget := composition.lod.budget("pedestrians",camera.size)
	if budget == 0:
		people.multimesh.visible_instance_count = 0; drawn = 0; return
	elapsed += dt
	if elapsed >= 1.0:
		elapsed = 0; _routes()
	var occupied := {}
	for u in world.units.values(): occupied[int(u.tile)] = true
	drawn = 0
	for route in routes:
		if drawn >= budget: break
		if occupied.has(route.tile): continue
		var phase := fposmod(world.render_time*float(route.speed)+float(route.phase),2.0)
		var point: Vector2 = (route.a as Vector2).lerp(route.b, phase if phase<=1 else 2-phase)
		var x := world.grid.near_x(point.x,camera.focus.x)
		var y := world.ground_height(x,point.y)+.025
		people.multimesh.set_instance_transform(drawn,Transform3D(Basis(),Vector3(x,y,point.y)))
		people.multimesh.set_instance_color(drawn,route.tint)
		drawn += 1
	people.multimesh.visible_instance_count = drawn
