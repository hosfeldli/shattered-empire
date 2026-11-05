class_name BuildingLifecycle
extends RefCounted
## Bounded, deterministic material damage and staged realization of the actual building mesh.
## Ruins and rubble are visual only; no collision, cover or pathfinding is introduced.
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
				# Nearby triangles share a cell, producing local missing panels rather than noise.
				var cell:=Vector3i(floori(local.x*13),floori(local.y*13),floori(local.z*13))
				var hash_value:=posmod(cell.x*73856093^cell.y*19349663^cell.z*83492791^int(record.id)*31,1000)/1000.0
				var threshold:=severity*(1.6 if material=="glass" else .7 if material=="steel" else 1.0)
				if hash_value<threshold: continue
			for vertex in range(index,index+3):
				out[0].append(part[0][vertex]); out[1].append(part[1][vertex]); out[2].append(part[2][vertex]); out[3].append(part[3][vertex])
	if construction<0 and not record.get("_skip_rubble",false) and (ruined or hp<60): rubble(target,source,record,ruined)

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

static func rubble(target:MeshKit,source:MeshKit,record:Dictionary,ruined:bool) -> void:
	var saved:=Transform3D(target.basis,target.origin); target.basis=source.basis; target.origin=source.origin
	var rng:=RandomNumberGenerator.new(); rng.seed=int(record.id)*131+int(record.t)*17
	var wall:="concrete" if int(record.get("age",0))>=2 or str(record.ty) in DevelopedBuildingLibrary.TYPES else "brick"
	for index in 12 if ruined else 5:
		var x:=rng.randf_range(-.32,.32); var z:=rng.randf_range(-.27,.27)
		target.box(wall,Vector3(x,.018,z),Vector3(rng.randf_range(.035,.09),rng.randf_range(.025,.07),rng.randf_range(.025,.08)),Color(.72,.66,.6),rng.randf()*TAU)
	if ruined:
		for index in 3: target.box("steel",Vector3(rng.randf_range(-.23,.23),.03,rng.randf_range(-.20,.20)),Vector3(.10,.018,.025),Color(.55,.5,.46),rng.randf()*TAU)
	target.basis=saved.basis; target.origin=saved.origin

static func construction(target:MeshKit,source:MeshKit,record:Dictionary,progress:float) -> void:
	var bounds:=AABB(); var first:=true
	var inverse:=source.basis.inverse()
	for part in source.parts.values():
		for vertex:Vector3 in part[0]:
			var local:Vector3=inverse*(vertex-source.origin)
			if first: bounds=AABB(local,Vector3.ZERO); first=false
			else: bounds=bounds.expand(local)
	var half:=Vector2(minf(.48,bounds.size.x*.5),minf(.40,bounds.size.z*.5))
	var center:=bounds.get_center(); var height:=maxf(.15,bounds.size.y)
	for x in [-half.x,half.x]:
		for z in [-half.y,half.y]:
			var point:=Vector3(center.x+x,.02,center.z+z)
			if progress<.15: target.box("timber",point,Vector3(.012,.065,.012))
			else:
				target.box("concrete",point,Vector3(.055,.025,.055))
				target.box("steel",point+Vector3(0,.025,0),Vector3(.012,height*minf(1,progress*1.8),.012))
	if progress>=.48:
		var complete:Dictionary=record.duplicate(); complete.hp=100; complete.st="operational"
		append(target,source,complete,progress)
	if progress>=.22 and progress<.96:
		var top:=height*minf(1,progress*1.8)+.05
		for z in [-half.y,half.y]: target.box("timber",Vector3(center.x,top,center.z+z),Vector3(half.x*2+.06,.014,.018))
		if height>.25:
			target.box("steel",Vector3(center.x+half.x+.04,.02,center.z),Vector3(.015,height+.14,.015),Color(.8,.65,.28))
			target.box("steel",Vector3(center.x, height+.16,center.z),Vector3(half.x*2,.014,.02),Color(.8,.65,.28))
