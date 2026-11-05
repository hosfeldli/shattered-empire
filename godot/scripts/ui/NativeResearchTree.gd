class_name NativeResearchTree
extends Control
## Era columns with actionable cards. Only the selected prerequisite path draws connectors;
## filters make current choices readable without losing the complete five-era development map.
signal technology_selected(key:String)
var world:WorldState
var model:ResearchPresentation
var selected:=""
var cards:={}
var headers:Array=[]
var font:Font
var elapsed:=0.0
var query:=""
var view_filter:=0
var era:=-1
var _signature:=""

func setup(w:WorldState) -> void:
	world=w; model=ResearchPresentation.new(w); font=load("res://assets/fonts/BarlowSemiCondensed-Regular.ttf")
	mouse_filter=Control.MOUSE_FILTER_STOP; layout_cards()

func configure(text:String,filter_:int,era_:int) -> void:
	query=text.strip_edges().to_lower(); view_filter=filter_; era=era_; layout_cards()

func layout_cards() -> void:
	cards.clear(); headers.clear()
	var definitions:Dictionary=world.defs.get("TECHS",{}); var columns:={}
	for key:String in definitions:
		var info:Dictionary=definitions[key]; var age:=int(info.get("age",0))
		if era>=0 and age!=era: continue
		if view_filter==0 and not model.ready(key) and key!=world.econ.get("research") and not key in world.econ.get("queue",[]): continue
		if view_filter==2 and not key in world.econ.get("techs",[]): continue
		var searchable:=(str(info.get("name",""))+" "+str(info.get("desc",""))+" "+" ".join(model.unlocks(key))).to_lower()
		if not query.is_empty() and not query in searchable: continue
		if not columns.has(age): columns[age]=[]
		columns[age].append(key)
	var ages:=columns.keys(); ages.sort(); var height:=120.0
	for column in ages.size():
		var age:int=ages[column]; var list:Array=columns[age]
		list.sort_custom(func(a,b):
			var ar:=0 if model.ready(a) else 1; var br:=0 if model.ready(b) else 1
			return ar<br if ar!=br else int(definitions[a].cost)<int(definitions[b].cost))
		var era_defs:Array=world.defs.get("AGES",[])
		headers.append({"title":str(era_defs[age].name) if age<era_defs.size() else "Era %d"%age,"position":Vector2(16+column*246,24)})
		for row in list.size(): cards[list[row]]=Rect2(16+column*246,42+row*120,228,106)
		height=maxf(height,52+list.size()*120)
	custom_minimum_size=Vector2(maxi(1,ages.size())*246+16,height)
	_signature=str([world.econ.get("techs",[]),world.econ.get("research"),world.econ.get("queue",[]),world.econ.get("age",0)])
	queue_redraw()

func _draw() -> void:
	if world==null: return
	for header in headers: draw_string(font,header.position,header.title,HORIZONTAL_ALIGNMENT_LEFT,228,17,NativeUI.GOLD)
	if cards.is_empty():
		draw_string(font,Vector2(18,34),"No matching technologies",HORIZONTAL_ALIGNMENT_LEFT,320,18,NativeUI.TEXT)
		draw_string(font,Vector2(18,60),"Choose All technologies to plan a future unlock.",HORIZONTAL_ALIGNMENT_LEFT,360,15,NativeUI.MUTED)
	var path:Array=model.path(selected) if not selected.is_empty() else []
	for key in path:
		if not cards.has(key): continue
		var rectangle:Rect2=cards[key]
		for prerequisite in world.defs.TECHS[key].get("req",[]):
			if not cards.has(prerequisite): continue
			var previous:Rect2=cards[prerequisite]
			var a:=previous.position+Vector2(previous.size.x,previous.size.y*.5); var b:=rectangle.position+Vector2(0,rectangle.size.y*.5)
			draw_polyline(PackedVector2Array([a,Vector2(a.x+8,a.y),Vector2(a.x+8,b.y),b]),Color(.65,.56,.34,.65),2,true)
	for key:String in cards:
		var rectangle:Rect2=cards[key]; var definition:Dictionary=world.defs.TECHS[key]
		var status:=model.status(key); var chosen:=selected==key
		var fill:=Color("253a35") if status=="Complete" else Color("303931") if status=="Researching" else Color("1d3038") if model.ready(key) else Color("192329")
		draw_style_box(NativeUI.style(fill,NativeUI.GOLD if chosen or status=="Researching" else Color("617268") if key in path else Color("35474d"),6),rectangle)
		var text:=str(definition.name); var first:=""; var second:=""
		for word in text.split(" "):
			if font.get_string_size(first+" "+word,HORIZONTAL_ALIGNMENT_LEFT,-1,17).x<202 and second.is_empty(): first+=(" " if not first.is_empty() else "")+word
			else: second+=(" " if not second.is_empty() else "")+word
		draw_string(font,rectangle.position+Vector2(10,22),first,HORIZONTAL_ALIGNMENT_LEFT,208,17,NativeUI.TEXT)
		if not second.is_empty(): draw_string(font,rectangle.position+Vector2(10,41),second,HORIZONTAL_ALIGNMENT_LEFT,208,17,NativeUI.TEXT)
		var unlocks:=model.unlocks(key); var summary:=" · ".join(unlocks) if not unlocks.is_empty() else str(definition.get("desc",""))
		var clipped:=summary
		while font.get_string_size(clipped,HORIZONTAL_ALIGNMENT_LEFT,-1,13).x>201 and clipped.length()>3: clipped=clipped.left(clipped.length()-4)+"…"
		draw_string(font,rectangle.position+Vector2(10,64),clipped,HORIZONTAL_ALIGNMENT_LEFT,208,13,NativeUI.MUTED)
		var footer:=status if status!="Available now" else "%d points · %s"%[int(definition.cost),model.estimate(key)]
		draw_string(font,rectangle.position+Vector2(10,91),footer,HORIZONTAL_ALIGNMENT_LEFT,208,13,NativeUI.GOLD if model.ready(key) or status=="Researching" else NativeUI.MUTED)

func _gui_input(event:InputEvent) -> void:
	if event is InputEventMouseButton and event.pressed and event.button_index==MOUSE_BUTTON_LEFT:
		for key in cards:
			if (cards[key] as Rect2).has_point(event.position): selected=str(key); technology_selected.emit(selected); queue_redraw(); accept_event(); return

func _process(dt:float) -> void:
	elapsed+=dt
	if elapsed>.5:
		elapsed=0
		var signature:=str([world.econ.get("techs",[]),world.econ.get("research"),world.econ.get("queue",[]),world.econ.get("age",0)])
		if signature!=_signature: layout_cards()
		else: queue_redraw()
