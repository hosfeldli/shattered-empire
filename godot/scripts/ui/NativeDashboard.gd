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
var city_tab:="Overview"
var build_group:="City"
var thumbnail_jobs:Array=[]
var research_query:=""
var research_filter:=0
var research_era:=-1
var research_graph:NativeResearchTree

func setup(owner_:NativeWorkspace) -> void:
	workspace=owner_; world=owner_.world
	size_flags_horizontal=Control.SIZE_EXPAND_FILL; size_flags_vertical=Control.SIZE_EXPAND_FILL
	scroll=ScrollContainer.new(); scroll.size_flags_vertical=Control.SIZE_EXPAND_FILL; scroll.horizontal_scroll_mode=ScrollContainer.SCROLL_MODE_DISABLED; add_child(scroll)
	body=VBoxContainer.new(); body.size_flags_horizontal=Control.SIZE_EXPAND_FILL; body.add_theme_constant_override("separation",10); scroll.add_child(body)

func sync() -> void:
	var ids:Array=workspace.rows.map(func(row):return row.key)
	var key:Variant=workspace.current.get("key")
	var layout:Variant=[]
	if workspace.page in ["Cities"]: layout=_data().get("gov",{}).get("proposals",[]).map(func(item):return item.id)
	elif workspace.page=="Resources": layout=[_data().get("actions",[]),_data().get("consumers",[]).map(func(item):return item.get("type")),_data().get("producers",[]).map(func(item):return item.get("count",item.get("n",0)))]
	if workspace.page=="Rivals": layout=workspace.rows.map(func(row):return row.data)
	if workspace.page=="Research": layout=world.econ.get("queue",[])
	if workspace.page=="Construction": layout=[world.econ.get("age",0),world.econ.get("techs",[])]
	var next:=str([workspace.page,workspace.expanded,city_tab,ids,null if workspace.page=="Research" and workspace.expanded else key,layout])
	if signature!=next:
		signature=next; _build()
	_update_values()

func _card(parent:Node,title:String) -> VBoxContainer:
	var panel:=PanelContainer.new(); panel.add_theme_stylebox_override("panel",NativeUI.style(Color("1c292f"),Color("36464b"),9)); panel.size_flags_horizontal=Control.SIZE_EXPAND_FILL; parent.add_child(panel)
	var column:=VBoxContainer.new(); panel.add_child(column)
	if not title.is_empty(): NativeUI.label(column,title.to_upper(),13,NativeUI.GOLD)
	return column

func _bind(parent:Node,getter:Callable,size_:=17,color:=NativeUI.TEXT) -> Label:
	var label:=NativeUI.label(parent,"",size_,color); bindings.append({"label":label,"get":getter}); return label

func _metric(parent:Node,title:String,getter:Callable) -> void:
	var column:=_card(parent,title); _bind(column,getter,22)

func _button(parent:Node,title:String,action:Callable,primary:=false) -> Button:
	var button:=NativeUI.compact_button(parent,title,action)
	if primary:
		button.add_theme_stylebox_override("normal",NativeUI.style(Color("d0af6c"),Color("e5c687"),6)); button.add_theme_color_override("font_color",Color("142026")); button.add_theme_color_override("font_hover_color",Color("142026"))
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
	if action_id.is_empty(): workspace.show_all_orders(true)
	else: workspace.focus_order(action_id)

func _record_picker() -> void:
	if workspace.rows.is_empty(): return
	var choices:=[]
	for row in workspace.rows: choices.append([row.key,str(row.label).split(" · ")[0]])
	var picker:=NativeUI.options(body,choices)
	for index in picker.item_count:
		if picker.get_item_metadata(index)==workspace.current.get("key"): picker.select(index)
	picker.item_selected.connect(func(index):workspace._choose(index))

