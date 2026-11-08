class_name MilitaryModelLibrary
extends RefCounted
## Role-specific silhouettes for every authoritative unit type, in the same modern post-collapse
## language, scale and materials as the buildings. Forward is +X. One model is the bounded
## representation of one server unit.
##
## Animations: "idle"; "kit" (equipment only: the people are drawn by SquadPresentation as
## free-moving figures); "roll_0"/"roll_1" (wheel hubs and track links advance while moving);
## "rotor_0"/"rotor_1" (helicopter blades); "walk_0"/"walk_1"/"cover" (legacy baked squads at wide
## zoom). Turrets are separate meshes so they traverse independently.
const TYPES:=["colonist","engineer","scout_buggy","militia","rifle_squad","mortar_team","armored_car","supply_truck","field_gun","mech_infantry","tank","sp_artillery","helicopter","recon_drone","missile_battery","fighter","bomber","oneway_drone","air_defense","special_forces","autonomous_tank","strike_swarm","exo_infantry"]
const OLIVE:=Color(.62,.65,.52)
const DARK:=Color(.36,.37,.34)

static func build(type:String,color:Color,animation:="idle") -> ArrayMesh:
	var k:=MeshKit.new(); var team:="team:"+color.to_html(false)
	var roll:=1 if animation=="roll_1" else 0
	var kit:=animation=="kit"
	match type:
		"militia","rifle_squad","special_forces","exo_infantry":
			if kit: k.box(team,Vector3(-.02,.002,0),Vector3(.02,.002,.02))     # people come from SquadPresentation
			elif animation=="gpu": _gpu_squad(k,type,color)
			elif animation=="gpu_low": _gpu_squad(k,type,color,true)
			else: _baked_squad(k,type,color)
		"engineer":
			# a utility handcart of tools and timber, with the crew drawn separately when close
			_wheel(k,Vector3(-.03,.022,-.05),.022,.01,roll); _wheel(k,Vector3(-.03,.022,.05),.022,.01,roll)
			k.box("timber",Vector3(-.03,.03,0),Vector3(.1,.012,.09),Color(.8,.68,.5))
			k.box("painted_metal",Vector3(-.04,.042,-.02),Vector3(.05,.02,.035),Color(1.2,.9,.3))
			for i in 3: k.box("timber",Vector3(-.03,.042+i*.006,.025),Vector3(.09,.005,.012),Color(.85,.72,.52))
			k.box("steel",Vector3(.04,.035,0),Vector3(.06,.004,.004))
			if not kit: _baked_squad(k,"engineer",color)
		"colonist": _convoy(k,team,roll,kit,color)
		"scout_buggy": _buggy(k,team,roll)
		"armored_car": _armored_car(k,team,roll)
		"supply_truck": _truck(k,team,roll,"canvas")
		"tank","mech_infantry","autonomous_tank": _tracked_hull(k,type,team,roll)
		"mortar_team":
			k.cylinder("steel",Vector3(.02,.0,0),.03,.006,10,DARK)                                   # baseplate
			_tube(k,Vector3(.02,.006,0),.11,.012,-1.0)                                                # tube laid at elevation
			for z in [-.025,.025]: k.box("steel",Vector3(.06,0,z),Vector3(.005,.06,.005),DARK,0)      # bipod
			for i in 3: k.box("painted_metal",Vector3(-.06,0,-.04+i*.03),Vector3(.022,.016,.014),Color(.55,.6,.45))   # bomb cases
			if not kit: _baked_squad(k,"crew",color,3)
		"field_gun":
			_field_gun(k,roll)
			if not kit: _baked_squad(k,"crew",color,4)
		"sp_artillery": _sp_artillery(k,team,roll)
		"missile_battery","air_defense": _launcher(k,type,team,roll)
		"helicopter": _helicopter(k,team,animation)
		"fighter","bomber","recon_drone","oneway_drone","strike_swarm":
			if type=="strike_swarm":
				for offset in [Vector3(.09,0,0),Vector3(-.06,0,-.12),Vector3(-.06,0,.12),Vector3(-.18,0,-.22),Vector3(-.18,0,.22)]: _aircraft(k,"oneway_drone",team,offset,.55)
			else: _aircraft(k,type,team,Vector3.ZERO,1.0)
		_: _baked_squad(k,"rifle_squad",color)
	return k.commit()


