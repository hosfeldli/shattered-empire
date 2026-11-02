class_name GameHUD
extends CanvasLayer
## 2D interface over the 3D world: a start panel (server address, name, play / watch / rejoin), the
## top bar (empire, stockpiles and rates, time, connection), the selection panel, recent notes and
## order feedback. It only displays server state and forwards requests.

signal start_requested(opts: Dictionary)

const GOODS := ["food", "materials", "ore", "steel", "fuel", "electronics", "munitions", "credits"]

var world: WorldState
var net: NetworkClient
var military: MilitaryRenderer
var settlements: SettlementRenderer
var root: Control
var lobby: PanelContainer
var url_edit: LineEdit
var name_edit: LineEdit
var lobby_status: Label
var top: Label
var conn: Label
var sel: Label
var notes: Label
var toast: Label
var box: Panel
var bar: ColorRect
var help: Label
var note_lines: Array = []
var toast_until := 0.0
var input_ref: InputController


func setup(w: WorldState, n: NetworkClient, m: MilitaryRenderer, s: SettlementRenderer) -> void:
	world = w
	net = n
	military = m
	settlements = s
	layer = 10
	root = Control.new()
	root.set_anchors_preset(Control.PRESET_FULL_RECT)
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(root)
	bar = ColorRect.new()
	bar.color = Color(0.08, 0.09, 0.1, 0.78)
	bar.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(bar)
	top = _label(Vector2(12, 6), 14)
	conn = _label(Vector2(0, 6), 13)
	conn.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	conn.custom_minimum_size = Vector2(350, 0)
	sel = _label(Vector2(12, 0), 13)
	notes = _label(Vector2(0, 40), 12)
	notes.custom_minimum_size = Vector2(420, 0)
	notes.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	notes.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	toast = _label(Vector2(0, 0), 15)
	toast.custom_minimum_size = Vector2(600, 0)
	toast.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	help = _label(Vector2(0, 0), 12)
	help.custom_minimum_size = Vector2(460, 0)
	help.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	help.modulate = Color(1, 1, 1, 0.7)
	help.text = "WASD pan · wheel zoom · middle-drag pan · left select · right move · Ctrl+right attack-move · H hold · T stance · Esc cancel · F3 stats"
	box = Panel.new()
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.9, 0.85, 0.5, 0.12)
	sb.border_color = Color(0.95, 0.9, 0.55, 0.9)
	sb.set_border_width_all(1)
	box.add_theme_stylebox_override("panel", sb)
	box.mouse_filter = Control.MOUSE_FILTER_IGNORE
	box.visible = false
	root.add_child(box)
	_build_lobby()
	world.note.connect(_on_note)
	net.status_changed.connect(func(_s): _refresh_conn())


func _label(pos: Vector2, size: int) -> Label:
	var l := Label.new()
	l.position = pos
	l.add_theme_font_size_override("font_size", size)
	l.add_theme_color_override("font_color", Color(0.93, 0.92, 0.88))
	l.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.75))
	l.add_theme_constant_override("outline_size", 4)
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(l)
	return l


func _build_lobby() -> void:
	lobby = PanelContainer.new()
	lobby.custom_minimum_size = Vector2(440, 0)
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 8)
	lobby.add_child(v)
	var title := Label.new()
	title.text = "Shattered Empires — native client"
	title.add_theme_font_size_override("font_size", 20)
	v.add_child(title)
	var sub := Label.new()
	sub.text = "Connects to an authoritative server; the simulation runs there."
	sub.modulate = Color(1, 1, 1, 0.7)
	v.add_child(sub)
	url_edit = LineEdit.new()
	url_edit.placeholder_text = "ws://127.0.0.1:8137/ws"
	v.add_child(url_edit)
	name_edit = LineEdit.new()
	name_edit.placeholder_text = "Player name"
	v.add_child(name_edit)
	var h := HBoxContainer.new()
	v.add_child(h)
	for spec in [["Play against the AI", "ai"], ["Watch the AI", "observe"], ["Rejoin last", "rejoin"]]:
		var b := Button.new()
		b.text = spec[0]
		var mode: String = spec[1]
		b.pressed.connect(func(): start_requested.emit({"mode": mode, "url": url_edit.text if url_edit.text != "" else url_edit.placeholder_text, "name": name_edit.text if name_edit.text != "" else "Commander"}))
		h.add_child(b)
	lobby_status = Label.new()
	lobby_status.modulate = Color(1, 0.85, 0.7)
	v.add_child(lobby_status)
	root.add_child(lobby)


func show_lobby(on: bool, status := "") -> void:
	lobby.visible = on
	lobby_status.text = status
	_layout()


