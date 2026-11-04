class_name WorldCompositionSystem
extends RefCounted
## Shared entry point for LWE services. Consumers use the authorized graph, recipe registry and
## identity channels rather than rebuilding their own interpretations of every snapshot.

var world: WorldState
var adapter := WorldStateAdapter.new()
var registry := RecipeRegistry.new()
var identities := VisualIdentityCache.new()
var graph := WorldSemanticGraph.new()
var scheduler := GenerationScheduler.new()
var lod := LODManager.new()
var weather := EnvironmentContext.new()
var sites := SitePlanner.new()
var _buildings_version := -1
var sync_us := 0


func setup(w: WorldState) -> void:
	world = w
	weather.setup(w)
	sites.setup(w)
	registry.load_defaults()
	adapter.setup(w)
	graph.setup(w, adapter, registry, identities)
	world.welcomed.connect(reset)
	world.reset.connect(reset)
	world.econ_applied.connect(sync)
	world.snapshot_applied.connect(graph.sync_actors)
	world.geo_changed.connect(graph.terrain_changed)
	world.tiles_changed.connect(func(_tiles: PackedInt32Array, roads: PackedInt32Array): graph.roads_changed(roads))
	reset()


func reset() -> void:
	adapter.clear()
	graph.clear()
	scheduler.clear()
	identities.reset(world.world_seed)
	_buildings_version = -1


func sync() -> void:
	if world.grid == null or _buildings_version == world.buildings_version:
		return
	var started := Time.get_ticks_usec()
	_buildings_version = world.buildings_version
	graph.sync_cities()
	graph.apply_buildings(adapter.sync_buildings())
	sync_us = Time.get_ticks_usec() - started


func explain_building(id: int) -> Dictionary:
	return graph.explain_building(id)


func stats() -> Dictionary:
	return {"graph": graph.stats(), "scheduler": scheduler.stats(), "recipe_errors": registry.errors,
		"sync_ms": sync_us / 1000.0}
