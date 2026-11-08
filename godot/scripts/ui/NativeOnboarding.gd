class_name NativeOnboarding
extends PanelContainer
## A first-match checklist that teaches the core loop by doing it. Steps complete from real actions
## (camera use, selection, accepted server commands), never from reading. Compact, top-right,
## dismissable, and remembered once finished so it never nags an experienced player.
const STEPS := [
	["look", "Look around your settlement", "WASD or edge-drag to pan · wheel to zoom"],
	["growth", "Choose how your city grows", "Click your town hall → Guide growth → pick Housing, Industry or Farming → click where it should grow"],
	["scout", "Scout nearby ground", "Click a unit, then right-click unexplored ground to send it"],
	["opportunity", "Act on an opportunity", "Open a suggestion on the left (a deposit, a city ready to grow…) and use its action, or press B and place a building"],
	["research", "Choose a research goal", "Press T and start a technology: each era opens new strategies"],
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
	custom_minimum_size = Vector2(300, 0)
	var layout := VBoxContainer.new(); layout.add_theme_constant_override("separation", 6); add_child(layout)
	var header := HBoxContainer.new(); layout.add_child(header)
	var heading := NativeUI.label(header, "Tutorial" if bool(game.preferences.values.get("tutorial", false)) else "Your first decisions", 16, NativeUI.GOLD); heading.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	heading.add_theme_font_override("font", load("res://assets/fonts/BarlowSemiCondensed-SemiBold.ttf"))
	NativeUI.icon_button(header, "close", "Hide the checklist (it will not return)", _dismiss, 24)
	for step in STEPS:
		var row := HBoxContainer.new(); row.add_theme_constant_override("separation", 8); layout.add_child(row)
		var mark := NativeIcon.new(); mark.kind = "info"; mark.color = NativeUI.MUTED; mark.custom_minimum_size = Vector2(18, 18); mark.size_flags_vertical = Control.SIZE_SHRINK_BEGIN; row.add_child(mark)
		var text := VBoxContainer.new(); text.add_theme_constant_override("separation", -2); text.size_flags_horizontal = Control.SIZE_EXPAND_FILL; row.add_child(text)
		var title := NativeUI.label(text, step[1], 14, NativeUI.TEXT)
		var detail := NativeUI.label(text, step[2], 11, NativeUI.MUTED); detail.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		rows[step[0]] = [mark, title, detail]
	NativeUI.label(layout, "K lists every control · F10 hides the interface", 11, Color(NativeUI.MUTED, .8))
	app.net.command_result.connect(_on_command)
	app.world.welcomed.connect(func(): start_focus = Vector3.INF)
	_refresh_coach()


func _on_command(command: Dictionary, reply: Dictionary) -> void:
	if reply.has("error") and reply.error != null: return
	match str(command.get("c", "")):
		"cityGrowth": _complete("growth")
		"move", "army": _complete("scout")
		"oppQuiet", "build", "buildMany": _complete("opportunity")
		"research", "researchQueue": _complete("research")
	_refresh_coach()


func _complete(key: String) -> void:
	if done.has(key): return
	done[key] = true
	var row: Array = rows[key]
	(row[0] as NativeIcon).kind = "check"; (row[0] as NativeIcon).color = NativeUI.GOOD; (row[0] as NativeIcon).queue_redraw()
	(row[1] as Label).add_theme_color_override("font_color", NativeUI.MUTED)
	(row[2] as Label).hide()
	if done.size() == STEPS.size(): finished_at = Time.get_ticks_msec() / 1000.0


## In the tutorial, only the current step shows how to do it, highlighted; the rest stay short.
func _refresh_coach() -> void:
	var tutorial: bool = bool(app.preferences.values.get("tutorial", false))
	var current := ""
	for step in STEPS:
		if not done.has(step[0]): current = step[0]; break
	for key in rows:
		if done.has(key): continue
		var row: Array = rows[key]
		(row[2] as Label).visible = not tutorial or key == current
		(row[1] as Label).add_theme_color_override("font_color", NativeUI.GOLD if tutorial and key == current else NativeUI.TEXT)


func _dismiss() -> void:
	app.preferences.values.onboarding_done = true; app.preferences.values.tutorial = false; app.preferences.save()
	if bool(app.preferences.values.get("tutorial_finished_note", false)) == false and done.size() == STEPS.size():
		app.hud.show_toast("Tutorial complete · the world is yours to shape", true)
	hide()


func _process(_dt: float) -> void:
	var world: WorldState = app.world
	var wanted: bool = not app.automated and world.ready_ and not world.spectator and not app.shell.is_blocking() and not app.shell.world_hidden and not bool(app.preferences.values.get("onboarding_done", false))
	visible = wanted and not app.workspace.panel.visible
	if not visible: app.hud.notes.position.y = 120
	if not wanted: return
	if start_focus == Vector3.INF: start_focus = app.cam.focus; start_size = app.cam.size
	if not done.has("look") and (app.cam.focus.distance_to(start_focus) > 4.0 or absf(app.cam.size - start_size) > 6.0): _complete("look"); _refresh_coach()
	var bounds := get_viewport_rect().size
	position = Vector2(bounds.x - size.x - 12, 66)
	if visible: app.hud.notes.position.y = position.y + size.y + 10
	if finished_at > 0.0 and Time.get_ticks_msec() / 1000.0 - finished_at > 4.0: _dismiss()
