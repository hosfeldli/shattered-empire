class_name SitePlanner
extends RefCounted
## Visual siting inside an authoritative hex. Channel geometry matches WorldRenderer's river
## ribbons. Buildings stay level, sit on sampled terrain, and keep their footprints off water.
var world:WorldState
var channels:={}


func setup(w:WorldState) -> void:
	world=w
	w.welcomed.connect(clear); w.reset.connect(clear)


func clear() -> void: channels.clear()


func rivers(tile:int) -> Array:
	var cached:Dictionary=channels.get(tile,{})
	if int(cached.get("revision",-1))==world.geometry_revision: return cached.segments
	var result:=[]
	var nearby:=[tile]
	for dir in 6:
		var neighbor:=world.grid.nb[tile*6+dir]
		if neighbor>=0: nearby.append(neighbor)
	var center:=world.grid.center(tile)
	for t in nearby:
		if world.known[t]==0 or not world.is_river(t): continue
		var point:=world.grid.center(t)
		point.x=center.x+world.grid.dx_wrap(center.x,point.x)
		var width:=(.2+.07*world.flow_bucket(t))*.5
		var flow:=world.flow_dir(t)
		if flow>=0:
			result.append({"a":point,"b":point+world.grid.dir_vec[flow]*HexGrid.SQRT3*.5,"width":width})
		for dir in 6:
			var neighbor:=world.grid.nb[t*6+dir]
			if neighbor<0 or world.known[neighbor]==0 or not world.is_river(neighbor): continue
			if world.flow_dir(neighbor)==(dir+3)%6:
				result.append({"a":point,"b":point+world.grid.dir_vec[dir]*HexGrid.SQRT3*.5,"width":width})
		if flow<0:
			# A known isolated source is a water area too, even without an outgoing flow record.
			result.append({"a":point,"b":point+Vector2(.001,0),"width":width})
	if channels.size()>4096: channels.clear()
	channels[tile]={"revision":world.geometry_revision,"segments":result}
	return result


func plan(tile:int, preferred:Vector2, heading:float, half_size:Vector2, reserved:Array=[]) -> Dictionary:
	var river:=rivers(tile)
	var candidates:=[preferred]
	for radius in [.30,.48,.63]:
		for k in 12: candidates.append(Vector2.from_angle(heading+TAU*k/12.0)*radius)
	var headings:=[heading]
	if not river.is_empty():
		var direction:Vector2=river[0].b-river[0].a
		headings.append(-atan2(direction.y,direction.x)+PI*.5)
	var center:=world.grid.center(tile)
	for scale_ in [1.0,.8,.65,.5,.38]:
		for offset in candidates:
			for yaw in headings:
				var half:Vector2=half_size*scale_
				var radius:=half.length()
				var collision:=false
				for other in reserved:
					if (offset as Vector2).distance_to(other.offset)<(radius+float(other.radius))*.96: collision=true; break
				if collision: continue
				var corners:=_corners(center+offset,float(yaw),half)
				var fits:=true
				for point in corners:
					if world.grid.tile_at(point.x,point.y)!=tile: fits=false; break
				if not fits or not clear_of_water(tile,corners,.055): continue
				var high:=-INF; var low:=INF
				for point in corners+[center+offset]:
					var height:=world.ground_height(point.x,point.y)
					high=maxf(high,height); low=minf(low,height)
				return {"valid":true,"offset":offset,"yaw":yaw,"scale":scale_,"radius":radius,"half_size":half,
					"corners":corners,"min_height":low,"max_height":high,"river_near":not river.is_empty(),
					"transform":Transform3D(Basis(Vector3.UP,float(yaw)).scaled(Vector3.ONE*scale_),Vector3(center.x+offset.x,high+.012,center.y+offset.y))}
	return {"valid":false,"reason":"No dry footprint inside the received building parcel"}


func _corners(center:Vector2,yaw:float,half:Vector2) -> Array:
	var result:=[]
	for point in [Vector2(-half.x,-half.y),Vector2(half.x,-half.y),Vector2(half.x,half.y),Vector2(-half.x,half.y)]:
		result.append(center+(point as Vector2).rotated(-yaw))
	return result


func clear_of_water(tile:int,corners:Array,margin:float) -> bool:
	for point in corners:
		var t:=world.grid.tile_at(point.x,point.y)
		if t>=0 and world.known[t] and (world.is_sea(t) or world.is_lake(t)): return false
	for river in rivers(tile):
		var anchor:Vector2=corners[0]
		var ra:Vector2=river.a; var rb:Vector2=river.b
		ra.x=world.grid.near_x(ra.x,anchor.x); rb.x=ra.x+world.grid.dx_wrap(river.a.x,rb.x)
		if Geometry2D.is_point_in_polygon(ra,PackedVector2Array(corners)) or Geometry2D.is_point_in_polygon(rb,PackedVector2Array(corners)): return false
		for k in corners.size():
			var a:Vector2=corners[k]; var b:Vector2=corners[(k+1)%corners.size()]
			if Geometry2D.segment_intersects_segment(a,b,ra,rb)!=null: return false
			if a.distance_to(Geometry2D.get_closest_point_to_segment(a,ra,rb))<float(river.width)+margin: return false
			if ra.distance_to(Geometry2D.get_closest_point_to_segment(ra,a,b))<float(river.width)+margin: return false
			if rb.distance_to(Geometry2D.get_closest_point_to_segment(rb,a,b))<float(river.width)+margin: return false
	return true


func crosses_water(tile:int,a:Vector2,b:Vector2,width:=.12) -> bool:
	var midpoint:=(a+b)*.5
	return not clear_of_water(tile,_corners(midpoint,-(b-a).angle(),Vector2(a.distance_to(b)*.5,width*.5)),.03)
