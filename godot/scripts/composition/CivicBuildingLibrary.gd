class_name CivicBuildingLibrary
extends RefCounted
## Modern post-collapse compositions for the settlement hub (by city tier), farms (one estate
## seat per connected farm district, field equipment elsewhere), the timber mill, mines and
## quarries matched to their deposit, the power plant, the legacy supply depot and the land-side
## port, built from the reusable component library (ComponentKit / assets/components). They
## replace the earlier timber-and-gable placeholders. Everything stays inside the authoritative
## parcel; activity details appear only when the server reports the building active.
const TYPES := ["town", "farm", "lumber", "mine", "quarry", "power_plant", "depot"]


## ctx: {"seat": bool (farm estate head), "deposit": int, "active": bool, "team": Color, "tier": int}
static func compose(k: MeshKit, b: Dictionary, type: String, tint: Color, ctx: Dictionary) -> bool:
	if not type in TYPES: return false
	var lv := int(b.get("lv", 1))
	var active := bool(ctx.get("active", false))
	var rng := RandomNumberGenerator.new(); rng.seed = int(b.get("t", 0)) * 7919 + type.hash()
	match type:
		"town": _hub(k, int(ctx.get("tier", 0)), tint, "team:" + (ctx.get("team", Color.WHITE) as Color).to_html(false), rng)
		"farm": _farm(k, lv, tint, bool(ctx.get("seat", true)), active, rng)
		"lumber": _sawmill(k, lv, tint, active)
		"mine": _mine(k, lv, tint, int(ctx.get("deposit", 0)), active)
		"quarry": _quarry(k, lv, tint, active)
		"power_plant": _power(k, lv, tint)
		"depot": _depot(k, tint, active)
	return true


## Settlement hub: a repaired modern municipal building (concrete and glass, flag, roof solar)
## on a civic forecourt. City tiers add a plaza and apartments (City), mid-rise offices and
## streetlights (Metropolis) and a cluster of towers (Megacity). Each tier only adds.
static func _hub(k: MeshKit, tier: int, tint: Color, flag: String, rng: RandomNumberGenerator) -> void:
	k.box("paving", Vector3(0, .002, .2), Vector3(.5, .008, .2), Color(.9, .88, .84))
	k.part("office_low", Vector3(-.04, .01, -.08), 0.0, 1.35, tint)
	k.box("concrete", Vector3(.16, .01, -.08), Vector3(.1, .12, .17), tint * Color(.95, .95, .92))
	k.box("glass", Vector3(.16, .04, .006), Vector3(.08, .07, .003))
	k.part("solar_array", Vector3(-.04, .255, -.08), 0.0, .9)
	k.box("steel", Vector3(.2, .012, .17), Vector3(.006, .26, .006))
	k.box(flag, Vector3(.226, .23, .17), Vector3(.05, .032, .003))
	for i in 3: k.part("parked_car", Vector3(-.2 + i * .07, .01, .3), PI * .5, 1.0, [Color(.75, .3, .25), Color(.8, .8, .78), Color(.3, .4, .55)][i])
	k.part("bus_shelter", Vector3(.05, .01, .32), 0.0, 1.0)
	if tier >= 1:
		k.part("apartment_block", Vector3(-.32, .01, -.05), PI * .5, 1.0, tint)
		k.box("stone", Vector3(.0, .01, .18), Vector3(.05, .05, .05), Color(.82, .8, .76))      # memorial
		for x in [-.12, .12]:
			k.cylinder("bark", Vector3(x, .01, .2), .006, .04, 5)
			k.cone("foliage", Vector3(x, .04, .2), .03, .07, 7, Color(.8, .95, .75))
	if tier >= 2:
		k.part("office_tall", Vector3(.33, .01, -.18), 0.0, 1.0, tint)
		k.part("apartment_tall", Vector3(-.34, .01, .22), 0.0, .85, tint)
		for x in [-.22, .0, .22]: k.part("streetlight", Vector3(x, .01, .38), 0.0, 1.0)
	if tier >= 3:
		k.part("office_tall", Vector3(.3, .01, .2), PI * .5, 1.35, tint * Color(.92, .95, 1.0))
		k.part("office_tall", Vector3(-.14, .01, -.32), 0.0, 1.6, tint * Color(.95, .97, 1.0))
		k.part("satellite_dish", Vector3(-.14, .01 + .42 * 1.6, -.32), rng.randf() * TAU, 1.0)