static func turret(type:String,color:Color) -> ArrayMesh:
	var k:=MeshKit.new(); var team:="team:"+color.to_html(false)
	match type:
		"tank":
			# low welded turret, mantlet, long smoothbore with bore evacuator, commander's hatch, smoke dischargers
			_slope_box(k,Vector3(-.015,.105,0),Vector3(.15,.045,.12),.03,OLIVE)
			k.box("olive",Vector3(.06,.112,0),Vector3(.03,.03,.05),OLIVE*.92)
			_barrel(k,Vector3(.075,.127,0),.24,.008)
			k.cylinder("olive",Vector3(-.03,.15,-.03),.016,.008,8,OLIVE*.95)
			k.box("steel",Vector3(-.03,.158,.025),Vector3(.004,.025,.004),DARK)
			for z in [-.055,.055]: k.box("steel",Vector3(.035,.13,z),Vector3(.02,.012,.012),DARK)
			k.box("canvas",Vector3(-.085,.11,0),Vector3(.03,.03,.1),Color(.62,.58,.46))
		"mech_infantry":
			k.box("olive",Vector3(.02,.135,.03),Vector3(.07,.028,.06),OLIVE)
			_barrel(k,Vector3(.055,.148,.03),.1,.004)
			k.box("glass",Vector3(.0,.165,.03),Vector3(.02,.008,.02))
		"autonomous_tank":
			_slope_box(k,Vector3(0,.11,0),Vector3(.14,.04,.11),.03,Color(.72,.77,.8),"composite")
			_barrel(k,Vector3(.07,.13,0),.22,.008)
			k.box("glass",Vector3(-.02,.15,.03),Vector3(.03,.02,.03))
			k.part("radar",Vector3(-.04,.15,-.02),0.0,.5)
	k.box(team,Vector3(-.035,.151,0),Vector3(.04,.002,.04))
	return k.commit()


# ------------------------------------------------------------------ building blocks
## a road wheel or tyre on its side (axis along Z), with hub detail that advances by `roll`
static func _wheel(k:MeshKit,center:Vector3,radius:float,width:float,roll:int,material:="char") -> void:
	var saved:=Transform3D(k.basis,k.origin)
	k.origin=k.origin+k.basis*(center+Vector3(0,0,-width*.5)); k.basis=k.basis*Basis(Vector3.RIGHT,PI*.5)
	k.cylinder(material,Vector3.ZERO,radius,width,10,Color(.32,.31,.3))
	k.basis=saved.basis; k.origin=saved.origin
	var angle:=float(roll)*PI*.25
	for spoke in 2:
		var a:=angle+spoke*PI*.5
		var hub:=center+Vector3(cos(a)*radius*.45,sin(a)*radius*.45-radius*.0,width*.51*(1.0 if center.z>=0 else -1.0))
		k.box("steel",hub-Vector3(0,.002,0),Vector3(.004,.004,.002),Color(.62,.62,.6))
	k.box("steel",center+Vector3(0,-.002,width*.51*(1.0 if center.z>=0 else -1.0)),Vector3(radius*.5,radius*.5,.002),Color(.55,.56,.54))


