class_name NativeResourceStrip
extends PanelContainer
## The compact top bar: who and when you are, the essential stockpiles with their trend, current
## research and three quiet icon controls (Overview, Alerts, Settings). One translucent strip that
## leaves the world in view; every chip opens the detail behind it.
const ESSENTIAL:=["food","materials","steel","credits"]
var app:Node
var empire:Label
var age:Label
var emblem:ColorRect
var values:={}
var rates:={}
var elapsed:=0.0
var research_label:Label
var research_bar:ProgressBar
var alerts:Button
var alert_badge:Label
var alert_records:Array=[]
var alert_menu:PopupMenu
var alert_signature:=""
var overview_menu:PopupMenu
var all_panel:PopupPanel
var all_grid:GridContainer


func _open_resource(key:String) -> void:
	app.workspace.open_page("Resources")
	for index in app.workspace.rows.size():
		if app.workspace.rows[index].key==key: app.workspace._choose(index); return


func setup(game:Node) -> void:
	app=game
	theme=NativeUI.theme()
	add_theme_stylebox_override("panel",NativeUI.style(NativeUI.PANEL,NativeUI.LINE,6,10,true))
	mouse_filter=Control.MOUSE_FILTER_STOP
	var row:=HBoxContainer.new(); row.add_theme_constant_override("separation",6); add_child(row)
	# identity: faction colour, empire name, era · clock · local weather
	emblem=ColorRect.new(); emblem.custom_minimum_size=Vector2(4,30); row.add_child(emblem)
	var identity:=VBoxContainer.new(); identity.custom_minimum_size.x=170; identity.add_theme_constant_override("separation",-2); row.add_child(identity)
	empire=NativeUI.label(identity,"",16,NativeUI.TEXT); empire.autowrap_mode=TextServer.AUTOWRAP_OFF; empire.text_overrun_behavior=TextServer.OVERRUN_TRIM_ELLIPSIS
	empire.add_theme_font_override("font",load("res://assets/fonts/BarlowSemiCondensed-SemiBold.ttf"))
	age=NativeUI.label(identity,"",11,NativeUI.MUTED); age.autowrap_mode=TextServer.AUTOWRAP_OFF; age.text_overrun_behavior=TextServer.OVERRUN_TRIM_ELLIPSIS
	_divider(row)
	# essential stockpiles: icon, amount and a coloured trend; click for the full explanation
	for good in ESSENTIAL:
		var key:String=good
		var chip:=Button.new(); chip.flat=true; chip.focus_mode=Control.FOCUS_NONE; chip.custom_minimum_size=Vector2(92,36)
		NativeUI._compact_styles(chip)
		chip.add_theme_stylebox_override("normal",NativeUI.style(Color(0,0,0,0),Color(0,0,0,0),8,6))
		chip.pressed.connect(func():_open_resource(key)); row.add_child(chip)
		var icon:=TextureRect.new(); icon.texture=load("res://assets/icons/resources/%s.svg"%key); icon.expand_mode=TextureRect.EXPAND_IGNORE_SIZE
		icon.stretch_mode=TextureRect.STRETCH_KEEP_ASPECT_CENTERED; icon.position=Vector2(7,9); icon.size=Vector2(18,18); icon.mouse_filter=Control.MOUSE_FILTER_IGNORE; chip.add_child(icon)
		var amount:=NativeUI.label(chip,"0",15,NativeUI.TEXT); amount.position=Vector2(31,0); amount.autowrap_mode=TextServer.AUTOWRAP_OFF; amount.mouse_filter=Control.MOUSE_FILTER_IGNORE
		amount.add_theme_font_override("font",load("res://assets/fonts/BarlowSemiCondensed-SemiBold.ttf"))
		var rate:=NativeUI.label(chip,"",10,NativeUI.MUTED); rate.position=Vector2(31,18); rate.autowrap_mode=TextServer.AUTOWRAP_OFF
		rate.mouse_filter=Control.MOUSE_FILTER_IGNORE; rates[key]=rate; values[key]=chip; chip.set_meta("amount",amount)
	# every stockpile at a glance: a small panel under the strip (click a row for its detail page)
	all_panel=PopupPanel.new(); all_panel.add_theme_stylebox_override("panel",NativeUI.style(NativeUI.PANEL,NativeUI.LINE,6,10,true)); add_child(all_panel)
	all_grid=GridContainer.new(); all_grid.columns=3; all_grid.add_theme_constant_override("h_separation",14); all_panel.add_child(all_grid)
	var more:=NativeUI.icon_button(row,"industry","All stockpiles, production and shortages",func():
		_fill_all(); all_panel.popup(Rect2i(Vector2i(get_global_rect().position+Vector2(0,size.y+4)),Vector2i(0,0))),30)
	more.tooltip_text="All resources · stockpiles and trends (click a row for production and shortages)"
	_divider(row)
	# current research: name and a thin progress bar; click opens Research
	var research:=Button.new(); research.flat=true; research.focus_mode=Control.FOCUS_NONE; research.custom_minimum_size=Vector2(170,34)
	NativeUI._compact_styles(research); research.add_theme_stylebox_override("normal",NativeUI.style(Color(0,0,0,0),Color(0,0,0,0),8,6))
	research.tooltip_text="Research · T"; research.pressed.connect(func():app.workspace.open_page("Research")); row.add_child(research)
	var flask:=NativeIcon.new(); flask.kind="research"; flask.color=NativeUI.TEAL; flask.position=Vector2(6,8); flask.size=Vector2(18,18); flask.mouse_filter=Control.MOUSE_FILTER_IGNORE; research.add_child(flask)
	research_label=NativeUI.label(research,"",13,NativeUI.TEXT); research_label.position=Vector2(30,3); research_label.size=Vector2(136,18)
	research_label.autowrap_mode=TextServer.AUTOWRAP_OFF; research_label.text_overrun_behavior=TextServer.OVERRUN_TRIM_ELLIPSIS; research_label.mouse_filter=Control.MOUSE_FILTER_IGNORE
	research_bar=ProgressBar.new(); research_bar.show_percentage=false; research_bar.position=Vector2(30,24); research_bar.size=Vector2(132,4); research_bar.mouse_filter=Control.MOUSE_FILTER_IGNORE
	research_bar.add_theme_stylebox_override("background",NativeUI.style(Color(1,1,1,.08),Color(0,0,0,0),0,2))
	research_bar.add_theme_stylebox_override("fill",NativeUI.style(NativeUI.TEAL,Color(0,0,0,0),0,2)); research.add_child(research_bar)
	var spacer:=Control.new(); spacer.size_flags_horizontal=Control.SIZE_EXPAND_FILL; row.add_child(spacer)
	# quiet icon controls on the right
	var overview:=NativeUI.icon_button(row,"overview","Overview · cities, economy, rivals, chronicle and map lenses",func():
		overview_menu.position=Vector2i(get_global_mouse_position())+Vector2i(-180,18); overview_menu.popup())
	overview_menu=PopupMenu.new(); overview.add_child(overview_menu)
	var pages:=["Cities","Economy","Rivals","Chronicle"]
	for page in pages: overview_menu.add_item(page)
	overview_menu.add_separator("Map lens")
	for index in app.strategic.selector.item_count: overview_menu.add_item(app.strategic.selector.get_item_text(index))
	overview_menu.index_pressed.connect(func(index):
		if index<pages.size(): app.workspace.open_page(pages[index]); return
		var lens:int=int(index)-pages.size()-1
		if lens>=0: app.strategic.mode=lens; app.strategic.selector.select(lens); app.strategic._dirty=true)
	alerts=NativeUI.icon_button(row,"alerts","Alerts",func():
		if alert_records.is_empty(): app.workspace.open_page("Chronicle"); return
		alert_menu.position=Vector2i(get_global_mouse_position())+Vector2i(-300,18); alert_menu.popup())
	alert_menu=PopupMenu.new(); alerts.add_child(alert_menu)
	alert_menu.index_pressed.connect(func(index):
		var note:Dictionary=alert_records[index]
		if note.get("good")!=null: _open_resource(str(note.good))
		elif int(note.get("tile",-1))>=0: app.cam.focus_tile(int(note.tile)); app.workspace.panel.hide()
		else: app.workspace.open_page("Chronicle"))
	alert_badge=Label.new(); alert_badge.add_theme_font_size_override("font_size",10); alert_badge.add_theme_color_override("font_color",NativeUI.INK)
	alert_badge.add_theme_stylebox_override("normal",NativeUI.style(NativeUI.BAD,Color(0,0,0,0),0,7)); alert_badge.position=Vector2(20,-2)
	alert_badge.custom_minimum_size=Vector2(15,14); alert_badge.horizontal_alignment=HORIZONTAL_ALIGNMENT_CENTER; alert_badge.mouse_filter=Control.MOUSE_FILTER_IGNORE
	alerts.add_child(alert_badge)
	NativeUI.icon_button(row,"settings","Settings",func():app.shell.previous="pause"; app.shell.show_view("settings"))