## A farm: the estate seat carries the farmstead (corrugated barn, silos, machine shed, tractor,
## hay); other farms in the same estate carry field equipment only, so a large farm district never
## repeats a barn on every hex. Upgrades add silos and greenhouses without moving anything.
static func _farm(k: MeshKit, lv: int, tint: Color, seat: bool, active: bool, rng: RandomNumberGenerator) -> void:
	if seat:
		k.box("corrugated", Vector3(.04, .02, 0), Vector3(.26, .13, .17), tint * Color(.85, .55, .45))
		k.gable("corrugated", Vector3(.04, .15, 0), .17, .26, .06, tint * Color(.8, .5, .42), PI * .5, .015)
		k.box("char", Vector3(.171, .02, 0), Vector3(.004, .1, .08))
		k.part("silo", Vector3(-.15, .01, .06), 0.0, 1.0, tint)
		if lv >= 2: k.part("silo", Vector3(-.15, .01, -.05), 0.0, .9, tint)
		k.box("corrugated", Vector3(.02, .02, .2), Vector3(.18, .07, .09), tint * Color(.75, .78, .78))
		if active: k.part("tractor", Vector3(.16, .02, .18), rng.randf() * TAU, 1.0, Color(.3, .55, .3))
		k.part("hay_bales", Vector3(-.08, .02, -.18), rng.randf() * .4, 1.0)
	else:
		if rng.randf() < .5: k.part("center_pivot", Vector3(-.15, .02, 0), rng.randf() * TAU, 1.0)
		else:
			k.part("hay_bales", Vector3(.0, .02, .0), rng.randf() * TAU, 1.0)
			k.box("corrugated", Vector3(.14, .02, -.12), Vector3(.08, .05, .06), tint * Color(.75, .78, .78))
		if active and rng.randf() < .4: k.part("tractor", Vector3(.1, .02, .1), rng.randf() * TAU, 1.0, Color(.3, .55, .3))
	if lv >= 3: k.part("greenhouse", Vector3(.04, .02, -.2 if seat else .18), 0.0, 1.0)


## Contemporary salvaged sawmill: a long open steel shed over the saw line, log decks, an
## infeed conveyor, sawn timber stacks and a log loader when working.
static func _sawmill(k: MeshKit, lv: int, tint: Color, active: bool) -> void:
	k.box("concrete", Vector3(-.06, .01, 0), Vector3(.36, .01, .2), Color(.84, .83, .8))
	for x in [-.22, -.1, .02, .1]:
		for z in [-.09, .09]: k.box("steel", Vector3(x, .02, z), Vector3(.01, .12, .01), tint)
	k.gable("corrugated", Vector3(-.06, .14, 0), .2, .36, .05, tint, PI * .5, .02)
	k.box("steel", Vector3(-.06, .02, 0), Vector3(.28, .03, .04), Color(.6, .62, .6))
	k.part("conveyor", Vector3(.2, .02, 0), PI, .7)
	for z in [-.2, .2]: k.part("log_pile", Vector3(.25, .02, z), 0.0, 1.0)
	for i in 3: k.box("timber", Vector3(-.24 + i * .07, .02, .2), Vector3(.05, .03 + i * .008, .06), Color(1.05, .92, .72))
	if lv >= 2: k.part("log_pile", Vector3(-.25, .02, -.2), 0.0, 1.0)
	if lv >= 3: k.box("corrugated", Vector3(-.28, .02, .02), Vector3(.1, .1, .14), tint)
	if active: k.part("excavator", Vector3(.12, .02, -.22), PI * .7, 1.0, Color(.95, .72, .2))


## Mines follow the deposit: coal and iron get a shaft headframe, winding house, conveyor and an
## ore or coal stockpile; a shaft into bare rock gets a smaller adit portal. Levels add a second
## conveyor and processing shed.
static func _mine(k: MeshKit, lv: int, tint: Color, deposit: int, active: bool) -> void:
	var heap := Color(.22, .21, .2) if deposit == 3 else Color(.72, .45, .34) if deposit == 2 else Color(.62, .6, .57)
	k.box("concrete", Vector3(0, .01, 0), Vector3(.5, .008, .36), Color(.78, .76, .72))
	if deposit in [2, 3]:
		k.part("headframe", Vector3(.05, .018, -.06), 0.0, 1.1, tint)
	else:
		k.box("rock", Vector3(-.05, .01, -.14), Vector3(.24, .14, .1), Color(.75, .72, .68))
		k.box("char", Vector3(-.05, .02, -.088), Vector3(.07, .07, .004))
		k.box("timber", Vector3(-.05, .09, -.086), Vector3(.09, .012, .008), Color(.7, .6, .45))
	k.part("conveyor", Vector3(.2, .018, .12), PI * .5, .9)
	k.cone("rubble", Vector3(.22, .018, .26), .1, .08, 10, heap)
	k.box("corrugated", Vector3(-.2, .018, .14), Vector3(.12, .08, .1), tint)
	if lv >= 2:
		k.part("conveyor", Vector3(-.12, .018, -.02), 0.0, .7)
		k.box("corrugated", Vector3(-.26, .018, -.08), Vector3(.1, .12, .1), tint * Color(.9, .92, .95))
	if lv >= 3: k.part("silo", Vector3(.3, .018, -.12), 0.0, 1.1, tint)
	if active: k.part("cargo_truck", Vector3(.06, .018, .22), 0.0, 1.0, Color(.9, .75, .3))


