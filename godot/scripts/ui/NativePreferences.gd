class_name NativePreferences
extends RefCounted
## Local presentation preferences only. Gameplay state remains on the server.
const DEFAULTS:={"fullscreen":true,"resolution":"1600x900","quality":"medium","vsync":true,"fps":60,
	"volume":70.0,"mute":false,"ui_scale":1.0,"pan_speed":1.0,"zoom_speed":1.0,"invert_zoom":false,"edge_pan":false,
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
	if not str(values.quality) in LODManager.PRESETS: values.quality="medium"
	if not str(values.resolution) in ["1280x720","1600x900","1920x1080","2560x1440"]: values.resolution="1600x900"
	if not int(values.fps) in [0,30,60,120,144]: values.fps=60

func save() -> Error:
	var config:=ConfigFile.new()
	for key in values: config.set_value("preferences",key,values[key])
	return config.save(path)

func apply(app:Node,windowed:=false) -> void:
	app._apply_quality(str(values.quality))
	app.cam.pan_multiplier=float(values.pan_speed); app.cam.zoom_multiplier=float(values.zoom_speed)
	app.cam.invert_zoom=bool(values.invert_zoom); app.cam.edge_pan=bool(values.edge_pan)
	app.audio.enabled=not bool(values.mute)
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
	window.content_scale_size=Vector2i(1600,900)
	window.content_scale_factor=float(values.ui_scale) if scaled_ui else 1.0
	var skin:=NativeUI.theme()
	app.hud.root.theme=skin; app.workspace.panel.theme=skin; app.command_panel.panel.theme=skin
	if app.command_dock: app.command_dock.panel.theme=skin
	if app.shell: app.shell.root.theme=skin
	_scale_labels(app,1.0)

func _scale_labels(node:Node,scale_:float) -> void:
	if node is Label and node.has_meta("ui_font_size"): node.add_theme_font_size_override("font_size",roundi(float(node.get_meta("ui_font_size"))*scale_))
	for child in node.get_children(): _scale_labels(child,scale_)
