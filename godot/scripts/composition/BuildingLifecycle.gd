class_name BuildingLifecycle
extends RefCounted
## Bounded, deterministic material damage and staged realization of the actual building mesh.
## Ruins and rubble are visual only; no collision, cover or pathfinding is introduced.
##
## Construction follows the server's progress (p), crew (cr) and waiting reason (qw):
##   site preparation (stakes, tape, cleared ground) -> ground work (excavation, foundation slab,
##   rebar starters) -> structure/frame (columns and floor beams rising) -> exterior (the real
##   building rising inside scaffolding; no glazing or roof yet) -> equipment and finishing.
## Machinery, a tower crane on tall buildings, workers and material stacks appear only while a
## crew is actually working; a site waiting for materials shows empty pallets and no machinery,
## so stalled or unfunded work never looks complete or busy.
##
## Damage follows the real health band: missing panels clustered where recorded impacts struck
## (or deterministically when no localized impact exists), scorch on walls, exposed rebar on broken
## concrete, a collapsed roof slab when severe, and rubble. Each building takes only its own damage.

static func append(target:MeshKit,source:MeshKit,record:Dictionary,construction:=-1.0) -> void:
	var hp:=clampf(float(record.get("hp",100)),0,100)
	var ruined:=str(record.get("st",""))=="ruined" or hp<=0
	if construction<0 and hp>=85 and not ruined:
		for material in source.parts:
			var out:=target._part(material); var part:Array=source.parts[material]
			for channel in 4: out[channel].append_array(part[channel])
		return
	var severity:=0.0 if hp>=85 else .10 if hp>=60 else .28 if hp>=35 else .52
	var inverse:=source.basis.inverse(); var high:=.1
	for part in source.parts.values():
		for vertex:Vector3 in part[0]: high=maxf(high,(inverse*(vertex-source.origin)).y)
	var impacts:Array=record.get("_impacts",[])
	for material in source.parts:
		var part:Array=source.parts[material]; var out:=target._part(material)
		for index in range(0,part[0].size(),3):
			var center:Vector3=(part[0][index]+part[0][index+1]+part[0][index+2])/3.0
			var local:Vector3=inverse*(center-source.origin)
			if construction>=0:
				if construction<.88 and str(material) in ["roof_slate","roof_tile","glass"]: continue
				_clip(part,index,out,source,inverse,high*clampf((construction-.32)/.63,0,1)); continue
			elif ruined:
				_clip(part,index,out,source,inverse,high*.25); continue
			elif severity>0 and local.y>.055:
				# Nearby triangles share a cell, producing local missing panels rather than noise;
				# panels near a recorded impact break first (the hit side of the building).
				var cell:=Vector3i(floori(local.x*13),floori(local.y*13),floori(local.z*13))
				var hash_value:=posmod(cell.x*73856093^cell.y*19349663^cell.z*83492791^int(record.id)*31,1000)/1000.0
				var near:=0.0
				for point:Vector2 in impacts: near=maxf(near,1.0-clampf(Vector2(center.x,center.z).distance_to(point)/.3,0,1))
				var threshold:=severity*(1.6 if material=="glass" else .7 if material=="steel" else 1.0)*(1.0+1.4*near)*(.6 if not impacts.is_empty() else 1.0)
				if hash_value<threshold: continue
			for vertex in range(index,index+3):
				out[0].append(part[0][vertex]); out[1].append(part[1][vertex]); out[2].append(part[2][vertex]); out[3].append(part[3][vertex])
	if construction<0 and not record.get("_skip_rubble",false):
		if ruined or hp<60: rubble(target,source,record,ruined)
		if not ruined and hp<60: _scars(target,source,record,hp,high)


static func _clip(part:Array,index:int,out:Array,source:MeshKit,inverse:Basis,height:float) -> void:
	var polygon:=[]
	for vertex in range(index,index+3): polygon.append([part[0][vertex],part[1][vertex],part[2][vertex],part[3][vertex]])
	var clipped:=[]; var previous:Array=polygon[-1]
	var before:float=(inverse*((previous[0] as Vector3)-source.origin)).y
	for current:Array in polygon:
		var after:float=(inverse*((current[0] as Vector3)-source.origin)).y
		if (before<=height)!=(after<=height):
			var amount:float=clampf((height-before)/(after-before),0,1)
			clipped.append([(previous[0] as Vector3).lerp(current[0],amount),(previous[1] as Vector3).lerp(current[1],amount).normalized(),(previous[2] as Color).lerp(current[2],amount),(previous[3] as Vector2).lerp(current[3],amount)])
		if after<=height: clipped.append(current)
		previous=current; before=after
	for triangle in range(1,clipped.size()-1):
		for vertex in [clipped[0],clipped[triangle],clipped[triangle+1]]:
			for channel in 4: out[channel].append(vertex[channel])


