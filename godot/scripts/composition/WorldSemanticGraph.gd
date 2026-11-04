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


func setup(w: WorldState, a: WorldStateAdapter, r: RecipeRegistry, identity: VisualIdentityCache) -> void:
	world = w
	adapter = a
	registry = r
	identities = identity


func clear() -> void:
	nodes.clear(); edges.clear(); districts.clear(); district_of.clear(); at_tile.clear()
	contexts.clear(); matches.clear(); _by_chunk.clear(); _references.clear()
	_city_keys.clear(); _unit_keys.clear(); _formation_keys.clear(); _battle_keys.clear(); _bf_version = -1
	_army_keys.clear()
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
	for id in ids:
		if _refresh_context(id):
			var key := str(district_of.get(id, ""))
			if key != "":
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


func stats() -> Dictionary:
	return {"nodes": nodes.size(), "building_nodes": adapter.buildings.size(), "districts": districts.size(),
		"revision": revision, "topology_revision": topology_revision, "last_districts_touched": last_districts_touched}
