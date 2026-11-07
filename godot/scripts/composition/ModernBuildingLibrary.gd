class_name ModernBuildingLibrary
extends RefCounted
## Modern post-collapse compositions for defences, military, civic and extraction sites, replacing
## earlier medieval-looking placeholders (stone castle fort, timber watchtower, temple academy).
## Visual language: repaired concrete, prefabricated modules, containers, steel and earthworks.
## Every element stays inside the authoritative parcel; nothing here changes gameplay.
const TYPES := ["fort", "guard_post", "bunker", "barracks", "camp", "academy", "university", "oil_well", "airfield", "aa_battery", "comms_tower", "port"]
const OLIVE := Color(.58, .6, .5)
const HAZARD := Color(.92, .72, .22)


static func compose(k: MeshKit, b: Dictionary, type: String, tint: Color, team: Color) -> bool:
	if not type in TYPES: return false
	var lv := int(b.get("lv", 1))
	var flag := "team:" + team.to_html(false)
	match type:
		"fort": _fort(k, tint, flag)
		"guard_post": _guard_post(k, tint, flag)
		"bunker": _bunker(k, tint)
		"barracks": _barracks(k, tint, flag, lv)
		"camp": _camp(k, tint)
		"academy": _campus(k, tint, false)
		"university": _campus(k, tint, true)
		"oil_well": _pumpjack(k, tint, lv, int(b.get("a", 0)) if int(b.get("d", 0)) == 1 and int(b.get("hp", 100)) >= 35 else 0)
		"airfield": _airfield(k, tint, flag)
		"aa_battery": _aa(k, tint)
		"comms_tower": _mast(k, tint)
		"port": _port(k, tint, lv)
	return true


## Earth-covered concrete casemates around a central command bunker; berms between them and a
## sheltered vehicle yard. Reads as a modern strongpoint, not a castle.
static func _fort(k: MeshKit, tint: Color, flag: String) -> void:
	for i in 6:
		var a := deg_to_rad(-90.0 + 60.0 * i)
		var p := Vector3(cos(a) * .56, 0, sin(a) * .56)
		k.cone("soil", p, .2, .1, 10, Color(.74, .68, .52))                       # earth cover
		k.box("concrete", p + Vector3(0, 0, 0), Vector3(.2, .085, .16), tint * Color(.86, .86, .82), -a + PI * .5)
		var slit := p + Vector3(cos(a), 0, sin(a)) * .085
		k.box("char", slit + Vector3(0, .045, 0), Vector3(.12, .018, .006), Color.WHITE, -a + PI * .5)
		var nxt := deg_to_rad(-90.0 + 60.0 * (i + 1))
		var mid := (p + Vector3(cos(nxt) * .56, 0, sin(nxt) * .56)) * .5
		k.box("soil", mid, Vector3(.42, .06, .09), Color(.72, .66, .5), -(a + nxt) * .5)   # connecting berm
	k.box("concrete", Vector3(0, 0, 0), Vector3(.28, .14, .24), tint)
	k.box("concrete", Vector3(0, .14, 0), Vector3(.3, .02, .26), tint * .92)
	k.box("steel", Vector3(.1, .16, -.08), Vector3(.008, .26, .008))
	k.box(flag, Vector3(.125, .38, -.08), Vector3(.05, .032, .004))
	for i in 2:
		k.box("steel", Vector3(-.2 + i * .12, 0, .3), Vector3(.1, .045, .06), OLIVE)  # parked vehicles


## A checkpoint: prefabricated lookout cabin on steel legs, concrete barriers, a boom gate and
## a sandbagged weapon position.
static func _guard_post(k: MeshKit, tint: Color, flag: String) -> void:
	for x in [-.06, .06]:
		for z in [-.06, .06]:
			k.box("steel", Vector3(x, 0, z), Vector3(.016, .26, .016), tint * Color(.7, .72, .7))
	k.box("concrete", Vector3(0, .26, 0), Vector3(.18, .11, .18), tint)
	k.box("glass", Vector3(0, .3, .091), Vector3(.15, .04, .004))
	k.box("glass", Vector3(.091, .3, 0), Vector3(.004, .04, .15))
	k.box("steel", Vector3(0, .37, 0), Vector3(.21, .015, .21), tint * .8)
	k.box("steel", Vector3(.07, .385, -.07), Vector3(.006, .16, .006))
	k.box(flag, Vector3(.092, .52, -.07), Vector3(.045, .028, .004))
	for i in 4:
		k.box("concrete", Vector3(-.3 + i * .13, 0, .24), Vector3(.11, .05, .035), Color(.86, .85, .8))   # jersey barriers
	k.box("steel", Vector3(.3, 0, .1), Vector3(.03, .07, .03), HAZARD)
	k.box("steel", Vector3(.3, .065, .02), Vector3(.012, .012, .2), Color(.95, .9, .85))                # boom gate
	for i in 5:
		var a := PI * .15 + PI * .7 * i / 4.0
		k.box("canvas", Vector3(-.22 + cos(a) * .1, 0, -.18 + sin(a) * .1), Vector3(.06, .03, .035), Color(.8, .75, .56), -a)
	k.box("steel", Vector3(-.22, .03, -.13), Vector3(.08, .012, .012), Color(.3, .3, .3))


