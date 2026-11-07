class_name NativeWorkspace
extends CanvasLayer
## Typed native system workspaces. Commands use existing authoritative server contracts.
const PAGES:=["Economy","Resources","Cities","Buildings","Production","Construction","Research","Military","Armies","Formations","Logistics","Air","Strategic","Rivals","Battles","Alerts","History","Observer","Sandbox"]
const NAMES:={"n":"Name","ty":"Building type","t":"Location","o":"Owner","h":"Housing","st":"Condition","un":"Unemployed","fs":"Food shortage","rsv":"Reserved recruits","lab":"Labor force","rec":"Recruitable population","gr":"Growth per minute","ua":"Unassigned workers","wf":"Workforce","iso":"Isolated","fr":"Freight capacity","ship":"Goods shipped","gov":"Governor","dmg":"City damage","ti":"Development tier","s":"Workers assigned","w":"Production constraint","lk":"Worker lock","off":"Switched off","q":"Training queue","rp":"Repeat production","ra":"Rally army","r":"Rally point / radius","pr":"Production per second","mi":"Ready missiles","mp":"Missile construction %","hp":"Health %","d":"Complete","p":"Construction %","a":"Active","f":"On fire","c":"City","cr":"Construction crews","qw":"Waiting for","tr":"Training progress %","lv":"Level","res":"Stockpiles","rates":"Net change per second","cmdlog":"Command history","techs":"Completed technologies"}
var commands:CommandRegistry
var world:WorldState
var net:NetworkClient
var camera:CameraController
var settlements:SettlementRenderer
var military:MilitaryRenderer
var tools:NativeCommandTools
var input_ref:InputController
var panel:PanelContainer
var sidebar:NativeSectionNav
var records:ItemList
var filter:LineEdit
var heading:Label
var summary:Label
var detail:Tree
var reply_tree:Tree
var action_list:OptionButton
var fields_box:VBoxContainer
var action_hint:Label
var execute:Button
var preview_button:Button
var feedback:Callable
var page:="Economy"
var actions:Array=[]
var page_actions:Array=[]
var rows:Array=[]
var current:={}
var controls:={}
var draft:={}
var active_action:={}
var last_reply:={}
var _records_signature:=""
var _detail_signature:=""
var timer:=0.0
var confirm:ConfirmationDialog
var pending:={}
var busy:=false
var dashboard:NativeDashboard
var inspector_view:VBoxContainer
var orders_toggle:Button
var selected_city:=-1
var expanded:=false
var expand_button:Button
var records_context:VBoxContainer
var pending_scenario_units:Array=[]

