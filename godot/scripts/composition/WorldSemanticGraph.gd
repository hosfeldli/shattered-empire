class_name WorldSemanticGraph
extends RefCounted
## Incremental semantic relationships over authorized records. District flood fills are limited
## to components affected by a topology edit; ordinary HP/activity changes never regroup a city.

signal districts_reconciled(upserted: Array, removed: Array)
signal district_invalidated(key: String, flags: int)

const CHANGE := WorldStateAdapter.Change
var world: WorldState
var adapter: WorldStateAdapter
var registry: RecipeRegistry
var identities: VisualIdentityCache
var nodes := {}             # namespaced key -> classified semantic record
var edges := {}             # source -> relationship -> target-key set
var districts := {}         # sorted member ids -> { ids, group, owner, revision }
var district_of := {}
var at_tile := {}
var contexts := {}
var matches := {}
var revision := 0
var topology_revision := 0
var last_districts_touched := 0
var _by_chunk := {}
var _references := {}
var _city_keys := {}
var _unit_keys := {}
var _formation_keys := {}
var _army_keys := {}
var _battle_keys := {}
var _bf_version := -1
# geography, transport, environment and history layers (rebuilt as budgeted scheduler jobs)
var scheduler: GenerationScheduler
var region_of := PackedInt32Array()     # tile -> region index (-1 none)
var regions: Array = []                 # index -> {key, kind, tiles, centre}
var network_of := PackedInt32Array()    # tile -> transport network index (-1 none)
var networks: Array = []
var history := {}                       # building id -> [[time, event], ...] (bounded)
var _geo_revision := 0
var _road_revision := 0
var _weather_keys := {}
const HISTORY_LIMIT := 12
const REGION_KINDS := {4: "Forest", 9: "Mountains", 10: "Mountains", 8: "Hills", 5: "Desert", 7: "Wetland", 6: "Tundra"}


func setup(w: WorldState, a: WorldStateAdapter, r: RecipeRegistry, identity: VisualIdentityCache) -> void:
	world = w
	adapter = a
	registry = r
	identities = identity


func clear() -> void:
	nodes.clear(); edges.clear(); districts.clear(); district_of.clear(); at_tile.clear()
	contexts.clear(); matches.clear(); _by_chunk.clear(); _references.clear()
	_city_keys.clear(); _unit_keys.clear(); _formation_keys.clear(); _battle_keys.clear(); _bf_version = -1
	_army_keys.clear(); _weather_keys.clear()
	regions.clear(); networks.clear(); history.clear()
	region_of = PackedInt32Array(); network_of = PackedInt32Array()
	revision = 0
	topology_revision = 0
	last_districts_touched = 0


func apply_buildings(delta: Dictionary) -> void:
	last_districts_touched = 0
	var topology_ids := {}
	for id in delta.added + delta.removed:
		topology_ids[id] = true
	for id in delta.changed:
		if int(delta.changed[id]) & CHANGE.TOPOLOGY:
			topology_ids[id] = true
	var affected := {}
	for id in topology_ids:
		_collect_component(id, affected)
		var old = delta.previous.get(id)
		if old != null:
			_collect_neighbors(old.tile, affected)
			at_tile.erase(old.tile)
			var chunk_ids: Dictionary = _by_chunk.get(world._chunk_of(old.tile), {})
			chunk_ids.erase(id)
	for id in delta.removed:
		_remove_node(_building_key(id))
		contexts.erase(id)
		matches.erase(id)
	for id in topology_ids:
		if adapter.buildings.has(id):
			var b: WorldStateAdapter.BuildingRecord = adapter.buildings[id]
			at_tile[b.tile] = id
			var cid := world._chunk_of(b.tile)
			if not _by_chunk.has(cid):
				_by_chunk[cid] = {}
			_by_chunk[cid][id] = true
	for id in topology_ids:
		if adapter.buildings.has(id):
			_collect_neighbors(adapter.buildings[id].tile, affected)
			affected[id] = true
	if not topology_ids.is_empty():
		_reconcile_districts(affected)
	var changed := {}
	for id in delta.added:
		changed[id] = CHANGE.STRUCTURE | CHANGE.STATE | CHANGE.ACTIVITY | CHANGE.CONTEXT
		_remember(id, "first seen" if adapter.buildings[id].complete else "construction seen")
	for id in delta.removed: _remember(id, "gone from view or destroyed")
	for id in delta.changed:
		var before = delta.previous.get(id); var now = adapter.buildings.get(id)
		if before == null or now == null: continue
		if not before.complete and now.complete: _remember(id, "completed")
		if now.level > before.level: _remember(id, "upgraded to level %d" % now.level)
		if now.hp < before.hp - 15: _remember(id, "damaged to %d%%" % now.hp)
		if now.hp >= 95 and before.hp < 80: _remember(id, "repaired")
		if now.owner != before.owner: _remember(id, "changed hands")
	for id in delta.changed:
		changed[id] = int(delta.changed[id])
	for id in changed:
		_upsert_building(id)
		if not contexts.has(id) or int(changed[id]) & (CHANGE.STRUCTURE | CHANGE.CONTEXT | CHANGE.TOPOLOGY):
			_refresh_context(id,true)
		elif delta.previous.has(id) and delta.previous[id].city!=adapter.buildings[id].city:
			_link_building(id)
		var key := str(district_of.get(id, ""))
		if key != "":
			district_invalidated.emit(key, int(changed[id]))
	# Refresh only adjacency endpoints of edits, including removal across the world seam.
	var relink := {}
	for id in topology_ids:
		var old = delta.previous.get(id)
		if old != null:
			_collect_neighbor_ids(old.tile, relink)
		if adapter.buildings.has(id):
			_collect_neighbor_ids(adapter.buildings[id].tile, relink)
			relink[id] = true
	for id in relink:
		_link_building(id)
	if not changed.is_empty() or not delta.removed.is_empty():
		revision += 1