## a box whose top front edge is chamfered (sloped glacis), base at p
static func _slope_box(k:MeshKit,p:Vector3,size:Vector3,chamfer:float,color:Color,material:="olive") -> void:
	var hx:=size.x*.5; var hz:=size.z*.5; var h:=size.y
	var o:=p
	var pts:={
		"bfl":Vector3(-hx,0,-hz),"bfr":Vector3(-hx,0,hz),"bbl":Vector3(hx,0,-hz),"bbr":Vector3(hx,0,hz),
		"tfl":Vector3(-hx,h,-hz),"tfr":Vector3(-hx,h,hz),"tbl":Vector3(hx-chamfer,h,-hz),"tbr":Vector3(hx-chamfer,h,hz),
		"mbl":Vector3(hx,h*.45,-hz),"mbr":Vector3(hx,h*.45,hz)}
	var w:={}
	for key in pts: w[key]=k.xf(o+pts[key])
	var up:=k.basis*Vector3.UP; var fx:=k.basis*Vector3.RIGHT; var fz:=k.basis*Vector3.BACK
	k.quad(material,w.tfl,w.tfr,w.tbr,w.tbl,color,up)
	k.quad(material,w.tbl,w.tbr,w.mbr,w.mbl,color*.95,fx+up)              # glacis
	k.quad(material,w.mbl,w.mbr,w.bbr,w.bbl,color*.9,fx)
	k.quad(material,w.bfl,w.bfr,w.tfr,w.tfl,color*.9,-fx)
	k.tri(material,w.bfl,w.tfl,w.tbl,color*.92,-fz); k.tri(material,w.bfl,w.tbl,w.mbl,color*.92,-fz); k.tri(material,w.bfl,w.mbl,w.bbl,color*.92,-fz)
	k.tri(material,w.bfr,w.tfr,w.tbr,color*.92,fz); k.tri(material,w.bfr,w.tbr,w.mbr,color*.92,fz); k.tri(material,w.bfr,w.mbr,w.bbr,color*.92,fz)


## a gun barrel along +X from p (horizontal cylinder)
static func _barrel(k:MeshKit,p:Vector3,length:float,radius:float) -> void:
	var saved:=Transform3D(k.basis,k.origin)
	k.origin=k.origin+k.basis*p; k.basis=k.basis*Basis(Vector3.BACK,-PI*.5)
	k.cylinder("steel",Vector3.ZERO,radius,length,8,Color(.5,.52,.48))
	k.cylinder("steel",Vector3(0,length*.55,0),radius*1.7,length*.12,8,Color(.48,.5,.46))
	k.basis=saved.basis; k.origin=saved.origin


## a tube raised at an angle (mortar, howitzer); elevation in radians from horizontal (+X)
static func _tube(k:MeshKit,p:Vector3,length:float,radius:float,elevation:float) -> void:
	var saved:=Transform3D(k.basis,k.origin)
	k.origin=k.origin+k.basis*p; k.basis=k.basis*Basis(Vector3.BACK,elevation)
	k.cylinder("steel",Vector3.ZERO,radius,length,8,DARK)
	k.basis=saved.basis; k.origin=saved.origin


static func _wheels(k:MeshKit,length:float,width:float,axles:int,roll:int,radius:=.03) -> void:
	for index in axles:
		var x:=lerpf(-length*.34,length*.34,index/float(maxi(1,axles-1)))
		for z in [-width*.5,width*.5]: _wheel(k,Vector3(x,radius,z),radius,.022,roll)


## a track run: dark track belt, road wheels, return rollers, link ribs shifted by `roll`
static func _tracks(k:MeshKit,length:float,width:float,roll:int) -> void:
	for side in [-1.0,1.0]:
		var z:float=side*width*.5
		k.box("char",Vector3(0,.0,z),Vector3(length,.038,.036),Color(.3,.3,.29))
		for i in 5:
			_wheel(k,Vector3(-length*.38+i*length*.19,.02,z+side*.019),.017,.004,roll,"steel")
		for i in int(length/.02):
			var x:=-length*.5+(i+.5*roll)*.02
			if x<length*.5: k.box("char",Vector3(x,.037,z),Vector3(.006,.003,.036),Color(.22,.22,.21))
		k.box("olive",Vector3(0,.035,z),Vector3(length*.96,.012,.038),OLIVE*.9)      # side skirt