func _fill_all() -> void:
	NativeUI.clear(all_grid)
	var world:WorldState=app.world
	var stock:Dictionary=world.econ.get("res",{}); var trend:Dictionary=world.econ.get("rates",{})
	var keys:=stock.keys(); keys.sort()
	for good in keys:
		var key:=str(good)
		var amount:=float(stock[good]); var rate:=float(trend.get(good,0))
		var problem:bool=world.econ.get("resources",{}).get(key,{}).get("status","") in ["empty","deficit"]
		var name_:=NativeUI.compact_button(all_grid,key.capitalize(),func():all_panel.hide(); _open_resource(key))
		name_.custom_minimum_size.x=120
		NativeUI.label(all_grid,("%.1fk"%(amount/1000.0) if amount>=10000 else str(roundi(amount))),14,NativeUI.BAD if problem else NativeUI.TEXT)
		NativeUI.label(all_grid,("%+.1f/s"%rate) if absf(rate)>=.05 else "steady",12,NativeUI.GOOD if rate>=.05 else NativeUI.BAD if rate<=-.05 else NativeUI.MUTED)


func _divider(row:HBoxContainer) -> void:
	var line:=ColorRect.new(); line.color=Color(1,1,1,.08); line.custom_minimum_size=Vector2(1,26); line.size_flags_vertical=Control.SIZE_SHRINK_CENTER; row.add_child(line)


