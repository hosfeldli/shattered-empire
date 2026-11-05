class_name NativeSectionNav
extends ScrollContainer
signal page_selected(title:String)
const MAIN:={"World":"World","Build":"Construction","Cities":"Cities","Military":"Military","Economy":"Economy","Research":"Research","Rivals":"Rivals","Chronicle":"Alerts"}
var items:Array=[]
var buttons:={}
var item_count:int:
	get: return MAIN.size()

func setup(pages:Array) -> void:
	items=pages
	custom_minimum_size.x=130; horizontal_scroll_mode=ScrollContainer.SCROLL_MODE_DISABLED
	var column:=VBoxContainer.new(); column.size_flags_horizontal=Control.SIZE_EXPAND_FILL; column.add_theme_constant_override("separation",5); add_child(column)
	for title in MAIN:
		var target:String=MAIN[title]
		var button:=NativeUI.button(column,title,func():page_selected.emit(target))
		button.alignment=HORIZONTAL_ALIGNMENT_LEFT; button.custom_minimum_size.y=44
		var icon:=NativeRailIcon.new(); icon.title=title; icon.position=Vector2(10,10); icon.mouse_filter=Control.MOUSE_FILTER_IGNORE; button.add_child(icon)
		buttons[target]=button

func set_mode(_observer:bool,_sandbox:bool) -> void: pass

func select(index:int) -> void:
	if index<0 or index>=items.size(): return
	var aliases:={"Resources":"Economy","Logistics":"Economy","Buildings":"Construction","Production":"Cities","Armies":"Military","Formations":"Military","Air":"Military","Strategic":"Military","Battles":"Alerts","History":"Alerts"}
	var current:String=aliases.get(items[index],items[index])
	for target in buttons:
		var style:=NativeUI.style(Color("314247") if target==current else Color(0,0,0,0),Color(0,0,0,0),5)
		style.content_margin_left=42
		if target==current: style.border_color=NativeUI.GOLD; style.border_width_left=2
		(buttons[target] as Button).add_theme_stylebox_override("normal",style)
