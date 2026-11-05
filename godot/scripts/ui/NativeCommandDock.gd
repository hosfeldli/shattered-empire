class_name NativeCommandDock
extends CanvasLayer
## Small contextual selection card; uncommon orders remain available in named menus.
var app:Node
var panel:PanelContainer
var title:Label
var state:Label
var cards:HFlowContainer
var orders:HFlowContainer
var hint:Label
var signature:=""
var timer:=0.0
var confirm_button:Button
var details:VBoxContainer
var recruit_open:=false
var queue_label:Label
var selection_key:=""
var deselect:Button

func setup(game:Node) -> void:
	app=game; layer=18
	panel=PanelContainer.new(); panel.theme=NativeUI.theme(); add_child(panel)
	panel.mouse_force_pass_scroll_events=false
	var layout:=VBoxContainer.new(); layout.add_theme_constant_override("separation",6); panel.add_child(layout)
	var header:=HBoxContainer.new(); layout.add_child(header)
	title=NativeUI.label(header,"Selection",19,NativeUI.GOLD); title.size_flags_horizontal=Control.SIZE_EXPAND_FILL
	deselect=NativeUI.compact_button(header,"Deselect",func():app.input.cancel(),"Clear selection · Escape. Space centers the selection.")
	state=NativeUI.label(layout,"",14,NativeUI.MUTED)
	cards=HFlowContainer.new(); layout.add_child(cards); cards.hide()
	orders=HFlowContainer.new(); orders.add_theme_constant_override("h_separation",5); orders.add_theme_constant_override("v_separation",5); layout.add_child(orders)
	details=VBoxContainer.new(); layout.add_child(details)
	hint=NativeUI.label(layout,"",14,NativeUI.GOLD)

func _button(message:String,action:Callable,explanation:="") -> Button:
	return NativeUI.compact_button(orders,message,action,explanation)

func _workspace(page:String,action_id:="") -> void:
	app.workspace.open_page(page)
	if not action_id.is_empty():
		app.workspace.focus_order(action_id)

func _target_move(attack:bool) -> void:
	if app.input.selected_army>=0: _army_target("attackMove" if attack else "move"); return
	app.command_tools.target_command({"c":"move","units":app.input._owned_units(),"attackMove":attack,"tile":"@map","formation":app.input.move_formation},"Attack-move" if attack else "Move units","point",false,false)

func _army_target(kind:String) -> void:
	app.command_tools.target_command({"c":"army","op":"order","id":app.input.selected_army,"kind":kind,"radius":4,"tile":"@map"},"Army "+kind.capitalize(),"point",false,false)

