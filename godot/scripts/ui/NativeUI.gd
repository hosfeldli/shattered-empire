class_name NativeUI
extends RefCounted
## One design system for every native control: a quiet slate field-command look with an amber
## accent, translucent panels that keep the world visible, and a few semantic colours.
const GOLD:=Color("e2b863")        # primary accent: selection, focus, primary actions
const INK:=Color("0d1216")
const TEXT:=Color("ebe7dc")
const MUTED:=Color("98a5ab")
const TEAL:=Color("6fbfc4")        # information, research
const GOOD:=Color("8fc27e")        # gains, completed
const BAD:=Color("e0806a")         # shortages, danger
const PANEL:=Color(.055,.075,.09,.93)
const PANEL_SOFT:=Color(.075,.1,.12,.86)
const LINE:=Color(1,1,1,.08)
const RADIUS:=7
static var font_scale:=1.0
static var heading_font:Font

static func style(color:Color,border:=LINE,padding:=12,radius:=RADIUS,shadow:=false) -> StyleBoxFlat:
	var box:=StyleBoxFlat.new(); box.bg_color=color; box.border_color=border
	box.set_border_width_all(1); box.set_corner_radius_all(radius)
	box.content_margin_left=padding; box.content_margin_right=padding
	box.content_margin_top=padding; box.content_margin_bottom=padding
	box.anti_aliasing=true
	if shadow: box.shadow_color=Color(0,0,0,.35); box.shadow_size=10; box.shadow_offset=Vector2(0,3)
	return box

static func theme(scale_:=1.0) -> Theme:
	font_scale=scale_
	var result:=Theme.new(); result.default_font_size=roundi(15*scale_)
	result.default_font=load("res://assets/fonts/BarlowSemiCondensed-Regular.ttf")
	if heading_font==null:
		var font:=FontVariation.new(); font.base_font=load("res://assets/fonts/CormorantGaramond.ttf"); font.variation_opentype={"wght":600}; heading_font=font
	for type in ["Label","Button","CheckButton","CheckBox","OptionButton","MenuButton","LinkButton"]:
		result.set_color("font_color",type,TEXT)
	for type in ["Button","OptionButton","MenuButton","CheckButton"]:
		result.set_color("font_hover_color",type,Color("fff3d6"))
		result.set_color("font_pressed_color",type,GOLD)
		result.set_color("font_focus_color",type,TEXT)
		result.set_color("font_disabled_color",type,Color(.55,.6,.63,.6))
		result.set_color("icon_normal_color",type,Color(TEXT,.92))
		result.set_color("icon_hover_color",type,GOLD)
	for type in ["Button","OptionButton","MenuButton"]:
		result.set_stylebox("normal",type,style(Color(1,1,1,.045),Color(1,1,1,.09),10))
		result.set_stylebox("hover",type,style(Color(1,1,1,.09),Color(GOLD,.55),10))
		result.set_stylebox("pressed",type,style(Color(GOLD,.18),GOLD,10))
		result.set_stylebox("disabled",type,style(Color(1,1,1,.02),Color(1,1,1,.04),10))
		result.set_stylebox("focus",type,style(Color(0,0,0,0),Color(GOLD,.7),0))
	result.set_stylebox("panel","PanelContainer",style(PANEL,LINE,14,RADIUS,true))
	result.set_stylebox("panel","PopupMenu",style(Color(.06,.08,.1,.98),Color(1,1,1,.1),6,RADIUS,true))
	result.set_stylebox("hover","PopupMenu",style(Color(GOLD,.16),Color(0,0,0,0),6,4))
	result.set_color("font_color","PopupMenu",TEXT); result.set_color("font_hover_color","PopupMenu",Color("fff3d6"))
	result.set_color("font_disabled_color","PopupMenu",Color(.55,.6,.63,.6))
	result.set_constant("v_separation","PopupMenu",6)
	result.set_stylebox("panel","TooltipPanel",style(Color(.04,.055,.07,.97),Color(GOLD,.25),8,5,true))
	result.set_color("font_color","TooltipLabel",TEXT)
	result.set_font_size("font_size","TooltipLabel",roundi(14*scale_))
	for type in ["LineEdit","TextEdit","ItemList","Tree"]:
		result.set_stylebox("normal",type,style(Color(0,0,0,.28),Color(1,1,1,.1),8))
		result.set_stylebox("focus",type,style(Color(0,0,0,.28),Color(GOLD,.6),8))
		result.set_stylebox("panel",type,style(Color(0,0,0,.28),Color(1,1,1,.08),6))
		result.set_color("font_color",type,TEXT)
		result.set_stylebox("selected",type,style(Color(GOLD,.18),GOLD,4))
	# slim scrollbars and separators keep panels calm
	for type in ["VScrollBar","HScrollBar"]:
		result.set_stylebox("scroll",type,style(Color(1,1,1,.03),Color(0,0,0,0),0,4))
		result.set_stylebox("grabber",type,style(Color(1,1,1,.16),Color(0,0,0,0),0,4))
		result.set_stylebox("grabber_highlight",type,style(Color(GOLD,.5),Color(0,0,0,0),0,4))
		result.set_stylebox("grabber_pressed",type,style(GOLD,Color(0,0,0,0),0,4))
	var rule:=StyleBoxLine.new(); rule.color=LINE; rule.thickness=1
	result.set_stylebox("separator","HSeparator",rule)
	result.set_constant("separation","VBoxContainer",8)
	result.set_constant("separation","HBoxContainer",8)
	return result

