class_name TrenchPresentation
extends RefCounted
## One route drives the terrain cut, floor, walls, parapet and reinforcement. A hex whose works
## run through two edges follows one smooth curve (the same curve the terrain shader cuts), so a
## line reads as a single continuous excavated channel rather than an accordion of spokes.
## Construction shows the server's real progress in stages: survey stakes and tape, earth removal
## with loose spoil heaps, deep excavation with a continuous spoil bank, reinforcement
## (revetments, sandbags, duckboards) and the finished line with a firing step and occasional
## fire bays. Crews and a small excavator work only at the project's actual fronts; works waiting
## for materials stand idle. Damaged segments slump. All geometry is cosmetic. The server owns
## cover, progress and traversability; mud and puddles come from the shared wet-weather surface.

const MAX_CREWS := 24
## samples along a through curve: dense enough that tight turns read as one smooth bend
const CURVE_SAMPLES := 21


static func routes(record:Array,grid:HexGrid) -> int:
	if record.size()>8 and int(record[8])>0: return int(record[8])
	# Older saves contain facing only. A short straight position replaces the old accordion.
	var angle:=float(record[3])*PI/3.0+PI*.5
	var direction:=posmod(int(round(-angle/(PI/3.0))),6)
	return (1<<direction)|(1<<posmod(direction+3,6))


## the drawn centre polylines of one hex in local coordinates (one curve, or one spoke per edge)
static func centrelines(bits:int,grid:HexGrid) -> Array:
	var ends:=[]
	for direction in 6:
		if bits&(1<<direction): ends.append(grid.dir_vec[direction]*HexGrid.SQRT3*.5)
	var result:=[]
	if ends.size()==2:
		var line:Array[Vector2]=[]
		for k in CURVE_SAMPLES:
			var t:=k/float(CURVE_SAMPLES-1)
			line.append(ends[0]*(1.0-t)*(1.0-t)+ends[1]*t*t)
		result.append(line)
		return result
	for end in ends:
		var line:Array[Vector2]=[]
		for k in 6: line.append((end as Vector2)*k/5.0)
		result.append(line)
	return result


## fire bays: a completed through hex selected by its cell (matches the terrain shader)
static func bay(tile:int,grid:HexGrid,t:float,progress:float,through:bool) -> float:
	if not through or progress<.99 or posmod((tile%grid.w)*7+(tile/grid.w)*13,3)!=0: return 1.0
	return 1.0+.6*smoothstep(.3,.4,t)*(1.0-smoothstep(.6,.7,t))


static func distance_to_route(record:Array,grid:HexGrid,point:Vector2) -> float:
	var center:=grid.center(int(record[0])); var local:=Vector2(grid.dx_wrap(center.x,point.x),point.y-center.y)
	var nearest:=INF
	for line in centrelines(routes(record,grid),grid):
		for k in (line as Array).size()-1:
			nearest=minf(nearest,local.distance_to(Geometry2D.get_closest_point_to_segment(local,line[k],line[k+1])))
	return nearest


