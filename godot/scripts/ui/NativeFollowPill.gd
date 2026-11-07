class_name NativeFollowPill
extends PanelContainer
## A small, unobtrusive pill while the camera follows a unit: who is followed, and a one-click
## stop. Panning, dragging, centring elsewhere or the unit leaving sight ends following; when the
## followed unit is lost a short note says why instead of the camera silently stopping.
var app: Node
var label: Label
var last_id := -1
var last_name := ""


func setup(game: Node) -> void:
	app = game
	theme = NativeUI.theme()
	mouse_filter = Control.MOUSE_FILTER_STOP
	add_theme_stylebox_override("panel", NativeUI.style(Color(NativeUI.PANEL, .9), Color(NativeUI.TEAL, .35), 8, 14, true))
	var row := HBoxContainer.new(); row.add_theme_constant_override("separation", 8); add_child(row)
	var eye := NativeIcon.new(); eye.kind = "follow"; eye.color = NativeUI.TEAL; eye.custom_minimum_size = Vector2(18, 18); row.add_child(eye)
	label = NativeUI.label(row, "", 13, NativeUI.TEXT)
	NativeUI.icon_button(row, "close", "Stop following (V)", func(): app.cam.follow_id = -1, 22)
	hide()


func _process(_dt: float) -> void:
	var id: int = app.cam.follow_id
	if id != last_id:
		if last_id >= 0 and id < 0 and not app.world.units.has(last_id) and last_name != "":
			app.hud.show_toast("%s is no longer in sight · camera released" % last_name, false)
		last_id = id
	if id < 0 or not app.world.ready_ or app.shell.world_hidden:
		hide(); return
	var unit: Dictionary = app.world.units.get(id, {})
	var kind := str(app.world.defs.get("UNITS", {}).get(str(unit.get("type", "")), {}).get("name", "unit"))
	last_name = "%s %s" % [kind, NativeCommandDock.callsign(id)]
	label.text = "Following %s" % last_name
	show(); reset_size()
	var bounds := get_viewport_rect().size
	position = Vector2((bounds.x - size.x) * 0.5, 64)
