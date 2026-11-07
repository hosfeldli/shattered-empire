class_name ComponentKit
extends RefCounted
## Source definitions of the reusable modern post-collapse component library. Each component is
## authored once in hex-radius units (1 unit ≈ 25 m, stylized realism), with its pivot at the
## centre of its base, +Y up and its front facing +Z. `tools/build_components.gd` exports every
## component to `assets/components/<id>.glb`; at runtime AssetLibrary loads the glTF (material
## slot names are the shared MaterialLibrary contract) and falls back to these definitions only
## if an asset is missing. Stable ids are listed in `recipes/assets.json` with their users.

const IDS := ["container", "storage_tank", "chimney_stack", "cooling_tower", "pipe_rack", "rooftop_hvac",
	"water_tank", "solar_array", "satellite_dish", "radar", "streetlight", "fence_panel", "gantry_crane",
	"tower_crane", "conveyor", "headframe", "excavator", "bulldozer", "parked_car", "van", "cargo_truck",
	"tractor", "silo", "greenhouse", "hay_bales", "center_pivot", "log_pile", "office_low", "office_tall",
	"apartment_block", "apartment_tall", "shop_row", "pallet_stack", "wind_turbine", "transformer", "bus_shelter"]


static func build(id: String) -> MeshKit:
	var k := MeshKit.new()
	match id:
		"container": _container(k)
		"storage_tank": _storage_tank(k)
		"chimney_stack": _chimney(k)
		"cooling_tower": _cooling_tower(k)
		"pipe_rack": _pipe_rack(k)
		"rooftop_hvac": _hvac(k)
		"water_tank": _water_tank(k)
		"solar_array": _solar(k)
		"satellite_dish": _dish(k)
		"radar": _radar(k)
		"streetlight": _streetlight(k)
		"fence_panel": _fence(k)
		"gantry_crane": _gantry(k)
		"tower_crane": _tower_crane(k)
		"conveyor": _conveyor(k)
		"headframe": _headframe(k)
		"excavator": _excavator(k)
		"bulldozer": _bulldozer(k)
		"parked_car": _car(k)
		"van": _van(k)
		"cargo_truck": _truck(k)
		"tractor": _tractor(k)
		"silo": _silo(k)
		"greenhouse": _greenhouse(k)
		"hay_bales": _hay(k)
		"center_pivot": _pivot(k)
		"log_pile": _logs(k)
		"office_low": _office(k, 3)
		"office_tall": _office(k, 7)
		"apartment_block": _apartments(k, 4)
		"apartment_tall": _apartments(k, 9)
		"shop_row": _shops(k)
		"pallet_stack": _pallets(k)
		"wind_turbine": _turbine(k)
		"transformer": _transformer(k)
		"bus_shelter": _shelter(k)
	return k


## 20-ft shipping container: corrugated walls with ribs, door end with locking bars, corner posts
static func _container(k: MeshKit) -> void:
	k.box("corrugated", Vector3(0, .004, 0), Vector3(.18, .074, .072))
	for x in range(-8, 9):
		k.box("corrugated", Vector3(x * .0105, .008, .036), Vector3(.004, .066, .003))
		k.box("corrugated", Vector3(x * .0105, .008, -.036), Vector3(.004, .066, .003))
	for x in [-.09, .09]:
		for z in [-.035, .035]: k.box("steel", Vector3(x, 0, z), Vector3(.008, .08, .008))
	for z in [-.015, .015]: k.box("steel", Vector3(.0915, .012, z), Vector3(.003, .058, .004))
	k.box("steel", Vector3(0, .078, 0), Vector3(.182, .004, .074))


