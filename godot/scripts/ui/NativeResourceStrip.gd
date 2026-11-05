class_name NativeResourceStrip
extends HBoxContainer
## A readable empire strip: resource amounts and rates link directly to their economic explanation.
var app:Node
var empire:Label
var age:Label
var values:={}
var rates:={}
var elapsed:=0.0
var identity:VBoxContainer
var chips:Array[Button]=[]

func setup(game:Node) -> void:
	app=game; add_theme_constant_override("separation",8)
	identity=VBoxContainer.new(); identity.custom_minimum_size.x=185; identity.add_theme_constant_override("separation",0); add_child(identity)
	empire=NativeUI.label(identity,"",19,NativeUI.GOLD); age=NativeUI.label(identity,"",12,NativeUI.MUTED)
	for good in GameHUD.GOODS:
		var key:String=good
		var button:=Button.new(); button.custom_minimum_size=Vector2(104,48)
		button.add_theme_stylebox_override("normal",NativeUI.style(Color("19272c"),Color("334046"),4))
		button.pressed.connect(func():
			app.workspace.open_page("Resources")
			for index in app.workspace.rows.size():
				if app.workspace.rows[index].key==key: app.workspace._choose(index); return)
		add_child(button)
		chips.append(button)
		var column:=VBoxContainer.new(); column.mouse_filter=Control.MOUSE_FILTER_IGNORE; column.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
		column.offset_left=10; column.offset_top=3; column.offset_right=-8; column.offset_bottom=-2; column.add_theme_constant_override("separation",0); button.add_child(column)
		NativeUI.label(column,key.to_upper(),10,NativeUI.MUTED).mouse_filter=Control.MOUSE_FILTER_IGNORE
		var row:=HBoxContainer.new(); row.mouse_filter=Control.MOUSE_FILTER_IGNORE; column.add_child(row)
		var amount:=NativeUI.label(row,"0",20); amount.mouse_filter=Control.MOUSE_FILTER_IGNORE; values[key]=amount
		amount.autowrap_mode=TextServer.AUTOWRAP_OFF; amount.custom_minimum_size.x=42; amount.size_flags_horizontal=Control.SIZE_EXPAND_FILL
		var rate:=NativeUI.label(row,"",12,NativeUI.MUTED); rate.mouse_filter=Control.MOUSE_FILTER_IGNORE; rate.size_flags_vertical=Control.SIZE_SHRINK_END; rates[key]=rate
		rate.autowrap_mode=TextServer.AUTOWRAP_OFF; rate.custom_minimum_size.x=30
		button.tooltip_text="Review "+key+" production, consumption and supply"

func _process(dt:float) -> void:
	visible=app.world.ready_
	if not visible: return
	position=Vector2(12,3); size=Vector2(get_viewport_rect().size.x-200,48)
	var compact:=get_viewport_rect().size.x<1400
	identity.custom_minimum_size.x=135 if compact else 185
	for chip in chips: chip.custom_minimum_size.x=80 if compact else 104
	for label in rates.values(): label.visible=not compact
	elapsed+=dt
	if elapsed<.2: return
	elapsed=0
	var world:WorldState=app.world
	empire.text=str(world.civ_by_id.get(world.civ_id,{}).get("name","Empire"))
	var eras:Array=world.defs.get("AGES",[]); var era:=int(world.econ.get("age",0))
	age.text=(str(eras[era].get("name","")) if era<eras.size() else "")+"   ·   "+app.hud._clock(world.server_time)+( "  ‖" if world.paused else "")
	for key in values:
		var amount:=float(world.econ.get("res",{}).get(key,0)); var rate:=float(world.econ.get("rates",{}).get(key,0))
		(values[key] as Label).text="%.1fk"%(amount/1000.0) if amount>=10000 else str(roundi(amount))
		(rates[key] as Label).text="%+.1f"%rate
		(rates[key] as Label).add_theme_color_override("font_color",Color("a1c4a1") if rate>=0 else Color("de9b77"))