func setup(w:WorldState,n:NetworkClient,cam:CameraController,s:SettlementRenderer,m:MilitaryRenderer,report:Callable) -> void:
	world=w; net=n; camera=cam; settlements=s; military=m; feedback=report; layer=30
	actions=commands.actions if commands else JSON.parse_string(FileAccess.get_file_as_string("res://recipes/ui_actions.json"))
	panel=PanelContainer.new(); panel.theme=NativeUI.theme(); panel.visible=false; add_child(panel)
	panel.mouse_force_pass_scroll_events=false
	var outer:=VBoxContainer.new(); panel.add_child(outer)
	var top:=HBoxContainer.new(); outer.add_child(top)
	heading=NativeUI.label(top,"Empire",19,NativeUI.TEXT); heading.size_flags_horizontal=Control.SIZE_EXPAND_FILL
	heading.add_theme_font_override("font",load("res://assets/fonts/BarlowSemiCondensed-SemiBold.ttf"))
	expand_button=NativeUI.compact_button(top,"Expand",func():set_expanded(not expanded),"Enlarge this panel for planning; the map remains interactive")
	NativeUI.icon_button(top,"close","Close · Escape",func():panel.hide(),28)
	var body:=VBoxContainer.new(); body.size_flags_vertical=Control.SIZE_EXPAND_FILL; outer.add_child(body)
	sidebar=NativeSectionNav.new(); sidebar.setup(PAGES); body.add_child(sidebar); sidebar.hide()
	sidebar.page_selected.connect(open_page)
	var host:=VBoxContainer.new(); host.size_flags_horizontal=Control.SIZE_EXPAND_FILL; body.add_child(host)
	host.size_flags_vertical=Control.SIZE_EXPAND_FILL
	orders_toggle=NativeUI.compact_button(outer,"More options…",func():show_all_orders(not inspector_view.visible),"Every command and parameter for this panel")
	var editor_scroll:=ScrollContainer.new(); editor_scroll.size_flags_vertical=Control.SIZE_EXPAND_FILL; editor_scroll.horizontal_scroll_mode=ScrollContainer.SCROLL_MODE_DISABLED; host.add_child(editor_scroll)
	var main:=VBoxContainer.new(); main.size_flags_horizontal=Control.SIZE_EXPAND_FILL; editor_scroll.add_child(main); inspector_view=main
	records_context=VBoxContainer.new(); main.add_child(records_context)
	filter=LineEdit.new(); filter.placeholder_text="Filter records…"; records_context.add_child(filter)
	filter.text_changed.connect(func(_value):_records_signature=""; _refresh())
	summary=NativeUI.label(records_context,"",14,NativeUI.MUTED)
	var left:=VBoxContainer.new(); left.size_flags_horizontal=Control.SIZE_EXPAND_FILL; records_context.add_child(left)
	records=ItemList.new(); records.custom_minimum_size.y=110; records.select_mode=ItemList.SELECT_MULTI; left.add_child(records)
	records.multi_selected.connect(func(index,_selected):_choose(index))
	records.item_activated.connect(func(index):_choose(index); _center_current())
	var buttons:=HBoxContainer.new(); left.add_child(buttons)
	NativeUI.compact_button(buttons,"Center on map",_center_current); NativeUI.compact_button(buttons,"Select on map",_select_current)
	detail=_tree(left); detail.custom_minimum_size.y=150; detail.hide()
	NativeUI.compact_button(left,"Inspect record details",func():detail.visible=not detail.visible)
	var right:=VBoxContainer.new(); right.size_flags_horizontal=Control.SIZE_EXPAND_FILL; main.add_child(right)
	NativeUI.label(right,"CHOOSE AN ORDER",13,NativeUI.GOLD)
	action_list=OptionButton.new(); action_list.custom_minimum_size.y=38; action_list.fit_to_longest_item=false; action_list.clip_text=true; right.add_child(action_list)
	action_list.item_selected.connect(func(index):_set_action(page_actions[index]))
	fields_box=VBoxContainer.new(); right.add_child(fields_box)
	action_hint=NativeUI.label(right,"",14,NativeUI.MUTED)
	preview_button=NativeUI.button(right,"Preview costs / effects",func():_perform(true))
	execute=NativeUI.button(right,"Issue order",func():_perform(false))
	reply_tree=_tree(right); reply_tree.custom_minimum_size.y=150; reply_tree.hide()
	confirm=ConfirmationDialog.new(); confirm.title="Confirm order"; add_child(confirm)
	confirm.theme=panel.theme
	confirm.confirmed.connect(func():_dispatch(pending))
	dashboard=NativeDashboard.new(); host.add_child(dashboard); dashboard.setup(self)
	show_all_orders(false)
	world.welcomed.connect(_reset); world.reset.connect(_reset)
	world.snapshot_applied.connect(_select_scenario_units)

func _reset() -> void:
	current.clear(); last_reply.clear(); pending_scenario_units.clear(); selected_city=-1; _records_signature=""; busy=false
	if panel.visible: open_page(page)