func sync_cities() -> void:
	var keep := {}
	var presence := {}
	for city in world.cities.values():
		var id := int(city.get("id", -1))
		var tile := int(city.get("t", -1))
		if id < 0 or tile < 0 or tile >= world.grid.n:
			continue
		var key := "city:%d" % id
		keep[key] = true
		if not _city_keys.has(key): presence[id] = true
		var data := {"id": id, "tile": tile, "owner": int(city.get("o", -1)),
			"tier": int(city.get("ti", 0)), "population": float(city.get("pop", 0)), "name": str(city.get("n", ""))}
		_upsert_node(key, "Settlement", "gameplay_authoritative", data)
	for key in _city_keys:
		if not keep.has(key):
			presence[int(str(key).trim_prefix("city:"))] = true
			_remove_node(key)
	_city_keys = keep
	if not presence.is_empty():
		for id in adapter.buildings:
			if presence.has(adapter.buildings[id].city): _link_building(id)


func sync_actors() -> void:
	var armies:={}; var army_of:={}
	for record in world.econ.get("armies",[]):
		var key:="army:%d"%int(record.id)
		armies[key]=true
		_upsert_node(key,"Army","gameplay_authoritative",record)
		for id in record.get("units",[]): army_of[int(id)]=key
	for key in _army_keys:
		if not armies.has(key): _remove_node(key)
	_army_keys=armies
	var formations := {}
	for record in world.econ.get("formations", []):
		var key := "formation:%d" % int(record.id)
		formations[key] = true
		_upsert_node(key,"Formation","gameplay_authoritative",record)
	for key in _formation_keys:
		if not formations.has(key): _remove_node(key)
	_formation_keys = formations
	var units := {}
	for id in world.units:
		var unit: Dictionary = world.units[id]
		var key := "unit:%d" % int(id)
		units[key] = true
		_upsert_node(key,"Unit","gameplay_authoritative",{"id":id,"tile":int(unit.tile),"owner":int(unit.owner),"type":unit.type,"hp":unit.hp,"suppression":unit.get("supp",0)})
		var links := {}
		var formation := "formation:%d" % int(unit.get("formation",0))
		if formations.has(formation): _link(links,"part_of_formation",formation)
		if army_of.has(int(id)): _link(links,"part_of_army",army_of[int(id)])
		var at:=int(unit.tile)
		if region_of.size()==world.grid.n and at>=0 and at<world.grid.n and region_of[at]>=0 and region_of[at]<regions.size(): _link(links,"in_region",str(regions[region_of[at]].key))
		_replace_edges(key,links)
	for key in _unit_keys:
		if not units.has(key): _remove_node(key)
	_unit_keys = units
	if _bf_version != world.bf_version:
		_bf_version = world.bf_version
		_sync_battle_regions()


