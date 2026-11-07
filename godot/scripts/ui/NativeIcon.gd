class_name NativeIcon
extends Control
## Crisp vector icons drawn on a 24-unit grid and scaled to the control, so they stay sharp at any
## interface scale. One consistent line weight, rounded joins and the shared accent colour.
var kind := "info"
var color := Color(-1, 0, 0)   # negative red = use the theme accent
var weight := 1.7


func _ready() -> void:
	if size == Vector2.ZERO: size = custom_minimum_size if custom_minimum_size != Vector2.ZERO else Vector2(20, 20)


func _draw() -> void:
	var c := NativeUI.GOLD if color.r < 0.0 else color
	var side := minf(size.x, size.y)
	var k := side / 24.0
	var o := (size - Vector2(side, side)) * 0.5
	var p := func(x: float, y: float) -> Vector2: return o + Vector2(x, y) * k
	var line := func(points: Array, closed := false) -> void:
		var pts := PackedVector2Array()
		for q in points: pts.append(p.call(q[0], q[1]))
		if closed: pts.append(pts[0])
		draw_polyline(pts, c, weight * maxf(k, .75), true)
	var circle := func(x: float, y: float, r: float, filled := false) -> void:
		if filled: draw_circle(p.call(x, y), r * k, c)
		else: draw_arc(p.call(x, y), r * k, 0, TAU, 32, c, weight * maxf(k, .75), true)
	var fill := func(points: Array, alpha := 1.0) -> void:
		var pts := PackedVector2Array()
		for q in points: pts.append(p.call(q[0], q[1]))
		draw_colored_polygon(pts, Color(c, alpha))
	match kind:
		"build":      # hammer over a brick
			line.call([[4, 20], [14, 10]]); fill.call([[11, 5], [16, 2], [22, 8], [17, 13]], .9)
		"army":       # shield with chevron
			line.call([[12, 2], [20, 5], [19, 14], [12, 22], [5, 14], [4, 5]], true); line.call([[8, 10], [12, 14], [16, 10]])
		"research":   # flask
			line.call([[9, 2], [15, 2]]); line.call([[10, 2], [10, 9], [4, 19], [6, 22], [18, 22], [20, 19], [14, 9], [14, 2]])
			fill.call([[6.5, 17], [17.5, 17], [19, 19.5], [17.5, 21], [6.5, 21], [5, 19.5]], .7)
		"overview":   # globe
			circle.call(12, 12, 9.5); line.call([[2.5, 12], [21.5, 12]]); draw_arc(p.call(12, 12), 9.5 * k, -PI * .5, PI * .5, 24, c, weight * k * .8, true)
			line.call([[12, 2.5], [12, 21.5]])
		"alerts":     # bell
			line.call([[6, 17], [6, 10], [8, 5.5], [12, 4], [16, 5.5], [18, 10], [18, 17], [20, 19], [4, 19], [6, 17]]); circle.call(12, 21.5, 1.6, true)
		"settings":   # gear
			circle.call(12, 12, 3.4)
			for i in 8:
				var a := TAU * i / 8.0
				line.call([[12 + cos(a) * 6.5, 12 + sin(a) * 6.5], [12 + cos(a) * 9.5, 12 + sin(a) * 9.5]])
			circle.call(12, 12, 6.8)
		"move":       # arrow
			line.call([[3, 12], [20, 12]]); line.call([[14, 6], [20, 12], [14, 18]])
		"attack":     # crosshair
			circle.call(12, 12, 7.5); line.call([[12, 1.5], [12, 7]]); line.call([[12, 17], [12, 22.5]]); line.call([[1.5, 12], [7, 12]]); line.call([[17, 12], [22.5, 12]]); circle.call(12, 12, 1.5, true)
		"defend":     # filled shield
			fill.call([[12, 2], [20, 5], [19, 14], [12, 22], [5, 14], [4, 5]], .85)
		"explore":    # compass
			circle.call(12, 12, 9.5); fill.call([[12, 5], [14.5, 12], [12, 19], [9.5, 12]], .9)
		"upgrade":    # double up-chevron
			line.call([[6, 12], [12, 6], [18, 12]]); line.call([[6, 19], [12, 13], [18, 19]])
		"repair":     # wrench
			line.call([[5, 19], [13, 11]]); circle.call(16, 8, 4.5)
		"train":      # soldier figure
			circle.call(12, 6, 3); line.call([[6, 22], [7, 13], [12, 11], [17, 13], [18, 22]])
		"rally":      # flag
			line.call([[6, 22], [6, 3]]); fill.call([[6, 3], [19, 6.5], [6, 11]], .85)
		"follow":     # eye
			line.call([[2, 12], [7, 7], [12, 5.5], [17, 7], [22, 12], [17, 17], [12, 18.5], [7, 17], [2, 12]]); circle.call(12, 12, 3, true)
		"close":      # x
			line.call([[6, 6], [18, 18]]); line.call([[18, 6], [6, 18]])
		"check":
			line.call([[5, 13], [10, 18], [19, 7]])
		"pause":
			fill.call([[6, 5], [10, 5], [10, 19], [6, 19]], .9); fill.call([[14, 5], [18, 5], [18, 19], [14, 19]], .9)
		"play":
			fill.call([[7, 4], [20, 12], [7, 20]], .9)
		"city":       # skyline
			line.call([[2, 21], [22, 21]]); line.call([[4, 21], [4, 11], [10, 11], [10, 21]]); line.call([[13, 21], [13, 4], [20, 4], [20, 21]]); line.call([[16, 8], [17, 8]]); line.call([[16, 12], [17, 12]])
		"industry":   # factory
			line.call([[2, 21], [2, 11], [8, 14], [8, 11], [14, 14], [14, 4], [18, 4], [18, 21], [2, 21]])
		"formation":
			for x in [6, 12, 18]: circle.call(x, 9, 2, true); circle.call(x, 16, 2, true)
		"info":
			circle.call(12, 12, 9.5); circle.call(12, 7.5, 1.4, true); line.call([[12, 11], [12, 17]])
		"time":
			circle.call(12, 12, 9.5); line.call([[12, 6], [12, 12], [16, 15]])
		"weather":    # cloud
			draw_arc(p.call(9, 13), 5 * k, PI * .5, PI * 1.6, 16, c, weight * k, true); draw_arc(p.call(14, 10), 6 * k, PI * 1.05, PI * 2.05, 18, c, weight * k, true)
			line.call([[9, 18], [19, 18]]); draw_arc(p.call(18, 14), 4 * k, -PI * .55, PI * .5, 12, c, weight * k, true)
		"star":
			var star := []
			for i in 10:
				var a := -PI * .5 + TAU * i / 10.0; var r := 10.0 if i % 2 == 0 else 4.2
				star.append([12 + cos(a) * r, 12.5 + sin(a) * r])
			fill.call(star, .95)
		_:
			circle.call(12, 12, 9.5)
