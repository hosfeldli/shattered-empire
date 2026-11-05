class_name NativeResearchTree
extends Control
## A native prerequisite graph, laid out from the received technology definitions.
signal technology_selected(key:String)
var world:WorldState
var selected:=""
var cards:={}
var font:Font
var elapsed:=0.0

func setup(w:WorldState) -> void:
	world=w; font=load("res://assets/fonts/BarlowSemiCondensed-Regular.ttf")
	var ranks:={}; var lanes:={}
	for key in world.defs.get("TECHS",{}): _rank(str(key),ranks,{})
	for key in world.defs.get("TECHS",{}):
		var rank:=int(ranks.get(key,0)); var lane:=int(lanes.get(rank,0)); lanes[rank]=lane+1
		cards[key]=Rect2(20+rank*244,28+lane*110,216,82)
	var high:=Vector2.ZERO
	for rect in cards.values(): high.x=maxf(high.x,rect.end.x); high.y=maxf(high.y,rect.end.y)
	custom_minimum_size=high+Vector2(28,28); mouse_filter=Control.MOUSE_FILTER_STOP

func _rank(key:String,cache:Dictionary,visiting:Dictionary) -> int:
	if cache.has(key): return int(cache[key])
	if visiting.has(key): return 0
	visiting[key]=true; var result:=0
	for prerequisite in world.defs.get("TECHS",{}).get(key,{}).get("req",[]): result=maxi(result,_rank(str(prerequisite),cache,visiting)+1)
	visiting.erase(key); cache[key]=result; return result

func _draw() -> void:
	if world==null: return
	for key in cards:
		var rectangle:Rect2=cards[key]; var definition:Dictionary=world.defs.TECHS[key]
		for prerequisite in definition.get("req",[]):
			if not cards.has(prerequisite): continue
			var previous:Rect2=cards[prerequisite]
			var a:=previous.position+Vector2(previous.size.x,previous.size.y*.5); var b:=rectangle.position+Vector2(0,rectangle.size.y*.5)
			draw_polyline(PackedVector2Array([a,Vector2((a.x+b.x)*.5,a.y),Vector2((a.x+b.x)*.5,b.y),b]),Color(.28,.39,.41),2,true)
	for key in cards:
		var rectangle:Rect2=cards[key]; var definition:Dictionary=world.defs.TECHS[key]
		var complete:bool=key in world.econ.get("techs",[]); var active:bool=world.econ.get("research")==key; var queued:bool=key in world.econ.get("queue",[])
		var fill:=Color("253a35") if complete else Color("343c33") if active else Color("21313d") if queued else Color("192329")
		draw_style_box(NativeUI.style(fill,NativeUI.GOLD if active or selected==key else Color("435057"),8),rectangle)
		var name_:String=str(definition.name); var first:=""; var second:=""
		for word in name_.split(" "):
			if first.length()+word.length()<23 and second.is_empty(): first+=(" " if not first.is_empty() else "")+word
			else: second+=(" " if not second.is_empty() else "")+word
		draw_string(font,rectangle.position+Vector2(12,23),first,HORIZONTAL_ALIGNMENT_LEFT,192,17,NativeUI.TEXT)
		if not second.is_empty(): draw_string(font,rectangle.position+Vector2(12,43),second,HORIZONTAL_ALIGNMENT_LEFT,192,17,NativeUI.TEXT)
		var status:="COMPLETE" if complete else "RESEARCHING" if active else "QUEUED" if queued else "%d POINTS"%int(definition.cost)
		draw_string(font,rectangle.position+Vector2(12,67),status,HORIZONTAL_ALIGNMENT_LEFT,192,12,NativeUI.GOLD if active else NativeUI.MUTED)

func _gui_input(event:InputEvent) -> void:
	if event is InputEventMouseButton and event.pressed and event.button_index==MOUSE_BUTTON_LEFT:
		for key in cards:
			if (cards[key] as Rect2).has_point(event.position): selected=str(key); technology_selected.emit(selected); queue_redraw(); accept_event(); return

func _process(dt:float) -> void:
	elapsed+=dt
	if elapsed>.25: elapsed=0; queue_redraw()