func _sync_battle_regions() -> void:
	var active := {}
	for record in world.bf.get("i", []): active[int(record[0])] = float(record[1])
	var seen := {}
	var keep := {}
	var tiles := active.keys(); tiles.sort()
	for tile in tiles:
		if seen.has(tile): continue
		var queue := [tile]; var head := 0; var intensity := 0.0
		seen[tile] = true
		while head < queue.size():
			var t := int(queue[head]); head += 1; intensity += float(active[t])
			for dir in 6:
				var neighbor := world.grid.nb[t*6+dir]
				if active.has(neighbor) and not seen.has(neighbor):
					seen[neighbor] = true; queue.append(neighbor)
		var key := "battle:%d" % int(tile)
		keep[key] = true
		_upsert_node(key,"BattleRegion","state_derived_visual",{"tiles":queue,"intensity":intensity,"tile":tile})
	for key in _battle_keys:
		if not keep.has(key): _remove_node(key)
	_battle_keys = keep


func terrain_changed(chunks: PackedInt32Array) -> void:
	var ids := {}
	for cid in chunks:
		for id in _by_chunk.get(cid, {}):
			ids[id] = true
	var dirty_districts := {}
	for id in ids:
		_refresh_context(id)
		# A neighboring height can change a shared terrain corner without changing this
		# building's own semantic context. Its sampled site and foundations still need work.
		var key := str(district_of.get(id, ""))
		if key != "": dirty_districts[key] = true
	for key in dirty_districts:
		district_invalidated.emit(key, CHANGE.CONTEXT)


func roads_changed(tiles: PackedInt32Array) -> void:
	var ids := {}
	for tile in tiles:
		_collect_neighbor_ids(tile, ids)
		if at_tile.has(tile):
			ids[at_tile[tile]] = true
	for id in ids:
		if _refresh_context(id):
			var key := str(district_of.get(id, ""))
			if key != "":
				district_invalidated.emit(key, CHANGE.CONTEXT)


func _collect_component(id: int, out: Dictionary) -> void:
	var key := str(district_of.get(id, ""))
	if districts.has(key):
		for member in districts[key].ids:
			out[member] = true
	else:
		out[id] = true


func _collect_neighbor_ids(tile: int, out: Dictionary) -> void:
	for dir in 6:
		var neighbor := world.grid.nb[tile * 6 + dir]
		if at_tile.has(neighbor):
			out[at_tile[neighbor]] = true


func _collect_neighbors(tile: int, out: Dictionary) -> void:
	var ids := {}
	_collect_neighbor_ids(tile, ids)
	for id in ids:
		_collect_component(id, out)


func _reconcile_districts(affected: Dictionary) -> void:
	var old_keys := {}
	for id in affected:
		if district_of.has(id):
			old_keys[district_of[id]] = true
	var fresh := {}
	var visited := {}
	var candidates := affected.keys()
	candidates.sort()
	for id in candidates:
		if visited.has(id) or not adapter.buildings.has(id):
			continue
		var first: WorldStateAdapter.BuildingRecord = adapter.buildings[id]
		var queue := [id]
		var head := 0
		var members := []
		visited[id] = true
		while head < queue.size():
			var current := int(queue[head])
			head += 1
			members.append(current)
			if district_of.has(current):
				old_keys[district_of[current]] = true
			if not first.mergeable():
				continue
			var b: WorldStateAdapter.BuildingRecord = adapter.buildings[current]
			for dir in 6:
				var tile := world.grid.nb[b.tile * 6 + dir]
				var other := int(at_tile.get(tile, -1))
				if visited.has(other) or not adapter.buildings.has(other):
					continue
				var neighbor: WorldStateAdapter.BuildingRecord = adapter.buildings[other]
				if neighbor.mergeable() and neighbor.group == first.group and neighbor.owner == first.owner:
					visited[other] = true
					queue.append(other)
		members.sort()
		var key := ",".join(members.map(func(value): return str(value)))
		fresh[key] = {"ids": members, "group": first.group, "owner": first.owner}
	var removed := []
	for key in old_keys:
		if districts.has(key):
			for id in districts[key].ids:
				district_of.erase(id)
		if not fresh.has(key):
			removed.append(key)
			districts.erase(key)
			_remove_node("district:" + key)
	var upserted := []
	for key in fresh:
		var next: Dictionary = fresh[key]
		var old: Dictionary = districts.get(key, {})
		next["revision"] = int(old.get("revision", 0)) + 1
		districts[key] = next
		for id in next.ids:
			district_of[id] = key
		_upsert_node("district:" + key, "District", "state_derived_visual", {"members": next.ids, "owner": next.owner, "group": next.group})
		upserted.append(key)
	last_districts_touched = upserted.size() + removed.size()
	topology_revision += 1
	districts_reconciled.emit(upserted, removed)


