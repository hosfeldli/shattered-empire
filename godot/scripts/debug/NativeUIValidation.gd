class_name NativeUIValidation
extends RefCounted
var app:Node
var checks:={}
var directory:=""
var catalogue:=CatalogueValidation.new()

func request(command:Dictionary) -> Dictionary:
	var reply:=LiveValidation.Reply.new(); app.net.cmd(command,func(record):reply.received.emit(record)); return await reply.received

func shot(name_:String) -> void:
	for frame in 4: await app.get_tree().process_frame
	if DisplayServer.get_name()!="headless":
		await RenderingServer.frame_post_draw
		app.get_viewport().get_texture().get_image().save_png(directory+"/"+name_+".png")

func frames(count:=4) -> void:
	for frame in count: await app.get_tree().process_frame

func mouse_button(point:Vector2,button:MouseButton,pressed:bool) -> void:
	var event:=InputEventMouseButton.new(); event.position=point; event.global_position=point; event.button_index=button; event.pressed=pressed
	app.get_viewport().push_input(event,true)

func compact_layout() -> void:
	var bounded:=true; var editors_bounded:=true
	for page in NativeWorkspace.PAGES:
		app.workspace.open_page(page); await frames()
		var bounds:Vector2=app.get_viewport().get_visible_rect().size
		var rect:Rect2=app.workspace.panel.get_global_rect()
		bounded=bounded and (page=="Research" or rect.size.x<=maxf(420,bounds.x*.35)+1) and rect.end.x<bounds.x and rect.end.y<=bounds.y-16
		app.workspace.show_all_orders(true)
		for record in app.workspace.page_actions:
			app.workspace._set_action(record); await frames(2)
			editors_bounded=editors_bounded and app.workspace.panel.size.x<=maxf(420,bounds.x*.35)+1
	checks.compact_workspaces=bounded
	checks.compact_order_forms=editors_bounded
	app.workspace.open_page("Cities"); await frames()
	checks.drawer_keeps_map_active=app.input.input_enabled and app.cam.input_enabled and app.command_tools.input_enabled
	var selected:Dictionary=app.military.selected.duplicate()
	for unit in app.world.units.values():
		if int(unit.owner)==app.world.civ_id: app.military.selected[int(unit.id)]=true
	var before_zoom:float=app.cam.goal_size
	var inside:Vector2=app.workspace.heading.get_global_rect().get_center()
	mouse_button(inside,MOUSE_BUTTON_WHEEL_UP,true); await frames()
	checks.drawer_intercepts_zoom=is_equal_approx(before_zoom,app.cam.goal_size)
	var before_orders:int=app.net._rid
	mouse_button(inside,MOUSE_BUTTON_RIGHT,true); mouse_button(inside,MOUSE_BUTTON_RIGHT,false); await frames()
	checks.drawer_intercepts_orders=app.net._rid==before_orders and app.input.right_press.x<0
	var outside:Vector2=app.get_viewport().get_visible_rect().size*Vector2(.8,.45)
	mouse_button(outside,MOUSE_BUTTON_WHEEL_UP,true); await frames()
	checks.map_zooms_beside_drawer=app.cam.goal_size<before_zoom
	app.military.selected=selected
	app.cam.goal_size=before_zoom
	await shot("cities")
	app.workspace.dashboard.city_tab="Development"; app.workspace.dashboard.signature=""; app.workspace.dashboard.sync(); await shot("city-development")
	app.workspace.open_page("Economy"); await shot("economy")
	app.workspace.open_page("Research"); app.workspace.set_expanded(true); await shot("research-tree")
	checks.research_expands_on_request=app.workspace.panel.size.x>420
	app.workspace.set_expanded(false); await frames()
	checks.research_returns_to_drawer=app.workspace.panel.size.x<=420
	var previous:float=app.preferences.values.ui_scale
	app.preferences.values.ui_scale=1.3; app.preferences.apply(app,true)
	app.workspace.open_page("Cities"); await shot("cities-large-ui")
	var view:Rect2=app.get_viewport().get_visible_rect()
	checks.scaled_drawer_fits=view.encloses(app.workspace.panel.get_global_rect())
	app.workspace.open_page("Construction"); app.workspace.dashboard._all_orders("construction_trench"); await shot("trench-order")
	checks.scaled_order_form_fits=view.encloses(app.workspace.panel.get_global_rect())
	checks.specific_order_is_focused=not app.workspace.records_context.visible and app.workspace.panel.size.y<view.size.y*.6
	app.preferences.values.ui_scale=previous; app.preferences.apply(app,true); await frames()


