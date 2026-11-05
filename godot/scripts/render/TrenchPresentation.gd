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

static func build(world:WorldState,anchor:Vector2) -> Dictionary:
	var kit:=MeshKit.new()
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
				kit.box("wood",Vector3(pos.x,world.ground_height(pos.x,pos.y)+.06,pos.y),Vector3(.018,.12,.018))
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
				var berm_offset:=front*(half_width+.05)
				kit.strip("soil",_point(world,a+berm_offset,.012+progress*.055),_point(world,b+berm_offset,.012+progress*.055),.07+progress*.04,Color(.76,.67,.49))
				if progress>=.75 and int(record[2])==1:
					kit.strip("canvas",_point(world,a+berm_offset,.09),_point(world,b+berm_offset,.09),.06,Color(.82,.77,.57))
					if step_%2==0:
						kit.strip("wood",left_a-drop*.8,right_a-drop*.8,.022,Color(.6,.5,.37))
	return {"mesh":kit.commit() if not kit.is_empty() else null,"mask":ImageTexture.create_from_image(image)}

static func _point(world:WorldState,point:Vector2,offset:float) -> Vector3:
	return Vector3(point.x,world.ground_height(point.x,point.y)+offset,point.y)