func _build() -> void:
	NativeUI.clear(body); bindings.clear(); response_panel=null; thumbnail_jobs.clear()
	var related:={"Buildings":["Buildings","Production","Cities"],"Military":["Military","Armies","Formations","Air","Strategic"],"Armies":["Military","Armies","Formations","Air","Strategic"],"Air":["Military","Armies","Air","Strategic"],"Economy":["Economy","Resources","Logistics"],"Resources":["Economy","Resources","Logistics"],"Alerts":["Alerts","Battles","History"]}
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
		"Armies": _armies()
		"Military","Formations","Air": _forces()
		"Rivals": _rivals()
		"Strategic": _strategic()
		"Battles": _battles()
		"Alerts","History": _events()
		_: _overview()
	if not workspace.last_reply.is_empty(): show_response(workspace.last_reply)

func show_response(reply:Dictionary) -> void:
	if is_instance_valid(response_panel): body.remove_child(response_panel); response_panel.queue_free()
	response_panel=null
	if reply.get("error")==null and not reply.has("plan") and not reply.has("preview"): return
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


func _economy() -> void:
	var resources:=_card(body,"Stockpiles · net per second")
	for good in GameHUD.GOODS:
		var key:String=good
		var row:=HBoxContainer.new(); resources.add_child(row)
		var button:=_button(row,str(world.defs.get("GOOD_NAMES",{}).get(key,key.capitalize())),func():workspace.open_page("Resources"); _select_key(key))
		button.size_flags_horizontal=Control.SIZE_EXPAND_FILL; button.alignment=HORIZONTAL_ALIGNMENT_LEFT
		_bind(row,func():return "%s   %+.1f"%[_number(world.econ.get("res",{}).get(key,0)),float(world.econ.get("rates",{}).get(key,0))],16)
	var power:=_card(body,"Infrastructure")
	_bind(power,func():return "Power %d generated / %d used · Storage %s"%[int(world.econ.get("power",{}).get("gen",0)),int(world.econ.get("power",{}).get("use",0)),str(world.econ.get("storage",0))],16)
	_button(power,"Inspect supply network",func():workspace.open_page("Logistics"))
	_button(power,"Spending breakdown",func():_all_orders())

func _select_key(key:Variant) -> void:
	for index in workspace.rows.size():
		if workspace.rows[index].key==key: workspace._choose(index); return

func _resource() -> void:
	_record_picker()
	_bind(body,func():return str(_data().get("title","Resource")),22)
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
		var button:=_button(advice,str(record.get("label","Review")),func():_resource_action(record))
		button.disabled=bool(record.get("disabled",false)); button.tooltip_text=str(record.get("why",""))
	var chains:=HBoxContainer.new(); body.add_child(chains)
	for category in ["producers","consumers"]:
		var card:=_card(chains,category)
		for record in _data().get(category,[]):
			NativeUI.label(card,str(record.get("name",record.get("type",""))),18)
			NativeUI.label(card,"%s facilities · %s / sec"%[str(record.get("count",record.get("n",0))),str(record.get("rate",record.get("output",0)))],14,NativeUI.MUTED)

func _resource_action(record:Dictionary) -> void:
	match str(record.get("a","")):
		"build","housing": workspace.tools.activate("build",record.get("type","house")); workspace.panel.hide()
		"inspect": workspace.open_page("Resources"); _select_key(record.get("good",""))
		"locate":
			for building in world.buildings.values():
				if int(building.o)==world.civ_id and building.ty==record.get("type"):
					workspace.settlements.selected_building=int(building.id); workspace.camera.focus_tile(int(building.t)); workspace.panel.hide(); return
		"find":
			var type:=str(record.get("type","mine")); var deposits:={"mine":[2,3],"oil_well":[1],"quarry":[5],"salvage":[7]}
			var nearest:=-1; var distance:=INF
			for tile in world.grid.n:
				if world.known[tile]==0: continue
				var biome:=world.biome(tile); var terrains:Array=world.defs.get("TERRAIN",[])
				var suitable:bool=world.deposit(tile) in deposits.get(type,[]) or type=="lumber" and biome<terrains.size() and str(terrains[biome].get("name","")).to_lower().contains("forest")
				if not suitable: continue
				var point:=world.grid.center(tile); var d:=Vector2(world.grid.dx_wrap(workspace.camera.focus.x,point.x),point.y-workspace.camera.focus.z).length_squared()
				if d<distance: nearest=tile; distance=d
			if nearest>=0: workspace.camera.focus_tile(nearest,16); workspace.panel.hide()
			else: workspace.feedback.call("No suitable deposit is known. Explore more terrain.",false)
		"research": workspace._dispatch({"c":"researchQueue","op":"goal","tech":record.get("tech")})
		_: _all_orders()

