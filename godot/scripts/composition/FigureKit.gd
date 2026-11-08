class_name FigureKit
extends RefCounted
## Human figures for troops, crews and civilians in the modern post-collapse style, with real
## proportions (about 0.085 tall: 1 unit ≈ 25 m, slightly enlarged for legibility). Each figure
## is built from limbs so poses read clearly at operational zoom: standing, two walking frames,
## kneeling to aim, and prone. Kit by role: rifle troops wear helmets, plate carriers and packs;
## militia wear caps and civilian jackets; special forces dark kit with night optics; exo infantry
## powered frames; engineers hard hats, hi-vis vests and tools; gun crews light kit; civilians
## everyday clothes. Forward is +X. Team colour appears only as a shoulder patch.

const VARIANTS := ["rifle", "militia", "special", "exo", "engineer", "crew", "civilian", "civilian_bag", "civilian_coat", "civilian_pack"]
const POSES := ["stand", "walk_a", "walk_b", "kneel", "prone"]
const SKIN := Color(1.0, .97, .95)

static var _cache := {}


static func mesh(variant: String, pose: String, team: Color) -> ArrayMesh:
	var key := "%s|%s|%s" % [variant, pose, team.to_html(false)]
	if not _cache.has(key):
		var k := MeshKit.new()
		build(k, variant, pose, team)
		_cache[key] = k.commit()
	return _cache[key]


## A low-poly figure for wide views: legs, body with kit colour, head and helmet (5 boxes).
static func build_low(k: MeshKit, variant: String, team: Color) -> void:
	var cloth: Color = {"rifle": Color(.62, .66, .5), "militia": Color(.58, .5, .4), "special": Color(.32, .35, .33), "exo": Color(.5, .54, .52)}.get(variant, Color(.62, .66, .5))
	var bulk := 1.25 if variant == "exo" else 1.0
	for side in [-1.0, 1.0]: k.box("olive", Vector3(0, 0, side * .008 * bulk), Vector3(.011 * bulk, .038, .01 * bulk), cloth * .85)
	k.box("olive", Vector3(0, .038, 0), Vector3(.018 * bulk, .03, .03 * bulk), cloth)
	k.box("skin", Vector3(.001, .071, 0), Vector3(.012, .012, .011), SKIN)
	k.box("olive", Vector3(0, .081, 0), Vector3(.016, .006, .015), cloth * .85)
	k.box("team:" + team.to_html(false), Vector3(0, .06, .0125 * bulk), Vector3(.006, .006, .002))