## local bounds of a composed building (in its own frame)
static func bounds(source:MeshKit) -> AABB:
	var result:=AABB(); var first:=true
	var inverse:=source.basis.inverse()
	for part in source.parts.values():
		for vertex:Vector3 in part[0]:
			var local:Vector3=inverse*(vertex-source.origin)
			if first: result=AABB(local,Vector3.ZERO); first=false
			else: result=result.expand(local)
	return result


## Material-specific scars on a standing damaged building: scorch on its walls, exposed bent
## rebar along broken concrete tops, and a fallen roof slab inside when the damage is severe.
static func _scars(target:MeshKit,source:MeshKit,record:Dictionary,hp:float,high:float) -> void:
	var saved:=Transform3D(target.basis,target.origin); target.basis=source.basis; target.origin=source.origin
	var box:=bounds(source)
	var rng:=RandomNumberGenerator.new(); rng.seed=int(record.id)*7907+17
	var c:=box.get_center(); var half:=box.size*.5
	var concrete:=source.parts.has("concrete") or source.parts.has("plaster")
	for k in 3 if hp<35 else 2:
		var side:=rng.randi()%4
		var y:=rng.randf_range(.03,maxf(.05,high*.8))
		var w:=rng.randf_range(.05,.11)
		var p:=Vector3(c.x+(half.x+.003)*(1 if side==0 else -1 if side==1 else rng.randf_range(-.6,.6)),y,c.z+(half.z+.003)*(1 if side==2 else -1 if side==3 else rng.randf_range(-.6,.6)))
		var size:=Vector3(.003,w*.8,w) if side<2 else Vector3(w,w*.8,.003)
		target.box("char",p,size,Color(.55,.5,.47))
	if concrete:
		for k in 4 if hp<35 else 2:
			var p:=Vector3(c.x+rng.randf_range(-half.x,half.x)*.8,high*rng.randf_range(.55,.85),c.z+rng.randf_range(-half.z,half.z)*.8)
			target.box("steel",p,Vector3(.004,.05,.004),Color(.5,.36,.28),rng.randf()*TAU)
			target.box("steel",p+Vector3(0,.045,0),Vector3(.025,.004,.004),Color(.5,.36,.28),rng.randf()*TAU)
	if hp<35 and high>.12:
		# a roof or floor slab that has dropped into the shell at an angle
		var slab:=Vector3(c.x,high*.35,c.z)
		target.basis=source.basis*Basis(Vector3(1,0,0).rotated(Vector3.UP,rng.randf()*TAU),.35)
		target.box("concrete" if concrete else "roof_slate",target.basis.inverse()*(source.basis*slab),Vector3(half.x*1.2,.012,half.z*1.1),Color(.62,.6,.57))
	target.basis=saved.basis; target.origin=saved.origin


static func rubble(target:MeshKit,source:MeshKit,record:Dictionary,ruined:bool) -> void:
	var saved:=Transform3D(target.basis,target.origin); target.basis=source.basis; target.origin=source.origin
	var rng:=RandomNumberGenerator.new(); rng.seed=int(record.id)*131+int(record.t)*17
	var wall:="concrete" if int(record.get("age",0))>=2 or str(record.ty) in DevelopedBuildingLibrary.TYPES else "brick"
	for index in 12 if ruined else 5:
		var x:=rng.randf_range(-.32,.32); var z:=rng.randf_range(-.27,.27)
		target.box(wall,Vector3(x,.018,z),Vector3(rng.randf_range(.035,.09),rng.randf_range(.025,.07),rng.randf_range(.025,.08)),Color(.72,.66,.6),rng.randf()*TAU)
	if ruined:
		for index in 3: target.box("steel",Vector3(rng.randf_range(-.23,.23),.03,rng.randf_range(-.20,.20)),Vector3(.10,.018,.025),Color(.55,.5,.46),rng.randf()*TAU)
		target.cone("rubble",Vector3(rng.randf_range(-.1,.1),.0,rng.randf_range(-.1,.1)),.2,.07,8,Color(.7,.66,.6))
	target.basis=saved.basis; target.origin=saved.origin