func _rebuild() -> void:
	NativeUI.clear(cards); NativeUI.clear(orders); NativeUI.clear(details); confirm_button=null; queue_label=null
	var world:WorldState=app.world; var selected:Dictionary=app.military.selected
	var units:Array=app.input._owned_units()
	if app.command_tools.mode!="select":
		if app.command_tools.mode!="build": confirm_button=_button("Confirm · Enter",func():app.command_tools.commit(),"Apply the previewed order")
		_button("Cancel · Esc",func():app.command_tools.cancel())
	elif not selected.is_empty():
		var aircraft:=not units.is_empty() and units.all(func(id):return world.defs.get("UNITS",{}).get(world.units[id].type,{}).get("air",false))
		var colonists:=not units.is_empty() and units.all(func(id):return world.units[id].type=="colonist")
		var extra:=[]
		if app.input.selected_army>=0:
			_button("Move",func():_army_target("move"))
			_button("Defend",func():_army_target("defend"))
			_button("Attack",func():_army_target("offensive"))
			extra.append({"label":"Formation and army options…","action":func():_workspace("Armies")})
		elif aircraft:
			_button("Air strike…",func():_workspace("Air","air_strike"),"Choose a strike target and mission parameters")
			_button("Patrol…",func():_workspace("Air","air_patrol"),"Choose a patrol area")
			_button("Return to base",func():app.workspace._dispatch({"c":"airMission","units":app.input._owned_units(),"kind":"return"}))
			extra.append({"label":"Assign home base…","action":func():_workspace("Air","air_home")})
		else:
			_button("Move",func():_target_move(false),"Choose a destination · right-click on the map also moves")
			if colonists:
				_button("Found city",func():app.workspace._dispatch({"c":"found","unit":units[0]}),"Establish a settlement at this colonist's location")
			else:
				_button("Attack-move",func():_target_move(true),"Advance and engage enemies along the route · E")
			_button("Hold",func():app.input._simple("hold",{}),"Stop and hold this position · H")
			if not colonists:
				extra.append({"label":"Withdraw · X","action":func():app.input._simple("withdraw",{})})
				extra.append({"label":"Draw deployment frontage","action":func():app.command_tools.activate("deploy"),"tip":"Right-drag also deploys along a line"})
				extra.append({"label":"Dig defensive positions…","action":func():_workspace("Military","fortify")})
				extra.append({"label":"Create army · G","action":func():app.input._simple("army",{"op":"create"})})
				extra.append({"label":"Set combat stance…","action":func():_workspace("Military","stance")})
		extra.append({"label":"Inspect selected forces","action":func():_workspace("Air" if aircraft else "Military")})
		var types:={}
		for id in selected:
			var type:=str(world.units.get(id,{}).get("type","")); types[type]=int(types.get(type,0))+1
		if types.size()>1:
			for type in types:
				var key:String=type
				extra.append({"label":"Select only %s (%d)"%[str(world.defs.get("UNITS",{}).get(key,{}).get("name",key)),types[key]],"action":func():
					for id in app.military.selected.keys():
						if world.units.get(id,{}).get("type")!=key: app.military.selected.erase(id)
					app.input.selection_changed.emit()})
		NativeUI.menu(orders,"Orders ▾",extra)
		for button in orders.get_children(): button.disabled=units.is_empty() or world.spectator
	elif app.settlements.selected_building>=0 and world.buildings.has(app.settlements.selected_building):
		var building:Dictionary=world.buildings[app.settlements.selected_building]
		var id:=int(building.id)
		var own:=int(building.o)==world.civ_id and not world.spectator
		var info:Dictionary=world.defs.get("BUILDINGS",{}).get(building.ty,{})
		var city:Dictionary=world.cities.get(int(building.get("c",-1)),{})
		if building.ty=="town":
			_button("Build · B",func():_workspace("Construction"))
			_button("Manage",func():_workspace("Cities"); app.workspace.dashboard.city_tab="Development"; app.workspace.dashboard.signature=""; app.workspace.dashboard.sync())
			_button("View production",func():_workspace("Cities"); app.workspace.dashboard.city_tab="Buildings"; app.workspace.dashboard.signature=""; app.workspace.dashboard.sync())
			if int(city.get("fs",0))>0:
				NativeUI.label(details,"Food shortage · farms are not supplying enough food.",15,Color("e4ad88"))
				NativeUI.compact_button(details,"Build Farm",func():app.command_tools.activate("build","farm"))
			elif int(city.get("iso",0))>0:
				NativeUI.label(details,"Supply connection lost · check roads and crossings.",15,Color("e4ad88"))
				NativeUI.compact_button(details,"Inspect supply connection",func():_workspace("Logistics"))
		else:
			if info.has("trains"):
				_button("Train troops",func():recruit_open=not recruit_open; signature="")
				_button("Rally point",func():app.command_tools.target_command({"c":"rally","building":id,"tile":"@map"},"Set rally point","point",false,false))
			if building.has("uc") or building.ty=="house" and int(building.get("lv",1))<3 and int(building.get("d",0))==1:
				_button("Upgrade",func():app.commands.issue("upgrade",{"building":id}))
			if float(building.get("hp",100))<100: _button("Repair",func():app.commands.issue("repair",{"building":id}))
			var extra:=[{"label":"Building details","action":func():_workspace("Buildings")}]
			if not city.is_empty(): extra.append({"label":"City details","action":func():_workspace("Cities")})
			if int(building.get("d",0))==0: extra.append({"label":"Prioritize construction","action":func():app.commands.issue("fund_next",{"building":id})})
			NativeUI.menu(orders,"More ▾",extra)
		if building.ty=="town" and info.has("trains"): _button("Train troops",func():recruit_open=not recruit_open; signature="")
		if recruit_open and info.has("trains") and own: _recruitment(building)
		for button in orders.get_children(): button.disabled=not own