static func build(k: MeshKit, full_variant: String, pose: String, team: Color) -> void:
	# civilian sub-variants share the civilian body and add their own clothing and carried items
	var variant := "civilian" if full_variant.begins_with("civilian") else full_variant
	var cloth: Color = {"rifle": Color(.62, .66, .5), "militia": Color(.58, .5, .4), "special": Color(.32, .35, .33),
		"exo": Color(.5, .54, .52), "engineer": Color(.55, .58, .6), "crew": Color(.6, .64, .5), "civilian": Color(.72, .7, .66)}[variant]
	var trousers: Color = Color(.4, .44, .55) if variant in ["militia", "civilian"] else cloth * Color(.9, .9, .9)
	var mat := "olive" if variant in ["rifle", "crew", "special", "exo"] else "canvas"
	var bulk := 1.25 if variant == "exo" else 1.0
	if pose == "prone":
		_prone(k, variant, mat, cloth, trousers, team)
		return
	var kneel := pose == "kneel"
	var stride := .016 if pose == "walk_a" else -.016 if pose == "walk_b" else 0.0
	var hip := .038 if not kneel else .022
	# legs: thigh and shin per side; kneeling puts one knee down and the other foot forward
	for side in [-1.0, 1.0]:
		var z: float = side * .008 * bulk
		if kneel:
			if side < 0:
				k.box(mat, Vector3(.004, 0, z), Vector3(.012 * bulk, .022, .01 * bulk), trousers)                 # shin on the ground
				k.box(mat, Vector3(-.012, 0, z), Vector3(.03, .008, .01 * bulk), trousers)
			else:
				k.box(mat, Vector3(.018, 0, z), Vector3(.011 * bulk, .022, .01 * bulk), trousers)
				k.box(mat, Vector3(.01, .018, z), Vector3(.022, .009, .011 * bulk), trousers)
		else:
			var swing: float = stride * side
			k.box(mat, Vector3(swing * .5, .019, z), Vector3(.011 * bulk, .02, .011 * bulk), trousers)
			k.box(mat, Vector3(swing, 0, z), Vector3(.01 * bulk, .02, .01 * bulk), trousers)
		k.box("char", Vector3((stride * side if not kneel else 0.0) + .004, 0, z), Vector3(.017, .006, .011 * bulk), Color(.3, .27, .24))   # boots
	# torso, arms, head
	var torso_y := hip
	k.box(mat, Vector3(0, torso_y, 0), Vector3(.016 * bulk, .03, .024 * bulk), cloth)
	for side in [-1.0, 1.0]:
		var arm_swing: float = -stride * side * .8
		k.box(mat, Vector3(arm_swing, torso_y + .006, side * .016 * bulk), Vector3(.009, .024, .008 * bulk), cloth)
	k.box("skin", Vector3(0, torso_y + .03, 0), Vector3(.008, .004, .008), SKIN)                                     # neck
	k.box("skin", Vector3(.001, torso_y + .033, 0), Vector3(.013, .014, .012), SKIN)                                 # head
	var head_top := torso_y + .047
	match variant:
		"rifle", "crew":
			k.cylinder("olive", Vector3(0, head_top - .004, 0), .0085, .006, 8, cloth * Color(.85, .88, .8), .006)
			if variant == "rifle":
				k.box("olive", Vector3(.0, torso_y + .006, 0), Vector3(.021, .02, .027), cloth * Color(.8, .84, .76))   # plate carrier
				k.box("canvas", Vector3(-.014, torso_y + .006, 0), Vector3(.01, .022, .02), Color(.6, .58, .48))       # pack
		"special":
			k.cylinder("olive", Vector3(0, head_top - .004, 0), .0085, .006, 8, cloth * .8, .006)
			k.box("char", Vector3(.008, head_top + .001, 0), Vector3(.006, .004, .008))                                 # night optics
			k.box("olive", Vector3(.0, torso_y + .006, 0), Vector3(.021, .02, .027), cloth * .85)
		"militia":
			k.box("canvas", Vector3(.002, head_top - .003, 0), Vector3(.015, .004, .013), Color(.45, .4, .32))         # cap
			k.box("canvas", Vector3(.006, head_top - .004, 0), Vector3(.008, .002, .012), Color(.4, .35, .28))
		"exo":
			k.box("composite", Vector3(0, torso_y + .004, 0), Vector3(.024, .028, .034), Color(.82, .84, .82))         # powered frame
			k.box("composite", Vector3(0, head_top - .006, 0), Vector3(.016, .014, .015), Color(.78, .8, .8))
			k.box("glass", Vector3(.008, head_top - .001, 0), Vector3(.002, .004, .012))
			for side in [-1.0, 1.0]: k.box("steel", Vector3(0, .004, side * .01), Vector3(.006, .03, .004), Color(.6, .62, .62))
		"engineer":
			k.cylinder("painted_metal", Vector3(0, head_top - .004, 0), .0085, .005, 8, Color(1.3, 1.0, .3), .007)     # hard hat
			k.box("painted_metal", Vector3(0, torso_y + .008, 0), Vector3(.018, .018, .026), Color(1.35, .7, .25))     # hi-vis vest
		"civilian":
			k.box("canvas", Vector3(-.001, head_top - .002, 0), Vector3(.013, .005, .013), Color(.32, .27, .22))       # hair
			k.box("canvas", Vector3(-.006, head_top - .009, 0), Vector3(.004, .008, .012), Color(.32, .27, .22))
			match full_variant:
				"civilian_coat":
					k.box("canvas", Vector3(0, torso_y - .016, 0), Vector3(.018, .018, .026), cloth * Color(.7, .72, .78))   # long coat skirt
					k.box("canvas", Vector3(0, torso_y + .02, 0), Vector3(.018, .012, .027), cloth * Color(.7, .72, .78))
				"civilian_bag":
					k.box("canvas", Vector3(0, torso_y + .004, -.017), Vector3(.016, .014, .006), Color(.5, .38, .28))     # shoulder bag
					k.box("canvas", Vector3(0, torso_y + .02, -.006), Vector3(.003, .02, .02), Color(.45, .34, .25), .6)
				"civilian_pack":
					k.box("canvas", Vector3(-.014, torso_y + .008, 0), Vector3(.01, .02, .018), Color(.35, .45, .55))     # rucksack
	# shoulder patch in the owner's colour (not for civilians)
	if variant != "civilian":
		k.box("team:" + team.to_html(false), Vector3(0, torso_y + .022, .0125 * bulk), Vector3(.006, .006, .002))
	# carried equipment
	var hands := Vector3(.012, torso_y + .012, .006)
	match variant:
		"rifle", "special", "militia", "exo":
			var aim := kneel
			var stock := "timber" if variant == "militia" else "steel"
			var length := .052 if variant == "special" else .045
			if aim: k.box(stock, Vector3(.02, torso_y + .022, .006), Vector3(length, .005, .004), Color(.3, .3, .3))
			else: k.box(stock, hands, Vector3(length * .9, .005, .004), Color(.3, .3, .3), .5)
		"engineer":
			k.box("timber", Vector3(-.006, torso_y - .004, .016), Vector3(.004, .04, .004), Color(.6, .48, .34))
			k.box("steel", Vector3(-.006, torso_y - .024, .016), Vector3(.012, .008, .003))
		"crew":
			if not kneel: k.box("painted_metal", Vector3(.006, torso_y - .008, .016), Vector3(.016, .01, .008), Color(.45, .5, .38))   # ammunition case
		"civilian":
			pass


static func _prone(k: MeshKit, variant: String, mat: String, cloth: Color, trousers: Color, team: Color) -> void:
	# lying flat, facing +X, weapon forward
	k.box(mat, Vector3(-.02, 0, 0), Vector3(.036, .008, .022), trousers)
	k.box(mat, Vector3(.012, 0, 0), Vector3(.03, .012, .024), cloth)
	k.box("skin", Vector3(.033, .003, 0), Vector3(.012, .011, .011), SKIN)
	if variant in ["rifle", "crew", "special"]: k.cylinder("olive", Vector3(.034, .008, 0), .008, .005, 8, cloth * .85, .006)
	if variant != "civilian":
		k.box("steel", Vector3(.05, .004, .006), Vector3(.04, .004, .004), Color(.3, .3, .3))
		k.box("team:" + team.to_html(false), Vector3(.012, .012, .006), Vector3(.006, .002, .006))
