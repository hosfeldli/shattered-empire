class_name NativeWorkspace
extends CanvasLayer
## Screen-space workspaces over the same filtered economy records as the web client.
var world: WorldState
var net: NetworkClient
var camera: CameraController
var settlements: SettlementRenderer
var military: MilitaryRenderer
var panel: PanelContainer
var tabs: TabContainer
var pages := {}
var city_list: ItemList
var building_list: ItemList
var research_list: ItemList
var nation_list: ItemList
var force_list: ItemList
var summaries := {}
var feedback: Callable
var timer := 0.0


func setup(w: WorldState, n: NetworkClient, cam: CameraController, s: SettlementRenderer, m: MilitaryRenderer, report: Callable) -> void:
	world=w; net=n; camera=cam; settlements=s; military=m; feedback=report
	layer=20
	panel=PanelContainer.new(); panel.size=Vector2(760,540); panel.visible=false; add_child(panel)
	var layout:=VBoxContainer.new(); panel.add_child(layout)
	var close:=Button.new(); close.text="Empire workspaces · F2 to close"; close.pressed.connect(func(): panel.hide()); layout.add_child(close)
	tabs=TabContainer.new(); tabs.size_flags_vertical=Control.SIZE_EXPAND_FILL; layout.add_child(tabs)
	for title in ["Economy","Cities","Buildings","Research","Forces","Diplomacy","Government","History"]:
		var page:=VBoxContainer.new(); page.name=title; tabs.add_child(page); pages[title]=page
		var summary:=RichTextLabel.new(); summary.custom_minimum_size=Vector2(700,110); summary.bbcode_enabled=false; summary.selection_enabled=true
		page.add_child(summary); summaries[title]=summary
	city_list=_list(pages.Cities)
	city_list.item_activated.connect(func(index): camera.focus_tile(int(world.cities.get(_id(city_list,index),{}).get("t",world.start_tile))))
	for spec in [["Manual","off"],["Advisor","advisor"],["Managed","managed"],["Autonomous","autonomous"]]:
		var level:String=spec[1]
		_button(pages.Cities,"Governor: "+spec[0],func(): _send({"c":"governor","city":_id(city_list),"level":level}))
	building_list=_list(pages.Buildings)
	building_list.item_selected.connect(func(index):
		settlements.selected_building=_id(building_list,index); military.selected.clear()
		camera.focus_tile(int(world.buildings.get(settlements.selected_building,{}).get("t",world.start_tile))))
	for action in ["upgrade","repair","buildNext"]:
		var kind:String=action
		_button(pages.Buildings,{"upgrade":"Upgrade selected building","repair":"Repair selected building","buildNext":"Fund selected site next"}[action],func(): _send({"c":kind,"id":_id(building_list)}))
	research_list=_list(pages.Research)
	for spec in [["Queue technology","add"],["Research goal","goal"],["Move to front","front"],["Remove from queue","remove"]]:
		var op:String=spec[1]
		_button(pages.Research,spec[0],func(): _send({"c":"researchQueue","op":op,"tech":_key(research_list)}))
	force_list=_list(pages.Forces)
	force_list.item_selected.connect(func(index):
		var id:=_id(force_list,index)
		if world.units.has(id): military.selected={id:true}; settlements.selected_building=-1; camera.focus_tile(int(world.units[id].tile)))
	for spec in [["Hold selected","hold"],["Defensive stance","stance"]]:
		var command:String=spec[1]
		_button(pages.Forces,spec[0],func(): _send({"c":command,"units":military.selected.keys(),"stance":"defensive"}))
	_button(pages.Forces,"Form army from selected units",func(): _send({"c":"army","op":"create","units":military.selected.keys()}))
	nation_list=_list(pages.Diplomacy)
	for action in ["peace","trade","borders","alliance","war"]:
		var kind:String=action
		_button(pages.Diplomacy,"Request "+action,func(): _send({"c":"diplo","to":_id(nation_list),"action":kind}))
	var gov:=_dropdown(pages.Government,"GOVS")
	_button(pages.Government,"Reform government",func(): _send({"c":"gov","id":gov.get_item_metadata(gov.selected)}))
	var policy:=_dropdown(pages.Government,"POLICIES")
	_button(pages.Government,"Toggle policy",func():
		var key:String=policy.get_item_metadata(policy.selected)
		_send({"c":"policy","id":key,"on":not key in world.econ.get("policies",[])}))
	var focus:=_dropdown(pages.Government,"FOCI")
	_button(pages.Government,"Set economic focus",func(): _send({"c":"focus","id":focus.get_item_metadata(focus.selected)}))
	var tax:=OptionButton.new()
	for label in ["Low tax","Normal tax","High tax","Maximum tax"]: tax.add_item(label)
	pages.Government.add_child(tax)
	_button(pages.Government,"Set taxes",func(): _send({"c":"tax","level":tax.selected}))
	world.welcomed.connect(func(): _fill_dropdown(gov,"GOVS"); _fill_dropdown(policy,"POLICIES"); _fill_dropdown(focus,"FOCI"))


func _send(command: Dictionary) -> void:
	if world.spectator: feedback.call("Spectators cannot issue orders",false); return
	net.cmd(command,func(reply: Dictionary): feedback.call("Order accepted" if reply.get("error")==null else str(reply.error),reply.get("error")==null))


func _list(parent: Node) -> ItemList:
	var list:=ItemList.new(); list.size_flags_vertical=Control.SIZE_EXPAND_FILL; list.custom_minimum_size=Vector2(700,100); parent.add_child(list); return list


