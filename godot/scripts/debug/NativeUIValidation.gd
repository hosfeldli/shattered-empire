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

func banner_zoom() -> void:
	await request({"c":"pause","on":true}); await frames(12)
	var original:float=app.cam.size; var keys:={}; var aligned:=true; var stable:=true; var clouds_clear:=true
	app.world_labels.refresh()
	for key in app.world_labels.groups: keys[key]=app.world_labels.groups[key].ids.duplicate()
	for zoom in [6.0,16.0,30.0,50.0,80.0,40.0,10.0]:
		app.cam.size=zoom; app.cam.goal_size=zoom; app.cam._apply(); await frames(2)
		var opacity:float=app.environment.cloud_mat.get_shader_parameter("opacity")
		clouds_clear=clouds_clear and is_equal_approx(opacity,EnvironmentRenderer.cloud_opacity(zoom)) and opacity<=.10001
		if zoom<=28.0: clouds_clear=clouds_clear and not app.environment.clouds.visible
		for key in keys:
			stable=stable and app.world_labels.groups.has(key) and app.world_labels.groups[key].ids==keys[key]
		for banner:Dictionary in app.world_labels.banners:
			var anchor:=Vector2.ZERO
			for id in banner.ids: anchor+=app.cam.to_screen(app.military.draw_positions[id]+Vector3(0,.22,0))
			anchor/=banner.ids.size(); aligned=aligned and anchor.distance_to(banner.anchor)<.5
	checks.zoom_preserves_banner_membership=stable
	checks.banners_follow_camera_each_frame=aligned
	checks.clouds_fade_with_zoom=clouds_clear
	app.cam.size=original; app.cam.goal_size=original; app.cam._apply(); await frames()

func city_activity() -> void:
	app.input.cancel(); app.workspace.panel.hide(); await request({"c":"pause","on":false})
	var city:Dictionary={}
	for record:Dictionary in app.world.cities.values():
		if int(record.o)==app.world.civ_id: city=record; break
	if city.is_empty(): checks.city_activity=false; return
	app.cam.focus_tile(int(city.t),5.5); app.cam.size=5.5; app.cam.goal_size=5.5; app.cam._apply()
	app.civilians.elapsed=1.0; await frames(90)
	var before:Array=app.civilians.actor_positions.duplicate()
	checks.city_pedestrians=app.civilians.drawn>0
	checks.city_local_traffic=app.civilians.vehicles_drawn>0
	await shot("city-activity-before"); await frames(90)
	var changed:=false
	for index in mini(before.size(),app.civilians.actor_positions.size()): changed=changed or (before[index] as Vector3).distance_to(app.civilians.actor_positions[index])>.005
	checks.city_activity_moves=changed
	await shot("city-activity-after")
	var producer:Dictionary={}
	for building:Dictionary in app.world.buildings.values():
		if app.production_feedback.eligible(building): producer=building; break
	checks.measured_production_available=not producer.is_empty()
	if not producer.is_empty():
		app.cam.focus_tile(int(producer.t),6); app.cam.size=6; app.cam.goal_size=6; app.cam._apply()
		app.production_feedback.clock=fposmod(.7-NativeProductionFeedback.phase_at(0.0,int(producer.id)),NativeProductionFeedback.CYCLE_SECONDS)
		await frames(4)
		checks.production_icons_bounded=app.production_feedback.shown.size()>0 and app.production_feedback.shown.size()<=NativeProductionFeedback.MAX_VISIBLE
		await shot("production-icons")
	checks.no_routine_connection_status=not app.hud.conn.visible
	await request({"c":"pause","on":true})

func deployment_gesture() -> void:
	app.input.cancel(); app.workspace.panel.hide(); app.command_tools.cancel()
	var world:WorldState=app.world
	var units:Array=world.units.values().filter(func(unit):return int(unit.owner)==world.civ_id and not world.defs.UNITS[unit.type].get("civilian",false) and not world.defs.UNITS[unit.type].get("air",false)).slice(0,4)
	if units.is_empty(): checks.right_drag_deploys=false; return
	for unit:Dictionary in units: app.military.selected[int(unit.id)]=true
	app.cam.focus_tile(int(units[0].tile),16); app.cam.size=16; app.cam.goal_size=16; app.cam._apply(); await frames(6)
	var a:=int(units[0].tile); var b:=a
	for step_ in 4: b=world.grid.nb[b*6]
	var pa:Vector2=app.map_overlay._point(a); var pb:Vector2=app.map_overlay._point(b)
	var before:int=world.econ.get("formations",[]).size()
	mouse_button(pa,MOUSE_BUTTON_RIGHT,true)
	var motion:=InputEventMouseMotion.new(); motion.position=pb; motion.global_position=pb; motion.relative=pb-pa; app.get_viewport().push_input(motion,true)
	mouse_button(pb,MOUSE_BUTTON_RIGHT,false)
	var until:=Time.get_ticks_msec()+5000
	while world.econ.get("formations",[]).size()<=before and Time.get_ticks_msec()<until: await frames()
	checks.right_drag_deploys=world.econ.get("formations",[]).size()>before and app.command_tools.mode=="select"
	await shot("drag-deployment")

