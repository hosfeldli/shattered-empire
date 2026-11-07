class_name NativeAppShell
extends CanvasLayer
## Fullscreen native application shell: main menu, match setup, pause, settings and navigation.
var app:Node
var prefs:NativePreferences
var root:Control
var veil:ColorRect
var card:PanelContainer
var content:VBoxContainer
var navigation:VBoxContainer
var world_hidden:=false
var rail_buttons:={}
var status:Label
var view:=""
var previous:="main"
var automated:=false
var auto_paused:=false
var menu_pause_pending:=false
var connection_pending:=false
var connection_started:=0
var room:={}
var listening_key:=""
var binding_button:Button

func setup(game:Node,settings:NativePreferences,is_automated:bool) -> void:
	app=game; prefs=settings; automated=is_automated; layer=90
	root=Control.new(); root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	root.mouse_filter=Control.MOUSE_FILTER_IGNORE; root.theme=NativeUI.theme(); add_child(root)
	veil=ColorRect.new(); veil.color=Color(.025,.045,.06,.97)
	veil.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); root.add_child(veil)
	var backdrop:=NativeMenuBackdrop.new(); backdrop.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); veil.add_child(backdrop)
	card=PanelContainer.new(); root.add_child(card)
	var scroll:=ScrollContainer.new(); scroll.horizontal_scroll_mode=ScrollContainer.SCROLL_MODE_DISABLED; card.add_child(scroll)
	content=VBoxContainer.new(); content.size_flags_horizontal=Control.SIZE_EXPAND_FILL; scroll.add_child(content)
	navigation=VBoxContainer.new(); root.add_child(navigation)
	navigation.add_theme_constant_override("separation",5)
	navigation.add_theme_constant_override("separation",6)
	for title in ["Build","Army","Research"]:
		var target:String={"Build":"Construction","Army":"Armies","Research":"Research"}[title]
		var key:String={"Build":"B","Army":"","Research":"T"}[title]
		var button:=Button.new(); button.custom_minimum_size=Vector2(62,58); button.focus_mode=Control.FOCUS_NONE
		button.tooltip_text={"Build":"Build · place buildings, roads, bridges and trenches","Army":"Army · forces, armies and formations","Research":"Research · choose what your nation learns next"}[title]+(" ("+key+")" if not key.is_empty() else "")
		button.pressed.connect(func():
			app.command_panel.panel.hide()
			if app.workspace.panel.visible and app.workspace.page==target: app.workspace.panel.hide()
			else: app.workspace.open_page(target))
		for state in ["normal","hover","pressed"]:
			button.add_theme_stylebox_override(state,NativeUI.style(NativeUI.PANEL if state=="normal" else Color(.1,.13,.15,.95) if state=="hover" else Color(NativeUI.GOLD,.22),Color(1,1,1,.07) if state=="normal" else Color(NativeUI.GOLD,.6),4,9,state=="normal"))
		navigation.add_child(button)
		var glyph:=NativeIcon.new(); glyph.kind={"Build":"build","Army":"army","Research":"research"}[title]
		glyph.position=Vector2(19,7); glyph.size=Vector2(24,24); glyph.mouse_filter=Control.MOUSE_FILTER_IGNORE; button.add_child(glyph)
		var caption:=NativeUI.label(button,title,12,NativeUI.TEXT); caption.position=Vector2(0,34); caption.size=Vector2(62,16)
		caption.horizontal_alignment=HORIZONTAL_ALIGNMENT_CENTER; caption.mouse_filter=Control.MOUSE_FILTER_IGNORE
		var hint:=NativeUI.label(button,key,9,NativeUI.MUTED); hint.position=Vector2(48,3); hint.mouse_filter=Control.MOUSE_FILTER_IGNORE
		button.set_meta("page",target)
		rail_buttons[title]=button
	app.net.message.connect(_message)
	if automated: show_view("")
	else: show_view("main")

func is_blocking() -> bool: return not view.is_empty()

func _base(title:String,subtitle:String) -> void:
	NativeUI.clear(content)
	NativeUI.label(content,"SHATTERED EMPIRES",13,NativeUI.GOLD)
	NativeUI.label(content,title,32)
	if not subtitle.is_empty(): NativeUI.label(content,subtitle,15,NativeUI.MUTED)
	content.add_child(HSeparator.new())