## fuel/chemical storage tank: banded shell, low cone roof, spiral-ish access ladder and railing
static func _storage_tank(k: MeshKit) -> void:
	k.cylinder("concrete", Vector3.ZERO, .13, .012, 16)
	k.cylinder("painted_metal", Vector3(0, .012, 0), .11, .17, 16)
	for y in [.06, .12]: k.cylinder("steel", Vector3(0, y, 0), .112, .006, 16)
	k.cone("painted_metal", Vector3(0, .182, 0), .112, .03, 16)
	for i in 6:
		var a := i * .25
		k.box("steel", Vector3(cos(a) * .116, .03 * i, sin(a) * .116), Vector3(.02, .004, .01), Color.WHITE, -a)
	k.box("steel", Vector3(0, .2, 0), Vector3(.03, .02, .006))


static func _chimney(k: MeshKit) -> void:
	k.box("concrete", Vector3.ZERO, Vector3(.1, .03, .1))
	k.cylinder("brick", Vector3(0, .03, 0), .042, .6, 12, Color.WHITE, .028)
	for y in [.2, .4, .58]: k.cylinder("steel", Vector3(0, .03 + y, 0), .045 - y * .025, .012, 12)
	k.cylinder("char", Vector3(0, .63, 0), .03, .012, 12)
	k.box("steel", Vector3(.043, .03, 0), Vector3(.004, .6, .012))


## hyperbolic natural-draught cooling tower on a ring of legs
static func _cooling_tower(k: MeshKit) -> void:
	var rings := [[0.0, .2], [.05, .19], [.14, .15], [.24, .125], [.32, .13], [.38, .145]]
	for i in rings.size() - 1:
		k.cylinder("concrete", Vector3(0, rings[i][0], 0), rings[i][1], rings[i + 1][0] - rings[i][0], 20, Color.WHITE, rings[i + 1][1])
	for i in 12:
		var a := TAU * i / 12.0
		k.box("concrete", Vector3(cos(a) * .19, 0, sin(a) * .19), Vector3(.014, .03, .014), Color.WHITE, -a)
	k.cylinder("char", Vector3(0, .379, 0), .14, .002, 20)


static func _pipe_rack(k: MeshKit) -> void:
	for x in [-.12, 0, .12]:
		for z in [-.03, .03]: k.box("steel", Vector3(x, 0, z), Vector3(.01, .09, .01))
		k.box("steel", Vector3(x, .085, 0), Vector3(.012, .008, .07))
	for z in [-.022, 0, .022]: k.box("steel", Vector3(0, .093, z), Vector3(.26, .012, .012))
	k.box("painted_metal", Vector3(0, .105, -.01), Vector3(.26, .016, .016))


static func _hvac(k: MeshKit) -> void:
	k.box("painted_metal", Vector3.ZERO, Vector3(.07, .035, .045))
	for x in [-.018, .018]: k.cylinder("char", Vector3(x, .035, 0), .014, .002, 10)
	k.box("steel", Vector3(-.04, .005, 0), Vector3(.012, .012, .03))


static func _water_tank(k: MeshKit) -> void:
	for x in [-.025, .025]:
		for z in [-.025, .025]: k.box("steel", Vector3(x, 0, z), Vector3(.006, .05, .006))
	k.cylinder("timber", Vector3(0, .05, 0), .038, .05, 12)
	k.cone("steel", Vector3(0, .1, 0), .04, .02, 12)


static func _solar(k: MeshKit) -> void:
	for row in 2:
		var z := -.035 + row * .07
		for x in [-.06, 0, .06]: k.box("steel", Vector3(x, 0, z), Vector3(.006, .028, .006))
		var a := Vector3(-.09, .02, z - .025); var b := Vector3(.09, .02, z - .025)
		var c := Vector3(.09, .04, z + .022); var d := Vector3(-.09, .04, z + .022)
		k.quad("glass", a, b, c, d, Color(.5, .6, .9), Vector3(0, 1, -.5))
		k.quad("steel", a + Vector3(0, -.003, 0), b + Vector3(0, -.003, 0), c + Vector3(0, -.003, 0), d + Vector3(0, -.003, 0), Color.WHITE, Vector3(0, -1, .5))