func open_page(title:String) -> void:
	if title=="World": panel.hide(); return
	var aliases:={"Forces":"Military","Build":"Construction","Chronicle":"Alerts","Workforce":"Cities","Governors":"Cities"}
	page=str(aliases.get(title,title))
	if not page in PAGES: page="Economy"
	expanded=page=="Research"
	panel.show(); sidebar.select(PAGES.find(page)); filter.text=""; current.clear(); last_reply.clear(); reply_tree.hide()
	records.clear()
	if page in ["Buildings","Production"] and settlements.selected_building>=0: current={"key":settlements.selected_building}
	if page=="Research":
		var model:=ResearchPresentation.new(world)
		var key:String=str(world.econ.get("research","")) if world.econ.get("research")!=null else ""
		if key.is_empty():
			for technology:String in world.defs.get("TECHS",{}):
				if model.ready(technology): key=technology; break
		if not key.is_empty(): current={"key":key}
	if page in ["Cities"] and world.buildings.has(settlements.selected_building): current={"key":world.buildings[settlements.selected_building].get("c",-1)}
	elif page in ["Cities"] and selected_city>=0: current={"key":selected_city}
	heading.text="Build" if page=="Construction" else "Chronicle" if page=="Alerts" else page; _records_signature=""; _detail_signature=""
	page_actions=actions.filter(func(action):return action.page==page)
	action_list.clear()
	for action in page_actions: action_list.add_item(str(action.title).capitalize())
	_refresh()
	if not page_actions.is_empty(): _set_action(page_actions[0])
	else:
		active_action={}; NativeUI.clear(fields_box); execute.hide(); preview_button.hide(); action_hint.text="Select a record to inspect its current state."
	_fill_tree(reply_tree,{}); _refresh()
	if dashboard: dashboard.signature=""; dashboard.sync(); show_all_orders(false)

func show_all_orders(on:bool) -> void:
	if on: expanded=false
	inspector_view.visible=on
	inspector_view.get_parent().visible=on
	records_context.show()
	if dashboard: dashboard.visible=not on
	orders_toggle.text="Back" if on else "More options…"

func focus_order(id:String) -> void:
	show_all_orders(true)
	for index in page_actions.size():
		if page_actions[index].id==id:
			action_list.select(index); _set_action(page_actions[index]); records_context.hide(); return

func set_expanded(on:bool) -> void:
	expanded=on
	if dashboard: dashboard.signature=""; dashboard.sync()

func follow_selection() -> void:
	if not panel.visible: return
	var building:Dictionary=world.buildings.get(settlements.selected_building,{})
	var key:Variant=null
	if page=="Cities" and not building.is_empty(): key=building.get("c",-1)
	elif page in ["Buildings","Production"] and not building.is_empty(): key=settlements.selected_building
	elif page in ["Military","Air"] and not military.selected.is_empty(): key=military.selected.keys()[0]
	if key!=null:
		for index in rows.size():
			if rows[index].key==key:
				current=rows[index]; selected_city=int(key) if page=="Cities" else selected_city
				if dashboard: dashboard.signature=""
				_refresh(); return
	if not military.selected.is_empty() or not building.is_empty(): panel.hide()

func _tree(parent:Node) -> Tree:
	var tree:=Tree.new(); tree.columns=2; tree.hide_root=true; tree.size_flags_vertical=Control.SIZE_EXPAND_FILL
	tree.set_column_expand_ratio(0,2); tree.set_column_expand_ratio(1,3); parent.add_child(tree); return tree

func _pretty(key:Variant) -> String: return str(NAMES.get(str(key),str(key).replace("_"," ").capitalize()))

func _fill_tree(tree:Tree,data:Variant) -> void:
	var collapsed:={}
	if tree.get_root()!=null: _remember_tree(tree.get_root(),collapsed)
	tree.clear(); var root_item:=tree.create_item()
	_append_tree(tree,root_item,data,"",0,collapsed)

func _remember_tree(item:TreeItem,state:Dictionary) -> void:
	state[str(item.get_metadata(0))]=item.collapsed
	for child in item.get_children(): _remember_tree(child,state)