func show_view(kind:String) -> void:
	view=kind; veil.visible=not kind.is_empty(); card.visible=veil.visible
	if kind.is_empty():
		_resume_owned_pause(); return
	app.input.box_active=false; app.input.press_pos=Vector2(-1,-1)
	app.input.input_enabled=false; app.cam.input_enabled=false; app.command_tools.input_enabled=false
	match kind:
		"main":
			_base("Shattered Empires","A civilization to rebuild. A war to survive.")
			NativeUI.button(content,"New campaign",func():show_view("new"))
			NativeUI.button(content,"Rejoin last match",func():_connect({"mode":"rejoin"}))
			NativeUI.button(content,"Multiplayer",func():show_view("multiplayer"))
			NativeUI.button(content,"Watch an AI match",func():_new_game("observe"))
			NativeUI.button(content,"Combat sandbox",func():_connect({"mode":"sandbox"}))
			NativeUI.button(content,"Settings",func():previous="main";show_view("settings"))
			NativeUI.button(content,"Controls & field guide",func():previous="main";show_view("help"))
			NativeUI.button(content,"Quit",func():app.get_tree().quit())
			NativeUI.label(content,"NATIVE EDITION     •     ONLINE CAMPAIGNS",13,NativeUI.MUTED)
		"new": _new_game("ai")
		"multiplayer": _multiplayer()
		"pause":
			_base("Command menu","Online matches continue unless paused.")
			if app.world.ruleset=="legacy-v1": NativeUI.label(content,"Legacy campaign · original gameplay rules are preserved.",16,NativeUI.GOLD)
			if not app.world.ready_: show_view("main"); return
			if not app.world.paused and not app.world.spectator and app.world.can_pause and not menu_pause_pending:
				menu_pause_pending=true
				app.net.cmd({"c":"pause","on":true},func(reply):
					menu_pause_pending=false
					if reply.get("error")==null:
						auto_paused=true
						if view.is_empty(): _resume_owned_pause())
			NativeUI.button(content,"Resume",func():show_view(""))
			NativeUI.button(content,"Copy match code · "+app.world.match_id,func():DisplayServer.clipboard_set(app.world.match_id); app.hud.show_toast("Match code copied"))
			NativeUI.button(content,"Settings",func():previous="pause";show_view("settings"))
			NativeUI.button(content,"Controls & field guide",func():previous="pause";show_view("help"))
			NativeUI.button(content,"Return to main menu",return_to_menu)
			NativeUI.button(content,"Quit to desktop",func():app.get_tree().quit())
		"settings": _settings()
		"help":
			_base("Field guide","Select in the world. Right-click to give orders.")
			NativeUI.label(content,controls_text(),16)
			NativeUI.button(content,"Back",func():show_view(previous))
		"search": _search()
		"connecting":
			_base("Connecting","Preparing your place in the world…")
			status=NativeUI.label(content,"Joining your match…",16)
			NativeUI.button(content,"Cancel and return",return_to_menu)
		"room": _room()

func _resume_owned_pause() -> void:
	if auto_paused:
		auto_paused=false
		if app.world.ready_: app.net.cmd({"c":"pause","on":false})

func return_to_menu() -> void:
	_resume_owned_pause(); connection_pending=false; app.net.close()
	app.world.ready_=false
	if app.world.grid!=null: app.world._clear_map(); app.world.reset.emit()
	app.command_tools.cancel(); app.workspace.panel.hide(); app.command_panel.panel.hide()
	show_view("main")