static func _dish(k: MeshKit) -> void:
	k.box("concrete", Vector3.ZERO, Vector3(.05, .02, .05))
	k.cylinder("steel", Vector3(0, .02, 0), .008, .06, 8)
	k.cylinder("painted_metal", Vector3(0, .08, -.005), .006, .006, 6, Color.WHITE, .06)
	k.cone("painted_metal", Vector3(0, .074, -.006), .062, .018, 14)
	k.box("steel", Vector3(0, .1, .02), Vector3(.004, .004, .05))


static func _radar(k: MeshKit) -> void:
	k.box("painted_metal", Vector3.ZERO, Vector3(.07, .05, .06))
	k.cylinder("steel", Vector3(0, .05, 0), .01, .04, 8)
	k.box("steel", Vector3(0, .09, 0), Vector3(.12, .04, .006))
	for x in range(-5, 6): k.box("steel", Vector3(x * .011, .09, .004), Vector3(.002, .04, .002))


static func _streetlight(k: MeshKit) -> void:
	k.cylinder("steel", Vector3.ZERO, .004, .1, 6)
	k.box("steel", Vector3(.012, .098, 0), Vector3(.028, .004, .006))
	k.box("glass", Vector3(.024, .094, 0), Vector3(.012, .004, .008))


static func _fence(k: MeshKit) -> void:
	for x in [-.1, 0, .1]: k.box("steel", Vector3(x, 0, 0), Vector3(.005, .055, .005))
	k.quad("steel", Vector3(-.1, .004, 0), Vector3(.1, .004, 0), Vector3(.1, .05, 0), Vector3(-.1, .05, 0), Color(.9, .9, .9), Vector3.BACK)
	k.box("steel", Vector3(0, .052, 0), Vector3(.2, .003, .003))


## ship-to-shore container gantry crane: portal legs, boom over the quay, trolley and machinery house
static func _gantry(k: MeshKit) -> void:
	for x in [-.08, .08]:
		for z in [-.07, .07]: k.box("painted_metal", Vector3(x, 0, z), Vector3(.014, .3, .014))
		k.box("painted_metal", Vector3(x, .14, 0), Vector3(.012, .012, .15))
	k.box("painted_metal", Vector3(0, .3, 0), Vector3(.18, .02, .15))
	k.box("painted_metal", Vector3(0, .32, .14), Vector3(.05, .016, .5))
	k.box("painted_metal", Vector3(0, .34, -.06), Vector3(.08, .04, .06))
	k.box("steel", Vector3(0, .3, .25), Vector3(.03, .02, .03))
	k.box("steel", Vector3(0, .2, .25), Vector3(.002, .1, .002))
	for side in [-1.0, 1.0]: k.box("steel", Vector3(0, .32, .02 + .1 * side), Vector3(.004, .07, .004))


static func _tower_crane(k: MeshKit) -> void:
	k.box("concrete", Vector3.ZERO, Vector3(.06, .015, .06))
	for x in [-.012, .012]:
		for z in [-.012, .012]: k.box("painted_metal", Vector3(x, .015, z), Vector3(.004, .5, .004))
	for y in range(0, 10): k.box("painted_metal", Vector3(0, .02 + y * .05, 0), Vector3(.026, .003, .026), Color.WHITE, (y % 2) * .5)
	k.box("painted_metal", Vector3(.1, .5, 0), Vector3(.36, .012, .016))
	k.box("painted_metal", Vector3(-.12, .5, 0), Vector3(.1, .03, .03))
	k.box("glass", Vector3(.02, .48, .015), Vector3(.025, .02, .012))
	k.box("steel", Vector3(.2, .4, 0), Vector3(.002, .1, .002))


