class_name MilitaryModelLibrary
extends RefCounted
## Role-specific silhouettes across every authoritative era. Shared authored components are
## combined with equipment; one visible squad is a bounded representation of one server unit.
const TYPES:=["colonist","engineer","scout_buggy","militia","rifle_squad","mortar_team","armored_car","supply_truck","field_gun","mech_infantry","tank","sp_artillery","helicopter","recon_drone","missile_battery","fighter","bomber","oneway_drone","air_defense","special_forces","autonomous_tank","strike_swarm","exo_infantry"]

static func build(type:String,color:Color,animation:="idle") -> ArrayMesh:
	var k:=MeshKit.new(); var team:="team:"+color.to_html(false)
	match type:
		"militia","rifle_squad","special_forces","exo_infantry": _infantry(k,type,team,animation)
		"engineer":
			for offset in [Vector3(-.08,0,-.08),Vector3(.06,0,.09)]:
				k.component(AssetLibrary.unit_component("infantry_"+animation),Transform3D(Basis(),offset),Color(.9,.85,.7))
				k.box("steel",offset+Vector3(.04,.02,.04),Vector3(.05,.035,.025))
				k.box("timber",offset+Vector3(-.025,.03,.04),Vector3(.008,.10,.008))
		"colonist":
			_wheels(k,.34,.16,2); k.box("timber",Vector3(-.03,.04,0),Vector3(.32,.045,.16)); k.box("canvas",Vector3(-.06,.085,0),Vector3(.23,.11,.17))
			k.box("olive",Vector3(.12,.05,0),Vector3(.10,.09,.14)); k.box("glass",Vector3(.171,.105,0),Vector3(.004,.03,.12))
			k.box(team,Vector3(-.06,.20,0),Vector3(.09,.004,.08))
		"scout_buggy":
			k.component(AssetLibrary.unit_component("scout_vehicle"),Transform3D.IDENTITY)
			for z in [-.055,.055]: k.box("steel",Vector3(.015,.08,z),Vector3(.012,.075,.012))
			k.box("steel",Vector3(.015,.155,0),Vector3(.012,.01,.12)); k.box(team,Vector3(-.07,.102,0),Vector3(.06,.004,.065))
		"armored_car":
			_wheels(k,.36,.18,3); k.box("olive",Vector3(0,.055,0),Vector3(.34,.10,.17)); k.box("olive",Vector3(.01,.155,0),Vector3(.14,.055,.12))
			k.box("steel",Vector3(.13,.18,0),Vector3(.19,.014,.014)); k.box(team,Vector3(-.09,.156,0),Vector3(.075,.004,.10))
		"supply_truck":
			_wheels(k,.43,.18,3); k.box("olive",Vector3(.15,.04,0),Vector3(.12,.13,.17)); k.box("glass",Vector3(.212,.11,0),Vector3(.004,.05,.14))
			k.box("canvas",Vector3(-.07,.055,0),Vector3(.29,.13,.18)); k.box(team,Vector3(-.07,.187,0),Vector3(.10,.004,.08))
		"tank","mech_infantry","autonomous_tank":
			k.component(AssetLibrary.unit_component("tank_hull"),Transform3D.IDENTITY)
			if type=="mech_infantry":
				k.box("olive",Vector3(-.04,.08,0),Vector3(.23,.09,.14))
				for z in [-.075,.075]: k.box("steel",Vector3(-.10,.12,z),Vector3(.08,.04,.006))
			elif type=="autonomous_tank":
				for z in [-.075,.075]: k.box("steel",Vector3(0,.08,z),Vector3(.27,.04,.025),Color(.65,.7,.72))
				k.box("glass",Vector3(.12,.105,0),Vector3(.015,.022,.07))
			k.box(team,Vector3(-.10,.13,0),Vector3(.07,.004,.075))
		"mortar_team":
			k.cylinder("steel",Vector3(0,.01,0),.055,.012,10)
			k.box("steel",Vector3(.015,.02,0),Vector3(.025,.16,.025),Color.WHITE,.25)
			for z in [-.035,.035]: k.box("steel",Vector3(.065,.01,z),Vector3(.008,.105,.008))
			for p in [Vector3(-.10,0,-.08),Vector3(-.10,0,.08)]: k.component(AssetLibrary.unit_component("infantry_cover"),Transform3D(Basis(),p))
		"field_gun":
			k.component(AssetLibrary.unit_component("artillery_gun"),Transform3D.IDENTITY)
			for z in [-.12,.12]: k.component(AssetLibrary.unit_component("infantry_cover"),Transform3D(Basis(),Vector3(-.09,0,z)))
		"sp_artillery":
			k.component(AssetLibrary.unit_component("tank_hull"),Transform3D.IDENTITY)
			k.box("olive",Vector3(-.04,.08,0),Vector3(.19,.13,.16)); k.box("steel",Vector3(.20,.17,0),Vector3(.38,.028,.028)); k.box(team,Vector3(-.08,.212,0),Vector3(.08,.004,.08))
		"missile_battery","air_defense":
			_wheels(k,.40,.18,3); k.box("olive",Vector3(.13,.04,0),Vector3(.12,.10,.17)); k.box("glass",Vector3(.192,.10,0),Vector3(.004,.03,.13))
			k.box("steel",Vector3(-.08,.05,0),Vector3(.24,.04,.18))
			for z in [-.055,.055]:
				k.box("olive",Vector3(-.07,.10,z),Vector3(.25,.055,.045))
				if type=="air_defense": k.box("steel",Vector3(-.07,.157,z),Vector3(.22,.04,.045))
			if type=="air_defense":
				k.box("steel",Vector3(.03,.16,0),Vector3(.012,.10,.012)); k.box("steel",Vector3(.03,.26,0),Vector3(.04,.055,.14))
			else: k.cylinder("char",Vector3(.09,.08,.055),.015,.13,7)
			k.box(team,Vector3(.13,.143,0),Vector3(.07,.004,.07))
		"helicopter":
			k.box("olive",Vector3(.025,.035,0),Vector3(.24,.085,.095)); k.box("glass",Vector3(.105,.045,0),Vector3(.085,.045,.097))
			k.box("olive",Vector3(-.17,.06,0),Vector3(.23,.025,.025)); k.box("steel",Vector3(0,.12,0),Vector3(.015,.05,.015))
			var phase:=.4 if animation=="rotor_1" else 0.0
			k.box("char",Vector3(0,.17,0),Vector3(.48,.008,.025),Color.WHITE,phase); k.box("char",Vector3(0,.17,0),Vector3(.025,.008,.48),Color.WHITE,phase)
			for z in [-.065,.065]: k.box("steel",Vector3(0,.005,z),Vector3(.24,.008,.012))
			k.box(team,Vector3(-.1,.078,0),Vector3(.06,.004,.035))
		"fighter","bomber","recon_drone","oneway_drone","strike_swarm":
			if type=="strike_swarm":
				for offset in [Vector3(.09,0,0),Vector3(-.06,0,-.12),Vector3(-.06,0,.12),Vector3(-.18,0,-.22),Vector3(-.18,0,.22)]: _aircraft(k,"oneway_drone",team,offset,.55)
			else: _aircraft(k,type,team,Vector3.ZERO,1.0)
		_: _infantry(k,"rifle_squad",team,animation) # Safe forward-compatible silhouette; catalogue tests require explicit current types.
	return k.commit()