func _city() -> void:
	_record_picker()
	if workspace.current.is_empty(): NativeUI.label(body,"No cities to manage yet.",22); return
	var tabs:=HFlowContainer.new(); body.add_child(tabs)
	for section in ["Overview","Development","Buildings"]:
		var target:String=section
		_button(tabs,target,func():city_tab=target; signature=""; sync(),target==city_tab)
	match city_tab:
		"Overview":
			var stats:=GridContainer.new(); stats.columns=2; body.add_child(stats)
			_metric(stats,"Population",func():return _number(_data().get("pop",0)))
			_metric(stats,"Housing",func():return _number(_data().get("h",0)))
			_metric(stats,"Stability",func():return "%d%%"%int(_data().get("st",0)))
			_metric(stats,"Growth / minute",func():return "%+.1f"%float(_data().get("gr",0)))
			var conditions:=_card(body,"City conditions")
			_bind(conditions,func():return "Labor force %s · Unemployed %s\nAvailable recruits %s\n%s"%[_number(_data().get("lab",0)),_number(_data().get("un",0)),_number(_data().get("rec",0)),"Isolated from the supply network" if int(_data().get("iso",0)) else "Connected to the supply network"],16)
			_bind(conditions,func():return CityPresentation.work(world,_data()),15,NativeUI.MUTED)
			_button(body,"Center on city",workspace._center_current)
		"Development":
			NativeUI.label(body,"Routine staffing, repairs and basic needs are managed locally. Choose the city's development priority.",16,NativeUI.MUTED)
			var automatic:=CheckButton.new(); automatic.text="Automatic development"; automatic.button_pressed=bool(_data().get("development",{}).get("on",true)); body.add_child(automatic)
			NativeUI.label(body,"Development priority",14,NativeUI.GOLD)
			var priority:=NativeUI.options(body,[["balanced","Balanced"],["industry","Industry"],["agriculture","Agriculture"],["military","Military"]])
			for index in priority.item_count:
				if priority.get_item_metadata(index)==_data().get("development",{}).get("priority","balanced"): priority.select(index)
			var city_id:=int(workspace.current.key)
			var save:=func():workspace._dispatch({"c":"cityDevelopment","city":city_id,"on":automatic.button_pressed,"priority":NativeUI.value(priority)})
			automatic.toggled.connect(func(_on):save.call()); priority.item_selected.connect(func(_index):save.call())
			_button(body,"Suggest next construction",func():_action("city_plan",{"city":city_id}))
		"Buildings":
			for building in world.buildings.values():
				if int(building.get("c",-1))!=int(workspace.current.key): continue
				var id:=int(building.id)
				var card:=_card(body,"")
				var row:=HBoxContainer.new(); card.add_child(row)
				var label:=NativeUI.label(row,workspace._name("BUILDINGS",building.ty),17); label.size_flags_horizontal=Control.SIZE_EXPAND_FILL
				_button(row,"Inspect",func():workspace.settlements.selected_building=id; workspace.open_page("Buildings"))
				_bind(card,func():return str(world.buildings.get(id,{}).get("w","Working") if world.buildings.get(id,{}).get("d",0) else "Under construction"),14,NativeUI.MUTED)

