class_name DecisionHelpers
extends RefCounted
## Small, state-derived helpers that put decisions in front of the player: what a growth plan
## would use, what is known about a military objective, why a resource is short and what fixes
## it. Everything reads only what this client legitimately knows (explored terrain, visible
## troops, own economy); uncertainty is said, never guessed away.

const GROWTH_KINDS := {
	"housing": ["Housing", "Homes, shops and schools gather around streets", "house"],
	"industry": ["Industry", "Workshops and mills gather on freight roads", "steel_mill"],
	"farming": ["Farming", "Fields spread over the fertile land", "farm"],
}
const GROWTH_RADIUS := 2

## resource -> [producer building, deposit resource id or -1, short cause]
const PRODUCERS := {
	"food": ["farm", -1, "Farms and fishing supply food"],
	"materials": ["lumber", 5, "Timber mills, quarries and salvage yards supply materials"],
	"ore": ["mine", 2, "Mines on iron or coal deposits supply ore"],
	"steel": ["steel_mill", -1, "Steel mills turn ore into steel"],
	"fuel": ["oil_well", 1, "Oil wells (on oil) and synthetic refineries supply fuel"],
	"electronics": ["electronics_plant", -1, "Electronics plants supply electronics"],
	"munitions": ["munitions_plant", -1, "Munitions plants supply munitions"],
	"credits": ["market", -1, "Markets and trade earn credits"],
}


## Guide Growth: open the map target for a city and kind (the server checks reach and borders).
static func start_guide_growth(app: Node, city_id: int, kind: String) -> void:
	var title: String = "Guide growth · " + str(GROWTH_KINDS.get(kind, ["Growth"])[0])
	app.command_tools.target_command({"c": "cityGrowth", "city": city_id, "kind": kind, "tile": "@map"}, title, "point", false, false)
	app.command_tools.growth_city = city_id


## A short description of a candidate growth area: free land, roads, what is already there.
static func growth_preview(world: WorldState, city_id: int, tile: int, kind: String) -> Array:
	var city: Dictionary = world.cities.get(city_id, {})
	if city.is_empty() or tile < 0: return ["", false]
	var reach := int(city.get("r", 3))
	if world.grid.dist(tile, int(city.t)) > reach: return ["Too far from %s (within %d hexes of the centre)" % [str(city.n), reach], false]
	if int(world.tile_owner[tile]) != world.civ_id: return ["Outside your borders", false]
	var free := 0; var roads := 0; var same := 0; var water := 0
	var kinds: Dictionary = {"housing": ["house", "market", "academy"], "industry": ["lumber", "quarry", "mine", "salvage", "power_plant", "oil_well", "steel_mill", "refinery", "munitions_plant", "electronics_plant"], "farming": ["farm"]}
	for t in world.grid.disk(tile, GROWTH_RADIUS):
		if world.is_sea(t) or world.is_lake(t) or world.is_river(t): water += 1; continue
		var b := _building_on(world, t)
		if b.is_empty(): free += 1
		elif str(b.ty) in kinds.get(kind, []): same += 1
		if int(world.road[t]) > 0: roads += 1
	var parts: PackedStringArray = []
	parts.append("%d open hexes" % free)
	if same > 0: parts.append("joins %d existing" % same)
	parts.append("road access" if roads > 0 else "no road yet")
	if water > 0 and kind == "farming": parts.append("water nearby")
	return [", ".join(parts), free > 0]


## What is known about a place as a military objective (never more than this client can see).
static func assess_objective(world: WorldState, tile: int, kind: String) -> String:
	if tile < 0: return ""
	if not world.known[tile]: return "Unexplored ground · defences unknown"
	var parts: PackedStringArray = []
	var enemies := 0; var fortified := 0
	for t in world.grid.disk(tile, 2):
		for record in world.fw:
			if int(record[0]) == t and int(record[1]) != world.civ_id: fortified += 1
		var b := _building_on(world, t)
		if not b.is_empty() and int(b.o) != world.civ_id and str(b.ty) in ["guard_post", "bunker", "fort", "aa_battery"]: fortified += 2
	for unit in world.units.values():
		if int(unit.owner) != world.civ_id and world.grid.dist(int(unit.tile), tile) <= 3: enemies += 1
	if fortified >= 3: parts.append("strong enemy fortifications")
	elif fortified > 0: parts.append("some enemy works")
	if enemies > 0: parts.append("%d enemy units seen" % enemies)
	elif world.is_visible(tile): parts.append("no enemy troops in sight")
	else: parts.append("not in sight: defences may have changed")
	var cover := _cover_word(world, tile)
	if kind == "defend": parts.append(cover)
	elif kind in ["offensive", "attack"] and cover == "open ground": parts.append("exposed approach")
	var supplied: bool = (world.supply_bits[tile >> 3] & (1 << (tile & 7))) != 0 if world.supply_bits.size() > tile >> 3 else false
	parts.append("within supply" if supplied else "beyond supply lines")
	return " · ".join(parts).capitalize() if parts.size() == 1 else (parts[0].capitalize() + " · " + " · ".join(parts.slice(1)))


static func _cover_word(world: WorldState, tile: int) -> String:
	var biome := world.biome(tile)
	if biome in [3, 4]: return "wooded cover"
	if biome in [8, 9]: return "high ground"
	var b := _building_on(world, tile)
	if not b.is_empty(): return "built-up cover"
	return "open ground"


static func _building_on(world: WorldState, tile: int) -> Dictionary:
	for b in world.buildings.values():
		if int(b.t) == tile: return b
	return {}


## Why a resource is short and what fixes it: [cause, producer type or "", deposit tile or -1].
static func resource_fix(world: WorldState, good: String) -> Dictionary:
	var info: Dictionary = world.econ.get("resources", {}).get(good, {})
	var spec: Array = PRODUCERS.get(good, ["", -1, ""])
	var cause := str(info.get("why", ""))
	if cause.is_empty() or cause == "<null>": cause = str(spec[2])
	var producer := str(spec[0])
	var defs: Dictionary = world.defs.get("BUILDINGS", {}).get(producer, {})
	var unlocked: bool = not defs.is_empty() and int(defs.get("age", 0)) <= int(world.econ.get("age", 0)) and (str(defs.get("tech", "")).is_empty() or str(defs.get("tech", "")) in world.econ.get("techs", []))
	var deposit := -1
	if int(spec[1]) >= 0:
		var best := 1 << 30
		var home := world.start_tile
		for city in world.cities.values():
			if int(city.o) == world.civ_id: home = int(city.t); break
		for t in world.grid.n:
			if not world.known[t] or world.deposit(t) != int(spec[1]) or not _building_on(world, t).is_empty(): continue
			var d := world.grid.dist(t, home)
			if d < best: best = d; deposit = t
	var lock := "" if unlocked or defs.is_empty() else "%s needs %s" % [str(defs.get("name", producer)), str(world.defs.get("TECHS", {}).get(str(defs.get("tech", "")), {}).get("name", "a later era"))]
	return {"cause": cause, "producer": producer if unlocked else "", "producer_name": str(defs.get("name", producer)), "deposit": deposit, "locked": lock}
