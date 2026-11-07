class_name DevelopedBuildingLibrary
extends RefCounted
## Distinct industrial and advanced-era compounds, composed within their authoritative parcel.
const TYPES:=["steel_mill","refinery","munitions_plant","electronics_plant","motor_works","heavy_assembly","robotics_complex","drone_works","salvage","fusion_plant","shield_generator","missile_silo","wonder"]

static func compose(k:MeshKit,b:Dictionary,type:String,tint:Color) -> bool:
	if not type in TYPES: return false
	match type:
		"steel_mill":
			_hall(k,Vector3(-.12,.02,0),Vector3(.48,.23,.42),"brick",tint)
			for z in [-.17,.17]:
				k.cylinder("steel",Vector3(.25,.02,z),.075,.37,10,tint.darkened(.12),.05)
				k.cylinder("brick",Vector3(.36,.02,z),.035,.61,8,tint,.025)
			k.box("char",Vector3(.12,.025,0),Vector3(.17,.08,.12))
			k.part("rooftop_hvac",Vector3(-.2,.25+.02,.1),0.0,1.0,tint)
			k.part("pipe_rack",Vector3(.1,.02,.25),0.0,.9)
		"refinery":
			_hall(k,Vector3(-.24,.02,-.17),Vector3(.27,.14,.20),"concrete",tint)
			for x in [-.08,.10,.29]:
				k.cylinder("steel",Vector3(x,.02,.15),.075,.13,12,tint)
				k.cylinder("steel",Vector3(x,.15,.15),.072,.018,12,tint,.02)
			for x in [.06,.25]:
				k.cylinder("steel",Vector3(x,.02,-.17),.035,.48,10,tint,.025)
				for y in [.14,.27,.40]: k.box("steel",Vector3(x,y,-.17),Vector3(.10,.015,.10))
			k.box("steel",Vector3(.08,.10,-.01),Vector3(.45,.025,.025))
			k.part("storage_tank",Vector3(-.3,.02,.15),0.0,.7,tint)
			k.part("pipe_rack",Vector3(.0,.02,.31),0.0,1.0)
		"munitions_plant":
			for z in [-.17,.17]: _hall(k,Vector3(-.08,.02,z),Vector3(.57,.14,.20),"brick",tint)
			for x in [-.22,0,.22]:
				k.box("concrete",Vector3(x,.02,.01),Vector3(.09,.055,.10))
				k.box("steel",Vector3(x,.075,.01),Vector3(.07,.01,.08))
			for z in [-.17,.17]: k.part("rooftop_hvac",Vector3(.12,.16+.02,z),0.0,1.0,tint)
			k.part("fence_panel",Vector3(.33,.02,.0),PI*.5,1.0)
		"motor_works":
			_hall(k,Vector3(-.05,.02,-.06),Vector3(.68,.18,.33),"brick",tint)
			for x in [-.23,0,.23]:
				k.box("steel",Vector3(x,.03,.112),Vector3(.11,.09,.008),Color(.35,.38,.4))
				k.box("steel",Vector3(x,.03,.24),Vector3(.09,.025,.055))
			k.box("glass",Vector3(-.10,.12,-.235),Vector3(.46,.04,.005))
			for i in 2: k.part("van",Vector3(-.2+i*.13,.02,.31),0.0,1.0,[Color(.8,.8,.78),Color(.35,.45,.6)][i])
			k.part("rooftop_hvac",Vector3(.15,.2+.065,-.06),0.0,1.0,tint)
		"heavy_assembly":
			_hall(k,Vector3(0,.02,0),Vector3(.72,.31,.42),"steel",tint)
			for x in [-.25,.25]: k.box("steel",Vector3(x,.025,.29),Vector3(.025,.34,.025),Color(.7,.57,.28))
			k.box("steel",Vector3(0,.36,.29),Vector3(.58,.025,.035),Color(.7,.57,.28)); k.box("steel",Vector3(.08,.24,.29),Vector3(.02,.12,.02))
			k.box("char",Vector3(.22,.03,.211),Vector3(.15,.17,.005))
			k.part("cargo_truck",Vector3(-.2,.02,.33),0.0,1.15,Color(.55,.6,.45))
		"electronics_plant":
			k.box("concrete",Vector3(-.05,.02,0),Vector3(.64,.20,.40),tint)
			k.box("glass",Vector3(-.05,.08,.203),Vector3(.56,.11,.006))
			k.box("steel",Vector3(-.05,.22,0),Vector3(.66,.018,.42),tint)
			for x in [-.23,-.06,.11]:
				k.box("steel",Vector3(x,.24,-.07),Vector3(.10,.065,.14),Color(.8,.83,.81))
				for z in [-.11,-.04]: k.cylinder("char",Vector3(x,.306,z),.026,.004,10)
			k.box("concrete",Vector3(.32,.02,0),Vector3(.10,.13,.28),tint)
			k.part("solar_array",Vector3(.32,.15,0),0.0,.8)
			k.part("satellite_dish",Vector3(.12,.24,.12),.6,1.0)
		"drone_works":
			for z in [-.16,.16]:
				_hall(k,Vector3(-.11,.02,z),Vector3(.50,.17,.22),"steel",tint)
				k.box("char",Vector3(.143,.035,z),Vector3(.005,.12,.17))
			k.box("concrete",Vector3(.28,.02,0),Vector3(.16,.30,.13),tint)
			k.box("glass",Vector3(.28,.24,0),Vector3(.165,.05,.135))
			k.box("steel",Vector3(.28,.32,0),Vector3(.02,.13,.02)); k.box("steel",Vector3(.28,.45,0),Vector3(.13,.025,.045))
			k.part("radar",Vector3(-.3,.02,.3),0.0,1.0,tint)
		"robotics_complex":
			_hall(k,Vector3(-.07,.02,0),Vector3(.64,.31,.44),"composite",tint)
			k.box("glass",Vector3(-.07,.10,.224),Vector3(.56,.14,.006))
			for x in [-.20,.07]:
				k.box("steel",Vector3(x,.05,.29),Vector3(.055,.09,.055),Color(.72,.52,.24))
				k.box("steel",Vector3(x+.03,.14,.29),Vector3(.10,.025,.025),Color(.72,.52,.24))
			k.box("steel",Vector3(.31,.025,-.10),Vector3(.09,.42,.14),tint)
			for x in [-.25,-.05,.15]: k.part("rooftop_hvac",Vector3(x,.33+.065,-.1),0.0,1.0,tint)
		"salvage":
			_hall(k,Vector3(-.20,.02,-.10),Vector3(.28,.15,.28),"steel",tint)
			for index in 5:
				var x:=-.02+.08*(index%3); var z:=.10+.10*(index/3)
				k.box("steel",Vector3(x,.02,z),Vector3(.09,.045+.012*(index%2),.065),Color(.65,.58,.5),index*.4)
			k.box("steel",Vector3(.31,.02,-.12),Vector3(.025,.38,.025)); k.box("steel",Vector3(.23,.40,-.12),Vector3(.23,.02,.025))
		"fusion_plant":
			k.cylinder("concrete",Vector3(-.07,.02,0),.26,.10,16,tint)
			for index in 12:
				var angle:=TAU*index/12.0
				k.cylinder("composite",Vector3(-.07+cos(angle)*.19,.12,sin(angle)*.19),.038,.19,8,Color(.96,.96,.94))
			k.cylinder("steel",Vector3(-.07,.14,0),.11,.21,12,tint,.08)
			_hall(k,Vector3(.31,.02,0),Vector3(.13,.15,.31),"concrete",tint)
			k.box("glass",Vector3(.31,.09,.158),Vector3(.10,.05,.005))
		"shield_generator":
			k.cylinder("concrete",Vector3(0,.02,0),.19,.07,12,tint)
			k.cylinder("composite",Vector3(0,.09,0),.07,.30,10,tint,.045)
			for angle in [0.0,PI*.5,PI,PI*1.5]:
				var p:=Vector3(cos(angle)*.20,.02,sin(angle)*.20)
				k.box("steel",p,Vector3(.06,.24,.06),tint)
				k.box("glass",p+Vector3(0,.24,0),Vector3(.07,.035,.07))
		"missile_silo":
			for z in [-.15,.15]:
				k.cylinder("concrete",Vector3(-.10,.015,z),.12,.025,16,tint)
				k.cylinder("steel",Vector3(-.10,.04,z),.10,.012,16,tint)
				k.box("steel",Vector3(-.10,.054,z),Vector3(.18,.008,.012))
			_hall(k,Vector3(.25,.02,0),Vector3(.18,.13,.35),"concrete",tint)
			k.box("steel",Vector3(.27,.15,-.08),Vector3(.01,.25,.01)); k.box("steel",Vector3(.27,.40,-.08),Vector3(.13,.015,.04))
		"wonder":
			for index in 4:
				var angle:=TAU*index/4.0; var p:=Vector3(cos(angle)*.26,.02,sin(angle)*.26)
				k.box("composite",p,Vector3(.18,.48,.18),tint)
				k.box("glass",p+Vector3(.091,.12,0),Vector3(.004,.30,.14))
			k.box("stone",Vector3(0,.02,0),Vector3(.24,.82,.24),tint)
			for y in [.18,.40,.62]: k.box("foliage",Vector3(0,y,.145),Vector3(.28,.045,.07))
			k.box("glass",Vector3(0,.84,0),Vector3(.15,.15,.15))
	return true

