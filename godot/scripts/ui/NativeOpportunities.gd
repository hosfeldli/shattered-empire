class_name NativeOpportunities
extends VBoxContainer
## Up to two quiet opportunity indicators from the server's Opportunity Director (state the
## player can actually see: a deposit worth working, a city ready to grow, rival troops near the
## border, damage, idle research). A click opens a small card with one or two direct actions;
## acting on it or dismissing it keeps that suggestion quiet for a while. Never a task list, never
## required, hidden while a tool is in use or a panel is open.
var app: Node
var signature := ""
var open_key := ""


func setup(game: Node) -> void:
	app = game
	theme = NativeUI.theme()
	add_theme_constant_override("separation", 6)
	custom_minimum_size.x = 250


func _process(_dt: float) -> void:
	var world: WorldState = app.world
	var opps: Array = world.econ.get("opp", []) if world.econ.get("opp") is Array else []
	visible = world.ready_ and not world.spectator and not app.shell.is_blocking() and not app.shell.world_hidden \
		and app.command_tools.mode == "select" and not app.workspace.panel.visible and not opps.is_empty()
	position = Vector2(10, 276)
	if not visible: return
	var next := str([opps.map(func(o): return o.get("key", "")), open_key])
	if next == signature: return
	signature = next
	NativeUI.clear(self)
	for o: Dictionary in opps: _row(o)


func _row(o: Dictionary) -> void:
	var key := str(o.get("key", ""))
	var panel := PanelContainer.new()
	var accent: Color = NativeUI.BAD if str(o.get("k", "")) == "threat" else NativeUI.GOLD
	var style := NativeUI.style(Color(NativeUI.PANEL, .94), Color(accent, .45), 8, 9, true); style.border_width_left = 3
	panel.add_theme_stylebox_override("panel", style)
	add_child(panel)
	var body := VBoxContainer.new(); body.add_theme_constant_override("separation", 4); panel.add_child(body)
	var head := HBoxContainer.new(); head.add_theme_constant_override("separation", 6); body.add_child(head)
	var icon := NativeIcon.new(); icon.kind = {"threat": "alerts", "deposit": "industry", "grow": "build", "damage": "build", "research": "research"}.get(str(o.get("k", "")), "info"); icon.color = accent
	icon.custom_minimum_size = Vector2(16, 16); head.add_child(icon)
	var title := Button.new(); title.flat = true; title.text = str(o.get("title", "")); title.alignment = HORIZONTAL_ALIGNMENT_LEFT
	title.focus_mode = Control.FOCUS_NONE; title.size_flags_horizontal = Control.SIZE_EXPAND_FILL; title.add_theme_font_size_override("font_size", 13)
	title.pressed.connect(func(): open_key = "" if open_key == key else key; signature = "")
	head.add_child(title)
	NativeUI.icon_button(head, "close", "Not now (this suggestion stays quiet for a while)", func(): _quiet(key), 18)
	if open_key != key: return
	NativeUI.label(body, str(o.get("text", "")), 12, NativeUI.MUTED).autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	var actions := HFlowContainer.new(); body.add_child(actions)
	for action in o.get("actions", []):
		var label := str(action[0]); var what := str(action[1])
		NativeUI.compact_button(actions, label, func(): _act(o, what))


func _act(o: Dictionary, what: String) -> void:
	var tile := int(o.get("tile", -1))
	var key := str(o.get("key", ""))
	match what:
		"goto":
			if tile >= 0: app.cam.focus_tile(tile, 16.0)
			return
		"select":
			app.military.selected.clear()
			for id in o.get("units", []):
				if app.world.units.has(int(id)): app.military.selected[int(id)] = true
			app.input.selection_changed.emit()
			if tile >= 0: app.cam.focus_tile(tile, 20.0)
		"repair":
			app.commands.issue("repair", {"building": int(o.get("building", -1))})
		"guide":
			# open the city card on Guide Growth: the player picks the kind and the place
			var city: Dictionary = app.world.cities.get(int(o.get("city", -1)), {})
			for b in app.world.buildings.values():
				if str(b.ty) == "town" and int(b.get("c", -2)) == int(o.get("city", -1)):
					app.settlements.selected_building = int(b.id); app.input.selection_changed.emit(); break
			app.command_dock.guide_open = true; app.command_dock.signature = ""
			if not city.is_empty(): app.cam.focus_tile(int(city.t), 16.0)
		"build":
			app.command_tools.activate("build", str(o.get("build", "")))
			if tile >= 0: app.cam.focus_tile(tile, 14.0)
		"research":
			app.workspace.open_page("Research")
	_quiet(key)


func _quiet(key: String) -> void:
	app.commands.submit({"c": "oppQuiet", "key": key}, func(_r): pass)
	var opps: Array = app.world.econ.get("opp", [])
	app.world.econ["opp"] = opps.filter(func(o): return str(o.get("key", "")) != key)
	open_key = ""; signature = ""