func _append_tree(tree:Tree,parent:TreeItem,data:Variant,path:String,depth:int,state:Dictionary) -> void:
	if depth>7: return
	var keys:Array=data.keys() if data is Dictionary else range(data.size()) if data is Array else []
	for key in keys:
		var value:Variant=data[key]; var item:=tree.create_item(parent); var item_path:=path+"/"+str(key); item.set_metadata(0,item_path)
		var title:=_pretty(key) if data is Dictionary else str(key+1)
		if value is Dictionary: title=str(value.get("name",value.get("n",value.get("text",title))))
		item.set_text(0,title)
		if value is Dictionary or value is Array:
			item.set_text(1,"%d entries"%value.size()); item.collapsed=bool(state.get(item_path,depth>0)); _append_tree(tree,item,value,item_path,depth+1,state)
		else:
			var shown:=str(value) if value!=null else "—"
			if value is bool: shown="Yes" if value else "No"
			elif value is float: shown=str(snappedf(value,.01))
			item.set_text(1,shown); item.set_tooltip_text(1,shown)

func _entry(key:Variant,title:String,data:Variant,tile:=-1) -> Dictionary: return {"key":key,"label":title,"data":data,"tile":tile}

func _page_records() -> Array:
	var result:=[]; var econ:=world.econ
	match page:
		"Cities":
			for city in world.cities.values():
				if int(city.o)==world.civ_id or world.spectator: result.append(_entry(city.id,"%s · %d people · %d%% stability"%[city.n,int(city.pop),int(city.get("st",0))],city,int(city.t)))
		"Buildings","Production":
			for building in world.buildings.values():
				if int(building.o)==world.civ_id or world.spectator: result.append(_entry(building.id,"%s #%d · %s · %d%% HP"%[_name("BUILDINGS",building.ty),int(building.id),str(building.st),int(building.hp)],building,int(building.t)))
		"Research":
			for key in world.defs.get("TECHS",{}):
				var info:Dictionary=world.defs.TECHS[key].duplicate(true)
				info.status="Complete" if key in econ.get("techs",[]) else "Researching" if econ.get("research")==key else "Queued" if key in econ.get("queue",[]) else "Not researched"
				info.earned_points=econ.get("techProgress",{}).get(key,0); result.append(_entry(key,"%s · %s"%[info.name,info.status],info))
		"Military","Air":
			for unit in world.units.values():
				if int(unit.owner)!=world.civ_id and not world.spectator: continue
				if page=="Air" and not world.defs.get("UNITS",{}).get(unit.type,{}).get("air",false): continue
				result.append(_entry(unit.id,"%s #%d · HP %d%% · supply %d%%"%[_name("UNITS",unit.type),int(unit.id),int(unit.hp),int(unit.get("supply",0))],unit,int(unit.tile)))
		"Armies","Formations":
			for record in econ.get("armies" if page=="Armies" else "formations",[]): result.append(_entry(record.id,str(record.get("name",page+" #"+str(record.id))),record,int(record.get("tile",record.get("t",-1)))))
		"Rivals","Observer":
			for civ in world.civ_by_id.values():
				if page=="Rivals" and int(civ.id)==world.civ_id: continue
				result.append(_entry(civ.id,str(civ.name),civ))
		"Resources":
			for key in econ.get("resources",{}): result.append(_entry(key,_name("GOOD_NAMES",key),econ.resources[key]))
		"Battles":
			for battle in world.battles: result.append(_entry(battle.id,str(battle.get("name","Battle")),battle,int(battle.get("t",-1))))
		"Alerts":
			for index in world.notifications.size():
				var note:Dictionary=world.notifications[index]; result.append(_entry(index,str(note.get("text","Event")),note,int(note.get("tile",-1))))
		"History":
			for index in econ.get("cmdlog",[]).size():
				var record:Dictionary=econ.cmdlog[index]; result.append(_entry(index,str(record.get("text",record.get("label","Order"))),record,int(record.get("tile",-1))))
		_:
			var sections:={"Economy":["res","rates","gross","power","storage","saving","upkeep","ledger"],"Construction":["roads","trenches"],"Logistics":["convoys","caches","logPolicies","command"],"Strategic":["missiles"],"Sandbox":["command","readiness"]}
			for key in sections.get(page,[]): result.append(_entry(key,_pretty(key),{key:econ.get(key)}))
			if page=="Construction": result.append(_entry("ruins","Ruins",world.ruins))
			if page=="Strategic": result.append(_entry("warnings","Missile warnings",world.missiles))
	return result

