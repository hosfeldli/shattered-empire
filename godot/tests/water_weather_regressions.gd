extends SceneTree
var checks:=0
var failures:Array[String]=[]
func _initialize() -> void: call_deferred("_run")
func check(ok:bool,reason:String) -> void:
	checks+=1
	if not ok: failures.append(reason); push_error(reason)
func energy(sim:WaterSurfaceSimulation) -> float:
	var total:=0.0
	for value in sim.height: total+=value*value
	return total
func _run() -> void:
	var a:=WaterSurfaceSimulation.new(); a.reset(32); a.wet.fill(1)
	var b:=WaterSurfaceSimulation.new(); b.reset(32); b.wet.fill(1)
	a.impulse(Vector2(4.8,4.8),.5); b.impulse(Vector2(4.8,4.8),.5)
	for frame in 20: a.step(); b.step()
	check(a.height==b.height and a.velocity==b.velocity,"identical wave inputs diverged")
	check(absf(a.height[16*32+18])>.00001,"an impulse did not propagate to neighboring water")
	var peak:=energy(a)
	for frame in 240: a.step()
	check(energy(a)<peak*.2,"surface energy failed to dissipate")
	check(Array(a.height).all(func(value):return is_finite(value) and absf(value)<=.075),"surface solver exceeded its stable bounds")
	var barrier:=WaterSurfaceSimulation.new(); barrier.reset(32); barrier.wet.fill(1)
	for y in 32: barrier.wet[y*32+16]=0
	barrier.impulse(Vector2(4.2,4.8),.5)
	for frame in 80: barrier.step()
	var beyond:=0.0
	for y in 32:
		for x in range(17,32): beyond+=absf(barrier.height[y*32+x])
	check(beyond==0,"pressure waves crossed a dry riverbank")
	var moving:=WaterSurfaceSimulation.new(); moving.reset(32); moving.wet.fill(1); moving.current.fill(Vector2(.7,0))
	moving.impulse(Vector2(4.8,4.8),.5)
	for frame in 20: moving.step()
	check(moving.height!=b.height,"river current failed to advect surface motion")
	var original:=moving.height.duplicate(); moving.recenter(Vector2(5.25,4.8))
	check(is_equal_approx(moving.height[16*32+15],original[16*32+16]),"moving the simulation patch lost overlapping world-space waves")
	var before:=moving.steps; moving.advance(4.0)
	check(moving.steps-before<=2,"a long frame triggered unbounded catch-up work")
	var world:=WorldState.new(); root.add_child(world)
	world.apply_welcome({"defs":{"W":32,"H":16},"world":{"wrap":true},"civs":[],"seed":4})
	world.known.fill(1); world.height.fill(.2)
	for tile in world.grid.n: world.geo[tile*6+1]=2
	var tile:=8*32+31; var downstream:=8*32
	world.geo[tile*6+3]=1; world.geo[tile*6+4]=32; world.geo[tile*6+5]=1
	world.geo[downstream*6+3]=1; world.geo[downstream*6+4]=32; world.geo[downstream*6+5]=1
	var reach:=RiverGeometry.reach(world,tile)
	check(reach.size()==RiverGeometry.STEPS+1,"river curve was not sampled consistently")
	check((reach[-1] as Vector2).distance_to(reach[0])<2.0,"river curved across the entire wrapped world")
	check(is_equal_approx((reach[-1] as Vector2).x,world.grid.center(downstream).x+world.grid.period),"wrapped river endpoints do not share the same position")
	world.geo[downstream*6+4]=48; world.geo[downstream*6+5]=6
	var incoming:=RiverGeometry.ribbon(world,tile); var outgoing:=RiverGeometry.ribbon(world,downstream)
	check(not incoming.is_empty() and not outgoing.is_empty(),"river ribbon sections missing")
	var left_end:Vector2=incoming[-1].center+incoming[-1].side; var left_start:Vector2=outgoing[0].center+outgoing[0].side
	left_start.x=world.grid.near_x(left_start.x,left_end.x)
	check(left_end.distance_to(left_start)<.00001,"river bend has a gap on its left bank")
	var right_end:Vector2=incoming[-1].center-incoming[-1].side; var right_start:Vector2=outgoing[0].center-outgoing[0].side
	right_start.x=world.grid.near_x(right_start.x,right_end.x)
	check(right_end.distance_to(right_start)<.00001,"river bend has a gap on its right bank")
	check((incoming[-1].side as Vector2).is_equal_approx(outgoing[0].side),"width changes do not share a junction cross-section")
	var context:=EnvironmentContext.new(); context.setup(world)
	var bytes:=PackedByteArray(); bytes.resize(8); bytes.fill(0)
	context.apply({"cw":4,"ch":2,"cell":8,"cloud":Marshalls.raw_to_base64(bytes),"rain":Marshalls.raw_to_base64(bytes),"wet":Marshalls.raw_to_base64(bytes),"wind":[.3,.7],"cy":[[1,1.0,1.0,1.5,.8,1]]})
	var first:=context.wind_at_world(Vector2(3,5)); var wrapped:=context.wind_at_world(Vector2(3+world.grid.period,5))
	check(first.is_equal_approx(wrapped),"cyclone wind is discontinuous at the world seam")
	check(first.is_finite() and first.length()>0,"weather wind field is invalid")
	context.clear(); check(context.wind_at_world(Vector2(3,5))==Vector2.ZERO,"world reload retained old atmospheric velocity")
	print("WATER_WEATHER_TESTS ",JSON.stringify({"checks":checks,"failures":failures,"solver_max_step_us":a.max_step_us}))
	quit(1 if failures.size() else 0)
