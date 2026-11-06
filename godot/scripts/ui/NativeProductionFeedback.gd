class_name NativeProductionFeedback
extends Control
## Positive measured output rates, supplied in building.pr. These are explanatory rate
## indicators, not invented per-tick rewards. Only current visible production is eligible.
const CYCLE_SECONDS := 20.0
const DISPLAY_SECONDS := 4.5
const MAX_VISIBLE := 4
const RISE_PIXELS_PER_SECOND := 3.0
var app:Node
var icons:={}
var font:Font
var clock:=0.0
var shown:Array=[]

static func phase_at(time:float, id:int) -> float:
	# Stable, well-distributed phases avoid entire districts pulsing together.
	return fposmod(time+float(posmod(id*137,997))*CYCLE_SECONDS/997.0,CYCLE_SECONDS)

func setup(game:Node) -> void:
	app=game; set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); mouse_filter=Control.MOUSE_FILTER_IGNORE
	font=load("res://assets/fonts/BarlowSemiCondensed-SemiBold.ttf")
	for good in GameHUD.GOODS+["research","power"]:
		var path:="res://assets/icons/resources/%s.svg"%good
		if ResourceLoader.exists(path): icons[good]=load(path)

func eligible(building:Dictionary) -> bool:
	return int(building.get("d",0))==1 and int(building.get("a",0))==1 and not building.get("off",false) and building.get("st","")!="ruined" and app.world.is_visible(int(building.t)) and not building.get("pr",[]).is_empty()

func _process(dt:float) -> void:
	shown.clear()
	if not app.world.ready_ or app.world.paused or app.shell.is_blocking() or app.shell.world_hidden or not app.strategic.resource_markers or app.cam.size>32: queue_redraw(); return
	clock+=dt
	var candidates:=[]
	for building:Dictionary in app.world.buildings.values():
		if not eligible(building): continue
		var phase:=phase_at(clock,int(building.id))
		if phase>DISPLAY_SECONDS: continue
		var center:Vector2=app.world.grid.center(int(building.t))
		var point:=Vector3(app.world.grid.near_x(center.x,app.cam.focus.x),app.world.tile_height(int(building.t))+.72,center.y)
		var site:Dictionary=app.settlements.site_records.get(int(building.id),{})
		if site.get("valid",false):
			var frame:Transform3D=site.transform
			point=frame.origin+Vector3(0,.72,0); point.x=app.world.grid.near_x(point.x,app.cam.focus.x)
		if building.ty=="arcology": point.y+=.8
		var anchor:Vector2=app.cam.to_screen(point)
		if not Rect2(Vector2(8,100),size-Vector2(16,112)).has_point(anchor): continue
		var outputs:Array=building.pr.filter(func(record):return record.size()>=2 and float(record[1])>.005 and icons.has(str(record[0])))
		if outputs.is_empty(): continue
		var fade:float=smoothstep(0.0,.45,phase)*(1.0-smoothstep(3.6,DISPLAY_SECONDS,phase))*(1.0-smoothstep(22.0,32.0,app.cam.size))
		candidates.append({"id":int(building.id),"outputs":outputs,"anchor":anchor,"phase":phase,"alpha":fade,"distance":anchor.distance_to(size*.5)})
	candidates.sort_custom(func(a,b):return a.distance<b.distance)
	shown=candidates.slice(0,MAX_VISIBLE)
	queue_redraw()

func _draw() -> void:
	for record in shown:
		var anchor:Vector2=record.anchor
		if not app.preferences.values.reduced_motion: anchor.y-=record.phase*RISE_PIXELS_PER_SECOND
		var x:float=anchor.x-record.outputs.size()*29.0
		for output in record.outputs:
			var value:float=float(output[1]); var text:="+%s/s"%(str(roundi(value)) if is_equal_approx(value,roundf(value)) else str(snappedf(value,.01 if value<.1 else .1)))
			draw_texture_rect(icons[str(output[0])],Rect2(Vector2(x,anchor.y-15),Vector2(17,17)),false,Color(1,1,1,record.alpha*.85))
			draw_string_outline(font,Vector2(x+19,anchor.y-2),text,HORIZONTAL_ALIGNMENT_LEFT,-1,12,3,Color(0,0,0,record.alpha*.75))
			draw_string(font,Vector2(x+19,anchor.y-2),text,HORIZONTAL_ALIGNMENT_LEFT,-1,12,Color(.85,.88,.76,record.alpha*.85))
			x+=font.get_string_size(text,HORIZONTAL_ALIGNMENT_LEFT,-1,12).x+27
