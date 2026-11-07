class_name NativeAlertFeed
extends VBoxContainer
## Alert levels for play: only urgent events interrupt. Critical (attacks on cities, disasters,
## strategic weapons) shows a prominent banner for ten seconds; major and warning events show a
## compact pill for six; minor and informational events go quietly to the chronicle. Every alert
## with a location has a button that takes the camera there. Quiet notices never appear here.
const LIFETIME := {"critical": 10.0, "major": 6.0, "warning": 6.0}
const MAX_PILLS := 3
var app: Node
var items: Array = []        # [{node, until}]


func setup(game: Node) -> void:
	app = game
	theme = NativeUI.theme()
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_theme_constant_override("separation", 6)
	app.world.note.connect(_on_note)
	app.world.welcomed.connect(_clear)


func _clear() -> void:
	for item in items: (item.node as Node).queue_free()
	items.clear()


static func level_of(note: Dictionary) -> String:
	var level := str(note.get("level", ""))
	if level == "" and str(note.get("kind", "")) in ["war", "missile", "disaster", "siege"]: level = "major"
	return level


func _on_note(note: Dictionary) -> void:
	if note.get("quiet", false) or app.world.spectator: return
	var level := level_of(note)
	if not LIFETIME.has(level): return
	var critical := level == "critical"
	var pill := PanelContainer.new()
	var accent: Color = NativeUI.BAD if critical else NativeUI.GOLD
	var style := NativeUI.style(Color(NativeUI.PANEL, .95), Color(accent, .75 if critical else .45), 8 if not critical else 12, 12, true)
	style.border_width_left = 5 if critical else 3
	pill.add_theme_stylebox_override("panel", style)
	var row := HBoxContainer.new(); row.add_theme_constant_override("separation", 10); pill.add_child(row)
	var icon := NativeIcon.new(); icon.kind = "alerts"; icon.color = accent; icon.custom_minimum_size = Vector2(22, 22) if critical else Vector2(18, 18); row.add_child(icon)
	var text := NativeUI.label(row, str(note.get("text", "")), 16 if critical else 13, NativeUI.TEXT)
	text.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART; text.custom_minimum_size.x = 320 if critical else 260
	var tile := int(note.get("tile", -1))
	if tile >= 0:
		var go := NativeUI.compact_button(row, "Go", func(): app.cam.focus_tile(tile, 18.0))
		go.tooltip_text = "Move the camera to this event"
	NativeUI.icon_button(row, "close", "Dismiss", func(): _dismiss(pill), 20)
	add_child(pill)
	if critical: move_child(pill, 0)
	items.append({"node": pill, "until": Time.get_ticks_msec() / 1000.0 + float(LIFETIME[level]), "critical": critical})
	# keep the stack short: the oldest non-critical pills give way first
	var pills := items.filter(func(item): return not item.critical)
	while pills.size() > MAX_PILLS:
		_dismiss(pills.pop_front().node)


func _dismiss(node: Node) -> void:
	for item in items.duplicate():
		if item.node == node: items.erase(item)
	if is_instance_valid(node): node.queue_free()


func _process(_dt: float) -> void:
	var now := Time.get_ticks_msec() / 1000.0
	for item in items.duplicate():
		if now > float(item.until): _dismiss(item.node)
	visible = app.world.ready_ and not app.shell.world_hidden and not items.is_empty()
	if visible:
		reset_size()
		position = Vector2((get_viewport_rect().size.x - size.x) * 0.5, 100)
