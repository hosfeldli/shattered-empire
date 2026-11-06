class_name NativeUI
extends RefCounted
## Native controls share one restrained palette and spacing system.
const GOLD:=Color("d8b977")
const INK:=Color("11171d")
const TEXT:=Color("e8e4d9")
const MUTED:=Color("a2afb5")
static var font_scale:=1.0
static var heading_font:Font

static func style(color:Color,border:=Color("34434a"),padding:=12) -> StyleBoxFlat:
	var box:=StyleBoxFlat.new(); box.bg_color=color; box.border_color=border
	box.set_border_width_all(1); box.set_corner_radius_all(4)
	box.content_margin_left=padding; box.content_margin_right=padding
	box.content_margin_top=padding; box.content_margin_bottom=padding
	return box

static func theme(scale_:=1.0) -> Theme:
	font_scale=scale_
	var result:=Theme.new(); result.default_font_size=roundi(16*scale_)
	result.default_font=load("res://assets/fonts/BarlowSemiCondensed-Regular.ttf")
	if heading_font==null:
		var font:=FontVariation.new(); font.base_font=load("res://assets/fonts/CormorantGaramond.ttf"); font.variation_opentype={"wght":600}; heading_font=font
	result.set_color("font_color","Label",TEXT)
	result.set_color("font_color","Button",TEXT)
	result.set_color("font_hover_color","Button",GOLD)
	result.set_color("font_disabled_color","Button",Color("74818a"))
	for type in ["Button","OptionButton","MenuButton"]:
		result.set_stylebox("normal",type,style(Color("202830"),Color("3c454a")))
		result.set_stylebox("hover",type,style(Color("303b43"),GOLD))
		result.set_stylebox("pressed",type,style(Color("39454b"),GOLD))
		result.set_stylebox("disabled",type,style(Color("172126")))
		result.set_stylebox("focus",type,style(Color(0,0,0,0),GOLD,0))
	result.set_stylebox("panel","PanelContainer",style(Color("171e24"),Color("4b5357")))
	for type in ["LineEdit","TextEdit","ItemList","Tree"]:
		result.set_stylebox("normal",type,style(INK))
		result.set_stylebox("panel",type,style(INK))
		result.set_color("font_color",type,TEXT)
		result.set_stylebox("selected",type,style(Color("3c5059"),GOLD,4))
	result.set_constant("separation","VBoxContainer",10)
	result.set_constant("separation","HBoxContainer",10)
	return result

static func label(parent:Node,message:String,size_:=16,color:=TEXT) -> Label:
	var item:=Label.new(); item.text=message; item.set_meta("ui_font_size",size_); item.add_theme_font_size_override("font_size",roundi(size_*font_scale))
	if size_>=24 and heading_font!=null: item.add_theme_font_override("font",heading_font)
	elif size_>=19: item.add_theme_font_override("font",load("res://assets/fonts/BarlowSemiCondensed-SemiBold.ttf"))
	item.add_theme_color_override("font_color",color); item.autowrap_mode=TextServer.AUTOWRAP_WORD_SMART
	parent.add_child(item); return item

static func button(parent:Node,message:String,action:Callable) -> Button:
	var item:=Button.new(); item.text=message; item.custom_minimum_size.y=38
	item.mouse_force_pass_scroll_events=false
	item.pressed.connect(action); parent.add_child(item); return item

static func compact_button(parent:Node,message:String,action:Callable,explanation:="") -> Button:
	var item:=button(parent,message,action); item.custom_minimum_size.y=30
	item.add_theme_font_size_override("font_size",15)
	for state in ["normal","hover","pressed","disabled"]:
		var box:StyleBoxFlat=item.get_theme_stylebox(state).duplicate()
		box.content_margin_top=5; box.content_margin_bottom=5; box.content_margin_left=9; box.content_margin_right=9
		item.add_theme_stylebox_override(state,box)
	item.tooltip_text=explanation
	return item

static func menu(parent:Node,title:String,entries:Array) -> MenuButton:
	var item:=MenuButton.new(); item.flat=false; item.text=title; item.custom_minimum_size.y=30; item.add_theme_font_size_override("font_size",15); parent.add_child(item)
	for state in ["normal","hover","pressed","disabled"]:
		var box:StyleBoxFlat=item.get_theme_stylebox(state).duplicate(); box.content_margin_top=5; box.content_margin_bottom=5
		item.add_theme_stylebox_override(state,box)
	var popup:=item.get_popup(); popup.add_theme_font_size_override("font_size",16)
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
