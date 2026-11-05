class_name NativeDashboard
extends VBoxContainer
## Player-facing management: overview cards, production choices and research planning.
var workspace:NativeWorkspace
var world:WorldState
var scroll:ScrollContainer
var body:VBoxContainer
var bindings:Array=[]
var signature:=""
var elapsed:=0.0
var research_details:VBoxContainer
var response_panel:PanelContainer

func setup(owner_:NativeWorkspace) -> void:
	workspace=owner_; world=owner_.world
	size_flags_horizontal=Control.SIZE_EXPAND_FILL; size_flags_vertical=Control.SIZE_EXPAND_FILL
	scroll=ScrollContainer.new(); scroll.size_flags_vertical=Control.SIZE_EXPAND_FILL; scroll.horizontal_scroll_mode=ScrollContainer.SCROLL_MODE_DISABLED; add_child(scroll)
	body=VBoxContainer.new(); body.size_flags_horizontal=Control.SIZE_EXPAND_FILL; body.add_theme_constant_override("separation",18); scroll.add_child(body)

func sync() -> void:
	var ids:Array=workspace.rows.map(func(row):return row.key)
	var key:Variant=workspace.current.get("key")
	var layout:Variant=[]
	if workspace.page in ["Cities"]: layout=_data().get("gov",{}).get("proposals",[]).map(func(item):return item.id)
	elif workspace.page=="Resources": layout=[_data().get("actions",[]),_data().get("consumers",[]).map(func(item):return item.get("type")),_data().get("producers",[]).map(func(item):return item.get("count",item.get("n",0)))]
	if workspace.page=="Rivals": layout=workspace.rows.map(func(row):return row.data)
	var next:=str([workspace.page,ids,null if workspace.page=="Research" else key,layout])
	if signature!=next:
		signature=next; _build()
	_update_values()

func _card(parent:Node,title:String) -> VBoxContainer:
	var panel:=PanelContainer.new(); panel.add_theme_stylebox_override("panel",NativeUI.style(Color("1c292f"),Color("36464b"),16)); panel.size_flags_horizontal=Control.SIZE_EXPAND_FILL; parent.add_child(panel)
	var column:=VBoxContainer.new(); panel.add_child(column)
	if not title.is_empty(): NativeUI.label(column,title.to_upper(),13,NativeUI.GOLD)
	return column

func _bind(parent:Node,getter:Callable,size_:=17,color:=NativeUI.TEXT) -> Label:
	var label:=NativeUI.label(parent,"",size_,color); bindings.append({"label":label,"get":getter}); return label

func _metric(parent:Node,title:String,getter:Callable) -> void:
	var column:=_card(parent,title); _bind(column,getter,30)

func _button(parent:Node,title:String,action:Callable,primary:=false) -> Button:
	var button:=NativeUI.button(parent,title,action)
	if primary:
		button.add_theme_stylebox_override("normal",NativeUI.style(Color("d0af6c"),Color("e5c687"),10)); button.add_theme_color_override("font_color",Color("142026")); button.add_theme_color_override("font_hover_color",Color("142026"))
	return button

func _data() -> Dictionary:
	var data:Variant=workspace.current.get("data",{})
	return data if data is Dictionary else {}

func _action(id:String,values:Dictionary={}) -> void:
	var matches:=workspace.actions.filter(func(record):return record.id==id)
	if matches.is_empty(): return
	workspace._set_action(matches[0])
	for key in values:
		if not workspace.controls.has(key): continue
		var control:Control=workspace.controls[key]
		if control is OptionButton:
			for index in control.item_count:
				if control.get_item_metadata(index)==values[key]: control.select(index)
		elif control is CheckButton: control.button_pressed=bool(values[key])
		elif control is SpinBox: control.value=float(values[key])
		elif control is LineEdit: control.text=str(values[key])
	workspace._perform(false)

func _all_orders(action_id:="") -> void:
	workspace.show_all_orders(true)
	if not action_id.is_empty():
		var matches:=workspace.page_actions.filter(func(record):return record.id==action_id)
		if not matches.is_empty(): workspace.action_list.select(workspace.page_actions.find(matches[0])); workspace._set_action(matches[0])