func _new_game(mode:String) -> void:
	_base("New campaign" if mode=="ai" else "AI exhibition","Choose the world and opponents. Progress is saved automatically.")
	var player:=LineEdit.new(); player.text=str(prefs.values.player); NativeUI.field(content,"Your name").add_child(player); player.size_flags_horizontal=Control.SIZE_EXPAND_FILL
	var seed:=LineEdit.new(); seed.placeholder_text="Random"; NativeUI.field(content,"World seed").add_child(seed)
	var size_:=NativeUI.options(NativeUI.field(content,"Map size"),[["small","Small · 128 × 128"],["medium","Medium · 192 × 192"],["large","Large · 256 × 256"]]); size_.select(1)
	var style:=NativeUI.options(NativeUI.field(content,"Geography"),[["","Varied world"],["continents","Continents"],["archipelago","Archipelago"],["inlandSea","Inland sea"],["pangaea","Pangaea"]])
	var count:=SpinBox.new(); count.min_value=1; count.max_value=7; count.value=3; NativeUI.field(content,"AI opponents").add_child(count)
	var personality:=NativeUI.options(NativeUI.field(content,"AI personality"),[["mixed","Varied"],["warlord","Warlord"],["merchant","Merchant"],["builder","Builder"]])
	var difficulty:=NativeUI.options(NativeUI.field(content,"Difficulty"),[["easy","Easy"],["normal","Normal"],["hard","Hard"],["brutal","Brutal"]]); difficulty.select(1)
	var fair:=CheckButton.new(); fair.text="Fair-play AI"; fair.button_pressed=true; content.add_child(fair)
	NativeUI.button(content,"Begin campaign" if mode=="ai" else "Watch match",func():
		prefs.values.player=player.text.strip_edges(); prefs.save()
		var options:={"mode":mode,"name":prefs.values.player,"map":NativeUI.value(size_),"ais":int(count.value),"difficulty":NativeUI.value(difficulty),"aiPersonality":NativeUI.value(personality),"fairPlay":fair.button_pressed,"style":NativeUI.value(style)}
		if seed.text.is_valid_int(): options.seed=seed.text
		_connect(options))
	NativeUI.button(content,"Back",func():show_view("main"))

func _multiplayer() -> void:
	_base("Multiplayer","Host a match, join with a code, or watch a running match.")
	var code:=LineEdit.new(); code.placeholder_text="Match code"; content.add_child(code)
	NativeUI.button(content,"Join match",func():_connect({"mode":"join","match":code.text.strip_edges()}))
	NativeUI.button(content,"Spectate match",func():_connect({"mode":"spectate","match":code.text.strip_edges()}))
	var humans:=SpinBox.new(); humans.min_value=2; humans.max_value=8; humans.value=2; NativeUI.field(content,"Human seats").add_child(humans)
	var ais:=SpinBox.new(); ais.min_value=0; ais.max_value=6; NativeUI.field(content,"AI opponents").add_child(ais)
	NativeUI.button(content,"Host match",func():_connect({"mode":"pvp","humans":int(humans.value),"ais":int(ais.value)}))
	NativeUI.button(content,"Back",func():show_view("main"))

func _connect(options:Dictionary) -> void:
	if not options.has("url"): options.url=str(prefs.values.server)
	if not options.has("name"): options.name=str(prefs.values.player)
	connection_pending=true; connection_started=Time.get_ticks_msec()
	show_view("connecting"); app.start(options)

func _room() -> void:
	_base("Match lobby · "+str(room.get("match","")),"Share the match code with other commanders.")
	for slot in room.get("slots",[]): NativeUI.label(content,"%s · %s"%[slot.get("name","Open seat"),"ready" if slot.get("taken",false) else "waiting"])
	NativeUI.button(content,"Start match (host)",func():app.net.send({"t":"start"}))
	NativeUI.button(content,"Leave lobby",return_to_menu)