static func _conveyor(k: MeshKit) -> void:
	var a := Vector3(-.15, .02, 0); var b := Vector3(.15, .16, 0)
	var side := Vector3(0, 0, .016)
	k.quad("char", a - side, a + side, b + side, b - side, Color.WHITE, Vector3.UP)
	for s in [-1.0, 1.0]: k.quad("steel", a + side * s, b + side * s, b + side * s + Vector3(0, -.012, 0), a + side * s + Vector3(0, -.012, 0), Color.WHITE, side * s)
	for t in [.25, .6, .9]:
		var p := a.lerp(b, t)
		k.box("steel", Vector3(p.x, 0, 0), Vector3(.008, p.y, .03))
	k.box("painted_metal", b + Vector3(.015, -.03, 0), Vector3(.04, .05, .045))


## mine shaft headframe: A-frame legs, sheave wheel, winding house
static func _headframe(k: MeshKit) -> void:
	for z in [-.04, .04]:
		k.box("steel", Vector3(-.03, 0, z), Vector3(.012, .32, .012), Color.WHITE, 0)
		k.box("steel", Vector3(.06, 0, z), Vector3(.012, .3, .012), Color.WHITE, 0)
	for y in [.1, .2, .3]: k.box("steel", Vector3(.015, y, 0), Vector3(.1, .008, .09))
	k.cylinder("steel", Vector3(.01, .32, -.004), .045, .008, 16)
	k.box("steel", Vector3(.01, .32, 0), Vector3(.01, .01, .09))
	k.box("concrete", Vector3(-.2, 0, 0), Vector3(.12, .1, .1))
	k.box("corrugated", Vector3(-.2, .1, 0), Vector3(.13, .012, .11))
	k.box("steel", Vector3(-.09, .14, 0), Vector3(.17, .003, .003))


static func _excavator(k: MeshKit) -> void:
	for z in [-.022, .022]: k.box("char", Vector3(0, 0, z), Vector3(.08, .016, .014))
	k.box("painted_metal", Vector3(0, .016, 0), Vector3(.06, .024, .05))
	k.box("glass", Vector3(.018, .04, .012), Vector3(.022, .022, .022))
	k.box("painted_metal", Vector3(.05, .045, 0), Vector3(.07, .01, .012), Color.WHITE, .5)
	k.box("painted_metal", Vector3(.09, .03, 0), Vector3(.05, .01, .012), Color.WHITE, -.9)
	k.box("steel", Vector3(.105, 0, 0), Vector3(.02, .018, .022))


static func _bulldozer(k: MeshKit) -> void:
	for z in [-.022, .022]: k.box("char", Vector3(0, 0, z), Vector3(.07, .016, .014))
	k.box("painted_metal", Vector3(-.005, .016, 0), Vector3(.05, .024, .04))
	k.box("glass", Vector3(-.012, .04, 0), Vector3(.022, .02, .03))
	k.box("steel", Vector3(.045, 0, 0), Vector3(.008, .028, .07))


static func _car(k: MeshKit) -> void:
	k.box("painted_metal", Vector3(0, .006, 0), Vector3(.09, .022, .04))
	k.box("painted_metal", Vector3(-.006, .028, 0), Vector3(.05, .016, .036))
	k.box("glass", Vector3(-.006, .029, 0), Vector3(.052, .012, .037))
	for x in [-.028, .028]:
		for z in [-.02, .02]: k.cylinder("char", Vector3(x, 0, z), .008, .005, 6)


static func _van(k: MeshKit) -> void:
	k.box("painted_metal", Vector3(0, .006, 0), Vector3(.1, .045, .044))
	k.box("glass", Vector3(.045, .03, 0), Vector3(.012, .016, .04))
	for x in [-.032, .032]:
		for z in [-.022, .022]: k.cylinder("char", Vector3(x, 0, z), .009, .005, 6)