func _recruitment(building:Dictionary) -> void:
	var world:WorldState=app.world
	var facilities:Array=app.input.selected_buildings.keys()
	if facilities.is_empty(): facilities=[int(building.id)]
	var options:=VBoxContainer.new(); details.add_child(options)
	var quantity:=SpinBox.new(); quantity.min_value=1; quantity.max_value=60; quantity.value=1; quantity.custom_minimum_size.x=72
	var per_building:=CheckButton.new(); per_building.text="Per building"
	var repeat_:=CheckButton.new(); repeat_.text="Repeat"
	var advanced:=HFlowContainer.new(); advanced.hide(); advanced.add_child(quantity); advanced.add_child(per_building); advanced.add_child(repeat_)
	NativeUI.compact_button(options,"Quantity & repeat…",func():advanced.visible=not advanced.visible)
	options.add_child(advanced)
	var scroll:=ScrollContainer.new(); scroll.custom_minimum_size.y=150; scroll.horizontal_scroll_mode=ScrollContainer.SCROLL_MODE_DISABLED; details.add_child(scroll)
	var list:=VBoxContainer.new(); list.size_flags_horizontal=Control.SIZE_EXPAND_FILL; scroll.add_child(list)
	for type in world.defs.get("BUILDINGS",{}).get(building.ty,{}).get("trains",[]):
		var key:String=type; var info:Dictionary=world.defs.get("UNITS",{}).get(key,{})
		var row:=HBoxContainer.new(); list.add_child(row)
		var thumbnail:=NativeModelThumbnail.new(); row.add_child(thumbnail); thumbnail.setup(app.military._build_model(key,world.civ_color(world.civ_id)))
		var text:=VBoxContainer.new(); text.size_flags_horizontal=Control.SIZE_EXPAND_FILL; text.add_theme_constant_override("separation",0); row.add_child(text)
		NativeUI.label(text,str(info.get("name",key)),16)
		var costs:=[]
		for good in info.get("cost",{}): costs.append("%s %s"%[str(info.cost[good]),good])
		NativeUI.label(text," · ".join(costs),12,NativeUI.MUTED)
		var train:=NativeUI.compact_button(row,"Train",func():app.commands.train(facilities,key,maxi(5,int(quantity.value)) if Input.is_key_pressed(KEY_SHIFT) else int(quantity.value),per_building.button_pressed,repeat_.button_pressed))
		var tech:=str(info.get("tech",""))
		train.disabled=int(building.get("d",0))!=1 or int(info.get("age",0))>int(world.econ.get("age",0)) or not tech.is_empty() and not tech in world.econ.get("techs",[])
		train.tooltip_text="Requires completed training facility and appropriate technology" if train.disabled else "Queue one unit · Shift-click queues five"
	queue_label=NativeUI.label(details,"",14,NativeUI.MUTED)