func _settings() -> void:
	_base("Settings","Presentation and controls are saved on this computer.")
	var fullscreen:=CheckButton.new(); fullscreen.text="Fullscreen"; fullscreen.button_pressed=bool(prefs.values.fullscreen); content.add_child(fullscreen)
	var resolution:=NativeUI.options(NativeUI.field(content,"Window resolution"),[["1280x720","1280 × 720"],["1600x900","1600 × 900"],["1920x1080","1920 × 1080"],["2560x1440","2560 × 1440"]]); _select(resolution,prefs.values.resolution)
	var quality:=NativeUI.options(NativeUI.field(content,"Graphics"),[["low","Low"],["medium","Medium"],["high","High"],["ultra","Ultra"]]); _select(quality,prefs.values.quality)
	var vsync:=CheckButton.new(); vsync.text="Vertical sync"; vsync.button_pressed=prefs.values.vsync; content.add_child(vsync)
	var fps:=NativeUI.options(NativeUI.field(content,"Frame limit"),[[30,"30 FPS"],[60,"60 FPS"],[120,"120 FPS"],[144,"144 FPS"],[0,"Unlimited"]]); _select(fps,prefs.values.fps)
	var volume:=_slider("Master volume",0,100,5,float(prefs.values.volume))
	var ambience_volume:=_slider("Ambience",0,100,5,float(prefs.values.ambience_volume))
	var effects_volume:=_slider("Battle & effects",0,100,5,float(prefs.values.effects_volume))
	var mute:=CheckButton.new(); mute.text="Mute audio"; mute.button_pressed=prefs.values.mute; content.add_child(mute)
	var ui_scale:=_slider("Interface scale",.8,1.5,.1,float(prefs.values.ui_scale))
	var pan:=_slider("Pan speed",.3,3,.1,float(prefs.values.pan_speed))
	var zoom:=_slider("Zoom speed",.3,3,.1,float(prefs.values.zoom_speed))
	var invert:=CheckButton.new(); invert.text="Invert zoom direction"; invert.button_pressed=prefs.values.invert_zoom; content.add_child(invert)
	var edges:=CheckButton.new(); edges.text="Pan at screen edges"; edges.button_pressed=prefs.values.edge_pan; content.add_child(edges)
	var presentation:=VBoxContainer.new(); presentation.hide()
	NativeUI.compact_button(content,"World & accessibility options…",func():presentation.visible=not presentation.visible)
	content.add_child(presentation)
	var switches:={}
	for pair in [["weather_effects","Weather effects"],["screen_shake","Screen shake"],["reduced_motion","Reduced motion"],["high_contrast","High-contrast selection"],["unit_labels","Unit labels"],["resource_markers","Resource markers"],["territory_borders","Territory borders"],["wildlife","Livestock and birds"]]:
		var toggle:=CheckButton.new(); toggle.text=pair[1]; toggle.button_pressed=bool(prefs.values[pair[0]]); presentation.add_child(toggle); switches[pair[0]]=toggle
	var particles:=NativeUI.options(NativeUI.field(presentation,"Particle density"),[[0.0,"Minimal"],[.5,"Reduced"],[1.0,"Full"]]); _select(particles,prefs.values.particle_density)
	var shortcuts:=VBoxContainer.new(); shortcuts.hide()
	NativeUI.compact_button(content,"Keyboard shortcuts…",func():shortcuts.visible=not shortcuts.visible)
	content.add_child(shortcuts)
	for action in NativePreferences.SHORTCUTS:
		var key:String=action; var row:=NativeUI.field(shortcuts,key.replace("_"," ").capitalize())
		var button:=NativeUI.compact_button(row,OS.get_keycode_string(int(prefs.values.bindings.get(key,NativePreferences.SHORTCUTS[key]))),func():pass)
		button.pressed.connect(func():listening_key=key; binding_button=button; button.text="Press a key… (Esc cancels)")
	var server:=LineEdit.new(); server.text=str(prefs.values.server); server.size_flags_horizontal=Control.SIZE_EXPAND_FILL; NativeUI.field(content,"Game server").add_child(server)
	status=NativeUI.label(content,"",14,NativeUI.GOLD)
	NativeUI.button(content,"Apply & save",func():
		var address:=server.text.strip_edges()
		if not address.begins_with("ws://") and not address.begins_with("wss://"): status.text="Use a ws:// or wss:// game-server address."; return
		prefs.values.merge({"fullscreen":fullscreen.button_pressed,"resolution":NativeUI.value(resolution),"quality":NativeUI.value(quality),"vsync":vsync.button_pressed,"fps":NativeUI.value(fps),"volume":volume.value,"ambience_volume":ambience_volume.value,"effects_volume":effects_volume.value,"mute":mute.button_pressed,"ui_scale":ui_scale.value,"pan_speed":pan.value,"zoom_speed":zoom.value,"invert_zoom":invert.button_pressed,"edge_pan":edges.button_pressed,"server":address},true)
		for key in switches: prefs.values[key]=(switches[key] as CheckButton).button_pressed
		prefs.values.particle_density=NativeUI.value(particles)
		var error:=prefs.save(); prefs.apply(app); root.theme=NativeUI.theme()
		status.text="Settings saved" if error==OK else "Settings applied, but could not save them to disk")
	NativeUI.button(content,"Back",func():show_view(previous))