static func turret(type:String,color:Color) -> ArrayMesh:
	var k:=MeshKit.new()
	if type=="tank": k.component(AssetLibrary.unit_component("tank_turret"),Transform3D.IDENTITY)
	elif type=="mech_infantry":
		k.box("olive",Vector3(.03,.14,0),Vector3(.10,.035,.09)); k.box("steel",Vector3(.12,.17,0),Vector3(.16,.012,.012))
	elif type=="autonomous_tank":
		k.box("steel",Vector3(.01,.13,0),Vector3(.15,.045,.12),Color(.72,.77,.8)); k.box("steel",Vector3(.17,.16,0),Vector3(.28,.022,.022))
		k.box("glass",Vector3(-.025,.18,0),Vector3(.04,.025,.06))
	k.box("team:"+color.to_html(false),Vector3(-.02,.185,0),Vector3(.06,.004,.06))
	return k.commit()

static func _infantry(k:MeshKit,type:String,team:String,animation:String) -> void:
	var positions:=[Vector3(.1,0,0),Vector3(0,0,-.10),Vector3(0,0,.10),Vector3(-.11,0,-.16),Vector3(-.11,0,.16),Vector3(-.15,0,0)]
	var count:=4 if type in ["militia","special_forces","exo_infantry"] else 6
	for index in count:
		var p:Vector3=positions[index]
		var tint:=Color(.58,.62,.56) if type=="special_forces" else Color(.95,.9,.75) if type=="militia" else Color.WHITE
		k.component(AssetLibrary.unit_component("infantry_"+animation),Transform3D(Basis().scaled(Vector3.ONE*(1.1 if type=="exo_infantry" else 1.0)),p),tint)
		if type=="exo_infantry":
			k.box("steel",p+Vector3(0,.045,0),Vector3(.064,.05,.06),Color(.72,.75,.70))
			for z in [-.035,.035]: k.box("steel",p+Vector3(0,.012,z),Vector3(.025,.055,.016))
			k.box("steel",p+Vector3(-.03,.045,0),Vector3(.025,.07,.04))
		elif type=="special_forces":
			k.box("char",p+Vector3(-.025,.045,0),Vector3(.025,.04,.035)); k.box("steel",p+Vector3(.035,.067,.025),Vector3(.07,.008,.008))
		elif type=="militia": k.box("timber",p+Vector3(.035,.05,.025),Vector3(.08,.009,.01))
		k.box(team,p+Vector3(-.02,.09,.025),Vector3(.018,.02,.005))