func _process(dt:float) -> void:
	visible=app.world.ready_ and not app.world.spectator and not app.shell.world_hidden
	if not visible: return
	var width:=get_viewport_rect().size.x
	position=Vector2(10,8); size=Vector2(minf(width-20,1080),0)
	(values.steel as Button).visible=width>=1180
	elapsed+=dt
	if elapsed<.2: return
	elapsed=0
	var world:WorldState=app.world
	emblem.color=world.civ_color(world.civ_id)
	empire.text=str(world.civ_by_id.get(world.civ_id,{}).get("name","Empire"))
	var eras:Array=world.defs.get("AGES",[]); var era:=int(world.econ.get("age",0))
	age.text=(str(eras[era].get("name","")) if era<eras.size() else "")+" · "+app.hud._clock(world.server_time)+(" · Paused" if world.paused else "")+_weather()
	for key in values:
		var amount:=float(world.econ.get("res",{}).get(key,0)); var rate:=float(world.econ.get("rates",{}).get(key,0))
		var problem:bool=world.econ.get("resources",{}).get(key,{}).get("status","") in ["empty","deficit"]
		var chip:Button=values[key]
		var value:Label=chip.get_meta("amount")
		value.text=("%.1fk"%(amount/1000.0) if amount>=10000 else str(roundi(amount)))
		value.add_theme_color_override("font_color",NativeUI.BAD if problem else NativeUI.TEXT)
		var trend:Label=rates[key]
		trend.text=("%+.1f/s"%rate) if absf(rate)>=.05 else "steady"
		trend.add_theme_color_override("font_color",NativeUI.GOOD if rate>=.05 else NativeUI.BAD if rate<=-.05 else NativeUI.MUTED)
		chip.tooltip_text="%s  %d  (%+.1f per second)%s\nClick for production, consumption and shortages"%[key.capitalize(),roundi(amount),rate,"\nShortage: "+str(world.econ.get("resources",{}).get(key,{}).get("why","not enough supply")) if problem else ""]
	var tech:=str(world.econ.get("research",""))
	if tech.is_empty() or tech=="<null>":
		research_label.text="Choose research"; research_bar.value=0
	else:
		var info:Dictionary=world.defs.get("TECHS",{}).get(tech,{})
		research_label.text=str(info.get("name",tech))
		# waiting on goods: say which, in the bar itself (never a silent stall)
		var wait:Variant=world.econ.get("researchWait")
		if wait is Dictionary and not (wait as Dictionary).is_empty():
			var stock:Dictionary=world.econ.get("res",{}); var short:=[]
			for good in wait:
				if float(stock.get(good,0))<float(wait[good]): short.append("%d %s"%[ceili(float(wait[good])-float(stock.get(good,0))),good])
			research_label.text="Waiting · needs "+", ".join(short) if not short.is_empty() else research_label.text
			research_label.add_theme_color_override("font_color",NativeUI.GOLD)
		else: research_label.add_theme_color_override("font_color",NativeUI.TEXT)
		research_bar.max_value=maxf(1.0,float(info.get("cost",1))); research_bar.value=float(world.econ.get("progress",0))
	alert_records=world.notifications.filter(func(note):return note.get("level","") in ["critical","actionable","major","minor"] and not note.get("quiet",false)).slice(0,6)
	alert_badge.visible=not alert_records.is_empty(); alert_badge.text=str(alert_records.size())
	alerts.tooltip_text="Alerts · %d need attention"%alert_records.size() if not alert_records.is_empty() else "Alerts · all quiet (opens the chronicle)"
	var next:=str(alert_records)
	if next!=alert_signature:
		alert_signature=next; alert_menu.clear()
		for note in alert_records: alert_menu.add_item(str(note.get("text","Alert")))


## Local weather where the camera is looking: what a commander would note at a glance.
func _weather() -> String:
	var world:WorldState=app.world
	if world.grid==null or app.composition==null: return ""
	var tile:=world.grid.tile_at(app.cam.focus.x,app.cam.focus.z)
	if tile<0 or not world.known[tile]: return ""
	var here:Dictionary=app.composition.weather.at_tile(tile)
	var words:=[]
	if float(here.get("storm",0))>.35: words.append("Storm")
	elif float(here.get("snow",0))>.3: words.append("Snow")
	elif float(here.get("rain",0))>.25: words.append("Rain")
	elif float(here.get("fog",0))>.5: words.append("Fog")
	elif float(here.get("cloud",0))>.6: words.append("Overcast")
	else: words.append("Clear")
	var wind:Vector2=app.composition.weather.wind
	if wind.length()>.05:
		var compass:=["E","NE","N","NW","W","SW","S","SE"]
		var from:=-wind
		var index:=posmod(int(round(atan2(-from.y,from.x)/(PI/4.0))),8)
		words.append("wind %s%s"%[compass[index]," strong" if wind.length()>.9 else ""])
	return " · "+" · ".join(words)