static func build(world:WorldState,anchor:Vector2) -> Dictionary:
	var kit:=MeshKit.new()
	var defenses:={}
	for building:Dictionary in world.buildings.values():
		if building.ty in ["guard_post","bunker","fort","aa_battery"] and int(building.get("d",0))==1 and building.get("st","")!="ruined": defenses[int(building.t)]=building
	# actual work fronts of own projects (server project state); bounded crews
	var fronts:={}
	var trench_state:Dictionary=world.econ.get("trenches",{}) if world.econ.get("trenches") is Dictionary else {}
	for project in trench_state.get("projects",[]):
		if str(project.get("status",""))=="materials": continue
		for tile in project.get("fronts",[]): fronts[int(tile)]=true
	var image:=Image.create(world.grid.w,world.grid.h,false,Image.FORMAT_RGBA8)
	var crews:=0
	for record in world.fw:
		var tile:=int(record[0]); var progress:=float(record[4])/100.0
		var center:=world.grid.center(tile); center.x=anchor.x+world.grid.dx_wrap(anchor.x,center.x)
		var bits:=routes(record,world.grid)
		image.set_pixel(tile%world.grid.w,tile/world.grid.w,Color(progress,float(bits)/255.0,float(record[3])/255.0,1))
		var facing:=Vector2(cos(float(record[3])*PI/3),sin(float(record[3])*PI/3))
		var waiting:bool=record.size()>6 and int(record[6])==1
		var lines:=centrelines(bits,world.grid)
		var through:=lines.size()==1 and (lines[0] as Array).size()==CURVE_SAMPLES
		if progress<=.01:
			_survey(kit,world,center,lines,waiting)
			continue
		var hp:=float(record[5]) if record.size()>5 else 100.0
		var reinforced:=int(record[2])==1
		for line in lines:
			_channel(kit,world,tile,center,line,progress,facing,reinforced,through,hp)
		if not through:
			# junction floors meet under the same terrain cut rather than leaving wedge-shaped gaps
			var depth:=.015+.14*progress; var half_width:=.045+.03*progress
			kit.cylinder("soil",_point(world,center,-depth),half_width,.004,12,Color(.42,.35,.27))
		if fronts.has(tile) and progress<1.0 and not waiting and crews<MAX_CREWS:
			_crew(kit,world,center,lines,progress,tile); crews+=1
		elif waiting and progress<1.0:
			_stalled(kit,world,center,tile)
		for direction in 6:
			var neighbor:=world.grid.nb[tile*6+direction]
			if not defenses.has(neighbor) or int(defenses[neighbor].o)!=int(record[1]): continue
			_access(kit,world,center,direction,progress,defenses[neighbor])
	return {"mesh":kit.commit() if not kit.is_empty() else null,"mask":ImageTexture.create_from_image(image)}


## planned/surveyed only: stakes along the route joined by a white tape line
static func _survey(kit:MeshKit,world:WorldState,center:Vector2,lines:Array,waiting:bool) -> void:
	for line in lines:
		var previous:=Vector3.INF
		for k in range(0,(line as Array).size(),2):
			var p:Vector2=center+line[k]
			var top:=_point(world,p,.05)
			kit.box("timber",_point(world,p,0),Vector3(.012,.05,.012),Color(.85,.75,.6))
			if previous!=Vector3.INF: kit.strip("canvas",previous,top,.006,Color(1.4,1.4,1.35) if not waiting else Color(1.2,.9,.5))
			previous=top