func direct_placement() -> void:
	app.input.cancel(); app.workspace.panel.hide(); app.command_tools.activate("build","house")
	var until:=Time.get_ticks_msec()+5000
	while app.command_tools.valid_tiles.is_empty() and Time.get_ticks_msec()<until: await frames()
	if app.command_tools.valid_tiles.is_empty(): checks.placement_has_sites=false; return
	var tile:int=app.command_tools.valid_tiles.keys()[0]
	app.cam.focus_tile(tile,10); app.cam.set_process(false); app.cam.size=10; app.cam.goal_size=10; app.cam._apply()
	app.command_tools._preview_build(tile)
	until=Time.get_ticks_msec()+5000
	while app.command_tools.site_details.get("tile",-1)!=tile and Time.get_ticks_msec()<until: await frames()
	checks.authoritative_site_preview=app.command_tools.site_details.get("valid",false) and app.command_tools.site_details.has("cost")
	var preview:WorldPlacementPreview=app.command_tools.placement
	checks.recognizable_preview=preview.mesh!=null and preview.mesh.get_surface_count()>1 and preview.mesh.get_aabb().size.y>.1
	var generated:=preview.generated; preview.show_building("house",tile)
	checks.preview_cached=preview.generated==generated
	await shot("building-preview")
	var center:Vector2=app.world.grid.center(tile); var point:Vector2=app.cam.to_screen(Vector3(app.world.grid.near_x(center.x,app.cam.focus.x),app.world.tile_height(tile),center.y))
	mouse_button(point,MOUSE_BUTTON_LEFT,true); mouse_button(point,MOUSE_BUTTON_LEFT,false)
	until=Time.get_ticks_msec()+5000
	while (app.command_tools.mode!="select" or not app.world.buildings.values().any(func(building):return int(building.t)==tile and building.ty=="house")) and Time.get_ticks_msec()<until: await frames()
	checks.one_click_build=app.command_tools.mode=="select" and app.world.buildings.values().any(func(building):return int(building.t)==tile and building.ty=="house")
	var hub:Dictionary={}
	for building in app.world.buildings.values():
		if building.ty=="town" and int(building.o)==app.world.civ_id: hub=building; break
	if not hub.is_empty():
		app.settlements.selected_building=int(hub.id); app.input.selected_buildings={int(hub.id):true}; await frames()
		app.command_dock.recruit_open=true; app.command_dock.signature=""; await frames(8); await shot("recruitment")
		var before:int=hub.get("q",[]).size()
		app.commands.train([int(hub.id)],"scout_buggy")
		until=Time.get_ticks_msec()+5000
		while app.world.buildings[int(hub.id)].get("q",[]).size()<=before and Time.get_ticks_msec()<until: await frames()
		checks.direct_training=app.world.buildings[int(hub.id)].get("q",[]).size()>before
	app.input.cancel(); app.cam.set_process(true)

func action(id:String,values:Dictionary={}) -> Dictionary:
	var workspace:NativeWorkspace=app.workspace
	var found:=workspace.actions.filter(func(record):return record.id==id)
	if found.is_empty(): return {"error":"No such native UI action"}
	workspace.open_page(str(found[0].page)); workspace._set_action(found[0])
	for key in values:
		if not workspace.controls.has(key): continue
		var control:Control=workspace.controls[key]
		if control is OptionButton:
			for index in control.item_count:
				if control.get_item_metadata(index)==values[key]: control.select(index)
		elif control is CheckButton: control.button_pressed=bool(values[key])
		elif control is SpinBox: control.value=float(values[key])
		elif control is LineEdit: control.text=str(values[key])
	workspace.last_reply.clear(); workspace._perform(false)
	var until:=Time.get_ticks_msec()+8000
	while workspace.busy and Time.get_ticks_msec()<until: await app.get_tree().process_frame
	return workspace.last_reply.duplicate(true)

