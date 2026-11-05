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
		"refinery":
			_hall(k,Vector3(-.24,.02,-.17),Vector3(.27,.14,.20),"concrete",tint)
			for x in [-.08,.10,.29]:
				k.cylinder("steel",Vector3(x,.02,.15),.075,.13,12,tint)
				k.cylinder("steel",Vector3(x,.15,.15),.072,.018,12,tint,.02)
			for x in [.06,.25]:
				k.cylinder("steel",Vector3(x,.02,-.17),.035,.48,10,tint,.025)
				for y in [.14,.27,.40]: k.box("steel",Vector3(x,y,-.17),Vector3(.10,.015,.10))
			k.box("steel",Vector3(.08,.10,-.01),Vector3(.45,.025,.025))
		"munitions_plant":
			for z in [-.17,.17]: _hall(k,Vector3(-.08,.02,z),Vector3(.57,.14,.20),"brick",tint)
			for x in [-.22,0,.22]:
				k.box("concrete",Vector3(x,.02,.01),Vector3(.09,.055,.10))
				k.box("steel",Vector3(x,.075,.01),Vector3(.07,.01,.08))
		"motor_works":
			_hall(k,Vector3(-.05,.02,-.06),Vector3(.68,.18,.33),"brick",tint)
			for x in [-.23,0,.23]:
				k.box("steel",Vector3(x,.03,.112),Vector3(.11,.09,.008),Color(.35,.38,.4))
				k.box("steel",Vector3(x,.03,.24),Vector3(.09,.025,.055))
			k.box("glass",Vector3(-.10,.12,-.235),Vector3(.46,.04,.005))
		"heavy_assembly":
			_hall(k,Vector3(0,.02,0),Vector3(.72,.31,.42),"steel",tint)
			for x in [-.25,.25]: k.box("steel",Vector3(x,.025,.29),Vector3(.025,.34,.025),Color(.7,.57,.28))
			k.box("steel",Vector3(0,.36,.29),Vector3(.58,.025,.035),Color(.7,.57,.28)); k.box("steel",Vector3(.08,.24,.29),Vector3(.02,.12,.02))
			k.box("char",Vector3(.22,.03,.211),Vector3(.15,.17,.005))
		"electronics_plant":
			k.box("concrete",Vector3(-.05,.02,0),Vector3(.64,.20,.40),tint)
			k.box("glass",Vector3(-.05,.08,.203),Vector3(.56,.11,.006))
			k.box("steel",Vector3(-.05,.22,0),Vector3(.66,.018,.42),tint)
			for x in [-.23,-.06,.11]:
				k.box("steel",Vector3(x,.24,-.07),Vector3(.10,.065,.14),Color(.8,.83,.81))
				for z in [-.11,-.04]: k.cylinder("char",Vector3(x,.306,z),.026,.004,10)
			k.box("concrete",Vector3(.32,.02,0),Vector3(.10,.13,.28),tint)
		"drone_works":
			for z in [-.16,.16]:
				_hall(k,Vector3(-.11,.02,z),Vector3(.50,.17,.22),"steel",tint)
				k.box("char",Vector3(.143,.035,z),Vector3(.005,.12,.17))
			k.box("concrete",Vector3(.28,.02,0),Vector3(.16,.30,.13),tint)
			k.box("glass",Vector3(.28,.24,0),Vector3(.165,.05,.135))
			k.box("steel",Vector3(.28,.32,0),Vector3(.02,.13,.02)); k.box("steel",Vector3(.28,.45,0),Vector3(.13,.025,.045))
		"robotics_complex":
			_hall(k,Vector3(-.07,.02,0),Vector3(.64,.31,.44),"concrete",tint)
			k.box("glass",Vector3(-.07,.10,.224),Vector3(.56,.14,.006))
			for x in [-.20,.07]:
				k.box("steel",Vector3(x,.05,.29),Vector3(.055,.09,.055),Color(.72,.52,.24))
				k.box("steel",Vector3(x+.03,.14,.29),Vector3(.10,.025,.025),Color(.72,.52,.24))
			k.box("steel",Vector3(.31,.025,-.10),Vector3(.09,.42,.14),tint)
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
				k.cylinder("steel",Vector3(-.07+cos(angle)*.19,.12,sin(angle)*.19),.038,.19,8,Color(.76,.74,.67))
			k.cylinder("steel",Vector3(-.07,.14,0),.11,.21,12,tint,.08)
			_hall(k,Vector3(.31,.02,0),Vector3(.13,.15,.31),"concrete",tint)
			k.box("glass",Vector3(.31,.09,.158),Vector3(.10,.05,.005))
		"shield_generator":
			k.cylinder("concrete",Vector3(0,.02,0),.19,.07,12,tint)
			k.cylinder("steel",Vector3(0,.09,0),.07,.30,10,tint,.045)
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
				k.box("concrete",p,Vector3(.18,.48,.18),tint)
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

static func _hall(k:MeshKit,position:Vector3,dimensions:Vector3,material:String,tint:Color) -> void:
	k.box(material,position,dimensions,tint)
	k.sawtooth("steel","glass",position+Vector3(0,dimensions.y,0),dimensions.x,dimensions.z,.065,3,tint,PI*.5)