func _record_picker() -> void:
	if workspace.rows.is_empty(): return
	var choices:=[]
	for row in workspace.rows: choices.append([row.key,str(row.label).split(" · ")[0]])
	var picker:=NativeUI.options(body,choices)
	for index in picker.item_count:
		if picker.get_item_metadata(index)==workspace.current.get("key"): picker.select(index)
	picker.item_selected.connect(func(index):workspace._choose(index))

func _build() -> void:
	NativeUI.clear(body); bindings.clear(); response_panel=null
	var related:={"Cities":["Cities","Production"],"Buildings":["Cities","Buildings","Production"],"Military":["Military","Armies","Formations","Air","Strategic"],"Armies":["Military","Armies","Formations","Air","Strategic"],"Air":["Military","Armies","Air","Strategic"],"Economy":["Economy","Resources","Logistics"],"Resources":["Economy","Resources","Logistics"],"Alerts":["Alerts","Battles","History"]}
	if related.has(workspace.page):
		var tabs:=HFlowContainer.new(); body.add_child(tabs)
		for target in related[workspace.page]:
			var destination:String=target
			_button(tabs,"Overview" if target=="Cities" else "Events" if target=="Alerts" else target,func():workspace.open_page(destination),target==workspace.page)
	match workspace.page:
		"Economy": _economy()
		"Resources": _resource()
		"Cities": _city()
		"Research": _research()
		"Buildings","Production": _building()
		"Construction": _construction()
		"Military","Armies","Formations","Air": _forces()
		"Rivals": _rivals()
		"Strategic": _strategic()
		"Battles": _battles()
		"Alerts","History": _events()
		_: _overview()
	if not workspace.last_reply.is_empty(): show_response(workspace.last_reply)

func show_response(reply:Dictionary) -> void:
	if is_instance_valid(response_panel): body.remove_child(response_panel); response_panel.queue_free()
	var card:=_card(body,"Latest result"); response_panel=card.get_parent()
	if reply.get("error")!=null:
		NativeUI.label(card,str(reply.error),18,Color("e6a08a")); return
	if reply.has("plan"):
		var plan:Dictionary=reply.plan
		for issue in plan.get("issues",[]): NativeUI.label(card,str(issue),17,NativeUI.GOLD)
		for recommendation in plan.get("recs",[]):
			NativeUI.label(card,str(recommendation.get("reason","")),18)
			NativeUI.label(card,_cost(recommendation.get("cost",{})),15,NativeUI.MUTED)
			if recommendation.get("type")!=null:
				var type:String=recommendation.type
				_button(card,"Plan "+workspace._name("BUILDINGS",type),func():workspace.tools.activate("build",type); workspace.panel.hide())
	elif reply.has("preview"):
		NativeUI.label(card,"Preview of worker allocation",22)
		for change in reply.preview.get("changes",[]): NativeUI.label(card,"%s · %s → %s workers"%[workspace._name("BUILDINGS",change.type),str(change.from),str(change.to)],17)

	else: NativeUI.label(card,"Your order has been accepted.",18)

func _economy() -> void:
	NativeUI.label(body,"The national economy",30)
	NativeUI.label(body,"Stockpiles, production and the cost of keeping your empire moving.",16,NativeUI.MUTED)
	var grid:=GridContainer.new(); grid.columns=4; grid.size_flags_horizontal=Control.SIZE_EXPAND_FILL; grid.add_theme_constant_override("h_separation",12); grid.add_theme_constant_override("v_separation",12); body.add_child(grid)
	for good in GameHUD.GOODS:
		var key:String=good; var card:=_card(grid,str(world.defs.get("GOOD_NAMES",{}).get(key,key)))
		_bind(card,func():return str(roundi(float(world.econ.get("res",{}).get(key,0)))),30)
		_bind(card,func():return "%+.2f / sec"%float(world.econ.get("rates",{}).get(key,0)),16,NativeUI.MUTED)
		_button(card,"Details →",func():workspace.open_page("Resources"); _select_key(key))
	var row:=HBoxContainer.new(); body.add_child(row)
	_metric(row,"Power",func():return "%d / %d"%[int(world.econ.get("power",{}).get("gen",0)),int(world.econ.get("power",{}).get("use",0))])
	_metric(row,"Storage",func():return str(world.econ.get("storage",0)))
	_metric(row,"Field army",func():return "%d personnel"%int(world.econ.get("men",0)))
	var ledger:=_card(body,"Treasury and expenditure")
	NativeUI.label(ledger,"Income comes from productive cities and commercial halls. Roads and freight connect local production to national stockpiles.",17,NativeUI.MUTED)
	var buttons:=HFlowContainer.new(); ledger.add_child(buttons)
	_button(buttons,"Spending details",func():_all_orders())
	_button(buttons,"Infrastructure & supply",func():workspace.open_page("Logistics"))
	_button(buttons,"City production",func():workspace.open_page("Cities"))