func _rivals() -> void:
	NativeUI.label(body,"Beyond your borders",24)
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
	var model:=ResearchPresentation.new(world)
	var progress:=_card(body,"Current research")
	_bind(progress,func():return workspace._name("TECHS",world.econ.get("research","Choose a technology")),21)
	_bind(progress,func():return model.estimate(str(world.econ.get("research","")))+" · %.2f points / sec"%float(world.econ.get("researchRate",0)),15,NativeUI.MUTED)
	if not world.econ.get("queue",[]).is_empty():
		var queue:=_card(body,"Research queue")
		var queue_scroll:=ScrollContainer.new(); queue_scroll.custom_minimum_size.y=mini(world.econ.queue.size()*36,100); queue_scroll.horizontal_scroll_mode=ScrollContainer.SCROLL_MODE_DISABLED; queue.add_child(queue_scroll)
		var queue_list:=VBoxContainer.new(); queue_list.size_flags_horizontal=Control.SIZE_EXPAND_FILL; queue_scroll.add_child(queue_list)
		for technology in world.econ.queue:
			var key:String=technology; var row:=HBoxContainer.new(); queue_list.add_child(row)
			var name_:=NativeUI.label(row,workspace._name("TECHS",key),16); name_.size_flags_horizontal=Control.SIZE_EXPAND_FILL
			_button(row,"First",func():_action("research_front",{"tech":key}))
			_button(row,"Remove",func():_action("research_remove",{"tech":key}))
	if not workspace.expanded:
		_button(body,"Open technology tree",func():workspace.set_expanded(true))
		_record_picker()
		research_details=_card(body,"Selected technology")
	else:
		var tools:=HFlowContainer.new(); body.add_child(tools)
		var search:=LineEdit.new(); search.custom_minimum_size=Vector2(220,34); search.placeholder_text="Find a technology or unlock…"; search.text=research_query; tools.add_child(search)
		var filter:=NativeUI.options(tools,[[0,"Available now"],[1,"All technologies"],[2,"Completed"]]); filter.select(research_filter)
		var eras:=[[ -1,"All eras"]]
		for age:Dictionary in world.defs.get("AGES",[]): eras.append([int(age.id),str(age.name)])
		var era_choice:=NativeUI.options(tools,eras); era_choice.select(research_era+1)
		var columns:=HSplitContainer.new(); columns.custom_minimum_size.y=370; body.add_child(columns)
		var graph_scroll:=ScrollContainer.new(); graph_scroll.size_flags_horizontal=Control.SIZE_EXPAND_FILL; graph_scroll.custom_minimum_size.x=320; columns.add_child(graph_scroll)
		research_graph=NativeResearchTree.new(); research_graph.setup(world); graph_scroll.add_child(research_graph)
		research_graph.selected=str(workspace.current.get("key","")); research_graph.configure(research_query,research_filter,research_era)
		research_details=_card(columns,"Technology"); research_details.custom_minimum_size.x=260; research_details.size_flags_horizontal=Control.SIZE_FILL
		research_graph.technology_selected.connect(func(key):_select_key(key); _research_detail())
		search.text_changed.connect(func(text):research_query=text; research_graph.configure(research_query,research_filter,research_era))
		filter.item_selected.connect(func(index):research_filter=index; research_graph.configure(research_query,research_filter,research_era))
		era_choice.item_selected.connect(func(index):research_era=int(era_choice.get_item_metadata(index)); research_graph.configure(research_query,research_filter,research_era))
	_research_detail()

func _number(value:Variant) -> String:
	if value is int or value is float:
		var amount:=float(value)
		return str(roundi(amount)) if is_equal_approx(amount,roundf(amount)) else str(snappedf(amount,.1))
	return str(value) if value!=null else "—"

