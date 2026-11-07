class_name NativeResourceStrip
extends HBoxContainer
## Essential stockpiles stay visible; the resource menu exposes every balance and shortage.
const ESSENTIAL:=["food","materials","steel","credits"]
var app:Node
var empire:Label
var age:Label
var values:={}
var elapsed:=0.0
var identity:VBoxContainer
var chips:Array[Button]=[]
var resource_menu:MenuButton
var alerts:MenuButton
var alert_records:Array=[]
var alert_signature:=""

func _open_resource(key:String) -> void:
	app.workspace.open_page("Resources")
	for index in app.workspace.rows.size():
		if app.workspace.rows[index].key==key: app.workspace._choose(index); return

func setup(game:Node) -> void:
	app=game; add_theme_constant_override("separation",5)
	identity=VBoxContainer.new(); identity.custom_minimum_size.x=148; identity.add_theme_constant_override("separation",0); add_child(identity)
	empire=NativeUI.label(identity,"",17,NativeUI.GOLD); empire.autowrap_mode=TextServer.AUTOWRAP_OFF; empire.text_overrun_behavior=TextServer.OVERRUN_TRIM_ELLIPSIS
	age=NativeUI.label(identity,"",11,NativeUI.MUTED); age.autowrap_mode=TextServer.AUTOWRAP_OFF
	for good in ESSENTIAL:
		var key:String=good
		var button:=NativeUI.compact_button(self,key.capitalize()+" 0",func():_open_resource(key))
		button.icon=load("res://assets/icons/resources/%s.svg"%key); button.expand_icon=true; button.add_theme_constant_override("icon_max_width",18)
		button.custom_minimum_size=Vector2(94,32); chips.append(button); values[key]=button
	var entries:=[]
	for good in GameHUD.GOODS:
		var key:String=good
		entries.append({"label":key.capitalize(),"action":func():_open_resource(key)})
	resource_menu=NativeUI.menu(self,"Resources ▾",entries)
	for index in GameHUD.GOODS.size():
		var path:="res://assets/icons/resources/%s.svg"%GameHUD.GOODS[index]
		if ResourceLoader.exists(path): resource_menu.get_popup().set_item_icon(index,load(path))
	resource_menu.tooltip_text="All stockpiles, production rates and shortages"
	var overview:=[]
	for page in ["Cities","Economy","Rivals","Chronicle"]:
		var target:String=page
		overview.append({"label":page,"action":func():app.workspace.open_page(target)})
	for index in app.strategic.selector.item_count:
		var lens:int=index
		overview.append({"label":"Map lens · "+app.strategic.selector.get_item_text(index),"action":func():app.strategic.mode=lens; app.strategic.selector.select(lens); app.strategic._dirty=true})
	NativeUI.menu(self,"Overview ▾",overview)
	alerts=MenuButton.new(); alerts.text="Alerts"; alerts.flat=false; add_child(alerts)
	alerts.get_popup().index_pressed.connect(func(index):
		var note:Dictionary=alert_records[index]
		if note.get("good")!=null: _open_resource(str(note.good))
		elif int(note.get("tile",-1))>=0: app.cam.focus_tile(int(note.tile)); app.workspace.panel.hide()
		else: app.workspace.open_page("Chronicle"))
	NativeUI.compact_button(self,"Settings",func():app.shell.previous="pause"; app.shell.show_view("settings"))

func _process(dt:float) -> void:
	visible=app.world.ready_ and not app.world.spectator
	if not visible: return
	position=Vector2(10,3); size=Vector2(get_viewport_rect().size.x-150,36)
	(values.steel as Button).visible=get_viewport_rect().size.x>=1200
	elapsed+=dt
	if elapsed<.2: return
	elapsed=0
	var world:WorldState=app.world
	empire.text=str(world.civ_by_id.get(world.civ_id,{}).get("name","Empire"))
	var eras:Array=world.defs.get("AGES",[]); var era:=int(world.econ.get("age",0))
	age.text=(str(eras[era].get("name","")) if era<eras.size() else "")+" · "+app.hud._clock(world.server_time)+( " · Paused" if world.paused else "")+_weather()
	var declining:=0
	for index in GameHUD.GOODS.size():
		var key:String=GameHUD.GOODS[index]
		var amount:=float(world.econ.get("res",{}).get(key,0)); var rate:=float(world.econ.get("rates",{}).get(key,0))
		var number:="%.1fk"%(amount/1000.0) if amount>=10000 else str(roundi(amount))
		var description:="%s  %s   (%+.1f / sec)"%[key.capitalize(),number,rate]
		resource_menu.get_popup().set_item_text(index,description)
		var problem:bool=world.econ.get("resources",{}).get(key,{}).get("status","") in ["empty","deficit"]
		if problem: declining+=1
		if values.has(key):
			var button:Button=values[key]; button.text=number+"  "+("%+.1f"%rate if absf(rate)>=.05 else "")
			button.tooltip_text=description+"\nClick to explain production, consumption and shortages"
			button.add_theme_color_override("font_color",Color("e4ad88") if problem else NativeUI.TEXT)
	resource_menu.text="Resources ▾" if declining==0 else "Resources · %d short ▾"%declining

	alert_records=world.notifications.filter(func(note):return note.get("level","") in ["critical","actionable","major","minor"] and not note.get("quiet",false)).slice(0,6)
	alerts.visible=not alert_records.is_empty(); alerts.text="Alerts · %d"%alert_records.size()
	var next:=str(alert_records)
	if next!=alert_signature:
		alert_signature=next; alerts.get_popup().clear()
		for note in alert_records: alerts.get_popup().add_item(str(note.get("text","Alert")))


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
		# wind blows toward this vector; name where it comes from (z points south)
		var from:=-wind
		var index:=posmod(int(round(atan2(-from.y,from.x)/(PI/4.0))),8)
		words.append("wind from %s%s"%[compass[index]," (strong)" if wind.length()>.9 else ""])
	return " · "+", ".join(words)