func _select_key(key:Variant) -> void:
	for index in workspace.rows.size():
		if workspace.rows[index].key==key: workspace._choose(index); return

func _resource() -> void:
	_record_picker()
	_bind(body,func():return str(_data().get("title","Resource")),30)
	_bind(body,func():return str(_data().get("what","")),17,NativeUI.MUTED)
	var row:=HBoxContainer.new(); body.add_child(row)
	_metric(row,"Stockpile",func():return str(_data().get("stock",0)))
	_metric(row,"Available",func():return str(_data().get("available",0)))
	_metric(row,"Net flow",func():return "%+.2f / sec"%float(_data().get("net",0)))
	var advice:=_card(body,"Supply outlook")
	_bind(advice,func():return str(_data().get("headline","")),22)
	_bind(advice,func():return str(_data().get("cause","")),16,NativeUI.MUTED)
	for action in _data().get("actions",[]):
		var record:Dictionary=action
		_button(advice,str(record.get("label","Review")),func():_resource_action(record))
	var chains:=HBoxContainer.new(); body.add_child(chains)
	for category in ["producers","consumers"]:
		var card:=_card(chains,category)
		for record in _data().get(category,[]):
			NativeUI.label(card,str(record.get("name",record.get("type",""))),18)
			NativeUI.label(card,"%s facilities · %s / sec"%[str(record.get("count",record.get("n",0))),str(record.get("rate",record.get("output",0)))],14,NativeUI.MUTED)
	_button(body,"Import goods / request a quote",func():_all_orders("quote"))

func _resource_action(record:Dictionary) -> void:
	match str(record.get("a","")):
		"build","housing": workspace.tools.activate("build",record.get("type","house")); workspace.panel.hide()
		"research": workspace._dispatch({"c":"researchQueue","op":"goal","tech":record.get("tech")})
		_: _all_orders()