func _slider(title:String,low:float,high:float,step_:float,initial:float) -> HSlider:
	var row:=NativeUI.field(content,title); var slider:=HSlider.new(); slider.min_value=low; slider.max_value=high; slider.step=step_; slider.value=initial
	slider.size_flags_horizontal=Control.SIZE_EXPAND_FILL; slider.custom_minimum_size.x=150; row.add_child(slider)
	var amount:=NativeUI.label(row,str(snappedf(initial,.1))); amount.custom_minimum_size.x=42
	slider.value_changed.connect(func(v):amount.text=str(snappedf(v,.1))); return slider

func _select(item:OptionButton,wanted:Variant) -> void:
	for index in item.item_count:
		if item.get_item_metadata(index)==wanted: item.select(index); return

func _search() -> void:
	_base("Find in the world","Cities, buildings, forces and technologies visible to your civilization.")
	var query:=LineEdit.new(); query.placeholder_text="Search by name or type…"; content.add_child(query)
	var list:=ItemList.new(); list.custom_minimum_size=Vector2(400,360); content.add_child(list)
	var update:=func(_text:String):
		list.clear()
		for record in app.workspace.search_records():
			if not query.text.is_empty() and not query.text.to_lower() in str(record.label).to_lower(): continue
			list.add_item(record.label); list.set_item_metadata(list.item_count-1,record)
	query.text_changed.connect(update); update.call("")
	list.item_activated.connect(func(index):
		var record:Dictionary=list.get_item_metadata(index); show_view("")
		if record.has("tile"): app.cam.focus_tile(int(record.tile),16)
		else: app.workspace.open_page("Research"))
	NativeUI.button(content,"Back",func():show_view("" if app.world.ready_ else "main"))
	query.call_deferred("grab_focus")

func _message(record:Dictionary) -> void:
	if record.get("t")=="room": room=record; connection_pending=false; show_view("room")
	elif record.get("t")=="welcome": connection_pending=false; show_view("")
	elif record.get("t")=="error" and view=="connecting" and is_instance_valid(status): status.text=str(record.get("error","Connection failed"))

func _input(event:InputEvent) -> void:
	if not event is InputEventKey or not event.pressed or event.echo: return
	if not listening_key.is_empty():
		if event.keycode!=KEY_ESCAPE:
			var duplicate:=false
			for key in NativePreferences.SHORTCUTS:
				if key!=listening_key and int(prefs.values.bindings.get(key,NativePreferences.SHORTCUTS[key]))==event.keycode: duplicate=true
			if event.keycode in [KEY_F11,KEY_ENTER,KEY_TAB,KEY_W,KEY_A,KEY_S,KEY_D] or duplicate:
				binding_button.text="Key in use · choose another"; app.get_viewport().set_input_as_handled(); return
			prefs.values.bindings[listening_key]=int(event.keycode)
		binding_button.text=OS.get_keycode_string(int(prefs.values.bindings.get(listening_key,NativePreferences.SHORTCUTS[listening_key])))
		listening_key=""; app.get_viewport().set_input_as_handled(); return
	if event.keycode==KEY_F11:
		prefs.values.fullscreen=not bool(prefs.values.fullscreen); prefs.save(); prefs.apply(app,automated)
		app.get_viewport().set_input_as_handled(); return
	if event.keycode==KEY_ESCAPE:
		if view in ["settings","help"]: show_view(previous)
		elif view in ["new","multiplayer","connecting","room"]: return_to_menu()
		elif not view.is_empty(): show_view("" if app.world.ready_ else "main")
		elif app.workspace.panel.visible: app.workspace.panel.hide()
		elif app.command_tools.mode!="select": app.command_tools.cancel()
		elif not app.military.selected.is_empty() or app.settlements.selected_building>=0: app.input.cancel()
		else: show_view("pause")
		app.get_viewport().set_input_as_handled(); return
	if is_blocking(): return
	var focused:=app.get_viewport().gui_get_focus_owner()
	if focused is LineEdit or focused is TextEdit or focused is SpinBox: return
	var code:=prefs.canonical_key(event.keycode)
	if (code==KEY_SLASH or (code==KEY_K and (event.ctrl_pressed or event.meta_pressed))):
		show_view("search"); app.get_viewport().set_input_as_handled()
	elif code==KEY_K: previous="pause"; show_view("help"); app.get_viewport().set_input_as_handled()
	elif code==KEY_B:
		app.workspace.open_page("Construction"); app.get_viewport().set_input_as_handled()
	elif code==KEY_F10:
		world_hidden=not world_hidden
		if world_hidden: app.workspace.panel.hide()
		app.get_viewport().set_input_as_handled()
	elif code==KEY_T and not event.ctrl_pressed and not event.meta_pressed:
		if app.workspace.panel.visible and app.workspace.page=="Research": app.workspace.panel.hide()
		else: app.workspace.open_page("Research")
		app.get_viewport().set_input_as_handled()
	elif code==KEY_V and not event.ctrl_pressed and not event.meta_pressed and not app.world.spectator:
		# V: follow the selected unit with the camera, or stop following
		var picked:Array=app.military.selected.keys()
		if app.cam.follow_id>=0: app.cam.follow_id=-1
		elif not picked.is_empty(): app.cam.follow_id=int(picked[0])
		app.get_viewport().set_input_as_handled()
	elif code==KEY_M:
		prefs.values.mute=not bool(prefs.values.mute); prefs.save()
		app.audio.enabled=not bool(prefs.values.mute); AudioServer.set_bus_mute(0,bool(prefs.values.mute))
		if not app.audio.enabled: app.audio.stop()
		app.get_viewport().set_input_as_handled()
	elif code==KEY_L:
		app.strategic.mode=(app.strategic.mode+1)%app.strategic.selector.item_count
		app.strategic.selector.select(app.strategic.mode); app.strategic._dirty=true; app.get_viewport().set_input_as_handled()