static func _truck(k: MeshKit) -> void:
	k.box("painted_metal", Vector3(.05, .008, 0), Vector3(.035, .045, .048))
	k.box("glass", Vector3(.068, .03, 0), Vector3(.003, .016, .04))
	k.box("canvas", Vector3(-.02, .008, 0), Vector3(.1, .055, .052))
	k.box("steel", Vector3(0, .002, 0), Vector3(.14, .008, .03))
	for x in [-.05, -.02, .05]:
		for z in [-.026, .026]: k.cylinder("char", Vector3(x, 0, z), .01, .006, 6)


static func _tractor(k: MeshKit) -> void:
	k.box("painted_metal", Vector3(.01, .01, 0), Vector3(.05, .022, .028))
	k.box("glass", Vector3(-.012, .03, 0), Vector3(.026, .026, .028))
	for z in [-.022, .022]:
		k.cylinder("char", Vector3(-.016, 0, z), .016, .008, 8)
		k.cylinder("char", Vector3(.026, 0, z), .009, .006, 8)


static func _silo(k: MeshKit) -> void:
	k.cylinder("concrete", Vector3.ZERO, .05, .01, 14)
	k.cylinder("corrugated", Vector3(0, .01, 0), .045, .2, 14)
	k.cone("steel", Vector3(0, .21, 0), .047, .035, 14)
	k.box("steel", Vector3(.046, .01, 0), Vector3(.003, .2, .012))


static func _greenhouse(k: MeshKit) -> void:
	k.box("concrete", Vector3.ZERO, Vector3(.2, .01, .09))
	k.box("glass", Vector3(0, .01, 0), Vector3(.2, .05, .09))
	k.gable("glass", Vector3(0, .06, 0), .09, .2, .03, Color.WHITE, PI * .5, 0.0)
	for x in range(-4, 5): k.box("steel", Vector3(x * .025, .01, .046), Vector3(.002, .05, .002))


static func _hay(k: MeshKit) -> void:
	for i in 5:
		var p := Vector3(-.06 + (i % 3) * .05, (i / 3) * .028, (i / 3) * .01)
		k.cylinder("crop", p + Vector3(0, .0, 0), .016, .028, 10, Color(1.3, 1.15, .7))


static func _pivot(k: MeshKit) -> void:
	k.box("steel", Vector3.ZERO, Vector3(.02, .05, .02))
	for i in 5:
		var x := .04 + i * .06
		k.box("steel", Vector3(x, 0, 0), Vector3(.004, .04, .004))
		k.cylinder("char", Vector3(x, 0, .006), .006, .004, 6)
	k.box("steel", Vector3(.15, .04, 0), Vector3(.3, .004, .004))
	for i in 10: k.box("steel", Vector3(.02 + i * .03, .03, 0), Vector3(.03, .002, .002), Color.WHITE, .5 if i % 2 == 0 else -.5)


static func _logs(k: MeshKit) -> void:
	for row in 3:
		for i in 4 - row:
			k.cylinder("bark", Vector3(-.05, .012 + row * .02, -.03 + i * .02 + row * .01), .01, .1, 7)
	k.box("timber", Vector3(-.12, 0, 0), Vector3(.012, .05, .1))


## modern repaired concrete-and-glass office/civic block: ribbon glazing, roof plant, entrance canopy
static func _office(k: MeshKit, floors: int) -> void:
	var h := .06 * floors
	k.box("concrete", Vector3.ZERO, Vector3(.2, h, .14))
	for f in floors:
		var y := .018 + f * .06
		k.box("glass", Vector3(0, y, .0705), Vector3(.18, .03, .002))
		k.box("glass", Vector3(0, y, -.0705), Vector3(.18, .03, .002))
		k.box("glass", Vector3(.1005, y, 0), Vector3(.002, .03, .12))
		k.box("glass", Vector3(-.1005, y, 0), Vector3(.002, .03, .12))
	k.box("concrete", Vector3(0, h, 0), Vector3(.204, .008, .144))
	k.box("painted_metal", Vector3(.04, h + .008, -.02), Vector3(.05, .025, .04))
	k.box("steel", Vector3(0, .035, .08), Vector3(.07, .004, .025))
	k.box("glass", Vector3(0, 0, .0712), Vector3(.05, .032, .002))