func _refresh() -> void:
	if world.grid==null: return
	sidebar.set_mode(world.spectator,world.sandbox)
	rows=_page_records().filter(func(row):return filter.text.is_empty() or filter.text.to_lower() in str(row.label).to_lower())
	summary.text="%d records · %d units selected · %d facilities selected · Shift-click to select multiple"%[rows.size(),military.selected.size(),input_ref.selected_buildings.size() if input_ref else 0]
	var signature:=str(rows.map(func(row):return [row.key,row.label]))
	if signature!=_records_signature:
		var selected:=[]
		for index in records.get_selected_items(): selected.append(records.get_item_metadata(index))
		records.clear()
		for row in rows:
			records.add_item(row.label); records.set_item_metadata(records.item_count-1,row.key)
			if row.key in selected: records.select(records.item_count-1,false)
		_records_signature=signature
	if current.is_empty() and not rows.is_empty(): current=rows[0]; records.select(0)
	var found:=false
	for row in rows:
		if row.key==current.get("key"): current=row; found=true; break
	if not found:
		current=rows[0] if not rows.is_empty() else {}
		if not rows.is_empty(): records.select(0)
	var signature_detail:=str(current.get("data",{}))
	if signature_detail!=_detail_signature: _detail_signature=signature_detail; _fill_tree(detail,current.get("data",{}))
	if dashboard and dashboard.visible: dashboard.sync()
	execute.disabled=busy or not world.ready_ or active_action.is_empty() or (world.spectator and active_action.get("audience")!="observer")

func _choose(index:int) -> void:
	if index<0 or index>=rows.size(): return
	current=rows[index]; _detail_signature=""
	if page in ["Cities"]: selected_city=int(current.key)
	if input_ref and page in ["Buildings","Production"]:
		input_ref.selected_buildings.clear(); military.selected.clear()
		for selected in records.get_selected_items(): input_ref.selected_buildings[rows[selected].key]=true
		settlements.selected_building=int(current.key)
	elif page in ["Military","Air"]:
		military.selected.clear(); settlements.selected_building=-1
		if input_ref: input_ref.selected_buildings.clear()
		for selected in records.get_selected_items(): military.selected[rows[selected].key]=true
	if not active_action.is_empty(): draft.clear(); _render_form()
	_refresh()

func _center_current() -> void:
	if int(current.get("tile",-1))>=0: camera.focus_tile(int(current.tile)); panel.hide()

func _select_current() -> void:
	if current.is_empty(): return
	if page in ["Armies","Formations"]:
		military.selected.clear()
		for id in current.data.get("units",[]):
			if world.units.has(int(id)): military.selected[int(id)]=true
	_center_current(); panel.hide()

func _name(catalog:String,key:Variant) -> String:
	var record:Variant=world.defs.get(catalog,{}).get(key,key)
	return str(record.get("name",key)) if record is Dictionary else str(record)

func _set_action(action:Dictionary) -> void:
	active_action=action; draft.clear(); reply_tree.hide(); _render_form()

