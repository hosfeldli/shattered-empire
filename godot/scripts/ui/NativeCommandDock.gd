class_name NativeCommandDock
extends CanvasLayer
## Tactical orders stay one click away; detailed national/city management lives in workspaces.
var app:Node
var panel:PanelContainer
var title:Label
var state:Label
var cards:HFlowContainer
var orders:HFlowContainer
var hint:Label
var signature:=""
var timer:=0.0

func setup(game:Node) -> void:
	app=game; layer=18
	panel=PanelContainer.new(); panel.theme=NativeUI.theme(); add_child(panel)
	var layout:=VBoxContainer.new(); panel.add_child(layout)
	var header:=HBoxContainer.new(); layout.add_child(header)
	title=NativeUI.label(header,"Field command",19,NativeUI.GOLD); title.size_flags_horizontal=Control.SIZE_EXPAND_FILL
	NativeUI.button(header,"Center · Space",func():app.input.center_selection())
	state=NativeUI.label(layout,"",13,NativeUI.MUTED)
	cards=HFlowContainer.new(); layout.add_child(cards)
	orders=HFlowContainer.new(); layout.add_child(orders)
	hint=Label.new(); hint.add_theme_font_size_override("font_size",14); hint.add_theme_color_override("font_color",NativeUI.GOLD)
	hint.autowrap_mode=TextServer.AUTOWRAP_WORD_SMART; layout.add_child(hint)

func _button(message:String,action:Callable) -> Button:
	var button:=NativeUI.button(orders,message,action); button.custom_minimum_size.y=32; return button

func _workspace(page:String,action_id:="") -> void:
	app.workspace.open_page(page)
	if not action_id.is_empty():
		app.workspace.show_all_orders(true)
		var actions:Array=app.workspace.actions.filter(func(action):return action.id==action_id)
		if not actions.is_empty():
			var index:int=app.workspace.page_actions.find(actions[0]); app.workspace.action_list.select(index); app.workspace._set_action(actions[0])

func _rebuild() -> void:
	NativeUI.clear(cards); NativeUI.clear(orders)
	var world:WorldState=app.world; var selected:Dictionary=app.military.selected
	var units:Array=app.input._owned_units()
	if not selected.is_empty():
		var types:={}
		for id in selected:
			var type:=str(world.units.get(id,{}).get("type",""))
			types[type]=int(types.get(type,0))+1
		for type in types:
			var key:String=type
			var label:String=str(world.defs.get("UNITS",{}).get(key,{}).get("name",key))
			NativeUI.button(cards,"%d × %s"%[types[key],label],func():
				for id in app.military.selected.keys():
					if world.units.get(id,{}).get("type")!=key: app.military.selected.erase(id)
				app.input.selection_changed.emit())
		_button("Hold · H",func():app.input._simple("hold",{}))
		_button("Advance · E",func():app.command_tools.target_command({"c":"move","units":app.input._owned_units(),"attackMove":true,"tile":"@map","formation":app.input.move_formation},"Advance and engage"))
		_button("Withdraw · X",func():app.input._simple("withdraw",{}))
		_button("Deploy frontage",func():app.command_tools.activate("deploy"))
		_button("Dig in",func():_workspace("Military","fortify"))
		_button("Form army · G",func():app.input._simple("army",{"op":"create"}))
		_button("Stance / targeting",func():_workspace("Military","stance"))
		_button("More orders",func():_workspace("Military"))
		for button in orders.get_children(): button.disabled=units.is_empty() or world.spectator
	elif app.settlements.selected_building>=0 and world.buildings.has(app.settlements.selected_building):
		var building:Dictionary=world.buildings[app.settlements.selected_building]
		var own:=int(building.o)==world.civ_id and not world.spectator
		_button("Upgrade",func():_workspace("Buildings","upgrade"))
		_button("Repair",func():_workspace("Buildings","repair"))
		_button("Build next",func():_workspace("Buildings","fund_next"))
		if world.defs.get("BUILDINGS",{}).get(building.ty,{}).has("trains"):
			_button("Train units",func():_workspace("Production","train"))
			_button("Batch recruitment",func():_workspace("Production","batch_train"))
			_button("Rally point",func():app.command_tools.target_command({"c":"rally","building":app.settlements.selected_building,"tile":"@map"},"Facility rally point"))
		if int(building.get("c",-1))>=0:
			_button("Manage city",func():_workspace("Cities"))
		for button in orders.get_children(): button.disabled=not own
	else:
		_button("Select combat forces · Q",func():app.input.select_combat(true))
		_button("Construction · B",func():_workspace("Construction"))
		_button("Research · T",func():_workspace("Research"))
		_button("Economic ledger",func():_workspace("Economy"))
		_button("Field guide · K",func():app.shell.previous="pause"; app.shell.show_view("help"))

func _refresh() -> void:
	var world:WorldState=app.world
	var ids:Array=app.military.selected.keys(); var building:Dictionary=world.buildings.get(app.settlements.selected_building,{})
	var next:=str([ids,app.input.selected_buildings.keys(),app.settlements.selected_building,building.get("ty",""),world.spectator])
	if next!=signature: signature=next; _rebuild()
	if not ids.is_empty():
		var health:=0.0; var supply:=0.0; var morale:=0.0; var valid:=0
		for id in ids:
			var unit:Dictionary=world.units.get(id,{})
			if unit.is_empty(): continue
			health+=float(unit.hp); supply+=float(unit.get("supply",0)); morale+=float(unit.get("morale",100)); valid+=1
		title.text="%d units selected"%valid
		state.text="Health %d%%   ·   Supply %d%%   ·   Morale %d%%   ·   Movement: %s"%[int(health/maxi(valid,1)),int(supply/maxi(valid,1)),int(morale/maxi(valid,1)),app.input.move_formation.capitalize()]
	elif not building.is_empty():
		var info:Dictionary=world.defs.get("BUILDINGS",{}).get(building.ty,{})
		title.text=str(info.get("name",building.ty))+" · #%d"%int(building.id)
		state.text="Health %d%%   ·   %s   ·   Workers %s   ·   %d queued"%[int(building.hp),str(building.st).capitalize(),str(building.get("s","—")),building.get("q",[]).size()]
	else: title.text="Field command"; state.text="Select units, a building or a city. Shift adds to selection; Ctrl-drag selects facilities."
	hint.text=app.command_tools.status if app.command_tools.mode!="select" else ""

func _process(dt:float) -> void:
	panel.visible=app.world.ready_ and not app.shell.is_blocking() and not app.workspace.panel.visible and not app.shell.world_hidden and (not app.military.selected.is_empty() or app.settlements.selected_building>=0 or app.command_tools.mode!="select")
	if not panel.visible: return
	var bounds:=get_viewport().get_visible_rect().size
	panel.size=Vector2(maxf(560,bounds.x-260),panel.get_combined_minimum_size().y)
	panel.position=Vector2(12,bounds.y-panel.size.y-32)
	timer+=dt
	if timer>=.15: timer=0; _refresh()
