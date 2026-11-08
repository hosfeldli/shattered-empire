class_name NativeMenuBackdrop
extends Control
## Native vector cartography for the menu; decorative, independent from match knowledge.
var clock:=0.0

func _ready() -> void:
	mouse_filter=Control.MOUSE_FILTER_IGNORE; resized.connect(queue_redraw)

## alive but calm: settlement lights pulse slowly and a little ash drifts over the old map
func _process(dt:float) -> void:
	if not is_visible_in_tree(): return
	clock+=dt; queue_redraw()

func _draw() -> void:
	var step:=30.0; var tilt:=.58
	for row in 34:
		for col in 46:
			var x:=float(col)*step*1.732+float(row%2)*step*.866
			var y:=float(row)*step*1.5
			var h:=sin(col*.17+row*.22)*.5+cos(col*.23-row*.12)*.35+sin(row*.37)*.15
			var center:=Vector2(x,y*tilt)-Vector2(500,90)+size*Vector2(.51,.2)
			var points:=PackedVector2Array()
			for corner in 6:
				var angle:=TAU*corner/6.0+PI/6.0
				points.append(center+Vector2(cos(angle)*step,sin(angle)*step*tilt)-Vector2(0,maxf(h,0)*36))
			var color:=Color(.12,.21,.23,.16) if h<0 else Color(.25,.34,.31,.19)
			draw_colored_polygon(points,color)
			points.append(points[0]); draw_polyline(points,Color(.55,.58,.4,.08),1,true)
			if h>.6: draw_line(points[3],points[0],Color(.8,.7,.45,.11),1,true)
	for k in 12:
		var p:=Vector2(fposmod(sin(k*12.9898)*43758.5453,1.0),fposmod(sin(k*78.233)*12345.678,1.0))*size*Vector2(.8,.7)+size*Vector2(.15,.18)
		var pulse:=.5+.5*sin(clock*.8+k*1.7)
		draw_circle(p,9.0+4.0*pulse,Color(1.0,.78,.42,.05+.04*pulse)); draw_circle(p,2.4,Color(1.0,.85,.55,.55+.3*pulse))
	for k in 70:
		var x:=fposmod(k*.137+sin(clock*.2+k)*.01,1.0); var y:=fposmod(k*.071+clock*(.004+float(k%5)*.002),1.0)
		draw_circle(Vector2(x,y)*size,1.3,Color(.75,.73,.7,.22))