func _render_form() -> void:
	NativeUI.clear(fields_box); controls.clear()
	for field in active_action.get("fields",[]):
		var row:=NativeUI.field(fields_box,_pretty(field.label)); row.get_child(0).custom_minimum_size.x=110
		var control:Control; var initial:Variant=draft.get(field.key,field.get("default"))
		if field.get("kind")=="bool":
			var toggle:=CheckButton.new(); toggle.button_pressed=bool(initial); control=toggle
		elif field.get("kind")=="number":
			var spin:=SpinBox.new(); spin.min_value=float(field.get("min",0)); spin.max_value=float(field.get("max",100)); spin.step=float(field.get("step",1)); spin.value=float(initial); control=spin
		elif field.get("kind")=="text":
			var edit:=LineEdit.new(); edit.text=str(initial); control=edit
		else:
			var options:Array=[]
			if field.has("source"): options=_options(str(field.source))
			else:
				for choice in field.get("choices",[]): options.append(choice if choice is Array else [choice,str(choice).capitalize()])
			var dropdown:=NativeUI.options(row,options); control=dropdown
			var preferred:Variant=initial if initial!=null else _context().get(field.key)
			for i in dropdown.item_count:
				if dropdown.get_item_metadata(i)==preferred: dropdown.select(i)
			if str(field.key)=="city": dropdown.item_selected.connect(func(_index):_save_draft(); _render_form())
		if control.get_parent()==null: row.add_child(control)
		control.size_flags_horizontal=Control.SIZE_EXPAND_FILL; controls[field.key]=control
	execute.show(); preview_button.visible=active_action.has("preview_command")
	execute.text="Choose target on map" if active_action.has("map") else str(active_action.title).capitalize()
	action_hint.text="Select forces or facilities on the map or in the list. " if active_action.has("requires") else ""
	if active_action.has("map"): action_hint.text+="Choose a location on the map, then Enter confirms the order."
	if active_action.get("audience")=="observer": action_hint.text="Available while watching a match."
	elif active_action.get("audience")=="sandbox": action_hint.text="Available only in the combat sandbox."

func _save_draft() -> void:
	for key in controls: draft[key]=_control_value(controls[key])

func _control_value(control:Control) -> Variant:
	if control is OptionButton: return NativeUI.value(control)
	if control is CheckButton: return control.button_pressed
	if control is SpinBox: return int(control.value) if control.step>=1 else control.value
	if control is LineEdit: return control.text
	return null

func _context() -> Dictionary:
	var units:=military.selected.keys().filter(func(id):return world.units.has(id) and int(world.units[id].owner)==world.civ_id)
	var buildings:=input_ref.selected_buildings.keys() if input_ref else []
	if buildings.is_empty() and settlements.selected_building>=0: buildings=[settlements.selected_building]
	buildings=buildings.filter(func(id):return world.buildings.has(id) and int(world.buildings[id].o)==world.civ_id)
	var context:={"units":units,"buildings":buildings,"building":settlements.selected_building,"unit":units[0] if not units.is_empty() else -1,"map":"@map","tiles":"@tiles","line":"@line","target":"@target"}
	if page in ["Cities"]: context.city=current.get("key",-1)
	elif page in ["Buildings","Production"]: context.building=current.get("key",settlements.selected_building)
	elif page=="Armies": context.army=current.get("key",-1)
	elif page=="Formations": context.formation=current.get("key",-1)
	elif page=="Research": context.tech=current.get("key","")
	elif page in ["Rivals","Observer"]: context.nation=current.get("key",-1); context.civ=current.get("key",-1)
	elif page=="Battles":
		context.battle_tile=int(current.get("tile",-1))
		context.battle_units=world.units.values().filter(func(unit):return int(unit.owner)==world.civ_id and world.grid.dist(int(unit.tile),context.battle_tile)<=6).map(func(unit):return int(unit.id))
	return context

