class_name NativeOnboarding
extends PanelContainer
## A first-match checklist that teaches the core loop by doing it. Steps complete from real actions
## (camera use, selection, accepted server commands), never from reading. Compact, top-right,
## dismissable, and remembered once finished so it never nags an experienced player.
const STEPS := [
	["look", "Look around", "WASD or edge-drag to pan · wheel to zoom"],
	["city", "Open your city", "Click your town hall to see its people and work"],
	["build", "Place a building", "Press B, choose a Farm or Housing Block, click a highlighted site"],
	["move", "Move a unit", "Click a unit, then right-click where it should go"],
	["research", "Choose research", "Press T and start a technology"],
]
var app: Node
var done := {}
var rows := {}
var start_focus := Vector3.INF
var start_size := 0.0
var finished_at := -1.0


func setup(game: Node) -> void:
	app = game
	theme = NativeUI.theme()
	add_theme_stylebox_override("panel", NativeUI.style(NativeUI.PANEL, Color(NativeUI.GOLD, .3), 12, 9, true))
	custom_minimum_size = Vector2(268, 0)
	var layout := VBoxContainer.new(); layout.add_theme_constant_override("separation", 6); add_child(layout)
	var header := HBoxContainer.new(); layout.add_child(header)
	var heading := NativeUI.label(header, "Getting started", 16, NativeUI.GOLD); heading.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	heading.add_theme_font_override("font", load("res://assets/fonts/BarlowSemiCondensed-SemiBold.ttf"))
	NativeUI.icon_button(header, "close", "Hide the checklist (it will not return)", _dismiss, 24)
	for step in STEPS:
		var row := HBoxContainer.new(); row.add_theme_constant_override("separation", 8); layout.add_child(row)
		var mark := NativeIcon.new(); mark.kind = "info"; mark.color = NativeUI.MUTED; mark.custom_minimum_size = Vector2(18, 18); mark.size_flags_vertical = Control.SIZE_SHRINK_BEGIN; row.add_child(mark)
		var text := VBoxContainer.new(); text.add_theme_constant_override("separation", -2); text.size_flags_horizontal = Control.SIZE_EXPAND_FILL; row.add_child(text)
		var title := NativeUI.label(text, step[1], 14, NativeUI.TEXT)
		var detail := NativeUI.label(text, step[2], 11, NativeUI.MUTED)
		rows[step[0]] = [mark, title, detail]
	NativeUI.label(layout, "K lists every control · F10 hides the interface", 11, Color(NativeUI.MUTED, .8))
	app.net.command_result.connect(_on_command)
	app.world.welcomed.connect(func(): start_focus = Vector3.INF)


func _on_command(command: Dictionary, reply: Dictionary) -> void:
	if reply.has("error") and reply.error != null: return
	match str(command.get("c", "")):
		"build": _complete("build")
		"move": _complete("move")
		"research", "researchQueue": _complete("research")


func _complete(key: String) -> void:
	if done.has(key): return
	done[key] = true
	var row: Array = rows[key]
	(row[0] as NativeIcon).kind = "check"; (row[0] as NativeIcon).color = NativeUI.GOOD; (row[0] as NativeIcon).queue_redraw()
	(row[1] as Label).add_theme_color_override("font_color", NativeUI.MUTED)
	(row[2] as Label).hide()
	if done.size() == STEPS.size(): finished_at = Time.get_ticks_msec() / 1000.0


func _dismiss() -> void:
	app.preferences.values.onboarding_done = true; app.preferences.save()
	hide()


func _process(_dt: float) -> void:
	var world: WorldState = app.world
	var wanted: bool = not app.automated and world.ready_ and not world.spectator and not app.shell.is_blocking() and not app.shell.world_hidden and not bool(app.preferences.values.get("onboarding_done", false))
	visible = wanted and not app.workspace.panel.visible
	if not visible: app.hud.notes.position.y = 120
	if not wanted: return
	if start_focus == Vector3.INF: start_focus = app.cam.focus; start_size = app.cam.size
	if not done.has("look") and (app.cam.focus.distance_to(start_focus) > 4.0 or absf(app.cam.size - start_size) > 6.0): _complete("look")
	if not done.has("city") and str(world.buildings.get(app.settlements.selected_building, {}).get("ty", "")) == "town": _complete("city")
	var bounds := get_viewport_rect().size
	position = Vector2(bounds.x - size.x - 12, 66)
	if visible: app.hud.notes.position.y = position.y + size.y + 10
	if finished_at > 0.0 and Time.get_ticks_msec() / 1000.0 - finished_at > 4.0: _dismiss()