func _process(_dt:float) -> void:
	var bounds:=root.get_viewport_rect().size
	navigation.visible=app.world.ready_ and not app.world.spectator and not is_blocking() and not world_hidden
	navigation.position=Vector2(10,66)
	# the open panel's tool stays lit so it is obvious what the drawer belongs to
	for title in rail_buttons:
		var button:Button=rail_buttons[title]
		var open_:bool=app.workspace.panel.visible and app.workspace.page==str(button.get_meta("page",""))
		button.modulate=Color(1,1,1) if open_ or not app.workspace.panel.visible else Color(1,1,1,.72)
		button.add_theme_stylebox_override("normal",NativeUI.style(Color(NativeUI.GOLD,.2) if open_ else NativeUI.PANEL,Color(NativeUI.GOLD,.7) if open_ else Color(1,1,1,.07),4,9,true))
	app.hud.root.visible=not world_hidden and app.world.ready_
	app.strategic.selector.visible=false
	app.strategic.selector.custom_minimum_size=Vector2(156,30)
	card.size=Vector2(minf(650,bounds.x-32),minf(850,bounds.y-48)); card.position=(bounds-card.size)*.5
	if view=="main": card.size.y=minf(690,bounds.y-48); card.position=Vector2(maxf(24,bounds.x*.09),(bounds.y-card.size.y)*.5)
	app.hud.lobby.visible=false
	app.hud.root.visible=app.world.ready_ and not world_hidden
	if connection_pending and app.world.ready_: connection_pending=false; show_view("")
	if view=="connecting" and is_instance_valid(status) and Time.get_ticks_msec()-connection_started>15000:
		status.text="Still connecting. Check the game-server address in Settings, or cancel to return."

static func controls_text() -> String:
	return "WASD / arrows — pan · middle drag — pan · wheel / + / − — zoom\nShift — faster pan / add selection / queue orders\nLeft click — select · drag — select a group · double-click — same type on screen\nRight click — move, attack enemy, or rally selected facilities\nRight drag — draw and deploy on release · Tab — reverse facing while drawing\nCtrl/Cmd + right click — attack-move / focus fire\n1–9 — recall group · Ctrl/Cmd + 1–9 — assign · double tap — center\nQ — combat units on screen · Shift+Q — all owned combat units\nE / Ctrl+A — attack-move target · X — withdraw · H — hold\nF — cycle movement formation / found city with a colonist · G — form army\nB — construction · R — road tool · Enter — confirm preview · Backspace — undo\nT — research · F2 — empire workspaces · / or Ctrl+K — search\nSpace — center selection/capital · P — pause · M — mute\nL — cycle map lens · K — field guide · F11 — fullscreen · Esc — cancel/back/menu\nObserver: [ / ] change civilization · , / . change speed · V toggle fog\n\nBuild, Army and Research are the main tools. Overview contains cities, economy, rivals and history. Double-click a building to select matching buildings, then Upgrade selected. Troop icons show the composition on each tile; hover for names. F10 hides the interface."
