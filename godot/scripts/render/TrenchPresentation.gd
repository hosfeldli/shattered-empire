class_name TrenchPresentation
extends RefCounted
## One route drives the terrain cut, floor, walls, parapet and reinforcement.
## All geometry is cosmetic. The server owns cover, progress and traversability.
static func routes(record:Array,grid:HexGrid) -> int:
	if record.size()>8 and int(record[8])>0: return int(record[8])
	# Older saves contain facing only. A short straight position replaces the old accordion.
	var angle:=float(record[3])*PI/3.0+PI*.5
	var direction:=posmod(int(round(-angle/(PI/3.0))),6)
	return (1<<direction)|(1<<posmod(direction+3,6))

static func distance_to_route(record:Array,grid:HexGrid,point:Vector2) -> float:
	var center:=grid.center(int(record[0])); var local:=Vector2(grid.dx_wrap(center.x,point.x),point.y-center.y)
	var bits:=routes(record,grid); var nearest:=INF
	for direction in 6:
		if not bits&(1<<direction): continue
		var end:=grid.dir_vec[direction]*HexGrid.SQRT3*.5
		nearest=minf(nearest,local.distance_to(end*clampf(local.dot(end)/end.length_squared(),0,1)))
	return nearest

static func build(world:WorldState,anchor:Vector2) -> Dictionary:
	var kit:=MeshKit.new()
	var defenses:={}
	for building:Dictionary in world.buildings.values():
		if building.ty in ["guard_post","bunker","fort","aa_battery"] and int(building.get("d",0))==1 and building.get("st","")!="ruined": defenses[int(building.t)]=building
	var image:=Image.create(world.grid.w,world.grid.h,false,Image.FORMAT_RGBA8)
	for record in world.fw:
		var tile:=int(record[0]); var progress:=float(record[4])/100.0
		var center:=world.grid.center(tile); center.x=anchor.x+world.grid.dx_wrap(anchor.x,center.x)
		var bits:=routes(record,world.grid)
		image.set_pixel(tile%world.grid.w,tile/world.grid.w,Color(progress,float(bits)/255.0,float(record[3])/255.0,1))
		var facing:=Vector2(cos(float(record[3])*PI/3),sin(float(record[3])*PI/3))
		if progress<=.01:
			for sign_ in [-1,1]:
				var pos:=center+Vector2(-facing.y,facing.x)*.55*float(sign_)
				kit.box("timber",Vector3(pos.x,world.ground_height(pos.x,pos.y)+.06,pos.y),Vector3(.018,.12,.018))
			continue
		var depth:=.015+.14*progress
		var half_width:=.045+.03*progress
		for direction in 6:
			if not bits&(1<<direction): continue
			var end:=center+world.grid.dir_vec[direction]*HexGrid.SQRT3*.5
			var tangent:=(end-center).normalized(); var side:=Vector2(-tangent.y,tangent.x)
			for step_ in 5:
				var a:=center.lerp(end,float(step_)/5.0); var b:=center.lerp(end,float(step_+1)/5.0)
				var left_a:=_point(world,a+side*half_width,0); var right_a:=_point(world,a-side*half_width,0)
				var left_b:=_point(world,b+side*half_width,0); var right_b:=_point(world,b-side*half_width,0)
				var drop:=Vector3(0,depth,0)
				kit.quad("soil",left_a-drop,right_a-drop,right_b-drop,left_b-drop,Color(.48,.4,.3),Vector3.UP)
				kit.quad("soil",left_a,left_a-drop,left_b-drop,left_b,Color(.7,.6,.46),Vector3(-side.x,0,-side.y))
				kit.quad("soil",right_a,right_b,right_b-drop,right_a-drop,Color(.65,.55,.43),Vector3(side.x,0,side.y))
				var front:=side if side.dot(facing)>0 else -side
				if absf(side.dot(facing))<.001: front=side if side.y<0 or is_zero_approx(side.y) and side.x>0 else -side
				var berm_offset:=front*(half_width+.05)
				# A low spoil bank with sloped sides replaces the floating flat parapet ribbon.
				var crest:=.012+progress*.055; var berm_width:=.07+progress*.04
				var front_edge:=berm_offset+front*berm_width; var rear_edge:=berm_offset-front*berm_width
				kit.quad("soil",_point(world,a+rear_edge,.003),_point(world,a+berm_offset,crest),_point(world,b+berm_offset,crest),_point(world,b+rear_edge,.003),Color(.76,.67,.49),Vector3.UP)
				kit.quad("soil",_point(world,a+berm_offset,crest),_point(world,a+front_edge,.003),_point(world,b+front_edge,.003),_point(world,b+berm_offset,crest),Color(.72,.63,.48),Vector3.UP)
				if progress>=.75 and int(record[2])==1:
					var bag:=(a+b)*.5+berm_offset
					kit.box("canvas",_point(world,bag,crest),Vector3(.13,.035,.065),Color(.82,.77,.57),atan2(-tangent.y,tangent.x))
					if step_%2==0:
						kit.strip("timber",left_a-drop*.8,right_a-drop*.8,.022,Color(.6,.5,.37))
						for sign_ in [-1.0,1.0]:
							var support:=_point(world,a+side*(half_width+.006)*sign_,-depth)
							kit.box("timber",support,Vector3(.018,depth+.02,.018),Color(.7,.6,.46))
		# Junction floors meet under the same terrain cut rather than leaving wedge-shaped gaps.
		kit.cylinder("soil",_point(world,center,-depth),half_width,.004,12,Color(.48,.4,.3))
		for direction in 6:
			var neighbor:=world.grid.nb[tile*6+direction]
			if not defenses.has(neighbor) or int(defenses[neighbor].o)!=int(record[1]): continue
			_access(kit,world,center,direction,progress,str(defenses[neighbor].ty))
	return {"mesh":kit.commit() if not kit.is_empty() else null,"mask":ImageTexture.create_from_image(image)}

static func _access(kit:MeshKit,world:WorldState,center:Vector2,direction:int,progress:float,type:String) -> void:
	# A surface access path and an entry revetment tie adjacent authorized defenses together.
	# This is not an additional functional trench, road, crossing, collision or source of cover.
	var along:=world.grid.dir_vec[direction]; var side:=Vector2(-along.y,along.x)
	var start:=center+along*.18; var end:=center+along*1.50
	for step_ in 8:
		var a:=start.lerp(end,step_/8.0); var b:=start.lerp(end,(step_+1)/8.0)
		kit.strip("soil",_point(world,a,.008),_point(world,b,.008),.11,Color(.73,.66,.51))
	if progress<.75: return
	var entrance:=center+along*1.18
	var material:="timber" if type=="guard_post" else "concrete"
	for sign_ in [-1.0,1.0]:
		var position:Vector2=entrance+side*.09*sign_
		kit.box(material,_point(world,position,.008),Vector3(.18,.09,.035),Color(.88,.85,.76),atan2(-along.y,along.x))

static func _point(world:WorldState,point:Vector2,offset:float) -> Vector3:
	return Vector3(point.x,world.ground_height(point.x,point.y)+offset,point.y)