func _research_detail() -> void:
	if not is_instance_valid(research_details): return
	NativeUI.clear(research_details)
	var key:=str(workspace.current.get("key","")); var info:Dictionary=world.defs.get("TECHS",{}).get(key,{})
	var model:=ResearchPresentation.new(world)
	if info.is_empty(): NativeUI.label(research_details,"Choose a technology to see its unlocks and research path.",18); return
	NativeUI.label(research_details,str(info.get("name","Choose a technology")),25)
	NativeUI.label(research_details,str(info.get("desc","")),17,NativeUI.MUTED)
	NativeUI.label(research_details,model.status(key)+" · %s points"%str(info.get("cost",0)),15,NativeUI.GOLD)
	var unlocks:=model.unlocks(key)
	if not unlocks.is_empty():
		NativeUI.label(research_details,"UNLOCKS",12,NativeUI.GOLD)
		for item in unlocks: NativeUI.label(research_details,"• "+item,16)
	if not info.get("req",[]).is_empty(): NativeUI.label(research_details,"PREREQUISITES · CLICK TO INSPECT",12,NativeUI.MUTED)
	for prerequisite in info.get("req",[]):
		var target:String=prerequisite
		_button(research_details,("✓ " if target in world.econ.get("techs",[]) else "→ ")+workspace._name("TECHS",target),func():
			_select_key(target); _research_detail()
			if is_instance_valid(research_graph): research_graph.selected=target; research_graph.queue_redraw())
	NativeUI.label(research_details,model.estimate(key)+" at current output",14,NativeUI.MUTED)
	var complete:bool=key in world.econ.get("techs",[])
	var active:bool=world.econ.get("research")==key; var queued:bool=key in world.econ.get("queue",[])
	if model.ready(key):
		_button(research_details,"Researching" if active else "Start research",func():_action("research_now",{"tech":key}),true).disabled=active or complete
		_button(research_details,"Queued" if queued else "Queue next",func():_action("research_add",{"tech":key})).disabled=complete or active or queued
	elif not complete:
		var path:=model.path(key)
		NativeUI.label(research_details,"%d technologies on this path. The queue handles prerequisites in order; later eras must still be reached."%path.size(),14,NativeUI.MUTED)
		_button(research_details,"Queued" if queued else "Queue prerequisites & goal",func():_action("research_goal",{"tech":key}),true).disabled=queued

func _building() -> void:
	_record_picker()
	if workspace.current.is_empty(): NativeUI.label(body,"Select a facility to manage production.",24); return
	var data:=_data(); var type:=str(data.get("ty","")); var def:Dictionary=world.defs.get("BUILDINGS",{}).get(type,{})
	NativeUI.label(body,str(def.get("name",type)),24)
	_bind(body,func():return "%s · level %s · health %s%% · workers %s"%[str(_data().get("st","Operational")).capitalize(),str(_data().get("lv",1)),str(_data().get("hp",100)),str(_data().get("s",0))],17,NativeUI.MUTED)
	var choices:=HFlowContainer.new(); body.add_child(choices)
	for pair in [["Upgrade","upgrade"],["Repair","repair"],["Fund this site next","fund_next"]]:
		var action_id:String=pair[1]; _button(choices,pair[0],func():_action(action_id,{"building":int(workspace.current.key)}))
	var catalog:=GridContainer.new(); catalog.columns=1; catalog.add_theme_constant_override("h_separation",12); catalog.add_theme_constant_override("v_separation",12); body.add_child(catalog)
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
	var search:=LineEdit.new(); search.placeholder_text="Find a building…"; body.add_child(search)
	var catalog:=VBoxContainer.new(); catalog.add_theme_constant_override("separation",5); body.add_child(catalog)
	search.text_changed.connect(func(_value):_build_catalog(catalog,search.text,build_group)); _build_catalog(catalog,"",build_group)

func _build_group(type:String) -> String:
	if type in ["house","town","market","academy","university","port","comms_tower","wonder"]: return "City"
	if type in ["farm","lumber","mine","quarry","oil_well","salvage"]: return "Resources"
	var definition:Dictionary=world.defs.BUILDINGS[type]
	if definition.has("trains") or type in ["fort","bunker","guard_post","aa_battery","missile_silo","shield_generator","depot"]: return "Defense"
	return "Industry"

