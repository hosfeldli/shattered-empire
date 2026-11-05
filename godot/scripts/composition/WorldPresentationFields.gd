class_name WorldPresentationFields
extends RefCounted
## Compact surface context from authorized cells. Updates touch changed cells and their six
## neighbors; no world/mesh rebuild is needed for visibility or a new adjacent farm.
var world:WorldState
var materials:Array=[]
var visibility:ImageTexture
var agriculture:ImageTexture
var industry:ImageTexture
var visibility_bytes:=PackedByteArray()
var farm_bytes:=PackedByteArray()
var industry_bytes:=PackedByteArray()
var previous_visibility:=PackedByteArray()
var previous_known:=PackedByteArray()
var farms:={}
var works:={}
var buildings_version:=-1

func setup(w:WorldState,surfaces:Array) -> void:
	world=w; materials=surfaces
	w.welcomed.connect(reset); w.reset.connect(reset)
	w.vis_changed.connect(update_visibility); w.geo_changed.connect(update_geography)
	w.snapshot_applied.connect(update_development); w.econ_applied.connect(update_development)

func reset() -> void:
	farms.clear(); works.clear(); buildings_version=-1
	var count:=world.grid.n*4
	visibility_bytes.resize(count); visibility_bytes.fill(0)
	farm_bytes.resize(count); farm_bytes.fill(0); industry_bytes.resize(count); industry_bytes.fill(0)
	previous_visibility=world.vis_bits.duplicate(); previous_known=world.known_mask.duplicate()
	visibility=ImageTexture.create_from_image(Image.create_from_data(world.grid.w,world.grid.h,false,Image.FORMAT_RGBA8,visibility_bytes))
	agriculture=ImageTexture.create_from_image(Image.create_from_data(world.grid.w,world.grid.h,false,Image.FORMAT_RGBA8,farm_bytes))
	industry=ImageTexture.create_from_image(Image.create_from_data(world.grid.w,world.grid.h,false,Image.FORMAT_RGBA8,industry_bytes))
	var parameters:={"visibility_field":visibility,"visibility_cells":Vector2(world.grid.w,world.grid.h),"visibility_ready":1.0,"visibility_wrap":1.0 if world.grid.wrap else 0.0}
	for material:ShaderMaterial in materials:
		for key in parameters: material.set_shader_parameter(key,parameters[key])
	materials[0].set_shader_parameter("agriculture_field",agriculture)
	materials[0].set_shader_parameter("industry_field",industry)
	materials[0].set_shader_parameter("field_ready",1.0)
	# Whole-world row phase is periodic at the horizontal seam and shared by connected parcels.
	var angle:=.22+posmod(world.world_seed,9)*.045
	materials[0].set_shader_parameter("crop_wave",Vector2(TAU*roundf(cos(angle)*world.grid.period/.14)/world.grid.period,TAU*sin(angle)/.14))
	MaterialLibrary.bind_visibility(parameters)
	if world.known_mask.has(255): _write_visibility(range(world.grid.n))
	update_development()

func _around(changed:Array) -> Array:
	var affected:={}
	for tile:int in changed:
		if tile<0 or tile>=world.grid.n: continue
		affected[tile]=true
		for direction in 6:
			var neighbor:=world.grid.nb[tile*6+direction]
			if neighbor>=0: affected[neighbor]=true
	return affected.keys()

func _write_visibility(changed:Array) -> void:
	for tile:int in changed:
		var offset:=tile*4
		visibility_bytes[offset]=255 if world.known[tile] else 0
		visibility_bytes[offset+1]=255 if world.is_visible(tile) else 0
		var unknown:=0; var unseen:=0
		for direction in 6:
			var neighbor:=world.grid.nb[tile*6+direction]
			if neighbor<0 or not world.known[neighbor]: unknown|=1<<direction
			if neighbor<0 or not world.is_visible(neighbor): unseen|=1<<direction
		visibility_bytes[offset+2]=unknown; visibility_bytes[offset+3]=unseen
	visibility.update(Image.create_from_data(world.grid.w,world.grid.h,false,Image.FORMAT_RGBA8,visibility_bytes))

func update_visibility(bits:PackedByteArray) -> void:
	if visibility==null: return
	var changed:=[]
	for index in bits.size():
		var difference:=int(bits[index])^int(previous_visibility[index])
		if difference==0: continue
		for bit in 8:
			if difference & (1<<bit): changed.append(index*8+bit)
	previous_visibility=bits.duplicate()
	if not changed.is_empty(): _write_visibility(_around(changed))

func update_geography(chunks:PackedInt32Array) -> void:
	if visibility==null: return
	var changed:=[]
	for chunk:int in chunks:
		var x0:=(chunk%world.chunks_w)*world.chunk; var y0:=(chunk/world.chunks_w)*world.chunk
		for y in range(y0,mini(y0+world.chunk,world.grid.h)):
			for x in range(x0,mini(x0+world.chunk,world.grid.w)):
				var tile:=y*world.grid.w+x
				if previous_known[tile]!=world.known_mask[tile]: previous_known[tile]=world.known_mask[tile]; changed.append(tile)
	if not changed.is_empty(): _write_visibility(_around(changed))

func update_development() -> void:
	if agriculture==null or buildings_version==world.buildings_version: return
	buildings_version=world.buildings_version
	var next_farms:={}; var next_works:={}; var changed:={}
	for building:Dictionary in world.buildings.values():
		if str(building.get("st",""))=="ruined": continue
		var done:bool=int(building.get("d",0))==1
		var progress:=1.0 if done else int(building.get("p",0))/100.0
		if progress<.2: continue
		var group:=str(RecipeRegistry.GROUPS.get(str(building.ty),""))
		if group=="farm": next_farms[int(building.t)]=[int(building.o),int(building.get("lv",1)),int(building.get("hp",100))/25,roundi(progress*10)]
		elif group=="ind": next_works[int(building.t)]=[int(building.o),int(building.get("lv",1)),int(building.get("hp",100))/25,roundi(progress*10)]
	for pair in [[farms,next_farms],[works,next_works]]:
		for tile in pair[0]:
			if pair[0][tile]!=pair[1].get(tile): changed[tile]=true
		for tile in pair[1]:
			if pair[1][tile]!=pair[0].get(tile): changed[tile]=true
	farms=next_farms; works=next_works
	if changed.is_empty(): return
	for tile:int in _around(changed.keys()):
		_write_development_cell(farm_bytes,farms,tile); _write_development_cell(industry_bytes,works,tile)
	agriculture.update(Image.create_from_data(world.grid.w,world.grid.h,false,Image.FORMAT_RGBA8,farm_bytes))
	industry.update(Image.create_from_data(world.grid.w,world.grid.h,false,Image.FORMAT_RGBA8,industry_bytes))

func _write_development_cell(bytes:PackedByteArray,records:Dictionary,tile:int) -> void:
	var offset:=tile*4
	for channel in 4: bytes[offset+channel]=0
	if not records.has(tile): return
	bytes[offset]=255; bytes[offset+2]=clampi(int(records[tile][1])*80,0,255); bytes[offset+3]=clampi(roundi(float(records[tile][3])*25.5),0,255)
	var boundary:=0
	for direction in 6:
		var neighbor:=world.grid.nb[tile*6+direction]
		if not records.has(neighbor) or int(records[neighbor][0])!=int(records[tile][0]): boundary|=1<<direction
	bytes[offset+1]=boundary