func _city() -> void:
	_record_picker()
	if workspace.current.is_empty(): NativeUI.label(body,"No cities to manage yet.",24); return
	_bind(body,func():return str(_data().get("n","City")),32)
	_bind(body,func():return "Capital" if int(_data().get("cap",0)) else "Settlement",15,NativeUI.GOLD)
	var stats:=HBoxContainer.new(); body.add_child(stats)
	_metric(stats,"Population",func():return str(snappedf(float(_data().get("pop",0)),.1)))
	_metric(stats,"Housing",func():return str(_data().get("h",0)))
	_metric(stats,"Stability",func():return "%d%%"%int(_data().get("st",0)))
	_metric(stats,"Growth / minute",func():return "%+.1f"%float(_data().get("gr",0)))
	var columns:=HBoxContainer.new(); body.add_child(columns)
	var labor:=_card(columns,"Population & work")
	_bind(labor,func():return "Labor force   %s\nUnemployed   %s\nAvailable recruits   %s\nMilitary reserves   %s\nHousing   %s / %s"%[str(_data().get("lab",0)),str(_data().get("un",0)),str(_data().get("rec",0)),str(_data().get("rsv",0)),str(_data().get("pop",0)),str(_data().get("h",0))])
	NativeUI.label(labor,"Workers automatically respond to food needs, shortages and available production.",16,NativeUI.MUTED)
	var network:=_card(columns,"City connections")
	_bind(network,func():return "%s\nFreight capacity   %s\nGoods shipped   %s\nMigration   %s"%["Isolated from the national network" if int(_data().get("iso",0)) else "Connected to the national network","Unlimited" if float(_data().get("fr",0))<0 else str(_data().get("fr",0)),str(_data().get("ship",0)),str(_data().get("mig",0))])
	_button(network,"Center on city",workspace._center_current)
	var development:=_card(body,"Development")
	NativeUI.label(development,"Routine staffing, repairs, rubble and basic housing are handled locally. Major construction stays under your control.",16,NativeUI.MUTED)
	var controls:=HBoxContainer.new(); development.add_child(controls)
	var automatic:=CheckButton.new(); automatic.text="Automatic Development"; automatic.button_pressed=bool(_data().get("development",{}).get("on",true)); controls.add_child(automatic)
	var priority:=NativeUI.options(controls,[["balanced","Balanced"],["industry","Industry"],["agriculture","Agriculture"],["military","Military"]])
	for index in priority.item_count:
		if priority.get_item_metadata(index)==_data().get("development",{}).get("priority","balanced"): priority.select(index)
	_button(controls,"Apply",func():workspace._dispatch({"c":"cityDevelopment","city":int(workspace.current.key),"on":automatic.button_pressed,"priority":NativeUI.value(priority)}),true)
	_bind(development,func():return str(_data().get("development",{}).get("activity","No routine project active") if _data().get("development",{}).get("activity")!=null else "No routine project active"),16,NativeUI.MUTED)
	var production:=_card(body,"Production")
	for building in world.buildings.values():
		if int(building.get("c",-1))!=int(workspace.current.key): continue
		var id:=int(building.id)
		var line:=HBoxContainer.new(); production.add_child(line)
		var info:=_bind(line,func():return "%s · %s"%[workspace._name("BUILDINGS",world.buildings.get(id,{}).get("ty","")),str(world.buildings.get(id,{}).get("w","Working") if world.buildings.get(id,{}).get("d",0) else "Under construction")],17)
		info.size_flags_horizontal=Control.SIZE_EXPAND_FILL
		_button(line,"Inspect",func():workspace.settlements.selected_building=id; workspace.open_page("Buildings"))

func _rivals() -> void:
	NativeUI.label(body,"Beyond your borders",32)
	NativeUI.label(body,"Only observed activity is shown. A quiet border does not reveal an opponent's plans.",16,NativeUI.MUTED)
	for row in workspace.rows:
		var rival:Dictionary=row.data; var id:=int(rival.id)
		var intel:Dictionary=rival.get("intel",{})
		var status:=str(intel.get("state","unknown"))
		var card:=_card(body,str(rival.name))
		NativeUI.label(card,{"war":"At War","peaceful":"Peaceful","hostile":"Hostile","defeated":"Defeated","unknown":"Unknown"}.get(status,"Unknown"),24,Color("da8f73") if status=="war" else NativeUI.TEXT)
		NativeUI.label(card,str(intel.get("posture","Focus unknown")),19)
		var focus:Variant=intel.get("focus")
		NativeUI.label(card,"Known focus: "+str(world.civ_by_id.get(int(focus),{}).get("name","Focus unknown")) if focus!=null else "Focus unknown",16,NativeUI.MUTED)
		NativeUI.label(card,str(intel.get("activity","No current observations")),16,NativeUI.MUTED)
		if status in ["peaceful","hostile"]:
			_button(card,"Initiate Attack…",func():_action("diplo_war",{"nation":id}))
		elif status=="war": NativeUI.label(card,"Use Withdraw or Hold to disengage your forces. Enemy forces may continue fighting.",15,NativeUI.MUTED)

func _research() -> void:
	var progress:=_card(body,"Research programme")
	_bind(progress,func():return workspace._name("TECHS",world.econ.get("research","Automatic research")),26)
	_bind(progress,func():return "%s points earned · %.2f points / sec · %d technologies queued"%[str(world.econ.get("progress",0)),float(world.econ.get("researchRate",0)),world.econ.get("queue",[]).size()],16,NativeUI.MUTED)
	var columns:=HSplitContainer.new(); columns.custom_minimum_size.y=520; body.add_child(columns)
	var graph_scroll:=ScrollContainer.new(); graph_scroll.size_flags_horizontal=Control.SIZE_EXPAND_FILL; graph_scroll.custom_minimum_size.x=400; columns.add_child(graph_scroll)
	var graph:=NativeResearchTree.new(); graph.setup(world); graph_scroll.add_child(graph)
	research_details=_card(columns,"Technology")
	research_details.custom_minimum_size.x=260
	graph.technology_selected.connect(func(key):_select_key(key); _research_detail())
	_research_detail()