# ------------------------------------------------------------------ units
static func _baked_squad(k:MeshKit,type:String,color:Color,count:=-1) -> void:
	# Wide-zoom silhouette: the same figures, packed in a fixed arrangement.
	var variant:String={"militia":"militia","rifle_squad":"rifle","special_forces":"special","exo_infantry":"exo","engineer":"engineer","crew":"crew"}.get(type,"rifle")
	var positions:=[Vector3(.1,0,0),Vector3(0,0,-.1),Vector3(0,0,.1),Vector3(-.11,0,-.16),Vector3(-.11,0,.16),Vector3(-.15,0,0)]
	var n:=count if count>0 else 3 if variant in ["exo","engineer"] else 4 if variant in ["militia","special"] else 6
	if type=="crew": positions=[Vector3(-.1,0,-.07),Vector3(-.1,0,.07),Vector3(-.15,0,0),Vector3(-.04,0,.11)]
	for index in mini(n,positions.size()):
		var part:=MeshKit.new()
		FigureKit.build(part,variant,"stand",color)
		k.component(_surfaces(part),Transform3D(Basis(),positions[index]))


## One mesh holding the whole squad for large battles: every soldier's vertices carry its figure
## index and body part in UV so the surface shader animates each soldier on its own (wander, lag
## behind when marching, leg and arm swing, going to ground). One instance per unit.
static func _gpu_squad(k:MeshKit,type:String,color:Color,low:=false) -> void:
	var variant:String={"militia":"militia","rifle_squad":"rifle","special_forces":"special","exo_infantry":"exo"}.get(type,"rifle")
	var positions:=[Vector3(.1,0,0),Vector3(0,0,-.1),Vector3(0,0,.1),Vector3(-.11,0,-.16),Vector3(-.11,0,.16),Vector3(-.15,0,0)]
	var n:=3 if variant=="exo" else 4 if variant in ["militia","special"] else 6
	for index in n:
		var part:=MeshKit.new()
		if low: FigureKit.build_low(part,variant,color)
		else: FigureKit.build(part,variant,"stand",color)
		var offset:Vector3=positions[index]
		for material in part.parts:
			var source:Array=part.parts[material]; var out:=k._part("squad:"+str(material))
			for v in (source[0] as Array).size():
				var p:Vector3=source[0][v]
				var code:=0.0
				if p.y<.038 and absf(p.z)<=.016: code=.3 if p.z<0 else .5
				elif p.y>=.038 and p.y<.07 and absf(p.z)>.014: code=.7 if p.z<0 else .9
				out[0].append(p+offset); out[1].append(source[1][v]); out[2].append(source[2][v]); out[3].append(Vector2(index+code,p.y))


static func _surfaces(part:MeshKit) -> Array:
	var out:=[]
	for material in part.parts:
		var p:Array=part.parts[material]
		var arrays:=[]; arrays.resize(Mesh.ARRAY_MAX)
		arrays[Mesh.ARRAY_VERTEX]=PackedVector3Array(p[0]); arrays[Mesh.ARRAY_NORMAL]=PackedVector3Array(p[1]); arrays[Mesh.ARRAY_TEX_UV]=PackedVector2Array(p[3])
		out.append({"material":material,"arrays":arrays,"transform":Transform3D.IDENTITY})
	return out