## Low reinforced concrete, mostly buried in an earth berm, with a dark firing aperture.
static func _bunker(k: MeshKit, tint: Color) -> void:
	k.cone("soil", Vector3(0, 0, 0), .3, .1, 12, Color(.72, .66, .5))
	k.box("concrete", Vector3(0, 0, .02), Vector3(.3, .09, .24), tint * .9)
	k.box("concrete", Vector3(0, .09, .02), Vector3(.34, .025, .28), tint * .84)
	k.box("char", Vector3(0, .05, .141), Vector3(.2, .022, .005))
	k.box("concrete", Vector3(-.2, 0, -.16), Vector3(.05, .04, .14), tint)                              # entrance cut
	k.box("canvas", Vector3(.2, 0, .18), Vector3(.12, .035, .05), Color(.8, .75, .56), .3)


## Prefabricated accommodation blocks around a parade ground, vehicle shed and flag.
static func _barracks(k: MeshKit, tint: Color, flag: String, lv: int) -> void:
	k.box("paving", Vector3(.05, .002, .05), Vector3(.42, .01, .3), Color(.8, .79, .76))
	for i in 2:
		var z := -.24 + i * .5
		k.box("concrete", Vector3(-.3, 0, z), Vector3(.18, .12 + (.07 if lv >= 2 else 0.0), .14), tint)
		k.box("steel", Vector3(-.3, .12 + (.07 if lv >= 2 else 0.0), z), Vector3(.19, .012, .15), tint * .8)
		for w in 3: k.box("glass", Vector3(-.36 + w * .06, .06, z + .071), Vector3(.03, .03, .004))
	k.box("corrugated", Vector3(.3, 0, -.22), Vector3(.2, .11, .16), OLIVE)                              # vehicle shed
	k.box("char", Vector3(.3, .005, -.139), Vector3(.14, .08, .004))
	for i in 3: k.box("painted_metal", Vector3(.16 + i * .08, 0, .3), Vector3(.07, .05, .1), [OLIVE, Color(.5, .52, .46), OLIVE][i])   # containers
	k.box("steel", Vector3(.05, 0, .05), Vector3(.008, .32, .008))
	k.box(flag, Vector3(.077, .29, .05), Vector3(.05, .032, .004))
	for i in 4: k.box("timber", Vector3(-.05 + i * .06, 0, -.05), Vector3(.012, .05, .05), Color(.62, .5, .36))   # training frames


## Rebel encampment: irregular tents and containers behind scrap barricades.
static func _camp(k: MeshKit, tint: Color) -> void:
	for i in 3:
		var a := TAU * i / 3.0 + .4
		k.gable("canvas", Vector3(cos(a) * .25, 0, sin(a) * .25), .14, .2, .1, Color(.6, .58, .46), -a)
	k.box("painted_metal", Vector3(.05, 0, -.05), Vector3(.18, .07, .08), Color(.55, .38, .3), .4)
	k.box("painted_metal", Vector3(-.1, 0, .12), Vector3(.12, .06, .07), Color(.36, .42, .38), -.3)
	for i in 6:
		var a := TAU * i / 6.0
		k.box("steel", Vector3(cos(a) * .45, 0, sin(a) * .42), Vector3(.12, .045, .03), Color(.45, .4, .35), -a + PI * .5 + (i % 2) * .4)
	k.cylinder("char", Vector3(0, 0, .02), .04, .01, 8)