## modern residential block: storeys with recessed balconies, stair core, flat roof
static func _apartments(k: MeshKit, floors: int) -> void:
	var h := .05 * floors
	k.box("plaster", Vector3.ZERO, Vector3(.22, h, .12))
	k.box("concrete", Vector3(-.12, 0, 0), Vector3(.03, h + .02, .05))
	for f in floors:
		var y := .015 + f * .05
		for x in [-.075, -.025, .025, .075]:
			k.box("glass", Vector3(x, y, .0605), Vector3(.03, .026, .002))
			k.box("concrete", Vector3(x, y - .006, .068), Vector3(.034, .004, .016))
			k.box("steel", Vector3(x, y, .076), Vector3(.034, .012, .001))
			k.box("glass", Vector3(x, y, -.0605), Vector3(.03, .026, .002))
	k.box("concrete", Vector3(0, h, 0), Vector3(.224, .006, .124))
	k.box("painted_metal", Vector3(.05, h + .006, 0), Vector3(.03, .016, .03))


## a modern ground-floor shop row with signage band and awnings
static func _shops(k: MeshKit) -> void:
	k.box("concrete", Vector3.ZERO, Vector3(.24, .06, .08))
	for i in 4:
		var x := -.09 + i * .06
		k.box("glass", Vector3(x, .006, .0405), Vector3(.05, .036, .002))
		k.box("canvas", Vector3(x, .044, .05), Vector3(.054, .003, .02))
		k.box("painted_metal", Vector3(x, .05, .0408), Vector3(.05, .008, .001))
	k.box("concrete", Vector3(0, .06, 0), Vector3(.244, .006, .084))


static func _pallets(k: MeshKit) -> void:
	for i in 3:
		k.box("timber", Vector3(-.03 + i * .03, 0, 0), Vector3(.026, .006, .026))
		k.box("canvas", Vector3(-.03 + i * .03, .006, 0), Vector3(.022, .02 + (i % 2) * .01, .022))


static func _turbine(k: MeshKit) -> void:
	k.cylinder("concrete", Vector3.ZERO, .012, .5, 10, Color.WHITE, .007)
	k.box("painted_metal", Vector3(0, .5, .005), Vector3(.016, .014, .03))
	for i in 3:
		var a := TAU * i / 3.0
		var tip := Vector3(cos(a) * .14, .507 + sin(a) * .14, .022)
		k.quad("painted_metal", Vector3(0, .507, .022), Vector3(0, .507, .022) + Vector3(-sin(a), cos(a), 0) * .008, tip, tip + Vector3(sin(a), -cos(a), 0) * .003, Color.WHITE, Vector3.BACK)
		k.quad("painted_metal", Vector3(0, .507, .022), Vector3(0, .507, .022) + Vector3(-sin(a), cos(a), 0) * .008, tip, tip + Vector3(sin(a), -cos(a), 0) * .003, Color.WHITE, Vector3.FORWARD)


static func _transformer(k: MeshKit) -> void:
	k.box("concrete", Vector3.ZERO, Vector3(.08, .012, .06))
	k.box("painted_metal", Vector3(0, .012, 0), Vector3(.05, .04, .035))
	for x in [-.015, 0, .015]: k.cylinder("steel", Vector3(x, .052, 0), .004, .025, 6)
	for x in [-.035, .035]: k.box("steel", Vector3(x, .012, .02), Vector3(.004, .06, .004))


static func _shelter(k: MeshKit) -> void:
	k.box("steel", Vector3(-.03, 0, -.01), Vector3(.004, .045, .004))
	k.box("steel", Vector3(.03, 0, -.01), Vector3(.004, .045, .004))
	k.box("glass", Vector3(0, .005, -.012), Vector3(.06, .035, .002))
	k.box("steel", Vector3(0, .045, 0), Vector3(.07, .004, .03))