static func _convoy(k:MeshKit,team:String,roll:int,kit:bool,color:Color) -> void:
	# a settler convoy: a light truck towing a covered trailer of supplies and household goods
	k.part("van",Vector3(.1,.0,0),0.0,1.4,Color(.78,.76,.7))
	_wheel(k,Vector3(-.09,.02,-.045),.02,.012,roll); _wheel(k,Vector3(-.09,.02,.045),.02,.012,roll)
	k.box("timber",Vector3(-.08,.022,0),Vector3(.13,.014,.09),Color(.8,.68,.5))
	k.box("canvas",Vector3(-.08,.036,0),Vector3(.12,.05,.085),Color(.86,.8,.66))
	k.box("steel",Vector3(.0,.025,0),Vector3(.05,.004,.004))
	k.box(team,Vector3(-.08,.087,0),Vector3(.05,.002,.04))
	if not kit:
		for z in [.11,-.11]:
			var part:=MeshKit.new(); FigureKit.build(part,"civilian","stand",color)
			k.component(_surfaces(part),Transform3D(Basis(),Vector3(.02,0,z)))


static func _buggy(k:MeshKit,team:String,roll:int) -> void:
	_wheels(k,.2,.12,2,roll,.028)
	k.box("olive",Vector3(0,.03,0),Vector3(.17,.026,.09),OLIVE)
	k.box("olive",Vector3(.07,.05,0),Vector3(.05,.015,.08),OLIVE*.95)
	for x in [-.03,.04]:
		for z in [-.04,.04]: k.box("steel",Vector3(x,.056,z),Vector3(.005,.05,.005),DARK)
	k.box("steel",Vector3(.005,.104,0),Vector3(.08,.005,.085),DARK)                          # roll cage
	k.box("steel",Vector3(-.01,.105,0),Vector3(.004,.03,.004),DARK); _barrel(k,Vector3(-.01,.13,0),.06,.004)   # pintle gun
	k.box("canvas",Vector3(-.065,.056,0),Vector3(.04,.025,.07),Color(.66,.6,.48))
	k.box(team,Vector3(-.065,.082,0),Vector3(.035,.002,.04))


static func _armored_car(k:MeshKit,team:String,roll:int) -> void:
	_wheels(k,.32,.15,4,roll,.03)
	_slope_box(k,Vector3(0,.03,0),Vector3(.3,.075,.14),.05,OLIVE)
	k.box("glass",Vector3(.11,.088,0),Vector3(.02,.012,.09),Color(.4,.5,.55))
	k.box("olive",Vector3(-.02,.105,0),Vector3(.08,.03,.08),OLIVE*.95)                        # small turret
	_barrel(k,Vector3(.02,.118,0),.12,.006)
	for z in [-.07,.07]: k.box("steel",Vector3(-.13,.06,z),Vector3(.02,.02,.004),DARK)
	k.box(team,Vector3(-.06,.106,0),Vector3(.04,.002,.06))


static func _truck(k:MeshKit,team:String,roll:int,load:String) -> void:
	_wheels(k,.36,.15,3,roll,.03)
	k.box("olive",Vector3(.13,.03,0),Vector3(.09,.08,.14),OLIVE)
	k.box("glass",Vector3(.176,.075,0),Vector3(.004,.03,.12),Color(.4,.5,.55))
	k.box("steel",Vector3(-.02,.04,0),Vector3(.3,.012,.13),DARK)
	k.box(load,Vector3(-.06,.052,0),Vector3(.22,.08,.14),Color(.72,.68,.52))
	for i in 4: k.box("steel",Vector3(-.16+i*.07,.052,0),Vector3(.004,.084,.142),DARK)
	k.box(team,Vector3(-.06,.133,0),Vector3(.08,.002,.06))