static func construction(target:MeshKit,source:MeshKit,record:Dictionary,progress:float) -> void:
	var box:=bounds(source)
	var half:=Vector2(minf(.48,box.size.x*.5),minf(.40,box.size.z*.5))
	var center:=box.get_center(); var height:=maxf(.15,box.size.y)
	var waiting:=record.get("qw")!=null
	var working:=float(record.get("cr",0))>0.0 and not waiting
	var rng:=RandomNumberGenerator.new(); rng.seed=int(record.get("t",0))*313+7
	var corners:=[]
	for x in [-half.x,half.x]:
		for z in [-half.y,half.y]: corners.append(Vector3(center.x+x,.02,center.z+z))
	# site preparation: cleared and levelled ground, survey stakes and tape
	target.box("soil",Vector3(center.x,.006,center.z),Vector3(half.x*2+.08,.004,half.y*2+.08),Color(.82,.72,.56))
	for i in 4:
		var point:Vector3=corners[[0,1,3,2][i]]; var next:Vector3=corners[[1,3,2,0][i]]
		target.box("timber",point,Vector3(.01,.05,.01),Color(.85,.75,.6))
		if progress<.3: target.strip("canvas",point+Vector3(0,.045,0),next+Vector3(0,.045,0),.004,Color(1.3,1.2,1.0) if not waiting else Color(1.2,.6,.3))
	if progress>=.12:
		# ground work: excavation, a foundation slab rising, rebar starters
		var slab:=clampf((progress-.12)/.18,0,1)
		target.box("soil",Vector3(center.x,.009,center.z),Vector3(half.x*2+.02,.003,half.y*2+.02),Color(.52,.43,.32))
		target.box("concrete",Vector3(center.x,.012,center.z),Vector3(half.x*2,.006+.018*slab,half.y*2),Color(.86,.85,.82))
		if progress<.45:
			for gx in 3:
				for gz in 3:
					target.box("steel",Vector3(center.x+(gx-1)*half.x*.7,.03,center.z+(gz-1)*half.y*.7),Vector3(.003,.035,.003),Color(.55,.4,.3))
	if progress>=.3:
		# structure/frame: columns and floor beams climb ahead of the walls
		var frame_top:=height*clampf((progress-.3)/.35,0,1)
		for point in corners:
			target.box("steel",point+Vector3(0,.03,0),Vector3(.012,frame_top,.012),Color(.7,.68,.64))
		var levels:=int(frame_top/.08)
		for level in levels:
			var y:=.03+(level+1)*.08
			for z in [-half.y,half.y]: target.box("steel",Vector3(center.x,y,center.z+z),Vector3(half.x*2,.008,.01),Color(.7,.68,.64))
	if progress>=.48:
		var complete:Dictionary=record.duplicate(); complete.hp=100; complete.st="operational"
		append(target,source,complete,progress)
	if progress>=.45 and progress<.96:
		# exterior: scaffolding with boards around the rising shell
		var top:=height*minf(1,progress*1.2)+.04
		for z in [-half.y-.02,half.y+.02]:
			for y in range(1,int(top/.07)+1): target.box("timber",Vector3(center.x,y*.07,center.z+z),Vector3(half.x*2+.06,.006,.02),Color(.82,.7,.5))
		for point in corners: target.box("steel",point*Vector3(1.05,1,1.08)+Vector3(0,.0,0),Vector3(.006,top,.006),Color(.78,.74,.62))
	if working:
		if height>.25 and progress>=.2 and progress<.92:
			target.part("tower_crane",Vector3(center.x+half.x+.08,.01,center.z-half.y*.5),PI*.5+rng.randf()*.6,clampf((height+.12)/.5,.5,1.3),Color(.95,.72,.2))
		elif progress<.3:
			target.part("bulldozer",Vector3(center.x+half.x+.06,.01,center.z+half.y*.3),rng.randf()*TAU,1.0,Color(.95,.72,.2))
		else:
			target.part("excavator",Vector3(center.x+half.x+.07,.01,center.z),rng.randf()*TAU,1.0,Color(.95,.72,.2))
		if progress<.9: target.part("pallet_stack",Vector3(center.x-half.x-.06,.01,center.z+half.y*.4),0.0,1.0)
		for k in 3:
			var p:=Vector3(center.x+rng.randf_range(-half.x,half.x),.012,center.z+half.y+.035)
			target.box("olive",p,Vector3(.012,.026,.01),Color(.78,.72,.5))
			target.box("painted_metal",p+Vector3(0,.026,0),Vector3(.011,.008,.011),Color(.95,.75,.2))
	elif waiting:
		# halted for materials: empty pallets, no machinery, no crew
		for k in 2: target.box("timber",Vector3(center.x-half.x-.05,.012+k*.008,center.z+half.y*.4),Vector3(.05,.006,.045),Color(.7,.6,.45))