func _options(source:String) -> Array:
	var result:=[]
	match source:
		"cities","buildings","units","colonists","trucks","airbases","airbases_optional","silos","nations","all_nations":
			if source.ends_with("_optional"): result.append([null,"Automatic selection"])
			var data:Dictionary=world.cities if source=="cities" else world.civ_by_id if source in ["nations","all_nations"] else world.units if source in ["units","colonists","trucks"] else world.buildings
			for record in data.values():
				var own:=int(record.get("o",record.get("owner",record.get("id",-1))))==world.civ_id
				if source=="nations" and own: continue
				if not source in ["nations","all_nations"] and not own: continue
				var type:=str(record.get("ty",record.get("type","")))
				if source=="colonists" and type!="colonist": continue
				if source=="trucks" and type!="supply_truck": continue
				var definition:Dictionary=world.defs.get("BUILDINGS",{}).get(type,{})
				if source.begins_with("airbases") and not definition.get("airbase",false): continue
				if source=="silos" and not definition.get("silo",false): continue
				var title:=str(record.get("n",record.get("name",_name("BUILDINGS" if record.has("ty") else "UNITS",type)+" #"+str(record.id))))
				result.append([int(record.id),title])
		"armies","armies_optional","formations","roads","trenches","diplomatic_proposals","governor_proposals":
			if source=="armies_optional": result.append([0,"No army"])
			var raw:Variant=world.econ.get("armies" if source=="armies_optional" else "proposals" if source=="diplomatic_proposals" else source,[])
			var list:Array=raw if raw is Array else raw.get("projects",raw.get("list",[])) if raw is Dictionary else []
			if source=="governor_proposals":
				var city_id:Variant=_control_value(controls.city) if controls.has("city") else _context().get("city",-1)
				list=world.cities.get(int(city_id),{}).get("gov",{}).get("proposals",[])
			for record in list:
				if record is Dictionary: result.append([int(record.get("id",-1)),str(record.get("name",record.get("reason",record.get("text",source.capitalize()+" #"+str(record.get("id",0))))))])
		"queued_tech":
			for key in world.econ.get("queue",[]): result.append([key,_name("TECHS",key)])
		"training_types":
			var building:Variant=_control_value(controls.building) if controls.has("building") else settlements.selected_building
			var types:={}
			var selected:Array=input_ref.selected_buildings.keys() if input_ref else []
			if selected.is_empty(): selected=[building]
			for id in selected:
				for type in world.defs.get("BUILDINGS",{}).get(world.buildings.get(int(id),{}).get("ty",""),{}).get("trains",[]): types[type]=true
			for type in types: result.append([type,_name("UNITS",type)])
		"refit_types":
			var seen:={}
			for id in military.selected:
				for path in world.defs.get("REFIT",{}).get(world.units.get(id,{}).get("type",""),[]): seen[path.to]=true
			for key in seen: result.append([key,_name("UNITS",key)])
		_:
			for key in world.defs.get(source,{}): result.append([key,_name("GOOD_NAMES",key) if source=="IMPORT_PRICE" else _name(source,key)])
	return result

static func bind_command(value:Variant,bindings:Dictionary) -> Variant:
	if value is String and value.begins_with("@"): return bindings.get(value.substr(1),value)
	if value is Dictionary:
		var out:={}
		for key in value: out[key]=bind_command(value[key],bindings)
		return out
	if value is Array: return value.map(func(item):return bind_command(item,bindings))
	return value

func _perform(preview:bool) -> void:
	if active_action.is_empty() or busy: return
	if world.spectator and active_action.get("audience")!="observer": feedback.call("Spectators cannot issue gameplay orders",false); return
	if active_action.get("audience")=="observer" and not world.spectator: feedback.call("Open an observer match to use these controls",false); return
	if active_action.get("audience")=="sandbox" and not world.sandbox: feedback.call("Open the combat sandbox to use these controls",false); return
	var bindings:=_context()
	for key in controls:
		bindings[key]=_control_value(controls[key])
		if bindings[key]==null and not str(key) in ["base","army"]: feedback.call("Choose "+str(key).capitalize()+" first",false); return
	var required:=str(active_action.get("requires",""))
	if not required.is_empty() and bindings.get(required,[]).is_empty(): feedback.call("Select your "+required+" first",false); return
	if active_action.has("tool"):
		tools.activate(str(active_action.tool),bind_command(active_action.get("tool_option",""),bindings)); panel.hide(); return
	var command:Dictionary=bind_command(active_action.command,bindings)
	if active_action.get("request_id",false): command.requestId="native-%d"%Time.get_ticks_usec()
	if preview: command.c=active_action.preview_command
	if active_action.has("map"):
		tools.target_command(command,str(active_action.title),str(active_action.map),bool(active_action.get("preview",false))); panel.hide(); return
	if active_action.get("confirm",false) and not preview:
		pending=command; confirm.dialog_text=str(active_action.title).capitalize()+"?"; confirm.popup_centered(); return
	_dispatch(command)