func _number(value:Variant) -> String:
	if value is int or value is float:
		var amount:=float(value)
		return str(roundi(amount)) if is_equal_approx(amount,roundf(amount)) else str(snappedf(amount,.1))
	return str(value) if value!=null else "—"

func _research_detail() -> void:
	if not is_instance_valid(research_details): return
	NativeUI.clear(research_details)
	var info:=_data(); var key:=str(workspace.current.get("key",""))
	NativeUI.label(research_details,str(info.get("name","Choose a technology")),25)
	NativeUI.label(research_details,str(info.get("desc","")),17,NativeUI.MUTED)
	NativeUI.label(research_details,"%s points · %s"%[str(info.get("cost",0)),str(info.get("status",""))],15,NativeUI.GOLD)
	for prerequisite in info.get("req",[]): NativeUI.label(research_details,"Requires "+workspace._name("TECHS",prerequisite),15,NativeUI.MUTED)
	var complete:bool=key in world.econ.get("techs",[])
	_button(research_details,"Research now",func():_action("research_now",{"tech":key}),true).disabled=complete
	_button(research_details,"Add to research queue",func():_action("research_add",{"tech":key})).disabled=complete
	_button(research_details,"Set as long-term goal",func():_action("research_goal",{"tech":key})).disabled=complete
	_button(research_details,"Manage research queue",func():_all_orders("research_front"))

func _building() -> void:
	_record_picker()
	if workspace.current.is_empty(): NativeUI.label(body,"Select a facility to manage production.",24); return
	var data:=_data(); var type:=str(data.get("ty","")); var def:Dictionary=world.defs.get("BUILDINGS",{}).get(type,{})
	NativeUI.label(body,str(def.get("name",type)),32)
	_bind(body,func():return "%s · level %s · health %s%% · workers %s"%[str(_data().get("st","Operational")).capitalize(),str(_data().get("lv",1)),str(_data().get("hp",100)),str(_data().get("s",0))],17,NativeUI.MUTED)
	var choices:=HFlowContainer.new(); body.add_child(choices)
	for pair in [["Upgrade","upgrade"],["Repair","repair"],["Fund this site next","fund_next"]]:
		var action_id:String=pair[1]; _button(choices,pair[0],func():_action(action_id,{"building":int(workspace.current.key)}))
	var catalog:=GridContainer.new(); catalog.columns=3; catalog.add_theme_constant_override("h_separation",12); catalog.add_theme_constant_override("v_separation",12); body.add_child(catalog)
	for unit in def.get("trains",[]):
		var key:String=unit; var definition:Dictionary=world.defs.get("UNITS",{}).get(key,{})
		var card:=_card(catalog,str(definition.get("name",key)))
		NativeUI.label(card,_cost(definition.get("cost",{})),17)
		NativeUI.label(card,"%s seconds · %s population"%[str(definition.get("time",0)),str(definition.get("pop",0))],14,NativeUI.MUTED)
		_button(card,"Recruit",func():workspace._dispatch({"c":"train","building":int(workspace.current.key),"unit":key}),true)
		_button(card,"Repeat production",func():workspace._dispatch({"c":"repeat","buildings":[int(workspace.current.key)],"unit":key}))
	var queue:=_card(body,"Training queue")
	_bind(queue,func():return "\n".join(_data().get("q",[]).map(func(item):return workspace._name("UNITS",item[0])+" · "+str(item[1])+" sec remaining")),17)
	_button(queue,"Batch / rally / queue controls",func():_all_orders("batch_train") if workspace.page=="Production" else workspace.open_page("Production"))

func _cost(cost:Dictionary) -> String:
	var parts:=[]
	for good in cost: parts.append("%s %s"%[str(cost[good]),str(world.defs.get("GOOD_NAMES",{}).get(good,good))])
	return " · ".join(parts)