func _upsert_building(id: int) -> void:
	var b: WorldStateAdapter.BuildingRecord = adapter.buildings[id]
	_upsert_node(_building_key(id), "Building", "gameplay_authoritative", {"id": b.id, "tile": b.tile,
		"type": b.type, "owner": b.owner, "level": b.level, "complete": b.complete,
		"hp": b.hp, "progress": b.progress, "active": b.active, "fire": b.fire})


func _refresh_context(id: int, force_recipe := false) -> bool:
	if not adapter.buildings.has(id):
		return false
	var b: WorldStateAdapter.BuildingRecord = adapter.buildings[id]
	var context := adapter.context_for(b.tile)
	var changed:bool = contexts.get(id, {}) != context
	contexts[id] = context
	if changed or force_recipe or not matches.has(id):
		matches[id] = registry.resolve_building(b, context)
		_link_building(id)
	if changed:
		revision += 1
	return changed


func _link_building(id: int) -> void:
	if not adapter.buildings.has(id) or not nodes.has(_building_key(id)):
		return
	var b: WorldStateAdapter.BuildingRecord = adapter.buildings[id]
	var links := {}
	var district := str(district_of.get(id, ""))
	if district != "" and nodes.has("district:" + district):
		_link(links, "belongs_to_district", "district:" + district)
	if nodes.has("city:%d" % b.city):
		_link(links, "belongs_to_city", "city:%d" % b.city)
	var neighbors := {}
	_collect_neighbor_ids(b.tile, neighbors)
	for neighbor in neighbors:
		if nodes.has(_building_key(neighbor)):
			_link(links, "adjacent_to", _building_key(neighbor))
	var context: Dictionary = contexts.get(id, {})
	if context.get("terrain_known", false) and float(context.get("slope", 0)) > 0.15:
		var site := "slope:%d" % b.tile
		_feature(site, "TerrainFeature", {"tile": b.tile, "feature": "slope", "slope": context.slope})
		_link(links, "located_on_slope", site)
	for tile in context.get("river_tiles", []):
		var key := "river:%d" % int(tile)
		_feature(key, "TerrainFeature", {"tile": tile, "feature": "river"})
		_link(links, "near_river", key)
	for tile in context.get("coast_tiles", []):
		var key := "coast:%d" % int(tile)
		_feature(key, "TerrainFeature", {"tile": tile, "feature": "coast"})
		_link(links, "near_coast", key)
	if int(context.get("deposit", 0)) > 0:
		var key := "resource:%d" % b.tile
		_feature(key, "ResourceSite", {"tile": b.tile, "deposit": context.deposit})
		_link(links, "supported_by", key)
	if region_of.size() == world.grid.n and region_of[b.tile] >= 0 and region_of[b.tile] < regions.size():
		_link(links, "within_region", str(regions[region_of[b.tile]].key))
	if network_of.size() == world.grid.n:
		for t in [b.tile] + Array(range(6)).map(func(d): return world.grid.nb[b.tile * 6 + d]):
			if int(t) >= 0 and network_of[int(t)] >= 0 and network_of[int(t)] < networks.size():
				_link(links, "served_by_network", str(networks[network_of[int(t)]].key)); break
	for edge in context.get("roads", []):
		var a := mini(b.tile, int(edge.to))
		var z := maxi(b.tile, int(edge.to))
		var key := "road:%d:%d:%d" % [a, z, int(edge.type)]
		_feature(key, "Infrastructure", {"a": a, "b": z, "road_type": edge.type, "broken": edge.broken}, "gameplay_authoritative")
		_link(links, "adjacent_to_infrastructure", key)
		if not edge.broken:
			_link(links, "connected_by_rail" if int(edge.type) == 4 else "connected_by_road", key)
	_replace_edges(_building_key(id), links)


func _building_key(id: int) -> String:
	return "building:%d" % id


