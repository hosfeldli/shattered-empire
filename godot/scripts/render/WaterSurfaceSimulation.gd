class_name WaterSurfaceSimulation
extends RefCounted
## Bounded, fixed-step shallow-water surface solver. Heights and vertical velocities are advected
## by the received river current, then pressure waves propagate between wet cells. Reflecting
## banks and a damped outer border keep impulses stable. This cannot flood authoritative land.
const STEP:=1.0/30.0
var resolution:=48
var cell_size:=.30
var origin:=Vector2.ZERO
var height:=PackedFloat32Array()
var velocity:=PackedFloat32Array()
var wet:=PackedByteArray()
var current:=PackedVector2Array()
var scratch_h:=PackedFloat32Array()
var scratch_v:=PackedFloat32Array()
var next_h:=PackedFloat32Array()
var next_v:=PackedFloat32Array()
var texture:ImageTexture
var clock:=0.0
var accumulator:=0.0
var steps:=0
var max_step_us:=0
var exposed:=PackedInt32Array()

func reset(size_:=48) -> void:
	resolution=size_; origin=Vector2.ZERO; clock=0; accumulator=0; steps=0
	var count:=resolution*resolution
	# Packed arrays copy on write: keep explicit initialized buffers.
	height.resize(count); height.fill(0); velocity=height.duplicate(); scratch_h=height.duplicate(); scratch_v=height.duplicate(); next_h=height.duplicate(); next_v=height.duplicate()
	wet.resize(count); wet.fill(0); current.resize(count); current.fill(Vector2.ZERO)
	texture=null

func recenter(center:Vector2) -> bool:
	var wanted:=(center/ cell_size).floor()*cell_size-Vector2.ONE*(resolution/2)*cell_size
	var shift:=Vector2i(((wanted-origin)/cell_size).round())
	if shift==Vector2i.ZERO: return false
	var old_h:=height.duplicate(); var old_v:=velocity.duplicate(); var old_wet:=wet.duplicate(); var old_current:=current.duplicate()
	exposed.clear()
	for y in resolution:
		for x in resolution:
			var sx:=x+shift.x; var sy:=y+shift.y; var index:=y*resolution+x
			var inside:=sx>=0 and sy>=0 and sx<resolution and sy<resolution
			height[index]=old_h[sy*resolution+sx] if inside else 0
			velocity[index]=old_v[sy*resolution+sx] if inside else 0
			wet[index]=old_wet[sy*resolution+sx] if inside else 0
			current[index]=old_current[sy*resolution+sx] if inside else Vector2.ZERO
			if not inside: exposed.append(index)
	origin=wanted
	return true

func impulse(point:Vector2,strength:float) -> void:
	var cell:=Vector2i(((point-origin)/cell_size).floor())
	if cell.x<1 or cell.y<1 or cell.x>=resolution-1 or cell.y>=resolution-1: return
	var index:=cell.y*resolution+cell.x
	if wet[index]: velocity[index]=clampf(velocity[index]+strength,-.6,.6)

func advance(dt:float,wind:Vector2=Vector2.ZERO) -> bool:
	accumulator=minf(accumulator+dt,STEP*2.0)
	var updated:=false
	while accumulator>=STEP:
		accumulator-=STEP; step(wind); updated=true
	return updated

func step(wind:Vector2=Vector2.ZERO) -> void:
	var started:=Time.get_ticks_usec(); clock+=STEP; steps+=1
	for y in resolution:
		for x in resolution:
			var index:=y*resolution+x
			if not wet[index]: scratch_h[index]=0; scratch_v[index]=0; continue
			var back:=Vector2(x,y)-current[index]*STEP/cell_size
			scratch_h[index]=_sample(height,back); scratch_v[index]=_sample(velocity,back)
	var c2:=1.6; var inv_cell2:=1.0/(cell_size*cell_size)
	for y in resolution:
		for x in resolution:
			var index:=y*resolution+x
			if not wet[index]: next_h[index]=0; next_v[index]=0; continue
			var h:=scratch_h[index]; var lap:=-4.0*h
			lap+=scratch_h[index-1] if x>0 and wet[index-1] else h
			lap+=scratch_h[index+1] if x<resolution-1 and wet[index+1] else h
			lap+=scratch_h[index-resolution] if y>0 and wet[index-resolution] else h
			lap+=scratch_h[index+resolution] if y<resolution-1 and wet[index+resolution] else h
			var point:=origin+Vector2(x,y)*cell_size
			var gust:=sin(point.dot(wind.normalized())*2.1-clock*2.8)*minf(wind.length(),2.0)*.018
			var edge:=mini(mini(x,y),mini(resolution-1-x,resolution-1-y))
			var damping:=.965 if edge>=4 else .78
			var v:=clampf((scratch_v[index]+(lap*c2*inv_cell2+gust)*STEP)*damping,-.6,.6)
			next_v[index]=v; next_h[index]=clampf(h+v*STEP,-.075,.075)
	var old_h:=height; height=next_h; next_h=old_h
	var old_v:=velocity; velocity=next_v; next_v=old_v
	max_step_us=maxi(max_step_us,Time.get_ticks_usec()-started)

func upload() -> void:
	var image:=Image.create_from_data(resolution,resolution,false,Image.FORMAT_RF,height.to_byte_array())
	if texture==null: texture=ImageTexture.create_from_image(image)
	else: texture.update(image)

func _sample(buffer:PackedFloat32Array,point:Vector2) -> float:
	var p:=point.clamp(Vector2.ZERO,Vector2.ONE*(resolution-1.001)); var x:=int(p.x); var y:=int(p.y); var f:=p-Vector2(x,y)
	return lerpf(lerpf(buffer[y*resolution+x],buffer[y*resolution+x+1],f.x),lerpf(buffer[(y+1)*resolution+x],buffer[(y+1)*resolution+x+1],f.x),f.y)
