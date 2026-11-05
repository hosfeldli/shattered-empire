class_name NativeModelThumbnail
extends SubViewportContainer
## A cached single-frame view of the same mesh used by the world, not a symbolic tile icon.
func setup(model:Mesh) -> void:
	custom_minimum_size=Vector2(72,52); stretch=true; mouse_filter=Control.MOUSE_FILTER_IGNORE
	var view:=SubViewport.new(); view.size=Vector2i(144,104); view.transparent_bg=true; view.own_world_3d=true
	view.render_target_update_mode=SubViewport.UPDATE_ONCE; add_child(view)
	if model==null: return
	var instance:=MeshInstance3D.new(); instance.mesh=model; instance.cast_shadow=GeometryInstance3D.SHADOW_CASTING_SETTING_OFF; view.add_child(instance)
	var bounds:=model.get_aabb(); var center:=bounds.get_center(); var radius:=maxf(bounds.size.length()*.7,.5)
	var camera:=Camera3D.new(); camera.projection=Camera3D.PROJECTION_ORTHOGONAL; camera.size=radius*1.65; camera.far=radius*10; view.add_child(camera)
	camera.position=center+Vector3(1,1.6,1.5).normalized()*radius*3; camera.look_at(center); camera.current=true
	var sun:=DirectionalLight3D.new(); sun.rotation_degrees=Vector3(-55,-40,0); sun.light_energy=1.2; view.add_child(sun)
	var environment:=WorldEnvironment.new(); var sky:=Environment.new(); sky.background_mode=Environment.BG_CLEAR_COLOR; sky.ambient_light_source=Environment.AMBIENT_SOURCE_COLOR; sky.ambient_light_color=Color(.7,.76,.84); sky.ambient_light_energy=.7; environment.environment=sky; view.add_child(environment)