func mass_upgrade() -> void:
	await request({"c":"pause","on":false})
	var world:WorldState=app.world
	var houses:Array=world.buildings.values().filter(func(building):return building.ty=="house" and int(building.o)==world.civ_id)
	for attempt in maxi(0,2-houses.size()):
		var sites:=await request({"c":"placement","type":"house"})
		if sites.get("tiles",[]).is_empty(): break
		await request({"c":"build","type":"house","tile":int(sites.tiles[0]),"plan":true}); await frames(15)
	var until:=Time.get_ticks_msec()+35000
	while Time.get_ticks_msec()<until:
		houses=world.buildings.values().filter(func(building):return building.ty=="house" and int(building.o)==world.civ_id and int(building.get("d",0))==1 and int(building.get("lv",1))==1)
		if houses.size()>=2: break
		await frames(12)
	checks.finished_houses_for_batch=houses.size()>=2
	if houses.size()<2: return
	app.input.cancel(); app.workspace.panel.hide(); app.cam.focus_tile(int(houses[0].t),16); app.cam.size=16; app.cam.goal_size=16; app.cam._apply(); await frames(8)
	var center:Vector2=world.grid.center(int(houses[0].t)); var point:Vector2=app.cam.to_screen(Vector3(world.grid.near_x(center.x,app.cam.focus.x),world.tile_height(int(houses[0].t)),center.y))
	var event:=InputEventMouseButton.new(); event.position=point; event.global_position=point; event.button_index=MOUSE_BUTTON_LEFT; event.pressed=true; event.double_click=true
	app.get_viewport().push_input(event,true); mouse_button(point,MOUSE_BUTTON_LEFT,false); await frames(12)
	var selected:Array=app.input.selected_buildings.keys()
	checks.double_click_matches_building_type=selected.size()>=2 and selected.all(func(id):return world.buildings[id].ty=="house" and int(world.buildings[id].o)==world.civ_id)
	var eligible:Array=selected.filter(func(id):return int(world.buildings[id].get("d",0))==1 and int(world.buildings[id].get("lv",1))==1)
	var buttons:Array=app.command_dock.orders.get_children().filter(func(button):return str(button.text).begins_with("Upgrade"))
	if not buttons.is_empty(): (buttons[0] as Button).pressed.emit()
	until=Time.get_ticks_msec()+5000
	# native-v4: an accepted upgrade starts timed works (server "wk"); the level follows on completion
	var started:=func(id): return int(world.buildings[id].get("lv",1))==2 or not (world.buildings[id].get("wk",[]) as Array).is_empty()
	while not eligible.all(started) and Time.get_ticks_msec()<until: await frames()
	checks.mass_upgrade_authoritative=eligible.size()>=2 and eligible.all(started)
	checks.mass_upgrade_keeps_selection=app.input.selected_buildings.keys()==selected
	await shot("mass-upgrade")

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
	var original_zoom:float=app.cam.goal_size
	app.cam.size=34.0; app.cam.goal_size=34.0; app.cam._apply()
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
	app.cam.goal_size=original_zoom
	await shot("cities")
	app.workspace.dashboard.city_tab="Development"; app.workspace.dashboard.signature=""; app.workspace.dashboard.sync(); await shot("city-development")
	app.workspace.open_page("Economy"); await shot("economy")
	app.workspace.open_page("Research"); app.workspace.set_expanded(true); await shot("research-tree")
	checks.research_expands_on_request=app.workspace.panel.size.x>420
	var graph:NativeResearchTree=app.workspace.dashboard.research_graph
	checks.research_starts_with_available=graph.view_filter==0 and graph.cards.keys().all(func(key):return graph.model.ready(key) or key==app.world.econ.get("research") or key in app.world.econ.get("queue",[]))
	graph.configure("",1,-1)
	checks.research_all_eras=graph.cards.size()==app.world.defs.TECHS.size()
	graph.configure("tank",1,-1)
	checks.research_searches_unlocks=not graph.cards.is_empty() and graph.cards.keys().all(func(key):return "tank" in (str(app.world.defs.TECHS[key].get("desc",""))+" "+" ".join(graph.model.unlocks(key))).to_lower())
	await shot("research-search"); graph.configure("",0,-1)
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
	checks.native_ruleset=app.world.ruleset=="native-v4"
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
	# The selection card refreshes on a timer; a fixed number of rendered frames can
	# be shorter than that interval on a fast machine.
	var army_card_until:=Time.get_ticks_msec()+2000
	while Time.get_ticks_msec()<army_card_until and not app.command_dock.orders.get_children().any(func(button):return button.text=="Defend"):
		await frames()
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
	var scenario_until:=Time.get_ticks_msec()+8000
	while app.input._owned_units().is_empty() and Time.get_ticks_msec()<scenario_until: await frames()
	await app.get_tree().create_timer(.15).timeout
	app.workspace.panel.hide(); await shot("ground-selection")
	checks.ground_specific_actions=app.command_dock.orders.get_children().any(func(button):return button.text=="Attack-move") and not app.command_dock.orders.get_children().any(func(button):return button.text=="Air strike…")
	checks.unit_behavior_choices=app.command_dock.behavior_buttons.size()==3
	if checks.unit_behavior_choices:
		var combat:Array=app.input._owned_units().filter(func(id):return not app.world.defs.UNITS[app.world.units[id].type].get("civilian",false) and not app.world.defs.UNITS[app.world.units[id].type].get("air",false))
		(app.command_dock.behavior_buttons.explore as Button).pressed.emit()
		var until:=Time.get_ticks_msec()+4000
		while combat.any(func(id):return app.world.units[id].stance!="explore") and Time.get_ticks_msec()<until: await frames()
		checks.explore_behavior_authoritative=combat.all(func(id):return app.world.units[id].stance=="explore")
		(app.command_dock.behavior_buttons.defensive as Button).pressed.emit(); await frames()
	app.world_labels.refresh()
	checks.bounded_troop_banners=not app.world_labels.banners.is_empty() and app.world_labels.banners.size()<=48
	var clickable:Array=app.world_labels.banners.filter(func(record):
		var point:Vector2=(record.rect as Rect2).get_center()
		return point.y>55 and not app.shell.navigation.get_global_rect().has_point(point) and not app.command_dock.panel.get_global_rect().has_point(point))
	if not clickable.is_empty():
		var banner:Dictionary=clickable[0]
		mouse_button((banner.rect as Rect2).get_center(),MOUSE_BUTTON_LEFT,true); mouse_button((banner.rect as Rect2).get_center(),MOUSE_BUTTON_LEFT,false); await frames()
		checks.banner_selects_real_units=banner.ids.all(func(id):return app.military.selected.has(id))
	else: checks.banner_selects_real_units=false
	checks.resource_icons_only=app.world_labels.markers.all(func(record):return (record.rect as Rect2).size==Vector2(20,20) and app.world_labels.icons.has(record.resource))
	checks.compact_troop_composition_icons=app.world_labels.banners.all(func(record):return (record.rect as Rect2).size==Vector2(26,26) and app.world_labels.unit_icons.has(record.type))
	checks.unit_card_behavior_compact=app.command_dock.panel.size.y<220
	await banner_zoom()
	await shot("troop-banners")
	await deployment_gesture()
	app.input.cancel(); await frames()
	checks.selection_hides_when_cleared=not app.command_dock.panel.visible
	app.workspace.open_page("Cities")
	var building_id:=-1
	for building in app.world.buildings.values():
		if int(building.o)==app.world.civ_id: building_id=int(building.id); break
	app.settlements.selected_building=building_id; app.input.selected_buildings[building_id]=true; app.input.selection_changed.emit(); await frames()
	checks.city_follows_map_selection=app.workspace.current.get("key")==app.world.buildings[building_id].get("c")
	app.workspace.panel.hide()
	var building_card_until:=Time.get_ticks_msec()+2000
	while Time.get_ticks_msec()<building_card_until and not app.command_dock.orders.get_children().any(func(button):return button.text=="Manage" or button.text=="More ▾"):
		await frames()
	await shot("building-selection")
	checks.building_specific_actions=app.command_dock.orders.get_children().any(func(button):return button.text=="Manage" or button.text=="More ▾")
	app.input.cancel(); await shot("world")
	await direct_placement()
	await mass_upgrade()
	await city_activity()
	checks.merge(await catalogue.run(app,directory),true)
	app.shell.show_view("pause"); await shot("pause-menu"); app.shell.show_view("")
	var result:={"checks":checks,"actions":app.workspace.actions.size(),"pages":NativeWorkspace.PAGES.size(),"rendered":DisplayServer.get_name()!="headless"}
	var file:=FileAccess.open(directory+"/ui-validation.json",FileAccess.WRITE); file.store_string(JSON.stringify(result,"  ")); file.close()
	print("NATIVE_UI ",JSON.stringify(result)); app.get_tree().quit(0 if not checks.values().has(false) else 1)