## A primary (accent-filled) action: at most one per card, so the next step is always obvious.
static func primary(item:Button) -> Button:
	item.add_theme_stylebox_override("normal",style(Color(GOLD,.22),Color(GOLD,.75),10))
	item.add_theme_stylebox_override("hover",style(Color(GOLD,.34),GOLD,10))
	item.add_theme_stylebox_override("pressed",style(Color(GOLD,.45),GOLD,10))
	item.add_theme_color_override("font_color",Color("fff3d6"))
	return item

## An icon-only round control with a tooltip, for the top bar and cards.
static func icon_button(parent:Node,kind:String,explanation:String,action:Callable,diameter:=34) -> Button:
	var item:=Button.new(); item.custom_minimum_size=Vector2(diameter,diameter); item.tooltip_text=explanation
	item.focus_mode=Control.FOCUS_NONE; item.mouse_force_pass_scroll_events=true
	for state in ["normal","hover","pressed"]:
		item.add_theme_stylebox_override(state,style(Color(1,1,1,.0 if state=="normal" else .08 if state=="hover" else .14),Color(GOLD,0.0 if state=="normal" else .5),0,int(diameter/2)))
	var glyph:=NativeIcon.new(); glyph.kind=kind; glyph.mouse_filter=Control.MOUSE_FILTER_IGNORE
	glyph.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); item.add_child(glyph)
	item.pressed.connect(action); parent.add_child(item); return item

static func label(parent:Node,message:String,size_:=16,color:=TEXT) -> Label:
	var item:=Label.new(); item.text=message; item.set_meta("ui_font_size",size_); item.add_theme_font_size_override("font_size",roundi(size_*font_scale))
	if size_>=24 and heading_font!=null: item.add_theme_font_override("font",heading_font)
	elif size_>=19: item.add_theme_font_override("font",load("res://assets/fonts/BarlowSemiCondensed-SemiBold.ttf"))
	item.add_theme_color_override("font_color",color); item.autowrap_mode=TextServer.AUTOWRAP_WORD_SMART
	parent.add_child(item); return item

static func button(parent:Node,message:String,action:Callable) -> Button:
	var item:=Button.new(); item.text=message; item.custom_minimum_size.y=36
	item.mouse_force_pass_scroll_events=true    # the wheel scrolls the list under the button
	item.pressed.connect(action); parent.add_child(item); return item

