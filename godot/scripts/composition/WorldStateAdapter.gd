class_name WorldStateAdapter
extends RefCounted
## Typed, immutable-by-convention presentation records from the already-filtered WorldState.
## No discovery, economy, pathfinding or ownership rules live here.

enum Change { STRUCTURE = 1, STATE = 2, ACTIVITY = 4, CONTEXT = 8, TOPOLOGY = 16 }
var world: WorldState
var buildings := {}


class BuildingRecord extends RefCounted:
	var id := -1
	var tile := -1
	var owner := -1
	var city := -1
	var type := ""
	var group := ""
	var level := 1
	var tier := 0
	var complete := false
	var lifecycle := "planned"
	var hp := 100
	var progress := 0
	var active := false
	var fire := false
	var source := {}
	var structure_key: Array = []
	var state_key: Array = []
	var activity_key: Array = []
	var topology_key: Array = []

	func mergeable() -> bool:
		return complete and group != "" and lifecycle not in ["planned", "ruined"]


func setup(w: WorldState) -> void:
	world = w


func clear() -> void:
	buildings.clear()


func record(b: Dictionary) -> BuildingRecord:
	var out := BuildingRecord.new()
	out.id = int(b.id) if typeof(b.get("id")) in [TYPE_INT, TYPE_FLOAT] else -1
	out.tile = int(b.t) if typeof(b.get("t")) in [TYPE_INT, TYPE_FLOAT] else -1
	out.owner = int(b.o) if typeof(b.get("o")) in [TYPE_INT, TYPE_FLOAT] else -1
	out.city = int(b.c) if typeof(b.get("c")) in [TYPE_INT, TYPE_FLOAT] else -1
	out.type = b.ty if b.get("ty") is String else ""
	out.group = str(RecipeRegistry.GROUPS.get(out.type, ""))
	out.level = maxi(1, int(b.get("lv", 1)))
	out.tier = int(b.get("ti", 0))
	out.complete = int(b.get("d", 0)) == 1
	out.lifecycle = str(b.get("st", "operational" if out.complete else "construction"))
	out.hp = clampi(int(b.get("hp", 100)), 0, 100)
	out.progress = clampi(int(b.get("p", 0)), 0, 100)
	out.active = int(b.get("a", 0)) == 1 and out.complete and out.lifecycle != "ruined"
	out.fire = int(b.get("f", 0)) == 1
	# WorldState replaces complete wire records on each economy snapshot. Keep this immutable
	# record rather than deep-copying every optional queue and production array every tick.
	out.source = b
	out.structure_key = [out.type, out.tile, out.owner, out.level, out.tier, out.complete, out.lifecycle == "ruined"]
	out.state_key = [out.hp, out.lifecycle, out.city]
	out.activity_key = [out.progress, out.active, out.fire]
	out.topology_key = [out.tile, out.owner, out.group, out.mergeable()]
	return out


func sync_buildings() -> Dictionary:
	var delta := {"added": [], "removed": [], "changed": {}, "previous": {}}
	var seen := {}
	for b in world.buildings.values():
		var next := record(b)
		if next.id < 0 or next.owner < 0 or next.tile < 0 or next.tile >= world.grid.n or next.type == "":
			continue
		seen[next.id] = true
		var old: BuildingRecord = buildings.get(next.id)
		if old == null:
			delta.added.append(next.id)
		else:
			var flags := 0
			if old.structure_key != next.structure_key:
				flags |= Change.STRUCTURE
			if old.state_key != next.state_key:
				flags |= Change.STATE
			if old.activity_key != next.activity_key:
				flags |= Change.ACTIVITY
			if old.topology_key != next.topology_key:
				flags |= Change.TOPOLOGY
			if flags != 0:
				delta.changed[next.id] = flags
				delta.previous[next.id] = old
		buildings[next.id] = next
	for id in buildings.keys():
		if not seen.has(id):
			delta.removed.append(id)
			delta.previous[id] = buildings[id]
			buildings.erase(id)
	return delta


## Only sample received geometry. Unknown neighbors contribute neither slope nor water facts.
func context_for(tile: int) -> Dictionary:
	var out := {"terrain_known": false, "slope": 0.0, "river_tiles": [], "river_geometry":[], "coast_tiles": [], "roads": []}
	if world.grid == null or tile < 0 or tile >= world.grid.n:
		return out
	out.terrain_known = world.known[tile] != 0
	if out.terrain_known:
		out["biome"] = world.biome(tile)
		out["elevation"] = world.tile_height(tile)
		out["deposit"] = world.deposit(tile)
		if world.is_river(tile):
			out.river_tiles.append(tile)
			out.river_geometry.append([tile,world.flow_dir(tile),world.flow_bucket(tile)])
	for dir in 6:
		var neighbor := world.grid.nb[tile * 6 + dir]
		if neighbor < 0:
			continue
		var edge := (world.road[tile] >> (dir * 4)) & 15
		if (edge & 7) != 0:
			out.roads.append({"to": neighbor, "type": edge & 7, "broken": (edge & 8) != 0, "dir": dir})
		if not out.terrain_known or world.known[neighbor] == 0:
			continue
		out.slope = maxf(float(out.slope), absf(world.height[neighbor] - world.height[tile]))
		if world.is_river(neighbor):
			out.river_tiles.append(neighbor)
			out.river_geometry.append([neighbor,world.flow_dir(neighbor),world.flow_bucket(neighbor)])
		if world.is_sea(neighbor) != world.is_sea(tile):
			out.coast_tiles.append(neighbor)
	return out