## A modern technical college or university: glazed teaching blocks, a laboratory with roof
## plant, solar arrays, paths and trees around a courtyard.
static func _campus(k: MeshKit, tint: Color, university: bool) -> void:
	var s := 1.18 if university else 1.0
	k.box("paving", Vector3(0, .002, .08), Vector3(.5 * s, .008, .2), Color(.86, .85, .8))
	k.box("concrete", Vector3(-.12 * s, 0, -.14), Vector3(.36 * s, .17 * s, .16), tint)
	k.box("glass", Vector3(-.12 * s, .03, -.059), Vector3(.33 * s, .11 * s, .004))
	k.box("steel", Vector3(-.12 * s, .17 * s, -.14), Vector3(.37 * s, .01, .17), tint * .85)
	for i in 3: k.box("glass", Vector3(-.24 * s + i * .1 * s, .18 * s, -.14), Vector3(.08, .006, .12), Color(.35, .42, .55))   # solar
	k.box("concrete", Vector3(.26 * s, 0, -.02), Vector3(.16, .12 + (.1 if university else 0.0), .3), tint * Color(.95, .97, 1.0))
	k.box("glass", Vector3(.181 * s + .0, .04, -.02), Vector3(.004, .06, .26))
	k.box("steel", Vector3(.26 * s, .12 + (.1 if university else 0.0), .05), Vector3(.08, .04, .06), Color(.75, .77, .76))     # lab plant
	if university:
		k.box("concrete", Vector3(-.2, 0, .3), Vector3(.3, .13, .12), tint)
		k.box("glass", Vector3(-.2, .03, .239), Vector3(.27, .07, .004))
	for i in 4:
		var p := Vector3(-.22 + i * .14, 0, .14)
		k.cylinder("bark", p, .008, .05, 5)
		k.cone("foliage", p + Vector3(0, .04, 0), .04, .09, 7, Color(.82, .95, .75))


## A working pumpjack: walking beam on an A-frame, horse head, crank and counterweight, wellhead
## and storage tanks. (The beam pose is static here; motion comes from activity presentation.)
static func _pumpjack(k: MeshKit, tint: Color, lv: int, b_active := 0) -> void:
	k.box("concrete", Vector3(0, 0, 0), Vector3(.36, .02, .1), Color(.8, .79, .75))
	for z in [-.03, .03]:
		k.box("steel", Vector3(.0, .02, z), Vector3(.02, .17, .02), HAZARD, 0.0)
	# The walking beam and horse head are animated separately (WildlifePresentation) when the
	# well is producing; an idle well shows them at rest here only when not animated.
	if int(b_active) == 0:
		k.box("steel", Vector3(.01, .19, 0), Vector3(.32, .025, .03), HAZARD)
		k.box("steel", Vector3(.17, .15, 0), Vector3(.04, .08, .035), tint * Color(.4, .4, .4))       # horse head
	k.box("steel", Vector3(.18, .02, 0), Vector3(.008, .12, .008), Color(.3, .3, .3))                  # polished rod
	k.box("steel", Vector3(-.13, .05, 0), Vector3(.06, .07, .05), Color(.35, .35, .35))               # counterweight
	k.cylinder("steel", Vector3(.18, .02, 0), .02, .03, 8, Color(.5, .45, .4))
	for i in mini(1 + lv, 3):
		k.cylinder("steel", Vector3(-.25 + i * .11, 0, .25), .045, .1, 12, tint * Color(.9, .9, .86))
	k.box("steel", Vector3(-.08, .015, .17), Vector3(.3, .01, .01), Color(.4, .4, .4))                 # flowline


## Runway with markings, a parallel taxiway, arched hangars, apron and a control tower.
static func _airfield(k: MeshKit, tint: Color, flag: String) -> void:
	k.box("asphalt", Vector3(0, .002, -.08), Vector3(1.5, .012, .2), Color(.6, .6, .6))
	for i in 9: k.box("concrete", Vector3(-.6 + i * .15, .015, -.08), Vector3(.07, .002, .012), Color(1.6, 1.6, 1.5))
	for x in [-.71, .71]:
		for z in [-.14, -.02]: k.box("concrete", Vector3(x, .015, z), Vector3(.04, .002, .025), Color(1.6, 1.6, 1.5))
	k.box("asphalt", Vector3(0, .002, .1), Vector3(1.2, .01, .06), Color(.55, .55, .55))
	k.box("asphalt", Vector3(-.1, .002, .3), Vector3(.62, .01, .2), Color(.62, .62, .6))                # apron
	for i in 2:
		var p := Vector3(-.3 + i * .3, 0, .38)
		k.cylinder("corrugated", p, .1, .16, 10, Color(.66, .68, .66), .1)
		k.box("corrugated", p + Vector3(0, 0, -.001), Vector3(.2, .09, .19), Color(.62, .64, .62))
		k.box("char", p + Vector3(0, .0, -.096), Vector3(.14, .08, .004))
	k.box("concrete", Vector3(.42, 0, .32), Vector3(.08, .26, .08), tint)
	k.box("glass", Vector3(.42, .26, .32), Vector3(.12, .05, .12), Color(.5, .62, .7))
	k.box("steel", Vector3(.42, .31, .32), Vector3(.13, .01, .13), tint * .8)
	k.box("steel", Vector3(.48, .32, .36), Vector3(.006, .12, .006))
	k.box(flag, Vector3(.5, .42, .36), Vector3(.04, .026, .004))


