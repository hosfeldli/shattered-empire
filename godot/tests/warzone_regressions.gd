extends SceneTree
## Physical terrain presentation regressions; no simulation rules are changed by this test.

var checks:=0
var failures:Array[String]=[]

func _initialize() -> void: call_deferred("run")

func check(ok:bool,reason:String) -> void:
	checks+=1
	if not ok: failures.append(reason); push_error(reason)

func run() -> void:
	var world:=WorldState.new(); root.add_child(world)
	world.apply_welcome({"seed":42,"defs":{"W":32,"H":16},"world":{"wrap":true}})
	world.known.fill(1); world.height.fill(.8)
	for tile in world.grid.n: world.geo[tile*6+1]=2
	var terrain:=WorldRenderer.new(); root.add_child(terrain); terrain.setup(world); terrain._on_welcome()
	var tile:=100; var center:=world.grid.center(tile)
	var original:=world.ground_height(center.x,center.y)
	world.bf={"c":[[tile,3]]}; world._refresh_visual_craters()
	var damaged:=world.ground_height(center.x,center.y)
	check(damaged<original-.05,"recorded crater did not recess visual terrain")
	check(absf(world.ground_height(center.x+world.grid.period,center.y)-damaged)<.00001,"crater changed across the wrap seam")
	for corner in world.grid.corners:
		check(absf(world.visual_crater_delta(tile,center.x+corner.x,center.y+corner.y))<.00001,"crater deformed a shared hex boundary")
	var chunk:=world._chunk_of(tile)
	check(terrain.dirty.has(chunk),"crater did not invalidate its terrain chunk")
	terrain._begin_chunk(chunk); terrain._append_tile(tile)
	var vertices:PackedVector3Array=PackedVector3Array(terrain.build_job.vt)
	var lowest:=INF
	for vertex in vertices: lowest=minf(lowest,vertex.y)
	check(vertices.size()>18 and lowest<original-.03,"terrain mesh did not contain a recessed crater")
	var copy:=WorldState.new(); root.add_child(copy)
	copy.apply_welcome({"seed":42,"defs":{"W":32,"H":16},"world":{"wrap":true}})
	copy.known.fill(1); copy.height.fill(.8)
	for cell in copy.grid.n: copy.geo[cell*6+1]=2
	copy.bf={"c":[[tile,3]]}; copy._refresh_visual_craters()
	check(absf(copy.ground_height(center.x,center.y)-damaged)<.00001,"crater layout changed after reconstruction")
	world.road[tile]=1; world._refresh_visual_craters()
	check(not world.visual_craters.has(tile) and absf(world.ground_height(center.x,center.y)-original)<.00001,"crater detached an authoritative road from terrain")
	world.road[tile]=0; world.buildings={1:{"t":tile}}; world._refresh_visual_craters()
	check(not world.visual_craters.has(tile),"crater deformed the ground below a building")
	world.buildings.clear(); world._refresh_visual_craters()
	world.bf={"c":[]}; world._refresh_visual_craters()
	check(not world.visual_craters.has(tile) and absf(world.ground_height(center.x,center.y)-original)<.00001,"cleared crater remained in terrain")
	print("WARZONE_TESTS ",JSON.stringify({"checks":checks,"failures":failures}))
	quit(0 if failures.is_empty() else 1)