## Quarry: stepped benches cut into the working face, crusher, conveyor to a ballast heap and haul
## trucks when working. Levels widen the cut and add a second crusher line.
static func _quarry(k: MeshKit, lv: int, tint: Color, active: bool) -> void:
	for tier in 3 + mini(lv - 1, 2):
		var y := .015 + tier * .06; var z := -.28 + tier * .05 - (tier - 2) * .0
		k.box("rock", Vector3(-.06, 0, z - tier * .05), Vector3(.6 - tier * .05, y + .06, .09), tint * Color(.92, .91, .87))
		k.box("rock", Vector3(-.36 + tier * .02, 0, -.08), Vector3(.08, y + .05, .32 - tier * .04), tint * Color(.9, .88, .83))
	k.box("steel", Vector3(.18, .015, -.02), Vector3(.1, .08, .1), Color(.62, .62, .6))
	k.box("painted_metal", Vector3(.18, .095, -.02), Vector3(.12, .02, .12), Color(.95, .72, .2))
	k.part("conveyor", Vector3(.25, .015, .12), PI * .5, .8)
	k.cone("ballast", Vector3(.26, .015, .3), .1, .08, 10, tint)
	for i in 4: k.box("stone", Vector3(-.05 + (i % 2) * .09, .015 + (i / 2) * .03, .22), Vector3(.08, .03, .08), tint * Color(.95, .92, .84))
	if active: k.part("cargo_truck", Vector3(.02, .015, .1), PI * .2, 1.0, Color(.95, .72, .2))
	if lv >= 2: k.part("excavator", Vector3(-.1, .1, -.18), PI * .5, 1.0, Color(.95, .72, .2))


## Restored conventional thermal power station: turbine hall, boiler house, chimney stack,
## cooling towers and a transformer yard. Levels add a second cooling tower and switchgear.
static func _power(k: MeshKit, lv: int, tint: Color) -> void:
	k.box("concrete", Vector3(-.18, .02, -.05), Vector3(.3, .16, .2), tint)
	k.sawtooth("corrugated", "glass", Vector3(-.18, .18, -.05), .3, .2, .04, 3, tint, PI * .5)
	k.box("corrugated", Vector3(-.02, .02, -.05), Vector3(.1, .26, .16), tint * Color(.9, .92, .95))
	k.part("chimney_stack", Vector3(.06, .02, -.18), 0.0, 1.0, tint)
	k.part("cooling_tower", Vector3(.28, .02, -.18), 0.0, .95, tint)
	if lv >= 2: k.part("cooling_tower", Vector3(.28, .02, .2), 0.0, .9, tint)
	for x in [-.2, -.1]: k.part("transformer", Vector3(x, .02, .22), 0.0, 1.0)
	k.part("pipe_rack", Vector3(.0, .02, .12), 0.0, 1.0)
	if lv >= 3: k.part("transformer", Vector3(.0, .02, .25), 0.0, 1.0)


static func _depot(k: MeshKit, tint: Color, active: bool) -> void:
	k.box("concrete", Vector3(0, .01, 0), Vector3(.6, .008, .4), Color(.8, .79, .76))
	k.box("corrugated", Vector3(-.1, .018, -.08), Vector3(.34, .14, .2), tint)
	k.gable("corrugated", Vector3(-.1, .158, -.08), .2, .34, .04, tint, PI * .5, .01)
	for x in [-.2, -.1, 0.0]: k.box("char", Vector3(x, .018, .021), Vector3(.06, .08, .003))
	for i in 3: k.part("container", Vector3(.2, .018 + (i / 2) * .08, -.15 + (i % 2) * .08), 0.0, 1.0, [Color(.7, .3, .25), Color(.3, .45, .6), Color(.55, .6, .4)][i])
	k.part("pallet_stack", Vector3(-.15, .018, .14), 0.0, 1.0)
	if active: k.part("cargo_truck", Vector3(.05, .018, .15), PI, 1.0, Color(.8, .8, .78))


## Port on the shore (older rulesets): a concrete quay along the water side, a container gantry,
## stacked containers and a terminal shed. Not used while ports stand on the water hex
## (ModernBuildingLibrary's terminal); kept for sandbox scenes that place a port ashore.
static func _port_land(k: MeshKit, lv: int, tint: Color, active: bool) -> void:
	k.box("concrete", Vector3(.25, 0, 0), Vector3(.3, .04, .7), Color(.82, .81, .78))
	k.part("gantry_crane", Vector3(.25, .04, -.1), PI * .5, .8, Color(.95, .5, .25))
	for i in 4: k.part("container", Vector3(-.05, .01 + (i / 2) * .08, -.2 + (i % 2) * .09), PI * .5, 1.0, [Color(.7, .3, .25), Color(.3, .45, .6), Color(.55, .6, .4), Color(.85, .75, .3)][i])
	k.box("corrugated", Vector3(-.22, .01, .1), Vector3(.18, .12, .26), tint)
	if lv >= 2: k.part("gantry_crane", Vector3(.25, .04, .2), PI * .5, .8, Color(.95, .5, .25))
	if active: k.part("cargo_truck", Vector3(.05, .01, .2), 0.0, 1.0)
