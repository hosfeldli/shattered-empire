class_name NativeRailIcon
extends Control
## Small vector symbols stay crisp at any interface scale.
var title:="World"
func _draw() -> void:
	var color:=NativeUI.GOLD
	var paths:={
		"World":[[Vector2(12,2),Vector2(21,7),Vector2(21,17),Vector2(12,22),Vector2(3,17),Vector2(3,7),Vector2(12,2)],[Vector2(3,7),Vector2(12,12),Vector2(21,7)],[Vector2(12,12),Vector2(12,22)]],
		"Build":[[Vector2(4,20),Vector2(15,7)],[Vector2(8,6),Vector2(13,2),Vector2(22,10),Vector2(18,14),Vector2(8,6)]],
		"Cities":[[Vector2(2,21),Vector2(22,21)],[Vector2(4,21),Vector2(4,10),Vector2(10,10),Vector2(10,21)],[Vector2(14,21),Vector2(14,3),Vector2(21,3),Vector2(21,21)]],
		"Military":[[Vector2(3,4),Vector2(12,1),Vector2(21,4),Vector2(20,14),Vector2(12,22),Vector2(4,14),Vector2(3,4)],[Vector2(12,6),Vector2(12,16)],[Vector2(8,11),Vector2(16,11)]],
		"Economy":[[Vector2(2,21),Vector2(22,21)],[Vector2(5,18),Vector2(5,13)],[Vector2(12,18),Vector2(12,8)],[Vector2(19,18),Vector2(19,3)]],
		"Research":[[Vector2(9,2),Vector2(15,2)],[Vector2(10,2),Vector2(10,9),Vector2(4,19),Vector2(5,21),Vector2(19,21),Vector2(20,19),Vector2(14,9),Vector2(14,2)],[Vector2(7,16),Vector2(17,16)]],
		"Rivals":[[Vector2(2,12),Vector2(7,5),Vector2(17,5),Vector2(22,12),Vector2(17,19),Vector2(7,19),Vector2(2,12)],[Vector2(12,8),Vector2(12,16)]],
		"Chronicle":[[Vector2(2,3),Vector2(10,3),Vector2(12,6),Vector2(14,3),Vector2(22,3),Vector2(22,20),Vector2(14,20),Vector2(12,22),Vector2(10,20),Vector2(2,20),Vector2(2,3)],[Vector2(12,6),Vector2(12,22)]]}
	for path in paths.get(title,paths.World): draw_polyline(PackedVector2Array(path),color,1.5,true)
