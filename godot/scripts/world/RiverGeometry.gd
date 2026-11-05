class_name RiverGeometry
extends RefCounted
## Shared channel curves for rendering, flow and dry building footprints. No invented waterways.
const STEPS:=10

static func width(world:WorldState,tile:int) -> float:
	return .20+.07*world.flow_bucket(tile)

static func tangent(world:WorldState,tile:int,fallback:=Vector2.RIGHT) -> Vector2:
	var direction:=world.flow_dir(tile)
	var forward:=world.grid.dir_vec[direction] if direction>=0 else fallback
	var arriving:=forward; var biggest:=-1
	for d in 6:
		var upstream:=world.grid.nb[tile*6+d]
		if upstream<0 or not world.known[upstream] or not world.is_river(upstream): continue
		var flow:=world.flow_dir(upstream)
		if flow>=0 and world.grid.nb[upstream*6+flow]==tile and world.flow_bucket(upstream)>biggest:
			biggest=world.flow_bucket(upstream); arriving=-world.grid.dir_vec[d]
	var result:=(forward+arriving).normalized()
	return result if result.length_squared()>.01 else forward

static func reach(world:WorldState,tile:int) -> Array:
	var grid:=world.grid; var start:=grid.center(tile); var direction:=world.flow_dir(tile)
	if direction<0: return []
	var next:=grid.nb[tile*6+direction]
	var end:=start+grid.dir_vec[direction]*HexGrid.SQRT3
	var known_next:=next>=0 and world.known[next]
	if not known_next: end=start.lerp(end,.5)
	var forward:=(end-start).normalized()
	var arriving:=forward
	var biggest:=-1
	for d in 6:
		var upstream:=grid.nb[tile*6+d]
		if upstream<0 or not world.known[upstream] or not world.is_river(upstream): continue
		var flow:=world.flow_dir(upstream)
		if flow>=0 and grid.nb[upstream*6+flow]==tile and world.flow_bucket(upstream)>biggest:
			biggest=world.flow_bucket(upstream); arriving=-grid.dir_vec[d]
	var leaving:=forward
	if known_next and world.is_river(next) and world.flow_dir(next)>=0:
		leaving=grid.dir_vec[world.flow_dir(next)]
	var tangent_start:=tangent(world,tile,forward)*.58
	var tangent_end:=tangent(world,next,forward)*.58 if known_next and world.is_river(next) else forward*.58
	var points:=[]
	for index in STEPS+1:
		var t:=float(index)/STEPS; var inv:=1.0-t
		points.append(start*inv*inv*inv+(start+tangent_start)*3.0*inv*inv*t+(end-tangent_end)*3.0*inv*t*t+end*t*t*t)
	return points

static func ribbon(world:WorldState,tile:int) -> Array:
	var points:=reach(world,tile); var result:=[]
	if points.is_empty(): return result
	var next:=world.grid.nb[tile*6+world.flow_dir(tile)]
	var end_width:=width(world,next) if next>=0 and world.known[next] and world.is_river(next) else width(world,tile)
	for index in points.size():
		var direction:Vector2
		if index==0: direction=tangent(world,tile)
		elif index==points.size()-1 and next>=0 and world.known[next] and world.is_river(next): direction=tangent(world,next)
		else: direction=((points[mini(points.size()-1,index+1)] as Vector2)-(points[maxi(0,index-1)] as Vector2)).normalized()
		var half:=lerpf(width(world,tile),end_width,float(index)/STEPS)*.5
		result.append({"center":points[index],"side":direction.orthogonal()*half})
	return result

static func segments(world:WorldState,tile:int) -> Array:
	var result:=[]; var points:=reach(world,tile)
	if points.is_empty():
		var point:=world.grid.center(tile)
		return [{"a":point,"b":point+Vector2(.001,0),"width":width(world,tile)*.5}]
	var next:=world.grid.nb[tile*6+world.flow_dir(tile)]
	var end_width:=width(world,next) if next>=0 and world.known[next] and world.is_river(next) else width(world,tile)
	for index in points.size()-1:
		result.append({"a":points[index],"b":points[index+1],"width":lerpf(width(world,tile),end_width,float(index)/STEPS)*.5})
	return result
