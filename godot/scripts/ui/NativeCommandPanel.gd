class_name NativeCommandPanel
extends CanvasLayer
## Native construction, training and research controls, populated from server definitions.

var world: WorldState
var tools: NativeCommandTools
var input: InputController
var settlements: SettlementRenderer
var panel: PanelContainer
var build_list: OptionButton
var road_list: OptionButton
var bridge_list: OptionButton
var train_list: OptionButton
var research_list: OptionButton
var status: Label
var train_button: Button
var research_status: Label
var _selection := -2


func setup(w: WorldState, t: NativeCommandTools, i: InputController, s: SettlementRenderer) -> void:
	world = w; tools = t; input = i; settlements = s
	layer = 12
	panel = PanelContainer.new()
	panel.position = Vector2(12,40)
	panel.custom_minimum_size = Vector2(290,0)
	add_child(panel)
	var col := VBoxContainer.new()
	col.add_theme_constant_override("separation", 5)
	panel.add_child(col)
	var heading := Label.new(); heading.text = "Construction & orders · B to hide"; col.add_child(heading)
	build_list = OptionButton.new(); col.add_child(build_list)
	_button(col, "Place building", func(): tools.activate("build", build_list.get_item_metadata(build_list.selected)))
	road_list = _options(col, [["Dirt road",1],["Paved road",2],["Highway",3],["Railway",4]])
	_button(col, "Draw road / railway", func(): tools.activate("road", road_list.get_item_metadata(road_list.selected)))
	bridge_list = OptionButton.new(); col.add_child(bridge_list)
	_button(col, "Draw bridge between banks", func(): tools.activate("bridge", bridge_list.get_item_metadata(bridge_list.selected)))
	var trenches := _options(col, [["Earthworks","basic"],["Reinforced trench","reinforced"]])
	_button(col, "Draw trench line", func(): tools.activate("trench", trenches.get_item_metadata(trenches.selected)))
	var form := _options(col, [["Line","line"],["Compact line","compact"],["Defense in depth","depth"],["Preserve shape","preserve"]])
	form.item_selected.connect(func(index): tools.formation = str(form.get_item_metadata(index)))
	_button(col, "Deploy selected units", func(): tools.activate("deploy"))
	_button(col,"Found settlement with selected convoy",func():
		for id in tools.military.selected:
			if str(world.units.get(id,{}).get("type",""))=="colonist":
				tools.net.cmd({"c":"found","unit":id},func(reply):tools.feedback.emit("Settlement founded" if reply.get("error")==null else str(reply.error),reply.get("error")==null))
				return
		tools.feedback.emit("Select a colonist convoy",false))
	var movement := _options(col, [["Move: line","line"],["Move: column","column"],["Move: wedge","wedge"],["Move: box","box"]])
	movement.item_selected.connect(func(index): input.move_formation = str(movement.get_item_metadata(index)))
	train_list = OptionButton.new(); col.add_child(train_list)
	train_button = _button(col, "Train at selected building", func():
		if train_list.selected >= 0: tools.train(settlements.selected_building, str(train_list.get_item_metadata(train_list.selected))))
	_button(col,"Cancel last training order",func(): tools.net.cmd({"c":"cancelTrain","building":settlements.selected_building},func(reply): tools.feedback.emit("Training cancelled" if reply.get("error")==null else str(reply.error),reply.get("error")==null)))
	research_list = OptionButton.new(); col.add_child(research_list)
	_button(col, "Queue research", func():
		if research_list.selected >= 0:
			tools.net.cmd({"c":"research", "tech":research_list.get_item_metadata(research_list.selected), "queue":true}, func(reply):
				tools.feedback.emit("Research queued" if reply.get("error") == null else str(reply.error), reply.get("error") == null)))
	research_status = Label.new(); research_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART; col.add_child(research_status)
	status = Label.new(); status.custom_minimum_size = Vector2(280,0); status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART; col.add_child(status)
	_button(col, "Confirm preview · Enter", tools.commit)
	_button(col, "Cancel · Esc", tools.cancel)
	tools.changed.connect(_status)
	world.welcomed.connect(_populate)
	panel.visible = false
	_status()


func _button(parent: Node, text: String, action: Callable) -> Button:
	var b := Button.new(); b.text = text; b.pressed.connect(action); parent.add_child(b); return b


func _options(parent: Node, choices: Array) -> OptionButton:
	var result := OptionButton.new()
	for choice in choices:
		result.add_item(str(choice[0])); result.set_item_metadata(result.item_count-1, choice[1])
	parent.add_child(result)
	return result


func _populate() -> void:
	for pair in [[build_list,"BUILDINGS"],[bridge_list,"BRIDGE_CLASSES"],[research_list,"TECHS"]]:
		var list: OptionButton = pair[0]; list.clear()
		var defs: Dictionary = world.defs.get(pair[1], {})
		for key in defs:
			if defs[key].get("obsolete", false): continue
			list.add_item(str(defs[key].get("name", key))); list.set_item_metadata(list.item_count-1, key)
	_selection = -2
	panel.visible = not world.spectator


func _status() -> void:
	if status:
		# Summarize the real cost/result instead of displaying protocol internals in the game UI.
		var reply := tools.preview
		var plan: Dictionary = reply.get("plan", reply.get("trench", {}))
		if not plan.is_empty():
			var costs := []
			for good in plan.get("cost", {}): costs.append("%s %s" % [plan.cost[good], good])
			status.text = "%s\n%s\nEnter to commission" % ["Ready" if plan.get("buildable", true) else "Cannot build this route", ", ".join(costs)]
		else: status.text = tools.status


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_B and world.ready_:
		panel.visible = not panel.visible
		get_viewport().set_input_as_handled()


func _process(_dt: float) -> void:
	if not world.ready_ or not panel.visible: return
	if _selection != settlements.selected_building:
		_selection = settlements.selected_building
		train_list.clear()
		var building: Dictionary = world.buildings.get(_selection, {})
		var definitions: Dictionary = world.defs.get("BUILDINGS", {})
		var definition: Dictionary = definitions.get(building.get("ty", ""), {})
		if int(building.get("o", -1)) == world.civ_id:
			for unit in definition.get("trains", []):
				train_list.add_item(str(world.defs.get("UNITS", {}).get(unit, {}).get("name", unit)))
				train_list.set_item_metadata(train_list.item_count-1, unit)
		train_button.disabled = train_list.item_count == 0
	if Engine.get_process_frames() % 15 == 0:
		var key := str(world.econ.get("research", ""))
		research_status.text = "Research: %s · %d points\nQueued: %d" % [str(world.defs.get("TECHS", {}).get(key, {}).get("name", "automatic")), int(world.econ.get("progress", 0)), world.econ.get("queue", []).size()]