static func compact_button(parent:Node,message:String,action:Callable,explanation:="") -> Button:
	var item:=button(parent,message,action); item.custom_minimum_size.y=30
	item.add_theme_font_size_override("font_size",14)
	item.focus_mode=Control.FOCUS_NONE
	_compact_styles(item)
	item.tooltip_text=explanation
	var kind:=icon_for(message)
	if not kind.is_empty():
		var glyph:=NativeIcon.new(); glyph.kind=kind; glyph.mouse_filter=Control.MOUSE_FILTER_IGNORE
		glyph.custom_minimum_size=Vector2(16,16); glyph.size=Vector2(16,16); glyph.position=Vector2(8,7)
		item.add_child(glyph); item.alignment=HORIZONTAL_ALIGNMENT_LEFT
		for state in ["normal","hover","pressed","disabled"]:
			(item.get_theme_stylebox(state) as StyleBoxFlat).content_margin_left=30
	return item

static func _compact_styles(item:Control) -> void:
	var looks:={"normal":[Color(1,1,1,.045),Color(1,1,1,.09)],"hover":[Color(1,1,1,.1),Color(GOLD,.55)],"pressed":[Color(GOLD,.2),GOLD],"disabled":[Color(1,1,1,.02),Color(1,1,1,.04)]}
	for state in looks:
		var box:=style(looks[state][0],looks[state][1],9,6)
		box.content_margin_top=5; box.content_margin_bottom=5
		item.add_theme_stylebox_override(state,box)

## The icon that best names a common action, so cards read at a glance.
static func icon_for(message:String) -> String:
	var text:=message.to_lower()
	for pair in [["attack","attack"],["defend","defend"],["explore","explore"],["move","move"],["upgrade","upgrade"],["repair","repair"],["train","train"],["rally","rally"],["follow","follow"],["cancel","close"],["deselect","close"],["pause works","pause"],["resume","play"],["build","build"],["manage","city"],["production","industry"],["research","research"],["deploy","formation"],["confirm","check"]]:
		if text.begins_with(pair[0]) or text.contains(" "+pair[0]): return pair[1]
	return ""

static func menu(parent:Node,title:String,entries:Array) -> MenuButton:
	var item:=MenuButton.new(); item.flat=false; item.text=title; item.custom_minimum_size.y=30; item.add_theme_font_size_override("font_size",14); parent.add_child(item)
	_compact_styles(item)
	var popup:=item.get_popup(); popup.add_theme_font_size_override("font_size",15)
	for entry in entries:
		popup.add_item(str(entry.label)); popup.set_item_disabled(popup.item_count-1,bool(entry.get("disabled",false)))
		popup.set_item_tooltip(popup.item_count-1,str(entry.get("tip","")))
	popup.index_pressed.connect(func(index): (entries[index].action as Callable).call())
	return item

static func options(parent:Node,rows:Array) -> OptionButton:
	var item:=OptionButton.new(); item.custom_minimum_size.y=38; item.size_flags_horizontal=Control.SIZE_EXPAND_FILL
	item.fit_to_longest_item=false; item.clip_text=true
	for row in rows:
		item.add_item(str(row[1])); item.set_item_metadata(item.item_count-1,row[0])
	parent.add_child(item); return item

static func value(item:OptionButton) -> Variant:
	return item.get_item_metadata(item.selected) if item.selected>=0 else null

static func field(parent:Node,title:String) -> HBoxContainer:
	var row:=HBoxContainer.new(); parent.add_child(row)
	var title_label:=label(row,title); title_label.custom_minimum_size.x=170
	title_label.size_flags_vertical=Control.SIZE_SHRINK_CENTER
	return row

static func clear(parent:Node) -> void:
	for child in parent.get_children(): parent.remove_child(child); child.queue_free()
