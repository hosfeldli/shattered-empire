class_name NativeObserverBar
extends HBoxContainer
## Watching an AI match replaces player tools with a small time/view controller.
var app:Node
var following:OptionButton
var time_label:Label
var speeds:={}
var fog:CheckButton
var signature:=""

func setup(game:Node) -> void:
	app=game; theme=NativeUI.theme(); add_theme_constant_override("separation",5)
	var label:=NativeUI.label(self,"WATCHING",13,NativeUI.GOLD); label.autowrap_mode=TextServer.AUTOWRAP_OFF
	following=OptionButton.new(); following.custom_minimum_size.x=160; following.fit_to_longest_item=false; following.clip_text=true; add_child(following)
	following.item_selected.connect(func(index):app.commands.submit({"c":"follow","civ":following.get_item_metadata(index)}))
	time_label=NativeUI.label(self,"",14,NativeUI.MUTED); time_label.custom_minimum_size.x=54
	time_label.autowrap_mode=TextServer.AUTOWRAP_OFF
	for rate in [0,1,2,4,8]:
		var speed:int=rate
		var button:=NativeUI.compact_button(self,"Pause" if rate==0 else "%d×"%rate,func():app.commands.submit({"c":"speed","speed":speed}))
		button.toggle_mode=true; speeds[rate]=button
	fog=CheckButton.new(); fog.text="Fog"; fog.tooltip_text="Show only what the watched civilization knows"; fog.toggled.connect(func(on):app.commands.submit({"c":"fog","on":on})); add_child(fog)
	var entries:=[]
	for page in ["Cities","Economy","Rivals","Chronicle"]:
		var target:String=page
		entries.append({"label":target,"action":func():app.workspace.open_page(target)})
	NativeUI.menu(self,"Overview ▾",entries)
	NativeUI.compact_button(self,"Menu",func():app.shell.show_view("pause"))

## its own translucent pill, matching the player top bar (the old full-width strip is gone)
func _draw() -> void:
	draw_style_box(NativeUI.style(NativeUI.PANEL,NativeUI.LINE,0,10,true),Rect2(Vector2(-10,-5),size+Vector2(20,10)))

func _notification(what:int) -> void:
	if what==NOTIFICATION_RESIZED: queue_redraw()

func _process(_dt:float) -> void:
	visible=app.world.ready_ and app.world.spectator and not app.shell.world_hidden and not app.shell.is_blocking()
	if not visible: return
	position=Vector2(20,13)
	size=Vector2.ZERO
	var civs:Array=app.world.civ_by_id.values(); var next:=str(civs.map(func(civ):return [civ.id,civ.name]))
	if next!=signature:
		signature=next; following.clear()
		for civ:Dictionary in civs: following.add_item(str(civ.name)); following.set_item_metadata(following.item_count-1,int(civ.id))
	for index in following.item_count:
		if int(following.get_item_metadata(index))==app.world.civ_id: following.select(index)
	time_label.text=app.hud._clock(app.world.server_time)
	for rate in speeds: (speeds[rate] as Button).set_pressed_no_signal(is_equal_approx(float(rate),float(app.world.observer.get("speed",1))))
	fog.set_pressed_no_signal(bool(app.world.observer.get("fog",false)))