func run(game:Node,out:String) -> void:
	app=game; directory=out; DirAccess.make_dir_recursive_absolute(directory)
	while app.world.snapshot_count<8 or not app.terrain.dirty.is_empty(): await app.get_tree().process_frame
	checks.windowed_test=DisplayServer.get_name()=="headless" or DisplayServer.window_get_mode()==DisplayServer.WINDOW_MODE_WINDOWED
	app.shell.show_view("main"); await shot("main-menu")
	app.shell.previous="main"; app.shell.show_view("settings"); await shot("settings")
	checks.menu_blocks_map=not app.input.input_enabled and not app.cam.input_enabled and not app.command_tools.input_enabled
	var saved:Dictionary=app.preferences.values.duplicate(true)
	app.preferences.values.volume=35.0; app.preferences.values.pan_speed=1.4
	var saved_ok:int=app.preferences.save()
	var restored:=NativePreferences.new(); restored.load_from(app.preferences.path)
	checks.settings_persist=saved_ok==OK and restored.values.volume==35.0 and restored.values.pan_speed==1.4
	app.preferences.values=saved; app.preferences.save()
	if DisplayServer.get_name()!="headless":
		app.preferences.values.fullscreen=true; app.preferences.apply(app,false)
		await app.get_tree().create_timer(.6).timeout
		checks.fullscreen=DisplayServer.window_get_mode()==DisplayServer.WINDOW_MODE_FULLSCREEN
		app.preferences.values=saved; app.preferences.apply(app,true)
		await app.get_tree().create_timer(.4).timeout
	app.shell.show_view("")
	var ids:={}; var duplicate:=false
	for record in app.workspace.actions:
		if ids.has(record.id): duplicate=true
		ids[record.id]=true
	checks.unique_actions=not duplicate
	checks.system_actions=ids.has("city_development") and ids.has("air_strike") and ids.has("missile_launch") and ids.has("batch_train") and ids.has("diplo_war")
	for page in NativeWorkspace.PAGES:
		app.workspace.open_page(page)
		for record in app.workspace.page_actions:
			app.workspace._set_action(record)
		for frame in 2: await app.get_tree().process_frame
	checks.eight_workspaces=app.workspace.sidebar.item_count==8
	app.workspace.open_page("Cities"); checks.city_records=app.workspace.records.item_count>0
	app.workspace.open_page("Research"); checks.technology_records=app.workspace.records.item_count==app.world.defs.TECHS.size()
	var city_id:=-1
	for city in app.world.cities.values():
		if int(city.o)==app.world.civ_id: city_id=int(city.id); break
	checks.native_ruleset=app.world.ruleset=="native-v1"
	checks.removed_controls=not ids.has("tax") and not ids.has("import") and not ids.has("diplo_trade")
	var development:=await action("city_development",{"city":city_id,"on":true,"priority":"industry"})
	checks.development_command=development.get("error")==null and not development.is_empty()
	var rejected:=await request({"c":"import","good":"ore","amount":10})
	checks.trading_disabled=rejected.has("error")
	var plan:=await action("city_plan",{"city":city_id})
	checks.city_plan=plan.has("plan")
	app.workspace.open_page("Cities"); await shot("cities")
	await compact_layout()
	app.workspace.open_page("Rivals"); await shot("rivals")
	app.workspace.open_page("Research"); await shot("research")
	checks.three_quick_tools=app.shell.rail_buttons.size()==3 and app.shell.rail_buttons.has("Build") and app.shell.rail_buttons.has("Army") and app.shell.rail_buttons.has("Research")
	checks.no_minimap=app.find_children("*","NativeMinimap",true,false).is_empty()
	var scenario:=await action("scenario",{"scenario":"air"})
	checks.native_sandbox=scenario.has("scenario")
	for frame in 120: await app.get_tree().process_frame
	var aircraft:=[]; var base:=-1
	for unit in app.world.units.values():
		if int(unit.owner)==app.world.civ_id and app.world.defs.UNITS.get(unit.type,{}).get("air",false): aircraft.append(int(unit.id))
	for building in app.world.buildings.values():
		if int(building.o)==app.world.civ_id and app.world.defs.BUILDINGS.get(building.ty,{}).get("airbase",false): base=int(building.id); break
	app.military.selected.clear()
	for id in aircraft: app.military.selected[id]=true
	var homed:=await action("air_home",{"base":base})
	checks.air_command=homed.get("rehomed",0)>0
	app.workspace.open_page("Air"); await shot("air-operations")
	app.workspace.open_page("Construction"); await shot("construction")
	app.command_panel.panel.hide(); app.workspace.panel.hide()
	var group_event:=InputEventKey.new(); group_event.keycode=KEY_1; group_event.ctrl_pressed=true
	app.input._group_key(group_event); var count:int=app.military.selected.size(); app.military.selected.clear(); group_event.ctrl_pressed=false; app.input._group_key(group_event)
	checks.control_groups=count>0 and app.military.selected.size()==count
	app.workspace.open_page("Armies")
	var formed:=await action("army_create",{"name":"UI validation force"})
	checks.army_command=formed.get("id",-1)>=0
	app.workspace.panel.hide()
	await shot("tactical-command")
	checks.compact_selection=app.command_dock.panel.size.x<=440 and app.command_dock.panel.size.y<200
	checks.army_specific_actions=app.command_dock.orders.get_children().any(func(button):return button.text=="Defend") and app.command_dock.orders.get_children().any(func(button):return button.text=="Attack")
	var before_orders:int=app.net._rid
	app.command_tools.target_command({"c":"army","op":"order","id":formed.get("id",-1),"kind":"move","tile":"@map"},"March army")
	app.command_tools.points=[app.world.start_tile]; app.command_tools.request_preview()
	checks.target_waits_for_confirm=app.net._rid==before_orders
	app.command_tools.commit(); app.command_tools.commit()
	checks.target_single_commit=app.net._rid==before_orders+1
	for frame in 5: await app.get_tree().process_frame
	app.input.selected_army=-1
	var ground:=await action("scenario",{"scenario":"mixed"})
	checks.ground_scenario=ground.has("scenario")
	await app.get_tree().create_timer(.6).timeout
	app.workspace.panel.hide(); await shot("ground-selection")
	checks.ground_specific_actions=app.command_dock.orders.get_children().any(func(button):return button.text=="Attack-move") and not app.command_dock.orders.get_children().any(func(button):return button.text=="Air strike…")
	app.input.cancel(); await frames()
	checks.selection_hides_when_cleared=not app.command_dock.panel.visible
	app.workspace.open_page("Cities")
	var building_id:=-1
	for building in app.world.buildings.values():
		if int(building.o)==app.world.civ_id: building_id=int(building.id); break
	app.settlements.selected_building=building_id; app.input.selected_buildings[building_id]=true; app.input.selection_changed.emit(); await frames()
	checks.city_follows_map_selection=app.workspace.current.get("key")==app.world.buildings[building_id].get("c")
	app.workspace.panel.hide(); await shot("building-selection")
	checks.building_specific_actions=app.command_dock.orders.get_children().any(func(button):return button.text=="Manage" or button.text=="More ▾")
	app.input.cancel(); await shot("world")
	await direct_placement()
	checks.merge(await catalogue.run(app,directory),true)
	app.shell.show_view("pause"); await shot("pause-menu"); app.shell.show_view("")
	var result:={"checks":checks,"actions":app.workspace.actions.size(),"pages":NativeWorkspace.PAGES.size(),"rendered":DisplayServer.get_name()!="headless"}
	var file:=FileAccess.open(directory+"/ui-validation.json",FileAccess.WRITE); file.store_string(JSON.stringify(result,"  ")); file.close()
	print("NATIVE_UI ",JSON.stringify(result)); app.get_tree().quit(0 if not checks.values().has(false) else 1)
