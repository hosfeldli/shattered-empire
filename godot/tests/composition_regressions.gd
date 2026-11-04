extends SceneTree

var checks := 0
var failures: Array[String] = []
var invalidations: Array = []


func _initialize() -> void:
	call_deferred("_run")


func check(ok: bool, message: String) -> void:
	checks += 1
	if not ok:
		failures.append(message)
		push_error(message)


func _building(id: int, tile: int, type := "house") -> Dictionary:
	return {"id": id, "t": tile, "ty": type, "o": 0, "c": 10, "d": 1, "st": "operational", "hp": 100, "p": 100, "a": 1}


func _sync(w: WorldState, system: WorldCompositionSystem) -> void:
	w.buildings_version += 1
	system.sync()


func _run() -> void:
	var w := WorldState.new()
	root.add_child(w)
	w.apply_welcome({"seed": 7, "defs": {"W": 32, "H": 16}, "world": {"wrap": true}})
	var system := WorldCompositionSystem.new()
	system.setup(w)
	var graph := system.graph
	graph.district_invalidated.connect(func(key, flags): invalidations.append([key, flags]))
	w.cities[10] = {"id": 10, "t": 100, "o": 0, "pop": 100, "ti": 1, "n": "Test"}
	w.buildings = {1: _building(1, 100), 2: _building(2, 101), 3: _building(3, 102), 4: _building(4, 300, "farm")}
	_sync(w, system)
	check(system.registry.errors.is_empty(), "recipe catalog must validate")
	check(graph.districts.has("1,2,3") and graph.districts.has("4"), "adjacent houses must share a district, distant farm must stay separate")
	check(graph.edges["building:1"].adjacent_to.has("building:2"), "building adjacency missing")
	check(graph.edges["building:1"].belongs_to_city.has("city:10"), "explicit city assignment missing")
	check(graph.explain_building(1).recipe.id == "residential.compound", "residential recipe must explain its selection")
	var topology := graph.topology_revision
	var distant_revision := int(graph.districts["4"].revision)
	var identity: Dictionary = graph.explain_building(3).identity
	invalidations.clear()
	w.buildings[1].hp = 88
	_sync(w, system)
	check(graph.topology_revision == topology, "minor HP change regrouped districts")
	check(invalidations.size() == 1 and invalidations[0][0] == "1,2,3" and int(invalidations[0][1]) == WorldStateAdapter.Change.STATE, "HP change must invalidate only its own district state")
	check(graph.districts["4"].revision == distant_revision, "local state update touched a distant district")
	invalidations.clear()
	_sync(w, system)
	check(invalidations.is_empty(), "identical snapshot must not invalidate geometry")
	w.buildings.erase(2)
	_sync(w, system)
	check(graph.districts.has("1") and graph.districts.has("3") and not graph.districts.has("1,2,3"), "removing a district's bridge building must split the component")
	check(not graph.at_tile.has(101) and not graph.nodes.has("building:2"), "removed building remains in graph/picking index")
	check(graph.districts["4"].revision == distant_revision, "component split rebuilt a distant district")
	w.buildings[3].o = 1
	w.buildings[3].lv = 2
	_sync(w, system)
	check(graph.explain_building(3).identity == identity, "ownership/level change randomized architectural identity")
	w.buildings.erase(3)
	_sync(w, system)
	check(not graph.explain_building(3).available, "lost visibility must not expose a removed enemy's live record")
	# Unknown terrain must not leak slope, river or coast information into recipe decisions.
	w.known.fill(0)
	w.known[100] = 1
	w.height[100] = 1
	w.height[101] = 50
	w.geo[100 * 6 + 1] = 2
	w.geo[101 * 6 + 3] = 1
	var context := system.adapter.context_for(100)
	check(context.slope == 0 and context.river_tiles.is_empty() and context.coast_tiles.is_empty(), "unknown neighbor terrain leaked into context")
	w.road[100] = 4
	graph.roads_changed(PackedInt32Array([100]))
	check(graph.edges["building:1"].connected_by_rail.has("road:100:101:4"), "actual rail edge missing")
	w.road[100] = 12
	graph.roads_changed(PackedInt32Array([100]))
	check(not graph.edges["building:1"].has("connected_by_rail"), "broken transport edge still described as connected")
	w.known[101] = 1
	w.height[101] = 2
	graph.terrain_changed(PackedInt32Array([w._chunk_of(100)]))
	check(graph.edges["building:1"].has("located_on_slope") and graph.edges["building:1"].has("near_river"), "newly authorized geography did not update local relationships")
	for links in graph.edges.values():
		for targets in links.values():
			for target in targets:
				check(graph.nodes.has(target), "dangling semantic relationship: " + target)
	var seeds := VisualIdentityCache.new()
	seeds.reset(7)
	var roof := seeds.seed_for("building:1", "house", 1, "roof")
	seeds.seed_for("building:2", "house", 1, "layout")
	check(roof == seeds.seed_for("building:1", "house", 1, "roof"), "generation order changed identity")
	check(roof != seeds.seed_for("building:1", "house", 1, "pedestrian_route"), "independent visual purposes share a seed")
	seeds.reset(7)
	check(roof == seeds.seed_for("building:1", "house", 1, "roof"), "reconnect/reload changed reconstructable identity")
	var scheduler := GenerationScheduler.new()
	var commits := []
	scheduler.enqueue("decoration", 1, GenerationScheduler.Priority.LOW, func(): return true, func(): commits.append("decoration"))
	scheduler.enqueue("bridge", 1, GenerationScheduler.Priority.CRITICAL, func(): return true, func(): commits.append("bridge"))
	scheduler.tick(0)
	check(commits.is_empty(), "zero generation budget must do no work")
	scheduler.tick(100000)
	check(commits == ["bridge", "decoration"], "generation priority was ignored")
	commits.clear()
	scheduler.enqueue("roof", 1, GenerationScheduler.Priority.HIGH, func():
		scheduler.enqueue("roof", 2, GenerationScheduler.Priority.HIGH, func(): return true, func(): commits.append("new"))
		return true,
		func(): commits.append("stale"))
	scheduler.tick(100000)
	check(commits == ["new"] and scheduler.superseded > 0, "superseded geometry result committed")
	system.reset()
	check(graph.nodes.is_empty() and graph.edges.is_empty() and not scheduler.has_pending(), "world reset leaked graph or generation jobs")
	print("COMPOSITION_TESTS ", JSON.stringify({"checks": checks, "failures": failures}))
	quit(0 if failures.is_empty() else 1)