func _construction() -> void:
	NativeUI.label(body,"Build your empire",32)
	NativeUI.label(body,"Choose a building, then place it on an approved site. Drag to plan several sites.",17,NativeUI.MUTED)
	var tools_row:=HFlowContainer.new(); body.add_child(tools_row)
	for spec in [["Road / rail","construction_road"],["Bridge","construction_bridge"],["Trench line","construction_trench"]]:
		var id:String=spec[1]; _button(tools_row,spec[0],func():_all_orders(id))
	var grid:=GridContainer.new(); grid.columns=3; grid.add_theme_constant_override("h_separation",12); grid.add_theme_constant_override("v_separation",12); body.add_child(grid)
	for type in world.defs.get("BUILDINGS",{}):
		var key:String=type; var def:Dictionary=world.defs.BUILDINGS[key]
		if def.get("obsolete",false) or def.get("rebelOnly",false): continue
		var card:=_card(grid,str(def.get("cat","Infrastructure")))
		NativeUI.label(card,str(def.get("name",key)),24)
		NativeUI.label(card,_cost(def.get("cost",{})),15,NativeUI.MUTED)
		if def.get("tech")!=null: NativeUI.label(card,"Requires "+workspace._name("TECHS",def.tech),14,NativeUI.MUTED)
		_button(card,"Plan building",func():workspace.tools.activate("build",key); workspace.panel.hide())

func _forces() -> void:
	_record_picker()
	NativeUI.label(body,"Forces & operations" if workspace.page=="Military" else workspace.page,32)
	var selected:=HBoxContainer.new(); body.add_child(selected)
	_metric(selected,"Owned units",func():return str(world.units.values().filter(func(unit):return int(unit.owner)==world.civ_id).size()))
	_metric(selected,"Armies",func():return str(world.econ.get("armies",[]).size()))
	_metric(selected,"Formations",func():return str(world.econ.get("formations",[]).size()))
	var operations:=_card(body,"Operational orders")
	var flow:=HFlowContainer.new(); operations.add_child(flow)
	for action in workspace.page_actions:
		var record:Dictionary=action
		_button(flow,str(record.title).capitalize(),func():_all_orders(str(record.id)))
	var status:=_card(body,"Selected force")
	_bind(status,func():return str(_data().get("name",workspace.current.get("label","Select units on the map or choose a force above"))),23)
	_bind(status,func():return "Health %s%%   ·   Supply %s%%   ·   Status %s"%[str(_data().get("hp","—")),str(_data().get("supply",_data().get("sup","—"))),str(_data().get("status",_data().get("stance","—")))],17,NativeUI.MUTED)
	_button(status,"Select on map",workspace._select_current)

func _strategic() -> void:
	NativeUI.label(body,"Strategic forces",32)
	var row:=HBoxContainer.new(); body.add_child(row)
	_metric(row,"Ready missiles",func():return str(world.econ.get("missiles",{}).get("ready",0)))
	_metric(row,"Visible launches",func():return str(world.missiles.get("m",[]).size()))
	var command:=_card(body,"Strategic strike planning")
	NativeUI.label(command,"Choose a target to request range, flight time and known interception estimates. The strike requires confirmation.",17,NativeUI.MUTED)
	_button(command,"Plan a missile strike",func():_action("missile_launch"),true)
	for building in world.buildings.values():
		if int(building.o)!=world.civ_id or not world.defs.get("BUILDINGS",{}).get(building.ty,{}).get("silo",false): continue
		var id:=int(building.id); var card:=_card(body,"Missile silo #"+str(id))
		NativeUI.label(card,"%d ready · %d%% construction"%[int(building.get("mi",0)),int(building.get("mp",0))],22)
		NativeUI.label(card,"Missile cost: "+_cost(world.defs.get("MISSILE",{}).get("cost",{})),16,NativeUI.MUTED)
		_button(card,"Build missile",func():workspace._dispatch({"c":"missileBuild","silo":id}))
	for launch in world.missiles.get("m",[]):
		var data:Array=launch; var warning:=_card(body,"Missile in flight")
		_bind(warning,func():return "%d seconds to impact"%maxi(0,ceili(float(data[4])-world.server_time)),24,Color("e6a08a"))
		_button(warning,"Go to target",func():workspace.camera.focus_tile(int(data[2]),20); workspace.panel.hide())