func _build_catalog(catalog:VBoxContainer,query:String,category:String) -> void:
	NativeUI.clear(catalog); thumbnail_jobs.clear()
	for group in ["City","Resources","Industry","Roads","Defense"]:
		var section:String=group
		var open:bool=category==group or not query.is_empty()
		var heading:=_button(catalog,("▾ " if open else "▸ ")+group,func():build_group="" if build_group==section else section; _build_catalog(catalog,query,build_group),open)
		heading.alignment=HORIZONTAL_ALIGNMENT_LEFT
		if open:
			heading.add_theme_stylebox_override("normal",NativeUI.style(Color("2b4052"),Color("53738d"),6))
			heading.add_theme_color_override("font_color",NativeUI.TEXT)
		if not open: continue
		if group=="Roads":
			var road:=NativeUI.options(catalog,[[1,"Dirt road"],[2,"Paved road"],[3,"Highway"],[4,"Railway"]])
			_button(catalog,"Draw road",func():workspace.tools.activate("road",NativeUI.value(road)); workspace.panel.hide())
			var bridges:=[]
			for key in world.defs.get("BRIDGE_CLASSES",{}): bridges.append([key,str(world.defs.BRIDGE_CLASSES[key].get("name",key))])
			var bridge:=NativeUI.options(catalog,bridges)
			_button(catalog,"Draw bridge between banks",func():workspace.tools.activate("bridge",NativeUI.value(bridge)); workspace.panel.hide())
		if group=="Defense":
			var trench:=NativeUI.options(catalog,[["basic","Basic trench"],["reinforced","Reinforced trench"]])
			_button(catalog,"Draw trench line",func():workspace.tools.activate("trench",NativeUI.value(trench)); workspace.panel.hide())
		for type in world.defs.get("BUILDINGS",{}):
			var key:String=type; var definition:Dictionary=world.defs.BUILDINGS[key]
			if type=="town" or definition.get("obsolete",false) or definition.get("rebelOnly",false) or _build_group(key)!=group: continue
			var name_:=str(definition.get("name",key))
			if not query.is_empty() and not query.to_lower() in name_.to_lower(): continue
			var tech:=str(definition.get("tech",""))
			var unlocked:bool=int(definition.get("age",0))<=int(world.econ.get("age",0)) and (tech.is_empty() or tech in world.econ.get("techs",[]))
			if not unlocked and query.is_empty(): continue
			var button:=_button(catalog,"",func():workspace.tools.activate("build",key); workspace.panel.hide())
			button.custom_minimum_size.y=62; button.disabled=not unlocked
			var row:=HBoxContainer.new(); row.mouse_filter=Control.MOUSE_FILTER_IGNORE; button.add_child(row)
			row.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); row.offset_left=5; row.offset_right=-5; row.offset_top=3; row.offset_bottom=-3
			var thumbnail:=NativeModelThumbnail.new(); thumbnail.custom_minimum_size=Vector2(64,48); row.add_child(thumbnail)
			var text:=VBoxContainer.new(); text.mouse_filter=Control.MOUSE_FILTER_IGNORE; text.size_flags_horizontal=Control.SIZE_EXPAND_FILL; text.add_theme_constant_override("separation",0); row.add_child(text)
			NativeUI.label(text,name_,16).mouse_filter=Control.MOUSE_FILTER_IGNORE
			NativeUI.label(text,_cost(definition.get("cost",{})) if unlocked else "Requires "+workspace._name("TECHS",tech) if not tech.is_empty() else "Requires a later era",12,NativeUI.MUTED).mouse_filter=Control.MOUSE_FILTER_IGNORE
			button.tooltip_text="Place "+name_+" on the map" if unlocked else "Requires "+workspace._name("TECHS",tech) if not tech.is_empty() else "Requires a later era"
			thumbnail_jobs.append(func():
				if is_instance_valid(thumbnail): thumbnail.setup(workspace.settlements.preview_mesh(key,world.start_tile,false)))

