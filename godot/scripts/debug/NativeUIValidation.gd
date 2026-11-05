class_name NativeUIValidation
extends RefCounted
var app:Node
var checks:={}
var directory:=""

func request(command:Dictionary) -> Dictionary:
	var reply:=LiveValidation.Reply.new(); app.net.cmd(command,func(record):reply.received.emit(record)); return await reply.received

func shot(name_:String) -> void:
	for frame in 4: await app.get_tree().process_frame
	if DisplayServer.get_name()!="headless":
		await RenderingServer.frame_post_draw
		app.get_viewport().get_texture().get_image().save_png(directory+"/"+name_+".png")

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
	app.workspace.open_page("Rivals"); await shot("rivals")
	app.workspace.open_page("Research"); await shot("research")
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
	var before_orders:int=app.net._rid
	app.command_tools.target_command({"c":"army","op":"order","id":formed.get("id",-1),"kind":"move","tile":"@map"},"March army")
	app.command_tools.points=[app.world.start_tile]; app.command_tools.request_preview()
	checks.target_waits_for_confirm=app.net._rid==before_orders
	app.command_tools.commit(); app.command_tools.commit()
	checks.target_single_commit=app.net._rid==before_orders+1
	for frame in 5: await app.get_tree().process_frame
	app.shell.show_view("pause"); await shot("pause-menu"); app.shell.show_view("")
	var result:={"checks":checks,"actions":app.workspace.actions.size(),"pages":NativeWorkspace.PAGES.size(),"rendered":DisplayServer.get_name()!="headless"}
	var file:=FileAccess.open(directory+"/ui-validation.json",FileAccess.WRITE); file.store_string(JSON.stringify(result,"  ")); file.close()
	print("NATIVE_UI ",JSON.stringify(result)); app.get_tree().quit(0 if not checks.values().has(false) else 1)
