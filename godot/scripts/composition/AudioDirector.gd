class_name AudioDirector
extends Node
## A bounded pool driven exclusively by visible authoritative combat events. M toggles sound.
var enabled := true
var camera: CameraController
var world: WorldState
var voices: Array[AudioStreamPlayer] = []
var streams := {}


func setup(w:WorldState,cam:CameraController) -> void:
	world=w; camera=cam
	for kind in ["fire","impact","kill"]: streams[kind]=load("res://assets/audio/%s.wav"%kind)
	for k in 12:
		var player:=AudioStreamPlayer.new(); add_child(player); voices.append(player)
	world.welcomed.connect(stop)
	world.reset.connect(stop)


func stop() -> void:
	for voice in voices: voice.stop()


func present(events:Array) -> void:
	if not enabled: return
	var count:=0
	for event in events:
		var kind:=str(event.get("k",""))
		if kind in ["launch","fire"]: kind="fire"
		elif kind in ["impact","hit","bhit"]: kind="impact"
		elif kind in ["kill","bkill"]: kind="kill"
		else: continue
		if camera.size>72 and kind=="fire": continue
		var tile:=int(event.get("b",-1))
		if tile<0: tile=int(event.get("a",-1))
		if tile<0: continue
		var point:=world.grid.center(tile)
		var distance:=Vector2(world.grid.dx_wrap(camera.focus.x,point.x),point.y-camera.focus.z).length()
		if distance>camera.size*1.5: continue
		for voice in voices:
			if voice.playing: continue
			voice.stream=streams[kind]
			voice.volume_db=-29.0-clampf(distance/maxf(camera.size,1)*10,0,18)
			voice.pitch_scale=.96+posmod(int(event.get("i",0)),7)*.015
			voice.play(); count+=1; break
		if count>=4: break


func _unhandled_input(event:InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.keycode==KEY_M:
		enabled=not enabled
		if not enabled: stop()
		get_viewport().set_input_as_handled()