## The excavated channel along one centre polyline: floor, darkening walls, spoil bank on the
## protected (facing) side, and stage details. Widths/depths follow the server progress.
static func _channel(kit:MeshKit,world:WorldState,tile:int,center:Vector2,line:Array,progress:float,facing:Vector2,reinforced:bool,through:bool,hp:float) -> void:
	var depth:=.015+.14*progress
	var base_half:=.045+.03*progress
	var count:=line.size()
	var points:=[]; var sides:=[]; var halves:=[]
	for k in count:
		var p:Vector2=center+line[k]
		var a:Vector2=line[maxi(k-1,0)]; var b:Vector2=line[mini(k+1,count-1)]
		var tangent:=(b-a).normalized(); var side:=Vector2(-tangent.y,tangent.x)
		points.append(p); sides.append(side)
		halves.append(base_half*bay(tile,world.grid,float(k)/(count-1),progress,through))
	# damage: a stable slumped section where the walls have collapsed into the floor
	var slump:=-1
	if hp<60.0: slump=posmod(tile*31,maxi(count-2,1))+1
	var lip:=Color(.66,.57,.43); var foot:=Color(.30,.25,.19); var floor_:=Color(.24,.20,.15)
	var front:Vector2=sides[count/2] if (sides[count/2] as Vector2).dot(facing)>=0 else -(sides[count/2] as Vector2)
	for k in count-1:
		var a:Vector2=points[k]; var b:Vector2=points[k+1]
		var sa:Vector2=sides[k]; var sb:Vector2=sides[k+1]
		var ha:float=halves[k]; var hb:float=halves[k+1]
		var da:=depth*(.35 if k==slump else 1.0); var db:=depth*(.35 if k+1==slump else 1.0)
		var left_a:=_point(world,a+sa*ha,0); var right_a:=_point(world,a-sa*ha,0)
		var left_b:=_point(world,b+sb*hb,0); var right_b:=_point(world,b-sb*hb,0)
		var drop_a:=Vector3(0,da,0); var drop_b:=Vector3(0,db,0)
		kit.quad("mud",left_a-drop_a,right_a-drop_a,right_b-drop_b,left_b-drop_b,floor_*1.4,Vector3.UP)
		var out_l:=Vector3(-sa.x,0,-sa.y); var out_r:=Vector3(sa.x,0,sa.y)
		kit.tri_colors("soil",left_a,left_a-drop_a,left_b-drop_b,lip,foot,foot,out_l)
		kit.tri_colors("soil",left_a,left_b-drop_b,left_b,lip,foot,lip,out_l)
		kit.tri_colors("soil",right_a,right_b,right_b-drop_b,lip*.94,lip*.94,foot,out_r)
		kit.tri_colors("soil",right_a,right_b-drop_b,right_a-drop_a,lip*.94,foot,foot,out_r)
		var seg_front:=sa if sa.dot(front)>=0 else -sa
		if progress<.4:
			# earth removal: loose spoil heaps thrown up on the front side
			if k%2==0:
				var heap:=(a+b)*.5+seg_front*(ha+.06)
				kit.cone("soil",_point(world,heap,-.004),.05+progress*.06,.02+progress*.06,7,Color(.74,.64,.48))
			continue
		# continuous spoil bank (parapet) with sloped faces; a low parados behind
		var crest:=.02+progress*.05; var bank:=.07+progress*.04
		var off_a:=seg_front*(ha+.05); var off_b:=seg_front*(hb+.05)
		kit.quad("soil",_point(world,a+off_a-seg_front*bank,.003),_point(world,a+off_a,crest),_point(world,b+off_b,crest),_point(world,b+off_b-seg_front*bank,.003),Color(.76,.67,.49),Vector3.UP)
		kit.quad("soil",_point(world,a+off_a,crest),_point(world,a+off_a+seg_front*bank,.003),_point(world,b+off_b+seg_front*bank,.003),_point(world,b+off_b,crest),Color(.72,.63,.48),Vector3.UP)
		if progress>=.75:
			kit.quad("soil",_point(world,a-off_a,.002),_point(world,a-off_a-seg_front*.05,.018),_point(world,b-off_b-seg_front*.05,.018),_point(world,b-off_b,.002),Color(.74,.66,.5),Vector3.UP)
			# revetment planks on both walls and duckboards along the floor
			for s in [-1.0,1.0]:
				var wall_a:=_point(world,a+sa*ha*s*.98,-da*.15); var wall_b:=_point(world,b+sb*hb*s*.98,-db*.15)
				kit.quad("timber",wall_a,wall_b,wall_b-Vector3(0,db*.8,0),wall_a-Vector3(0,da*.8,0),Color(.62,.52,.38),Vector3(-sa.x*s,0,-sa.y*s))
			var mid:=(a+b)*.5
			kit.strip("timber",_point(world,mid+sa*ha*.6,-depth+.006),_point(world,mid-sa*ha*.6,-depth+.006),.03,Color(.55,.44,.30))
			if k%2==0:
				for sign_ in [-1.0,1.0]: kit.box("timber",_point(world,a+sa*(ha+.004)*sign_,-depth),Vector3(.016,depth+.02,.016),Color(.7,.6,.46))
		if progress>=.75 and (reinforced or progress>=.99):
			var bag:=(a+b)*.5+seg_front*(ha+.03)
			kit.box("canvas",_point(world,bag,crest*.7),Vector3(.11,.03,.05),Color(.82,.77,.57),atan2(-(b-a).y,(b-a).x))
		if progress>=.99:
			# firing step along the front wall
			var step_a:=_point(world,a+seg_front*ha*.6,-depth*.45); var step_b:=_point(world,b+seg_front*hb*.6,-depth*.45)
			kit.strip("soil",step_a,step_b,ha*.5,Color(.5,.42,.31))
	if slump>=0 and slump<count:
		var p:Vector2=points[slump]
		kit.cone("soil",_point(world,p,-depth*.8),.07,depth*.7,7,Color(.6,.52,.4))