static func development(k:MeshKit,b:Dictionary,definition:Dictionary,tint:Color) -> void:
	var level:=int(b.get("lv",1)); var type:=str(b.ty)
	if type=="house" or type=="town" or level<2: return
	if not definition.has("jobs"): return
	if type=="farm":
		for index in range(level-1):
			var z:=.17 if index==0 else -.17
			k.box("timber",Vector3(.01,.025,z),Vector3(.24,.10,.11),tint*Color(.86,.74,.58))
			k.gable("roof_slate",Vector3(.01,.125,z),.11,.24,.04,tint,PI*.5)
		return
	if type=="quarry":
		for index in range(level-1):
			k.box("stone",Vector3(.32,.025+index*.06,.27),Vector3(.12,.06,.12),tint)
			k.box("steel",Vector3(.24,.07+index*.04,-.20),Vector3(.11,.08,.13),tint)
		return
	# Add service wings and equipment without moving or replacing the original structure.
	for index in range(level-1):
		var z:=.29 if index==0 else -.29
		k.box("concrete",Vector3(-.12,.025,z),Vector3(.38,.11,.14),tint)
		k.box("steel",Vector3(-.12,.135,z),Vector3(.40,.015,.16),tint)
		for x in [-.23,-.03]: k.box("glass",Vector3(x,.07,z+(.071 if z>0 else -.071)),Vector3(.07,.035,.005))
	if level>=3:
		k.box("steel",Vector3(.30,.025,.26),Vector3(.10,.24,.12),tint)
		k.cylinder("steel",Vector3(.30,.265,.26),.035,.05,8)

