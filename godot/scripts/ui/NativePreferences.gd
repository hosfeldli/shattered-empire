class_name NativePreferences
extends RefCounted
## Local presentation preferences only. Gameplay state remains on the server.
const SHORTCUTS:={"build":KEY_B,"research":KEY_T,"hold":KEY_H,"withdraw":KEY_X,"attack_move":KEY_E,"select_combat":KEY_Q,"form_army":KEY_G,"road":KEY_R,"center":KEY_SPACE,"pause":KEY_P}
const DEFAULTS:={"fullscreen":true,"resolution":"1600x900","quality":"medium","vsync":true,"fps":60,
	"volume":70.0,"ambience_volume":80.0,"effects_volume":85.0,"mute":false,"ui_scale":1.0,"pan_speed":1.0,"zoom_speed":1.0,"invert_zoom":false,"edge_pan":false,
	"weather_effects":true,"particle_density":1.0,"screen_shake":false,"reduced_motion":false,"high_contrast":false,"unit_labels":true,"resource_markers":true,"territory_borders":true,"wildlife":true,"onboarding_done":false,"bindings":{},
	"server":"wss://game.liamhosfeld.com/ws","player":"Commander"}
var values:=DEFAULTS.duplicate(true)
var path:="user://settings.cfg"
var previous_window_size:=Vector2i(1600,900)

func load_from(file:String) -> void:
	path=file; var config:=ConfigFile.new()
	if config.load(path)!=OK: return
	for key in DEFAULTS: values[key]=config.get_value("preferences",key,DEFAULTS[key])
	values.ui_scale=clampf(float(values.ui_scale),.8,1.5)
	values.pan_speed=clampf(float(values.pan_speed),.3,3)
	values.zoom_speed=clampf(float(values.zoom_speed),.3,3)
	values.volume=clampf(float(values.volume),0,100)
	values.ambience_volume=clampf(float(values.ambience_volume),0,100)
	values.effects_volume=clampf(float(values.effects_volume),0,100)
	if not str(values.quality) in RecipeRegistry.world_value("lod","presets",LODManager.PRESETS): values.quality="medium"
	if not str(values.resolution) in ["1280x720","1600x900","1920x1080","2560x1440"]: values.resolution="1600x900"
	if not int(values.fps) in [0,30,60,120,144]: values.fps=60

func save() -> Error:
	var config:=ConfigFile.new()
	for key in values: config.set_value("preferences",key,values[key])
	return config.save(path)

func apply(app:Node,windowed:=false) -> void:
	app._apply_quality(str(values.quality))
	app.cam.pan_multiplier=float(values.pan_speed); app.cam.zoom_multiplier=float(values.zoom_speed)
	app.input.preferences=self; app.command_tools.preferences=self
	app.cam.reduced_motion=bool(values.reduced_motion); app.cam.shake_enabled=bool(values.screen_shake) and not bool(values.reduced_motion)
	app.environment.effects_enabled=bool(values.weather_effects); app.environment.reduced_motion=bool(values.reduced_motion)
	app.composition.lod.particle_scale=float(values.particle_density)
	app.strategic.unit_labels=bool(values.unit_labels); app.strategic.resource_markers=bool(values.resource_markers)
	app.map_overlay.high_contrast=bool(values.high_contrast)
	app.terrain.territory.set_strength(1.0 if values.territory_borders else 0.0)
	app.wildlife.visible=bool(values.wildlife)
	app.military.ring_mesh.material=MaterialLibrary.glow(Color("77e7ff") if values.high_contrast else Color(.9,.92,.55))
	app.cam.invert_zoom=bool(values.invert_zoom); app.cam.edge_pan=bool(values.edge_pan)
	app.audio.enabled=not bool(values.mute)
	app.audio.set_levels(float(values.ambience_volume),float(values.effects_volume))
	AudioServer.set_bus_volume_db(0,linear_to_db(maxf(float(values.volume)/100.0,.001)))
	AudioServer.set_bus_mute(0,bool(values.mute) or float(values.volume)==0)
	Engine.max_fps=int(values.fps)
	if DisplayServer.get_name()!="headless":
		DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_ENABLED if values.vsync else DisplayServer.VSYNC_DISABLED)
		var was_fullscreen:=DisplayServer.window_get_mode() in [DisplayServer.WINDOW_MODE_FULLSCREEN,DisplayServer.WINDOW_MODE_EXCLUSIVE_FULLSCREEN]
		if not was_fullscreen and not windowed and values.fullscreen: previous_window_size=DisplayServer.window_get_size()
		DisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_WINDOWED if windowed or not values.fullscreen else DisplayServer.WINDOW_MODE_FULLSCREEN)
		if windowed and was_fullscreen: DisplayServer.window_set_size(previous_window_size)
		if not windowed and not values.fullscreen:
			var parts:String=str(values.resolution)
			var dimensions:=parts.split("x")
			DisplayServer.window_set_size(Vector2i(int(dimensions[0]),int(dimensions[1])))
	# Canvas-item stretching renders UI at native resolution, with one logical design space.
	# 3D keeps the output pixel count; text/layout scale consistently on HiDPI displays.
	var window:Window=app.get_tree().root
	var scaled_ui:bool=not app.automated or app.args.has("ui-test")
	window.content_scale_mode=Window.CONTENT_SCALE_MODE_CANVAS_ITEMS if scaled_ui else Window.CONTENT_SCALE_MODE_DISABLED
	window.content_scale_aspect=Window.CONTENT_SCALE_ASPECT_EXPAND
	window.content_scale_size=Vector2i(1280,720)
	window.content_scale_factor=float(values.ui_scale) if scaled_ui else 1.0
	var skin:=NativeUI.theme()
	app.hud.root.theme=skin; app.workspace.panel.theme=skin; app.command_panel.panel.theme=skin
	if app.command_dock: app.command_dock.panel.theme=skin
	if app.shell: app.shell.root.theme=skin
	_scale_labels(app,1.0)

func _scale_labels(node:Node,scale_:float) -> void:
	if node is Label and node.has_meta("ui_font_size"): node.add_theme_font_size_override("font_size",roundi(float(node.get_meta("ui_font_size"))*scale_))
	for child in node.get_children(): _scale_labels(child,scale_)

func canonical_key(code:int) -> int:
	for action in SHORTCUTS:
		if int(values.bindings.get(action,SHORTCUTS[action]))==code: return int(SHORTCUTS[action])
	return KEY_NONE if code in SHORTCUTS.values() else code
