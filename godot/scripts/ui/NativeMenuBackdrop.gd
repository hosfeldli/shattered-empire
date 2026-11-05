class_name NativeMenuBackdrop
extends Control
## Native vector cartography for the menu; decorative, independent from match knowledge.
func _ready() -> void:
	mouse_filter=Control.MOUSE_FILTER_IGNORE; resized.connect(queue_redraw)

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