func _armies() -> void:
	var armies:Array=world.econ.get("armies",[])
	if armies.is_empty():
		NativeUI.label(body,"No armies yet. Select troops and press G to organize an army.",17,NativeUI.MUTED)
		_button(body,"Form army from selection · G",func():workspace.commands.issue("army_create",{"units":workspace.input_ref._owned_units(),"name":"Field army"})).disabled=workspace.input_ref._owned_units().is_empty()
	for record in armies:
		var army:Dictionary=record
		var card:=_card(body,"")
		_button(card,str(army.name),func():
			workspace.input_ref.cancel(); workspace.input_ref.selected_army=int(army.id)
			for id in army.get("units",[]):
				if world.units.has(int(id)): workspace.military.selected[int(id)]=true
			workspace.panel.hide(); workspace.input_ref.selection_changed.emit())
		NativeUI.label(card,"%s · %d units\n%s"%[str(army.get("order",{}).get("kind","Hold")).capitalize(),army.get("units",[]).size(),str(army.get("status","Ready"))],15,NativeUI.MUTED)
	_button(body,"Advanced army orders…",func():_all_orders())

func _forces() -> void:
	_record_picker()
	_bind(body,func():return "%d units · %d armies · %d formations"%[world.units.values().filter(func(unit):return int(unit.owner)==world.civ_id).size(),world.econ.get("armies",[]).size(),world.econ.get("formations",[]).size()],15,NativeUI.MUTED)
	var status:=_card(body,"Selected force")
	_bind(status,func():return str(_data().get("name",str(workspace.current.get("label","Select a force on the map")).split(" · ")[0])),21)
	_bind(status,func():return "Health %s%% · Supply %s%%\nStatus: %s"%[str(_data().get("hp","—")),str(_data().get("supply",_data().get("sup","—"))),str(_data().get("status",_data().get("stance","—")))],16,NativeUI.MUTED)
	_button(status,"Select on map",workspace._select_current)
	var main:={"Military":["move","attack_move","hold"],"Armies":["army_move","army_defend","army_offensive"],"Formations":["formation_deploy","formation_rejoin","formation_shift"],"Air":["air_strike","air_patrol","air_return"]}
	var flow:=HFlowContainer.new(); body.add_child(flow)
	var extra:=[]
	for action in workspace.page_actions:
		var record:Dictionary=action
		var label:=str(record.title).capitalize()
		if record.id in main.get(workspace.page,[]): _button(flow,label+"…",func():_all_orders(str(record.id)))
		else: extra.append({"label":label+"…","action":func():_all_orders(str(record.id))})
	if not extra.is_empty(): NativeUI.menu(body,"Other military orders ▾",extra)

func _strategic() -> void:
	NativeUI.label(body,"Strategic forces",24)
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
	NativeUI.label(body,"Active engagements",24)
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
	NativeUI.label(body,"Situation reports" if workspace.page=="Alerts" else "Command chronicle",24)
	NativeUI.label(body,"Select an event to return to its location. Reports contain information received by your civilization.",16,NativeUI.MUTED)
	for row in workspace.rows:
		var record:Dictionary=row; var data:Dictionary=row.data
		var card:=_card(body,str(data.get("kind",data.get("by","Report"))))
		NativeUI.label(card,str(data.get("text",data.get("label",row.label))),18)
		NativeUI.label(card,"Time "+str(data.get("time",data.get("t",0))),14,NativeUI.MUTED)
		if int(record.get("tile",-1))>=0: _button(card,"Go to location",func():workspace.camera.focus_tile(int(record.tile)); workspace.panel.hide())

func _overview() -> void:
	_record_picker()
	NativeUI.label(body,workspace.page,24)
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
	if not thumbnail_jobs.is_empty(): (thumbnail_jobs.pop_front() as Callable).call()
	elapsed+=dt
	if elapsed>.5: elapsed=0; sync()