func _button(parent: Node, title: String, action: Callable) -> void:
	var button:=Button.new(); button.text=title; button.pressed.connect(action); parent.add_child(button)


func _dropdown(parent: Node, catalog: String) -> OptionButton:
	var list:=OptionButton.new(); parent.add_child(list); _fill_dropdown(list,catalog); return list


func _fill_dropdown(list: OptionButton, catalog: String) -> void:
	list.clear()
	for key in world.defs.get(catalog,{}):
		var value:Variant=world.defs[catalog][key]
		list.add_item(str(value.get("name",key)) if value is Dictionary else str(value)); list.set_item_metadata(list.item_count-1,key)


func _id(list: ItemList, index: int=-1) -> int:
	if index<0:
		if list.get_selected_items().is_empty(): return -1
		index=list.get_selected_items()[0]
	return int(list.get_item_metadata(index))


func _key(list: ItemList) -> String:
	if list.get_selected_items().is_empty(): return ""
	return str(list.get_item_metadata(list.get_selected_items()[0]))


func _rows(list: ItemList, rows: Array) -> void:
	var selected:Variant=null
	if not list.get_selected_items().is_empty(): selected=list.get_item_metadata(list.get_selected_items()[0])
	var scroll:=list.get_v_scroll_bar().value
	list.clear()
	for row in rows:
		list.add_item(row[1]); list.set_item_metadata(list.item_count-1,row[0])
		if row[0]==selected: list.select(list.item_count-1)
	list.get_v_scroll_bar().value=scroll


func _refresh() -> void:
	var econ:=world.econ
	var lines:=[]
	for good in GameHUD.GOODS:
		lines.append("%s: %d  (%+.2f/s)" % [good,int(econ.get("res",{}).get(good,0)),float(econ.get("rates",{}).get(good,0))])
	lines.append("Power: %d generated / %d used · storage %d" % [int(econ.get("power",{}).get("gen",0)),int(econ.get("power",{}).get("use",0)),int(econ.get("storage",0))])
	summaries.Economy.text="\n".join(lines)
	summaries.Economy.custom_minimum_size.y=350
	var cities:=[]
	for city in world.cities.values():
		cities.append([int(city.id),"%s · population %.1f · housing %s · stability %s · %s" % [city.n,float(city.pop),str(city.get("h","?")),str(city.get("st","?")),"isolated" if city.get("iso",0) else "connected"]])
	_rows(city_list,cities)
	summaries.Cities.text="Double-click a city to center. Governor settings affect only your cities."
	var buildings:=[]
	for building in world.buildings.values():
		if int(building.o)!=world.civ_id: continue
		buildings.append([int(building.id),"%s · #%d · %d%% health · %s%s" % [str(world.defs.get("BUILDINGS",{}).get(building.ty,{}).get("name",building.ty)),int(building.id),int(building.get("hp",100)),str(building.get("st",""))," · "+str(building.w) if building.get("w")!=null else ""]])
	_rows(building_list,buildings)
	summaries.Buildings.text="Choose a building to select and center it. Construction, upgrades and repairs use the server's current costs."
	var research:=[]
	for key in world.defs.get("TECHS",{}):
		var def:Dictionary=world.defs.TECHS[key]
		research.append([key,"%s · %d points · %s" % [def.name,int(def.cost),"complete" if key in econ.get("techs",[]) else "queued" if key in econ.get("queue",[]) else str(def.get("desc",""))]])
	_rows(research_list,research)
	summaries.Research.text="Current: %s · progress %d · %0.2f points/s\nQueue: %s" % [str(econ.get("research","automatic")),int(econ.get("progress",0)),float(econ.get("researchRate",0)),", ".join(econ.get("queue",[]))]
	var forces:=[]
	for unit in world.units.values():
		if int(unit.owner)!=world.civ_id: continue
		forces.append([int(unit.id),"%s · #%d · health %d%% · supply %d%% · suppression %d · formation %d" % [str(world.defs.get("UNITS",{}).get(unit.type,{}).get("name",unit.type)),int(unit.id),int(unit.hp),int(unit.get("supply",0)),int(unit.get("supp",0)),int(unit.get("formation",0))]])
	_rows(force_list,forces)
	summaries.Forces.text="%d formations · %d armies\nSelect units here or on the map; draw a deployment with the construction panel." % [econ.get("formations",[]).size(),econ.get("armies",[]).size()]
	var nations:=[]
	for civ in world.civ_by_id.values():
		if int(civ.id)==world.civ_id: continue
		var rel:Dictionary=civ.get("rel",{}) if civ.get("rel") is Dictionary else {}
		nations.append([int(civ.id),"%s · %s" % [str(civ.name),str(rel.get("state","unmet"))]])
	_rows(nation_list,nations)
	summaries.Diplomacy.text="Diplomatic requests are validated by the server. Unmet nations retain their existing information limits."
	summaries.Government.text="Government: %s · focus: %s · tax level: %d\nActive policies: %s" % [str(econ.get("gov","")),str(econ.get("focus","")),int(econ.get("tax",0)),", ".join(econ.get("policies",[]))]
	var history:=[]
	for record in econ.get("cmdlog",[]): history.append(str(record.get("text",record.get("label",""))))
	summaries.History.text="\n".join(history); summaries.History.custom_minimum_size.y=430


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.keycode==KEY_F2:
		panel.visible=not panel.visible
		if panel.visible: _refresh()
		get_viewport().set_input_as_handled()


func _process(dt: float) -> void:
	if not panel.visible: return
	panel.position=(get_viewport().get_visible_rect().size-panel.size)*.5
	timer+=dt
	if timer>=1.0: timer=0; _refresh()