static func _tracked_hull(k:MeshKit,type:String,team:String,roll:int) -> void:
	var tone:=Color(.72,.77,.8) if type=="autonomous_tank" else OLIVE
	var material:="composite" if type=="autonomous_tank" else "olive"
	_tracks(k,.32,.16,roll)
	_slope_box(k,Vector3(0,.03,0),Vector3(.3,.06,.13),.06,tone,material)
	k.box("steel",Vector3(-.13,.07,0),Vector3(.04,.012,.1),DARK)                              # engine deck grille
	if type=="mech_infantry":
		k.box(material,Vector3(-.05,.09,0),Vector3(.18,.045,.13),tone*.95)                    # troop compartment
		k.box("steel",Vector3(-.15,.04,0),Vector3(.006,.08,.08),DARK)                          # rear ramp
		for z in [-.066,.066]:
			for x in [-.1,-.04]: k.box("glass",Vector3(x,.115,z),Vector3(.02,.008,.002))
	elif type=="autonomous_tank":
		for z in [-.068,.068]: k.part("radar",Vector3(.05,.09,z),0.0,.35)
		k.box("glass",Vector3(.12,.08,0),Vector3(.015,.012,.07),Color(.4,.6,.8))
	k.box(team,Vector3(-.1,.091,0),Vector3(.05,.002,.05))


static func _field_gun(k:MeshKit,roll:int) -> void:
	# towed howitzer: split trail, gun shield, long barrel laid forward
	_wheel(k,Vector3(.02,.032,-.06),.032,.016,roll); _wheel(k,Vector3(.02,.032,.06),.032,.016,roll)
	k.box("steel",Vector3(.02,.03,0),Vector3(.04,.02,.11),OLIVE)
	k.box("olive",Vector3(.05,.04,0),Vector3(.006,.05,.11),OLIVE*.95)                        # shield
	_barrel(k,Vector3(.03,.055,0),.2,.007)
	for z in [-.05,.05]: k.box("steel",Vector3(-.08,.008,z*.6),Vector3(.18,.012,.012),OLIVE,z*2.0)   # trail legs
	for i in 2: k.box("painted_metal",Vector3(-.03,0,-.11+i*.02),Vector3(.018,.014,.012),Color(.55,.6,.45))


static func _sp_artillery(k:MeshKit,team:String,roll:int) -> void:
	_tracks(k,.34,.16,roll)
	_slope_box(k,Vector3(0,.03,0),Vector3(.32,.06,.13),.05,OLIVE)
	k.box("olive",Vector3(-.05,.09,0),Vector3(.16,.07,.13),OLIVE*.95)                         # large casemate turret
	_tube(k,Vector3(.03,.13,0),.28,.008,.18)
	k.box("steel",Vector3(-.14,.04,0),Vector3(.01,.02,.12),DARK)                               # spade
	k.box(team,Vector3(-.08,.161,0),Vector3(.06,.002,.06))


static func _launcher(k:MeshKit,type:String,team:String,roll:int) -> void:
	_wheels(k,.38,.15,3,roll,.03)
	k.box("olive",Vector3(.14,.03,0),Vector3(.08,.075,.14),OLIVE)
	k.box("glass",Vector3(.181,.07,0),Vector3(.004,.028,.12),Color(.4,.5,.55))
	k.box("steel",Vector3(-.04,.04,0),Vector3(.28,.014,.13),DARK)
	if type=="air_defense":
		k.box("olive",Vector3(-.04,.054,0),Vector3(.14,.05,.12),OLIVE*.95)
		for z in [-.04,.04]: _tube(k,Vector3(-.02,.1,z),.12,.012,.6)
		k.part("radar",Vector3(-.11,.104,0),0.0,.7)
	else:
		var saved:=Transform3D(k.basis,k.origin)
		k.origin=k.origin+k.basis*Vector3(-.15,.06,0); k.basis=k.basis*Basis(Vector3.BACK,.35)
		k.box("olive",Vector3(.11,0,0),Vector3(.22,.05,.12),OLIVE*.95)
		for z in [-.03,.03]: k.cylinder("char",Vector3(.225,.025,z),.012,.003,8)
		k.basis=saved.basis; k.origin=saved.origin
		for z in [-.07,.07]: k.box("steel",Vector3(-.15,0,z),Vector3(.008,.04,.008),DARK)       # stabilisers
	k.box(team,Vector3(.14,.106,0),Vector3(.04,.002,.06))