func _upsert_node(key: String, kind: String, authority: String, data: Dictionary) -> void:
	var old: Dictionary = nodes.get(key, {})
	if not old.is_empty() and old.data == data:
		return
	nodes[key] = {"key": key, "kind": kind, "authority": authority, "scope": "received_state",
		"revision": int(old.get("revision", 0)) + 1, "data": data.duplicate(true)}


func _feature(key: String, kind: String, data: Dictionary, authority := "state_derived_visual") -> void:
	_upsert_node(key, kind, authority, data)
	nodes[key]["ephemeral"] = true


func _link(links: Dictionary, relation: String, target: String) -> void:
	if not links.has(relation):
		links[relation] = {}
	links[relation][target] = true


func _replace_edges(source: String, links: Dictionary) -> void:
	if edges.get(source,{})==links: return
	for targets in links.values():
		for target in targets:
			_references[target] = int(_references.get(target, 0)) + 1
	var old: Dictionary = edges.get(source, {})
	for targets in old.values():
		for target in targets:
			_references[target] = int(_references.get(target, 0)) - 1
			if int(_references[target]) <= 0:
				_references.erase(target)
				if nodes.get(target, {}).get("ephemeral", false):
					nodes.erase(target)
	edges[source] = links


func _remove_node(key: String) -> void:
	_replace_edges(key, {})
	edges.erase(key)
	nodes.erase(key)


func explain_building(id: int) -> Dictionary:
	if not adapter.buildings.has(id):
		return {"available": false, "reason": "Entity is not present in this viewer's authorized state"}
	var recipe: Dictionary = matches.get(id, {})
	return {"available": true, "node": nodes.get(_building_key(id), {}).duplicate(true),
		"relationships": edges.get(_building_key(id), {}).duplicate(true),
		"context": contexts.get(id, {}).duplicate(true), "recipe": recipe.duplicate(true),
		"identity": identities.describe(_building_key(id), str(recipe.get("id", "fallback.structure")), int(recipe.get("version", 1)))}


## ------------------------------------------------------------------ history
func _remember(id: int, event: String) -> void:
	var list: Array = history.get(id, [])
	list.append([snappedf(world.server_time, 1.0), event])
	while list.size() > HISTORY_LIMIT: list.pop_front()
	history[id] = list
	if history.size() > 6000:
		for key in history.keys().slice(0, 500): history.erase(key)


## ------------------------------------------------------------------ geography
## Connected terrain regions over known hexes (forests, mountain massifs, deserts, wetlands, seas,
## lakes, rivers). Rebuilt as a low-priority, budgeted job when known geography changes.
func schedule_geography() -> void:
	if scheduler == null or world.grid == null: return
	_geo_revision += 1
	var n := world.grid.n
	var index := PackedInt32Array(); index.resize(n); index.fill(-1)
	var found: Array = []
	var state := {"next": 0}
	scheduler.enqueue("graph:geography", _geo_revision, GenerationScheduler.Priority.LOW, func():
		var end := mini(int(state.next) + 2048, n)
		for t in range(int(state.next), end):
			if index[t] >= 0 or not world.known[t]: continue
			var kind := _region_kind(t)
			if kind == "": continue
			var queue := [t]; var head := 0; index[t] = found.size()
			while head < queue.size():
				var at := int(queue[head]); head += 1
				for d in 6:
					var nb := world.grid.nb[at * 6 + d]
					if nb >= 0 and index[nb] < 0 and world.known[nb] and _region_kind(nb) == kind:
						index[nb] = found.size(); queue.append(nb)
			found.append({"key": "region:%s:%d" % [kind.to_lower(), t], "kind": kind, "tiles": queue.size(), "centre": int(queue[queue.size() / 2])})
		state.next = end
		return end >= n, func():
			for old in regions: _remove_node(str(old.key))
			regions = found; region_of = index
			for record in regions:
				_upsert_node(str(record.key), "TerrainRegion" if not record.kind in ["River", "Lake", "Sea"] else "WaterBody", "state_derived_visual",
					{"kind": record.kind, "tiles": record.tiles, "centre": record.centre})
			revision += 1)


func _region_kind(t: int) -> String:
	if world.is_river(t): return "River"
	if world.is_lake(t): return "Lake"
	if world.is_sea(t): return "Sea"
	return str(REGION_KINDS.get(world.biome(t), ""))