## Anti-aircraft battery: revetted gun pit with a twin-barrel mount angled skyward and a radar.
static func _aa(k: MeshKit, tint: Color) -> void:
	k.cylinder("canvas", Vector3(0, 0, 0), .2, .06, 14, Color(.8, .75, .56), .22)
	k.cylinder("steel", Vector3(0, .02, 0), .06, .05, 10, OLIVE)
	k.box("steel", Vector3(0, .07, 0), Vector3(.1, .05, .08), OLIVE)
	for z in [-.02, .02]:
		k.box("steel", Vector3(.06, .12, z), Vector3(.18, .012, .012), Color(.3, .3, .3), 0.0)
	k.box("steel", Vector3(-.25, 0, .18), Vector3(.012, .2, .012), Color(.6, .6, .6))
	k.box("steel", Vector3(-.25, .2, .18), Vector3(.1, .06, .008), Color(.85, .85, .82))              # radar panel
	k.box("canvas", Vector3(.22, 0, -.2), Vector3(.12, .05, .08), Color(.62, .6, .48))               # ammunition


## A tapering lattice communications mast with dishes and an equipment shelter.
static func _mast(k: MeshKit, tint: Color) -> void:
	k.box("concrete", Vector3(.2, 0, .12), Vector3(.16, .1, .12), tint)
	var legs := [Vector2(-.07, -.07), Vector2(.07, -.07), Vector2(0, .07)]
	for leg in legs:
		k.box("steel", Vector3(leg.x * .6, 0, leg.y * .6), Vector3(.014, .9, .014), Color(.85, .85, .85))
	for i in 8:
		var y := .1 + i * .1
		k.box("steel", Vector3(0, y, -.042), Vector3(.09, .006, .006), Color(.8, .3, .25) if i % 2 == 0 else Color(.9, .9, .9))
		k.box("steel", Vector3(0, y + .05, .0), Vector3(.006, .006, .09), Color(.85, .85, .85))
	for i in 2:
		k.cylinder("steel", Vector3(.05 - i * .1, .7 - i * .15, .05), .04, .012, 10, Color(.92, .92, .9))
	k.box("glow:ff5a3a", Vector3(0, .9, 0), Vector3(.02, .02, .02))


## A modern working harbour: concrete quay and pier toward the water side (+x), a gantry crane
## over the berth, a warehouse and stacked shipping containers; upgrades add stacks and a crane.
static func _port(k: MeshKit, tint: Color, lv: int) -> void:
	k.box("concrete", Vector3(.12, -.01, 0), Vector3(.5, .03, .5), Color(.78, .77, .74))
	k.box("concrete", Vector3(.55, -.02, -.05), Vector3(.5, .03, .14), Color(.76, .75, .72))          # pier
	for i in 5: k.box("concrete", Vector3(.36 + i * .1, -.06, .02), Vector3(.025, .05, .025), Color(.6, .6, .58))
	k.box("corrugated", Vector3(-.22, 0, -.12), Vector3(.26, .15, .22), tint * Color(.85, .87, .88))       # warehouse
	k.gable("corrugated", Vector3(-.22, .15, -.12), .22, .26, .05, tint * .9, PI * .5)
	k.box("char", Vector3(-.22, .0, -.009), Vector3(.12, .09, .004))
	var palette := [Color(.72, .32, .24), Color(.24, .42, .58), Color(.82, .62, .22), Color(.38, .5, .36)]
	for i in 3 + lv * 2:
		var col := i % 3; var row := i / 3
		k.box("painted_metal", Vector3(-.05 + col * .07, row * .035, .16), Vector3(.065, .033, .12), palette[i % 4])
	for crane in mini(lv, 2):
		var z := -.05 + crane * .16
		for x in [.42, .56]:
			k.box("steel", Vector3(x, 0, z - .05), Vector3(.012, .26, .012), HAZARD)
			k.box("steel", Vector3(x, 0, z + .05), Vector3(.012, .26, .012), HAZARD)
		k.box("steel", Vector3(.5, .26, z), Vector3(.36, .02, .11), HAZARD)
		k.box("steel", Vector3(.58, .2, z), Vector3(.012, .06, .012), Color(.3, .3, .3))