## positions from the viewport size (labels under a CanvasLayer, laid out by hand)
func _layout() -> void:
	var vp := root.get_viewport_rect().size
	bar.position = Vector2.ZERO
	bar.size = Vector2(vp.x, 30)
	conn.position = Vector2(vp.x - 362, 6)
	notes.position = Vector2(vp.x - 432, 40)
	sel.position = Vector2(12, vp.y - 150)
	toast.position = Vector2(vp.x * 0.5 - 300, vp.y - 64)
	help.position = Vector2(vp.x - 472, vp.y - 24)
	lobby.position = (vp - lobby.size) * 0.5


func show_toast(text: String, ok := true) -> void:
	toast.text = text
	toast.modulate = Color(0.85, 1, 0.85) if ok else Color(1, 0.75, 0.7)
	toast_until = Time.get_ticks_msec() / 1000.0 + 3.0


func _on_note(m: Dictionary) -> void:
	if m.get("quiet", false):
		return
	note_lines.push_front("[%s] %s" % [_clock(float(m.get("time", 0))), str(m.get("text", ""))])
	while note_lines.size() > 6:
		note_lines.pop_back()
	notes.text = "\n".join(note_lines)


func _clock(t: float) -> String:
	return "%d:%02d" % [int(t) / 60, int(t) % 60]


func _refresh_conn() -> void:
	conn.text = "%s · proto %d %s · %d ms" % [net.state, net.proto, ("+" + ",".join(net.caps)) if not net.caps.is_empty() else "", int(net.rtt_ms)]


func update(_dt: float) -> void:
	if Engine.get_process_frames() % 6 == 0:
		_layout()
		_refresh_conn()
		_refresh_top()
		_refresh_sel()
	if toast_until > 0.0 and Time.get_ticks_msec() / 1000.0 > toast_until:
		toast.text = ""
		toast_until = 0.0
	if input_ref and input_ref.box_active:
		var r := input_ref.box_rect.abs()
		box.visible = true
		box.position = r.position
		box.size = r.size
	else:
		box.visible = false


func _refresh_top() -> void:
	if not world.ready_:
		top.text = ""
		return
	var civ: Dictionary = world.civ_by_id.get(world.civ_id, {})
	var parts := PackedStringArray()
	parts.append("%s%s" % [str(civ.get("name", "?")), " (spectating)" if world.spectator else ""])
	var res: Dictionary = world.econ.get("res", {})
	var rates: Dictionary = world.econ.get("rates", {})
	for g in GOODS:
		if res.has(g):
			var r := float(rates.get(g, 0.0))
			parts.append("%s %d%s" % [g.substr(0, 4), int(res[g]), (" %+.1f" % r) if absf(r) >= 0.05 else ""])
	parts.append(_clock(world.server_time) + (" ‖" if world.paused else ""))
	top.text = "   ".join(parts)


func _refresh_sel() -> void:
	var lines := PackedStringArray()
	var units_def: Dictionary = world.defs.get("UNITS", {})
	if not military.selected.is_empty():
		var by_type := {}
		var hp := 0
		var n := 0
		var forms := {}
		var stance := ""
		for id in military.selected.keys():
			var u: Dictionary = world.units.get(id, {})
			if u.is_empty():
				continue
			var nm := str(units_def.get(u.type, {}).get("name", u.type))
			by_type[nm] = int(by_type.get(nm, 0)) + 1
			hp += int(u.hp)
			n += 1
			if int(u.get("formation", 0)) > 0:
				forms[int(u.formation)] = true
			stance = str(u.get("stance", ""))
		if n > 0:
			lines.append("%d selected · health %d%% · stance %s%s" % [n, hp / n, stance, (" · formation " + ",".join(forms.keys().map(func(x): return str(x)))) if not forms.is_empty() else ""])
			for k in by_type.keys():
				lines.append("  %d × %s" % [by_type[k], k])
	elif settlements.selected_building >= 0:
		var b: Dictionary = world.buildings.get(settlements.selected_building, {})
		if not b.is_empty():
			var bdefs: Dictionary = world.defs.get("BUILDINGS", {})
			var nm := str(bdefs.get(b.ty, {}).get("name", b.ty))
			lines.append("%s%s · %s" % [nm, (" (level %d)" % int(b.lv)) if b.has("lv") and b.lv != null else "", "under construction %d%%" % int(b.get("p", 0)) if int(b.get("d", 0)) == 0 else str(b.get("st", "operational"))])
			lines.append("health %d%% · %s%s" % [int(b.get("hp", 100)), "working" if int(b.get("a", 0)) == 1 else "idle", " · ON FIRE" if int(b.get("f", 0)) == 1 else ""])
			var pr = b.get("pr")
			if pr is Array and not (pr as Array).is_empty():
				lines.append("output " + ", ".join((pr as Array).map(func(x): return "%s %.2f/s" % [x[0], float(x[1])])))
			var key: String = settlements.district_of.get(int(b.id), "")
			var count := key.count(",") + 1 if key != "" else 1
			if count > 1:
				lines.append("part of a district of %d buildings" % count)
	sel.text = "\n".join(lines)