func _refresh() -> void:
	var world:WorldState=app.world
	deselect.visible=app.command_tools.mode=="select"
	var ids:Array=app.military.selected.keys(); var building:Dictionary=world.buildings.get(app.settlements.selected_building,{})
	var key:=str([ids,app.settlements.selected_building,app.input.selected_buildings.keys()])
	if key!=selection_key: selection_key=key; recruit_open=false
	var next:=str([world.econ.get("techs",[]) if recruit_open else [],app.input.selected_army,recruit_open,ids,ids.map(func(id):return world.units.get(id,{}).get("type","")),app.input.selected_buildings.keys(),app.settlements.selected_building,building.get("ty",""),int(building.get("d",0)),float(building.get("hp",100))<100,world.spectator,app.command_tools.mode])
	if next!=signature: signature=next; _rebuild()
	if app.command_tools.mode!="select":
		var mode:String=app.command_tools.mode
		title.text=app.command_tools.target_title.capitalize() if mode=="target" else "Place "+str(world.defs.get("BUILDINGS",{}).get(app.command_tools.value,{}).get("name",app.command_tools.value)) if mode=="build" else {"road":"Draw road","bridge":"Draw bridge","trench":"Draw trench line","deploy":"Deploy formation"}.get(mode,mode.capitalize())
		state.text=app.command_tools.status
		if is_instance_valid(confirm_button): confirm_button.disabled=app.command_tools.points.is_empty() or app.command_tools.preview.is_empty() or app.command_tools.preview.has("error")
	elif not ids.is_empty():
		var health:=0.0; var supply:=0.0; var morale:=0.0; var valid:=0
		for id in ids:
			var unit:Dictionary=world.units.get(id,{})
			if unit.is_empty(): continue
			health+=float(unit.hp); supply+=float(unit.get("supply",0)); morale+=float(unit.get("morale",100)); valid+=1
		title.text=str(world.defs.get("UNITS",{}).get(world.units.get(ids[0],{}).get("type",""),{}).get("name","Unit")) if valid==1 else "%d units selected"%valid
		state.text="Health %d%% · Supply %d%% · Morale %d%%"%[int(health/maxi(valid,1)),int(supply/maxi(valid,1)),int(morale/maxi(valid,1))]
		if app.input.selected_army>=0:
			for army in world.econ.get("armies",[]):
				if int(army.id)==app.input.selected_army: title.text=str(army.name); state.text+=" · "+str(army.get("order",{}).get("kind","Hold")).capitalize()
	elif not building.is_empty():
		var info:Dictionary=world.defs.get("BUILDINGS",{}).get(building.ty,{})
		title.text=str(world.cities.get(int(building.get("c",-1)),{}).get("n",info.get("name",building.ty))) if building.ty=="town" else str(info.get("name",building.ty))
		if building.ty=="town":
			var city:Dictionary=world.cities.get(int(building.get("c",-1)),{})
			state.text="%s people · %s\n%s"%[str(snappedf(float(city.get("pop",0)),.1)),"Growing" if float(city.get("gr",0))>0 else "Stable",str(city.get("development",{}).get("activity") if city.get("development",{}).get("activity")!=null else "No construction active")]
		else: state.text="Health %d%% · %s"%[int(building.hp),"Ready to train" if info.has("trains") and int(building.get("d",0))==1 else str(building.st).capitalize()]
		if is_instance_valid(queue_label):
			var queue:Array=building.get("q",[]); queue_label.visible=not queue.is_empty()
			queue_label.text="Training: "+" · ".join(queue.map(func(item):return str(world.defs.get("UNITS",{}).get(item[0],{}).get("name",item[0]))+" (~%s sec)"%str(item[1])))
	hint.hide()

func _process(dt:float) -> void:
	panel.visible=app.world.ready_ and not app.shell.is_blocking() and not app.workspace.panel.visible and not app.shell.world_hidden and (not app.military.selected.is_empty() or app.settlements.selected_building>=0 or app.command_tools.mode!="select")
	if not panel.visible: return
	var bounds:=get_viewport().get_visible_rect().size
	panel.size=Vector2(minf(440,bounds.x-340),0)
	panel.position=Vector2(10,bounds.y-panel.size.y-12)
	timer+=dt
	if timer>=.1: timer=0; _refresh()