func _battles() -> void:
	NativeUI.label(body,"Active engagements",32)
	if world.battles.is_empty(): NativeUI.label(body,"No active battles in your current reports.",18,NativeUI.MUTED)
	for battle in world.battles:
		var record:Dictionary=battle; var mine:Dictionary=battle.get("mine",{}); var tile:=int(battle.get("t",-1))
		var card:=_card(body,str(battle.get("name","Engagement")))
		NativeUI.label(card,"%d own units · %d engaging · %d withdrawing"%[int(mine.get("n",0)),int(mine.get("engaged",0)),int(mine.get("retreating",0))],23)
		NativeUI.label(card,"Supply %s%% · %d losses · %d reinforcements inbound"%[str(mine.get("sup","—")),int(mine.get("lost",0)),int(mine.get("inbound",0))],17,NativeUI.MUTED)
		for foe in record.get("foes",[]): NativeUI.label(card,"%s · %d visible units"%[str(world.civ_by_id.get(int(foe.civ),{}).get("name","Unknown force")),int(foe.get("n",0))],17)
		var controls:=HFlowContainer.new(); card.add_child(controls)
		_button(controls,"Go to battle",func():workspace.camera.focus_tile(tile,24); workspace.panel.hide())
		_button(controls,"Reinforce with selection",func():workspace._dispatch({"c":"move","units":workspace.input_ref._owned_units(),"tile":tile,"attackMove":true}))
		for type in ["hold","withdraw"]:
			var operation:String=type
			_button(controls,type.capitalize(),func():
				var units:=world.units.values().filter(func(unit):return int(unit.owner)==world.civ_id and world.grid.dist(int(unit.tile),tile)<=6).map(func(unit):return int(unit.id))
				workspace._dispatch({"c":operation,"units":units}))

func _events() -> void:
	NativeUI.label(body,"Situation reports" if workspace.page=="Alerts" else "Command chronicle",32)
	NativeUI.label(body,"Select an event to return to its location. Reports contain information received by your civilization.",16,NativeUI.MUTED)
	for row in workspace.rows:
		var record:Dictionary=row; var data:Dictionary=row.data
		var card:=_card(body,str(data.get("kind",data.get("by","Report"))))
		NativeUI.label(card,str(data.get("text",data.get("label",row.label))),18)
		NativeUI.label(card,"Time "+str(data.get("time",data.get("t",0))),14,NativeUI.MUTED)
		if int(record.get("tile",-1))>=0: _button(card,"Go to location",func():workspace.camera.focus_tile(int(record.tile)); workspace.panel.hide())

func _overview() -> void:
	_record_picker()
	NativeUI.label(body,workspace.page,32)
	var actions:=HFlowContainer.new(); body.add_child(actions)
	for action in workspace.page_actions:
		var record:Dictionary=action; _button(actions,str(record.title).capitalize(),func():_all_orders(str(record.id)))
	if workspace.rows.is_empty(): NativeUI.label(body,"No current records.",18,NativeUI.MUTED); return
	for row in workspace.rows:
		var record:Dictionary=row; var card:=_card(body,str(record.label).split(" · ")[0])
		var data:Variant=record.data
		if data is Dictionary:
			for key in data:
				if data[key] is Dictionary or data[key] is Array: continue
				NativeUI.label(card,workspace._pretty(key)+"   "+str(data[key]),16,NativeUI.MUTED)
		elif data is Array:
			for entry in data:
				if entry is Dictionary: NativeUI.label(card,str(entry.get("text",entry.get("name",entry.get("status","")))),16)
		_button(card,"Full details & orders",func():_select_key(record.key); _all_orders())

func _update_values() -> void:
	for item in bindings:
		if is_instance_valid(item.label): item.label.text=str((item["get"] as Callable).call())

func _process(dt:float) -> void:
	if not visible or not workspace.panel.visible: return
	elapsed+=dt
	if elapsed>.5: elapsed=0; sync()
