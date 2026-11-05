class_name WaterMicroSimulation
extends RefCounted
## Tactical water detail remains on the GPU: no readbacks and no full-resolution CPU solver.
const RESOLUTION:=256
const EXTENT:=10.0
const STEP:=1.0/120.0
var texture:=Texture2DRD.new()
var origin:=Vector2.ZERO
var accumulator:=0.0
var clock:=0.0
var steps:=0
var supported:=false
var _rd:RenderingDevice
var _shader:=RID()
var _pipeline:=RID()
var _sampler:=RID()
var _textures:Array[RID]=[]
var _sets:Array[RID]=[]
var _atlas:=RID()
var _index:=0
var _previous_origin:=Vector2.ZERO
var _reset:=true

func setup() -> void:
	if DisplayServer.get_name()=="headless": return
	supported=true
	RenderingServer.call_on_render_thread(_initialize)

func clear() -> void:
	accumulator=0; clock=0; steps=0
	RenderingServer.call_on_render_thread(func():_reset=true)

func update(dt:float,center:Vector2,atlas:Texture2D,cells:Vector2,wind:Vector2,rain:float) -> void:
	if not supported or atlas==null: return
	var spacing:=EXTENT/RESOLUTION
	origin=(center/spacing).floor()*spacing-Vector2.ONE*EXTENT*.5
	accumulator=minf(accumulator+dt,STEP*4)
	var count:=int(accumulator/STEP)
	if count<1: return
	accumulator-=count*STEP; clock+=count*STEP; steps+=count
	RenderingServer.call_on_render_thread(_compute.bind(count,origin,atlas.get_rid(),cells,wind,rain,clock))

func shutdown() -> void:
	texture.texture_rd_rid=RID()
	RenderingServer.call_on_render_thread(_free)

func _initialize() -> void:
	_rd=RenderingServer.get_rendering_device()
	if _rd==null: supported=false; return
	var source:RDShaderFile=load("res://shaders/water_micro.glsl")
	_shader=_rd.shader_create_from_spirv(source.get_spirv()); _pipeline=_rd.compute_pipeline_create(_shader)
	var sampler:=RDSamplerState.new(); sampler.mag_filter=RenderingDevice.SAMPLER_FILTER_LINEAR; sampler.min_filter=RenderingDevice.SAMPLER_FILTER_LINEAR
	_sampler=_rd.sampler_create(sampler)
	var format:=RDTextureFormat.new(); format.width=RESOLUTION; format.height=RESOLUTION
	format.format=RenderingDevice.DATA_FORMAT_R32G32B32A32_SFLOAT
	format.usage_bits=RenderingDevice.TEXTURE_USAGE_STORAGE_BIT|RenderingDevice.TEXTURE_USAGE_SAMPLING_BIT|RenderingDevice.TEXTURE_USAGE_CAN_COPY_TO_BIT|RenderingDevice.TEXTURE_USAGE_CAN_COPY_FROM_BIT
	for index in 2:
		var rid:=_rd.texture_create(format,RDTextureView.new(),[]); _rd.texture_clear(rid,Color(0,0,0,0),0,1,0,1); _textures.append(rid)

func _compute(count:int,new_origin:Vector2,atlas:RID,cells:Vector2,wind:Vector2,rain:float,time:float) -> void:
	if _rd==null or not _pipeline.is_valid(): return
	var atlas_rd:=RenderingServer.texture_get_rd_texture(atlas)
	if atlas_rd!=_atlas:
		for rid in _sets: if _rd.uniform_set_is_valid(rid): _rd.free_rid(rid)
		_sets.clear(); _atlas=atlas_rd
		for index in 2:
			var previous:=RDUniform.new(); previous.uniform_type=RenderingDevice.UNIFORM_TYPE_SAMPLER_WITH_TEXTURE; previous.binding=0; previous.add_id(_sampler); previous.add_id(_textures[index])
			var output:=RDUniform.new(); output.uniform_type=RenderingDevice.UNIFORM_TYPE_IMAGE; output.binding=1; output.add_id(_textures[1-index])
			var hydrology:=RDUniform.new(); hydrology.uniform_type=RenderingDevice.UNIFORM_TYPE_SAMPLER_WITH_TEXTURE; hydrology.binding=2; hydrology.add_id(_sampler); hydrology.add_id(_atlas)
			_sets.append(_rd.uniform_set_create([previous,output,hydrology],_shader,0))
	var shift:=(new_origin-_previous_origin)/(EXTENT/RESOLUTION)
	for step_ in count:
		var params:=PackedFloat32Array([new_origin.x,new_origin.y,EXTENT,RESOLUTION,STEP,time-(count-step_-1)*STEP,wind.x,wind.y,cells.x,cells.y,shift.x if step_==0 else 0.0,shift.y if step_==0 else 0.0,rain,1.0 if _reset else 0.0,0,0])
		var list:=_rd.compute_list_begin(); _rd.compute_list_bind_compute_pipeline(list,_pipeline); _rd.compute_list_bind_uniform_set(list,_sets[_index],0)
		_rd.compute_list_set_push_constant(list,params.to_byte_array(),params.size()*4)
		_rd.compute_list_dispatch(list,RESOLUTION/8,RESOLUTION/8,1); _rd.compute_list_end()
		_index=1-_index; _reset=false
	_previous_origin=new_origin
	texture.texture_rd_rid=_textures[_index]

func _free() -> void:
	if _rd==null: return
	for rid in _sets: if _rd.uniform_set_is_valid(rid): _rd.free_rid(rid)
	for rid in _textures: if rid.is_valid(): _rd.free_rid(rid)
	for rid in [_shader,_sampler]: if rid.is_valid(): _rd.free_rid(rid)
	_sets.clear(); _textures.clear()
