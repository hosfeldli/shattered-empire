extends SceneTree
var failures:Array=[]
var checks:=0
func check(ok:bool,why:String) -> void:
	checks+=1
	if not ok: failures.append(why)
func _initialize() -> void: call_deferred("run")
func run() -> void:
	var world:=WorldState.new(); root.add_child(world)
	world.apply_welcome({"defs":{"W":32,"H":16},"world":{"wrap":true}})
	world.known.fill(1)
	var camera:=CameraController.new(); root.add_child(camera); camera.setup(world); camera.size=10
	var renderer:=CombatRenderer.new(); root.add_child(renderer); renderer.setup(world,camera)
	world.bf={"s":[[100,4]]}
	renderer._build_field()
	check(renderer.smoke_list.size()==1,"smoke-only battlefield snapshots must be displayed")
	renderer._clear()
	check(renderer.smoke_list.is_empty() and renderer.smoke.multimesh.visible_instance_count==0,"world reset retained battlefield smoke")
	renderer._on_events([])
	check(renderer.fx.is_empty(),"effects appeared without an authoritative event")
	renderer._on_events([{"k":"impact","b":100,"r":1,"p":7}])
	check(renderer.fx.size()==5,"large impact did not produce bounded flash, dust, fire and smoke")
	check(renderer.fx.all(func(effect):return effect.kind in ["blast","dust","smoke","flame"]),"impact created an unrelated firing effect")
	(renderer.fx[0].node as MeshInstance3D).transparency=.9
	renderer._clear()
	check(renderer.fx.is_empty() and renderer.fx_pool.size()==5,"world reset did not return effects to the pool")
	check(renderer.fx_pool.all(func(node):return node.transparency==0.0 and node.scale==Vector3.ONE),"world reset left a pooled effect faded or scaled")
	renderer._on_events([{"k":"fire","a":100,"b":101}])
	check(renderer.fx.any(func(effect):return effect.kind=="smoke"),"gunfire did not produce event-driven smoke")
	renderer._clear()
	var composition:=WorldCompositionSystem.new(); composition.setup(world)
	composition.weather.columns=1; composition.weather.rows=1; composition.weather.wind_direction=Vector2.RIGHT
	renderer.composition=composition
	renderer._spawn("smoke",Vector3(2,1,2),Vector3.ZERO,2.0,Color.WHITE,.1)
	renderer._update_fx(.5)
	check(world.grid.dx_wrap(2.0,(renderer.fx[0].node as Node3D).position.x)>0.0,"battle smoke does not follow the weather wind")
	renderer._clear()
	for index in 300: renderer._spawn("dust",Vector3.ZERO,Vector3.ZERO,1.0,Color.WHITE,.2)
	check(renderer.fx.size()==CombatRenderer.MAX_FX,"combat effects exceeded their fixed budget")
	print("BATTLE_PRESENTATION_TESTS ",JSON.stringify({"checks":checks,"failures":failures}))
	quit(0 if failures.is_empty() else 1)