func _dispatch(command:Dictionary) -> void:
	if world.spectator and not command.get("c","") in ["follow","speed","fog","aiDiag"]:
		feedback.call("Spectators cannot issue gameplay orders",false); return
	busy=true
	commands.submit(command,func(reply):
		busy=false; last_reply=reply
		var visible_reply:Dictionary=reply.duplicate(true); visible_reply.erase("t"); visible_reply.erase("rid")
		_fill_tree(reply_tree,visible_reply)
		reply_tree.visible=not visible_reply.is_empty()
		if dashboard and dashboard.visible: dashboard.show_response(reply)
		if reply.get("error")!=null: feedback.call(str(reply.error),false)
		if reply.has("scenario"):
			military.selected.clear()
			if input_ref:
				input_ref.selected_army=-1; input_ref.selected_buildings.clear()
			settlements.selected_building=-1
			pending_scenario_units=reply.scenario.get("A",[]).duplicate()
			_select_scenario_units()
			camera.focus_tile(int(reply.scenario.arena),24); panel.hide()
		_refresh())

func _select_scenario_units() -> void:
	if pending_scenario_units.is_empty(): return
	if not pending_scenario_units.any(func(id):return world.units.has(int(id))): return
	for id in pending_scenario_units:
		if world.units.has(int(id)): military.selected[int(id)]=true
	pending_scenario_units.clear()
	if input_ref: input_ref.selection_changed.emit()

func cancel_pending_scenario_selection() -> void:
	pending_scenario_units.clear()

func _send(command:Dictionary) -> void: _dispatch(command)

func search_records() -> Array:
	var found:=[]
	for city in world.cities.values(): found.append({"label":"City · "+str(city.n),"tile":int(city.t)})
	for building in world.buildings.values(): found.append({"label":"Building · "+_name("BUILDINGS",building.ty)+" #"+str(building.id),"tile":int(building.t)})
	for unit in world.units.values(): found.append({"label":"Unit · "+_name("UNITS",unit.type)+" #"+str(unit.id),"tile":int(unit.tile)})
	for key in world.defs.get("TECHS",{}): found.append({"label":"Technology · "+_name("TECHS",key)})
	return found

func _unhandled_input(event:InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.keycode==KEY_F2 and world.ready_:
		if panel.visible: panel.hide()
		else: open_page(page)
		get_viewport().set_input_as_handled()

func _process(dt:float) -> void:
	if not panel.visible: return
	var bounds:=get_viewport().get_visible_rect().size
	var width:=minf(1080,bounds.x-96) if expanded else 300.0 if page in ["Construction","Armies"] and not inspector_view.visible else clampf(bounds.x*.26,340,390)
	var content_height:=inspector_view.get_combined_minimum_size().y if inspector_view.visible else dashboard.body.get_combined_minimum_size().y
	var height:=minf(760,bounds.y-111) if expanded else minf(content_height+120,minf(760,bounds.y-111))
	panel.size=Vector2(width,maxf(220,height)); panel.position=Vector2(82,66)
	expand_button.text="Compact" if expanded else "Expand"
	timer+=dt
	if timer>=1: timer=0; _refresh()