## ------------------------------------------------------------------ transport
## Connected road/rail networks from authoritative road edges; buildings link to the network
## that actually reaches them.
func schedule_transport() -> void:
	if scheduler == null or world.grid == null: return
	_road_revision += 1
	var n := world.grid.n
	var index := PackedInt32Array(); index.resize(n); index.fill(-1)
	var found: Array = []
	var state := {"next": 0}
	scheduler.enqueue("graph:transport", _road_revision, GenerationScheduler.Priority.LOW, func():
		var end := mini(int(state.next) + 4096, n)
		for t in range(int(state.next), end):
			if index[t] >= 0 or world.road[t] == 0: continue
			var queue := [t]; var head := 0; index[t] = found.size(); var rail := false
			while head < queue.size():
				var at := int(queue[head]); head += 1
				for d in 6:
					var kind := (int(world.road[at]) >> (d * 4)) & 7
					if kind <= 0: continue
					if kind == 4: rail = true
					var nb := world.grid.nb[at * 6 + d]
					if nb >= 0 and index[nb] < 0: index[nb] = found.size(); queue.append(nb)
			found.append({"key": "network:%d" % t, "tiles": queue.size(), "rail": rail})
		state.next = end
		return end >= n, func():
			for old in networks: _remove_node(str(old.key))
			networks = found; network_of = index
			for record in networks:
				_upsert_node(str(record.key), "TransportNetwork", "gameplay_authoritative", {"tiles": record.tiles, "rail": record.rail})
			for id in adapter.buildings: _link_building(id)
			revision += 1)


## ------------------------------------------------------------------ environment
func sync_environment(weather: EnvironmentContext) -> void:
	var keep := {}
	if weather == null or weather.columns <= 0: return
	for cell in weather.columns * weather.rows:
		var tile := (cell / weather.columns) * weather.cell * world.grid.w + (cell % weather.columns) * weather.cell
		if tile < 0 or tile >= world.grid.n: continue
		var here: Dictionary = weather.at_tile(tile)
		var kind := "Storm" if float(here.get("storm", 0)) > .35 else "Rain" if float(here.get("rain", 0)) > .3 else "Snow" if float(here.get("snow", 0)) > .3 else "Fog" if float(here.get("fog", 0)) > .5 else ""
		if kind == "": continue
		var key := "weather:%d" % cell
		keep[key] = true
		_upsert_node(key, "EnvironmentalRegion", "state_derived_visual", {"kind": kind, "tile": tile})
	for key in _weather_keys:
		if not keep.has(key): _remove_node(key)
	_weather_keys = keep


## ------------------------------------------------------------------ explanation
## Everything the presentation knows about one hex and why: terrain region, transport network,
## building recipe/identity/history, units and their memberships, battle and weather context.
func explain_tile(tile: int) -> Dictionary:
	if world.grid == null or tile < 0 or tile >= world.grid.n or not world.known[tile]:
		return {"available": false, "reason": "Hex not known to this viewer"}
	var out := {"available": true, "tile": tile, "known": true, "visible": world.is_visible(tile)}
	if region_of.size() == world.grid.n and region_of[tile] >= 0 and region_of[tile] < regions.size(): out["region"] = regions[region_of[tile]]
	if network_of.size() == world.grid.n and network_of[tile] >= 0 and network_of[tile] < networks.size(): out["network"] = networks[network_of[tile]]
	if at_tile.has(tile):
		var id := int(at_tile[tile])
		out["building"] = explain_building(id)
		out["history"] = history.get(id, [])
	var units := []
	for key in _unit_keys:
		var node: Dictionary = nodes.get(key, {})
		if int(node.get("data", {}).get("tile", -1)) == tile: units.append({"node": node.get("data", {}), "links": edges.get(key, {})})
	out["units"] = units
	for key in _battle_keys:
		if tile in (nodes.get(key, {}).get("data", {}).get("tiles", []) as Array): out["battle"] = nodes[key].data; break
	return out


func stats() -> Dictionary:
	return {"nodes": nodes.size(), "building_nodes": adapter.buildings.size(), "districts": districts.size(),
		"regions": regions.size(), "networks": networks.size(), "weather_regions": _weather_keys.size(), "histories": history.size(),
		"revision": revision, "topology_revision": topology_revision, "last_districts_touched": last_districts_touched}