static func _wheels(k:MeshKit,length:float,width:float,axles:int) -> void:
	for index in axles:
		var x:=lerpf(-length*.32,length*.32,index/float(maxi(1,axles-1)))
		for z in [-width*.5,width*.5]: k.box("char",Vector3(x,0,z),Vector3(.06,.06,.025))
	k.box("steel",Vector3(0,.03,0),Vector3(length,.025,width*.85))

static func _aircraft(k:MeshKit,type:String,team:String,offset:Vector3,scale_:float) -> void:
	var saved:=Transform3D(k.basis,k.origin); k.origin=offset; k.basis=Basis().scaled(Vector3.ONE*scale_)
	var drone:=type in ["recon_drone","oneway_drone"]
	var body:=.42 if type=="bomber" else .32 if type=="fighter" else .24
	var span:=.58 if type=="bomber" else .36 if type=="fighter" else .42 if type=="recon_drone" else .22
	k.box("steel",Vector3(0,.025,0),Vector3(body,.035,.045),Color(.72,.75,.74))
	k.box("steel",Vector3(-.025,.045,0),Vector3(.085,.012,span),Color(.72,.75,.74))
	k.box("steel",Vector3(-body*.40,.042,0),Vector3(.045,.008,span*.32))
	k.box("steel",Vector3(-body*.39,.04,0),Vector3(.04,.065,.009))
	if not drone: k.box("glass",Vector3(body*.24,.06,0),Vector3(.07,.025,.035))
	if type=="bomber":
		for z in [-.15,.15]: k.cylinder("char",Vector3(-.06,.02,z),.022,.07,8)
	elif type=="recon_drone": k.cylinder("glass",Vector3(.055,.008,0),.016,.016,8)
	elif type=="oneway_drone": k.box("char",Vector3(-.13,.045,0),Vector3(.012,.008,.14))
	k.box(team,Vector3(-.025,.06,span*.3),Vector3(.035,.004,.04)); k.basis=saved.basis; k.origin=saved.origin