## An industrial hall with the detail that makes it read at operational zoom: a concrete plinth,
## pilaster bays, a high clerestory window band, roller doors and a personnel door on the long
## front, downpipes at the corners and roof vents along the north-lit sawtooth roof.
static func _hall(k:MeshKit,position:Vector3,dimensions:Vector3,material:String,tint:Color) -> void:
	var wall:="corrugated" if material=="steel" else material
	k.box(wall,position,dimensions,tint)
	k.box("concrete",position+Vector3(0,0,0),Vector3(dimensions.x+.008,.025,dimensions.z+.008),Color(.84,.83,.8))
	k.sawtooth("corrugated","glass",position+Vector3(0,dimensions.y,0),dimensions.x,dimensions.z,.065,3,tint,PI*.5)
	var front:=position.z+dimensions.z*.5+.002; var back:=position.z-dimensions.z*.5-.002
	var bays:=maxi(2,int(dimensions.x/.12))
	for bay in bays+1:
		var x:=position.x-dimensions.x*.5+dimensions.x*bay/float(bays)
		for z in [front,back]: k.box("concrete",Vector3(x,position.y,z),Vector3(.012,dimensions.y,.006),tint*Color(.9,.9,.88))
	if dimensions.y>.1:
		for z in [front,back]: k.box("glass",Vector3(position.x,position.y+dimensions.y*.68,z),Vector3(dimensions.x*.9,dimensions.y*.14,.003))
	var doors:=mini(2,maxi(1,int(dimensions.x/.25)))
	for door in doors:
		var x:=position.x+(door-(doors-1)*.5)*dimensions.x*.42
		k.box("steel",Vector3(x,position.y+.025,front+.001),Vector3(.075,minf(.09,dimensions.y*.5),.003),Color(.62,.64,.62))
		for rib in 4: k.box("steel",Vector3(x,position.y+.035+rib*.016,front+.003),Vector3(.075,.002,.002),Color(.5,.52,.5))
	k.box("char",Vector3(position.x+dimensions.x*.38,position.y+.025,front+.001),Vector3(.016,.035,.003))
	for x in [position.x-dimensions.x*.5,position.x+dimensions.x*.5]:
		for z in [front,back]: k.box("steel",Vector3(x,position.y+.025,z),Vector3(.006,dimensions.y-.025,.006),Color(.55,.56,.56))
	for vent in maxi(1,int(dimensions.x/.22)):
		k.cylinder("steel",Vector3(position.x-dimensions.x*.3+vent*.22,position.y+dimensions.y+.04,position.z-dimensions.z*.25),.012,.03,8,Color(.7,.72,.72))