static func _helicopter(k:MeshKit,team:String,animation:String) -> void:
	k.box("olive",Vector3(.02,.03,0),Vector3(.18,.06,.06),OLIVE)
	_slope_box(k,Vector3(.11,.03,0),Vector3(.05,.05,.05),.03,Color(.45,.55,.6),"glass")          # canopy
	k.box("olive",Vector3(-.15,.06,0),Vector3(.2,.02,.02),OLIVE*.95)                              # tail boom
	k.box("olive",Vector3(-.25,.06,0),Vector3(.02,.05,.006),OLIVE)                                # fin
	for z in [-.05,.05]:
		k.box("olive",Vector3(.02,.05,z),Vector3(.04,.006,.04),OLIVE)                             # stub wings
		k.cylinder("char",Vector3(.02,.035,z*1.2),.008,.04,6)
	k.box("steel",Vector3(0,.09,0),Vector3(.012,.03,.012),DARK)
	var phase:=.4 if animation=="rotor_1" else 0.0
	k.box("char",Vector3(0,.12,0),Vector3(.42,.004,.018),Color.WHITE,phase); k.box("char",Vector3(0,.12,0),Vector3(.018,.004,.42),Color.WHITE,phase)
	for z in [-.04,.04]: k.box("steel",Vector3(.01,.0,z),Vector3(.18,.006,.008),DARK)            # skids
	k.box(team,Vector3(-.05,.061,0),Vector3(.04,.002,.03))


static func _aircraft(k:MeshKit,type:String,team:String,offset:Vector3,scale_:float) -> void:
	var saved:=Transform3D(k.basis,k.origin); k.origin=offset; k.basis=Basis().scaled(Vector3.ONE*scale_)
	var drone:=type in ["recon_drone","oneway_drone"]
	var body:=.42 if type=="bomber" else .32 if type=="fighter" else .24
	var span:=.58 if type=="bomber" else .36 if type=="fighter" else .42 if type=="recon_drone" else .22
	var sweep:=.12 if type=="fighter" else .05 if type=="bomber" else 0.0
	var grey:=Color(.72,.75,.74)
	k.box("painted_metal",Vector3(0,.012,0),Vector3(body,.03,.04),grey)
	# swept wings as flat quads with thickness faked by two faces
	for side in [-1.0,1.0]:
		var root_front:=Vector3(.03,.03,0); var root_back:=Vector3(-.07,.03,0)
		var tip_back:=Vector3(-.07-sweep,.03,side*span*.5); var tip_front:=Vector3(-.03-sweep,.03,side*span*.5)
		var pts:=[k.xf(root_front),k.xf(root_back),k.xf(tip_back),k.xf(tip_front)]
		k.quad("painted_metal",pts[0],pts[1],pts[2],pts[3],grey,k.basis*Vector3.UP)
		k.quad("painted_metal",pts[0],pts[1],pts[2],pts[3],grey*.85,k.basis*Vector3.DOWN)
	k.box("painted_metal",Vector3(-body*.42,.03,0),Vector3(.05,.006,span*.32),grey)             # tailplane
	k.box("painted_metal",Vector3(-body*.42,.03,0),Vector3(.045,.05,.006),grey)                 # fin
	if not drone: _slope_box(k,Vector3(body*.25,.042,0),Vector3(.07,.016,.026),.03,Color(.45,.55,.65),"glass")
	if type=="bomber":
		for z in [-.15,.15]: k.cylinder("char",Vector3(-.06,.02,z),.016,.06,8)
	elif type=="recon_drone": k.cylinder("glass",Vector3(.055,.0,0),.012,.012,8)
	elif type=="oneway_drone": k.box("char",Vector3(-.12,.035,0),Vector3(.012,.012,.03))
	k.box(team,Vector3(-.025,.034,span*.3),Vector3(.035,.002,.04)); k.basis=saved.basis; k.origin=saved.origin