## a bounded representative crew at a real work front: diggers, a wheelbarrow, and a small
## excavator once the cut is deep enough. Colours and shapes only; no simulated workers.
static func _crew(kit:MeshKit,world:WorldState,center:Vector2,lines:Array,progress:float,tile:int) -> void:
	var line:Array=lines[0]
	var at:Vector2=center+line[line.size()/2]
	var rng:=RandomNumberGenerator.new(); rng.seed=tile*977
	var depth:=.015+.14*progress
	for k in 3:
		var p:=at+Vector2(rng.randf_range(-.08,.08),rng.randf_range(-.08,.08))
		var y:=-depth*.6 if k<2 else .0
		var base:=_point(world,p,y)
		kit.box("olive",base,Vector3(.016,.032,.012),Color(.78,.72,.5))
		kit.box("painted_metal",base+Vector3(0,.032,0),Vector3(.013,.01,.013),Color(.95,.75,.2))
	var barrow:=_point(world,at+Vector2(.14,.05),0)
	kit.box("steel",barrow,Vector3(.04,.018,.024),Color(.5,.62,.5),rng.randf()*TAU)
	if progress>=.3:
		var e:=at+Vector2(-.18,.12)
		var base:=_point(world,e,0)
		var yaw:=rng.randf()*TAU
		kit.box("painted_metal",base,Vector3(.07,.03,.05),Color(.95,.72,.2),yaw)
		kit.box("painted_metal",base+Vector3(0,.03,0),Vector3(.035,.03,.035),Color(.95,.72,.2),yaw)
		kit.box("steel",base+Vector3(.05,.035,0),Vector3(.08,.01,.01),Color(.4,.4,.38),yaw-.4)


## works waiting for materials: an empty pallet and a tool stack, no crew
static func _stalled(kit:MeshKit,world:WorldState,center:Vector2,tile:int) -> void:
	var p:=center+Vector2.from_angle(float(posmod(tile*13,628))/100.0)*.25
	kit.box("timber",_point(world,p,0),Vector3(.06,.01,.05),Color(.7,.6,.45))
	kit.box("steel",_point(world,p+Vector2(.05,0),0),Vector3(.006,.04,.006),Color(.5,.5,.5),.4)


static func _access(kit:MeshKit,world:WorldState,center:Vector2,direction:int,progress:float,building:Dictionary) -> void:
	# A shallow communication path and an entrance tie adjacent authorized defenses into the line.
	# This is not an additional functional trench, road, crossing, collision or source of cover.
	var type:=str(building.ty)
	var along:=world.grid.dir_vec[direction]; var side:=Vector2(-along.y,along.x)
	var start:=center+along*.18; var end:=center+along*1.32
	for step_ in 8:
		var a:=start.lerp(end,step_/8.0); var b:=start.lerp(end,(step_+1)/8.0)
		kit.strip("soil",_point(world,a,.006),_point(world,b,.006),.1,Color(.6,.52,.4))
		kit.strip("soil",_point(world,a+side*.07,.012),_point(world,b+side*.07,.012),.035,Color(.76,.67,.5))
		kit.strip("soil",_point(world,a-side*.07,.012),_point(world,b-side*.07,.012),.035,Color(.76,.67,.5))
	if progress<.75: return
	var entrance:=center+along*1.18
	var yaw:=atan2(-along.y,along.x)
	var upgraded:=int(building.get("lv",1))>=2
	match type:
		"bunker","fort":
			# concrete entrance portal with wing walls and a steel door at the end of the path
			for sign_ in [-1.0,1.0]:
				kit.box("concrete",_point(world,entrance+side*.075*sign_,0),Vector3(.12,.08,.025),Color(.86,.85,.8),yaw)
			kit.box("concrete",_point(world,entrance+along*.04,.08),Vector3(.06,.02,.17),Color(.84,.83,.78),yaw)
			kit.box("steel",_point(world,entrance+along*.055,0),Vector3(.006,.07,.08),Color(.4,.42,.4),yaw)
		"aa_battery":
			for k in 3:
				for sign_ in [-1.0,1.0]: kit.box("canvas",_point(world,entrance+side*.08*sign_+along*(k*.04-.04),k*.0),Vector3(.045,.025,.03),Color(.82,.77,.57),yaw)
		_:
			var material:="concrete" if upgraded else "timber"
			for sign_ in [-1.0,1.0]:
				kit.box(material,_point(world,entrance+side*.075*sign_,0),Vector3(.14,.07,.02),Color(.88,.85,.76),yaw)
			for k in 3: kit.box(material,_point(world,entrance+along*(.02+k*.025),-.01+k*.012),Vector3(.022,.012,.11),Color(.8,.74,.62),yaw)


static func _point(world:WorldState,point:Vector2,offset:float) -> Vector3:
	return Vector3(point.x,world.ground_height(point.x,point.y)+offset,point.y)
