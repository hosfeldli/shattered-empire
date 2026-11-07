class_name AudioDirector
extends Node
## The soundscape. Ambience is a set of looping beds whose loudness follows what this viewer can
## legitimately perceive around the camera: known countryside, water, wind and weather, visible
## towns, operating industry, building sites and fighting. Combat one-shots come only from visible
## authoritative events and are chosen per weapon. Nothing here reveals hidden activity: memory
## records, unknown hexes and fogged events are silent. Voices are pooled and capped.
## Ambience and effects play on their own buses with independent volumes. M toggles sound.

const SCAN_INTERVAL := 0.35
const AMBIENCE := {
	"countryside": "res://assets/audio/countryside.mp3",
	"wind": "res://assets/audio/synth/amb_wind.ogg",
	"rain": "res://assets/audio/synth/amb_rain.ogg",
	"water": "res://assets/audio/synth/amb_water.ogg",
	"city": "res://assets/audio/synth/amb_city.ogg",
	"industry": "res://assets/audio/synth/amb_industry.ogg",
	"construction": "res://assets/audio/synth/amb_construction.ogg",
	"battle": "res://assets/audio/synth/amb_battle.ogg",
	"engines": "res://assets/audio/synth/amb_engines.ogg",
	"birds": "res://assets/audio/synth/amb_birds.ogg",
}
## base level of each bed at full presence (dB); beds are deliberately quiet under effects
const AMBIENCE_DB := {"countryside": -30.0, "wind": -31.0, "rain": -27.0, "water": -30.0, "city": -31.0, "industry": -33.0, "construction": -32.0, "battle": -29.0, "engines": -31.0, "birds": -33.0}
const EFFECTS := ["rifle", "mg", "autocannon", "cannon", "mortar", "artillery", "rocket", "explosion", "explosion_big", "collapse", "thunder"]
const CUES := ["radio", "build", "chime", "fanfare", "drum"]
## orders acknowledged over the radio; placements answered with a stake being driven
const RADIO_COMMANDS := ["move", "attack", "fortify", "hold", "withdraw", "stance", "formation", "deploy", "armyMove", "armyOrder", "patrol", "explore", "rally"]
const BUILD_COMMANDS := ["build", "road", "trench", "bridge", "upgrade", "batchUpgrade", "repair", "found"]
## weapon key (server WEAPON_KEYS) -> launch/fire sound; impact sound by blast class
const WEAPON_FIRE := {"carbine": "rifle", "rifle": "rifle", "smg_team": "rifle", "mg": "mg", "mg_light": "mg",
	"autocannon": "autocannon", "flak": "autocannon", "airburst": "autocannon", "aam": "rocket", "bombs": "",
	"warhead": "rocket", "cannon": "cannon", "fortgun": "cannon", "mortar": "mortar", "howitzer": "artillery",
	"missile": "rocket", "rockets": "rocket", "drone_strike": "rocket"}
const WEAPON_IMPACT := {"cannon": "explosion", "fortgun": "explosion", "rockets": "explosion", "drone_strike": "explosion",
	"autocannon": "", "flak": "", "airburst": "", "mortar": "explosion", "howitzer": "explosion_big", "missile": "explosion_big",
	"bombs": "explosion_big", "warhead": "explosion_big", "aam": "explosion"}

var enabled := true
var camera: CameraController
var world: WorldState
var weather: EnvironmentContext
var voices: Array[AudioStreamPlayer] = []
var streams := {}
var beds := {}           # name -> {player, gain, target}
var scan_wait := 0.0
var recent_fire := 0.0   # decaying count of visible weapon events near the camera
var last_voice_time := {}
var ambience_bus := 0
var effects_bus := 0
var cue_player: AudioStreamPlayer
var last_cue := {}
var own_state := {}      # own building id -> "done:level" (completion chimes)


func setup(w:WorldState,cam:CameraController) -> void:
	world=w; camera=cam
	ambience_bus=_bus("Ambience"); effects_bus=_bus("Effects")
	for kind in ["fire","impact","kill"]: streams[kind]=load("res://assets/audio/%s.wav"%kind)
	for name in EFFECTS:
		var path:="res://assets/audio/synth/sfx_%s.ogg"%name
		if ResourceLoader.exists(path): streams[name]=load(path)
	for name in AMBIENCE:
		var stream:AudioStream=load(AMBIENCE[name]) if ResourceLoader.exists(AMBIENCE[name]) else null
		if stream==null: continue
		if stream is AudioStreamOggVorbis: (stream as AudioStreamOggVorbis).loop=true
		elif stream is AudioStreamMP3: (stream as AudioStreamMP3).loop=true
		var player:=AudioStreamPlayer.new(); player.stream=stream; player.volume_db=-80; player.bus=AudioServer.get_bus_name(ambience_bus); add_child(player)
		beds[name]={"player":player,"gain":0.0,"target":0.0}
	for k in 14:
		var player:=AudioStreamPlayer.new(); player.bus=AudioServer.get_bus_name(effects_bus); add_child(player); voices.append(player)
	for name in CUES:
		var path:="res://assets/audio/synth/ui_%s.ogg"%name
		if ResourceLoader.exists(path): streams["ui_"+name]=load(path)
	cue_player=AudioStreamPlayer.new(); cue_player.bus=AudioServer.get_bus_name(effects_bus); add_child(cue_player)
	world.econ_applied.connect(_on_economy)
	world.welcomed.connect(stop)
	world.reset.connect(stop)


func _bus(name:String) -> int:
	var index:=AudioServer.get_bus_index(name)
	if index>=0: return index
	AudioServer.add_bus(); index=AudioServer.bus_count-1
	AudioServer.set_bus_name(index,name); AudioServer.set_bus_send(index,"Master")
	return index


func set_levels(ambience_percent:float,effects_percent:float) -> void:
	AudioServer.set_bus_volume_db(ambience_bus,linear_to_db(maxf(ambience_percent/100.0,.001)))
	AudioServer.set_bus_mute(ambience_bus,ambience_percent<=0.0)
	AudioServer.set_bus_volume_db(effects_bus,linear_to_db(maxf(effects_percent/100.0,.001)))
	AudioServer.set_bus_mute(effects_bus,effects_percent<=0.0)


func stop() -> void:
	for voice in voices: voice.stop()
	for bed in beds.values():
		(bed.player as AudioStreamPlayer).stop(); bed.gain=0.0; bed.target=0.0
	recent_fire=0.0
	own_state.clear()


func _process(dt:float) -> void:
	dt=maxf(dt,0.0)
	recent_fire*=exp(-dt/6.0)
	scan_wait-=dt
	if scan_wait<=0.0:
		scan_wait=SCAN_INTERVAL
		_scan()
	for name in beds:
		var bed:Dictionary=beds[name]
		bed.gain=lerpf(float(bed.gain),float(bed.target),1.0-exp(-dt*0.9))
		var player:AudioStreamPlayer=bed.player
		if bed.gain<.002:
			if player.playing and bed.target<=0.0: player.stop()
			continue
		if not player.playing:
			# start each bed at a stable but different point so layers never phase together
			player.play(fmod(float(name.hash()%997)*.37,maxf(player.stream.get_length()-1.0,1.0)))
		player.volume_db=AMBIENCE_DB[name]+linear_to_db(maxf(float(bed.gain),.0001))


## Survey what the viewer perceives around the camera and set each bed's target presence.
func _scan() -> void:
	for bed in beds.values(): bed.target=0.0
	if not enabled or not world.ready_ or world.grid==null: return
	var g:=world.grid
	var focus:=Vector2(camera.focus.x,camera.focus.z)
	var near:=1.0-smoothstep(30.0,80.0,camera.size)        # local soundscape fades as the camera rises
	var far:=smoothstep(25.0,120.0,camera.size)
	var radius:=clampf(camera.size*.45,4.0,14.0)
	var land:=0.0; var water:=0.0; var rough:=0.0; var samples:=0.0
	var step:=maxf(1.6,radius/4.0)
	var y:=-radius
	while y<=radius:
		var x:=-radius
		while x<=radius:
			if x*x+y*y<=radius*radius:
				var tile:=g.tile_at(focus.x+x,focus.y+y)
				if tile>=0 and world.known[tile]:
					samples+=1.0
					if world.is_sea(tile) or world.is_lake(tile) or world.is_river(tile): water+=1.0
					else:
						var biome:=world.biome(tile)
						if biome in [2,3,4,7,8]: land+=1.0
						if biome in [5,6,9,10]: rough+=1.0
			x+=step
		y+=step
	if samples>0.0:
		_target("countryside",clampf(land/samples*1.3,0,1)*near)
		_target("water",clampf(water/samples*2.2,0,1)*(.25+.75*near))
	var wind_strength:=.35
	var rain:=0.0
	if weather:
		wind_strength=clampf(.25+weather.strength*.75,0,1)
		var focus_tile:=g.tile_at(focus.x,focus.y)
		if focus_tile>=0:
			var here:Dictionary=weather.at_tile(focus_tile)
			rain=clampf(float(here.get("rain",0.0))*1.6+float(here.get("storm",0.0))*.6,0,1)
			wind_strength=clampf(wind_strength+float(here.get("storm",0.0))*.5,0,1)
	_target("wind",clampf(wind_strength*(.35+.65*far)+(rough/maxf(samples,1.0))*.4,0,1))
	_target("rain",rain*(.4+.6*near))
	# settlements, industry and works the viewer can currently see (memory records stay silent)
	var people:=0.0; var works:=0.0; var sites:=0.0
	for b in world.buildings.values():
		if int(b.get("mem",0))==1: continue
		var t:=int(b.t)
		if not world.is_visible(t) and int(b.o)!=world.civ_id: continue
		var p:=g.center(t)
		var d:=Vector2(g.dx_wrap(focus.x,p.x),p.y-focus.y).length()
		if d>radius*1.15: continue
		var weight:=1.0-d/(radius*1.15)
		if int(b.get("d",0))==0 or not (b.get("wk",[]) as Array).is_empty(): sites+=weight
		elif str(b.ty) in ["house","town","market","academy","university"]: people+=weight*(1.0+float(b.get("lv",1))*.3)
		elif int(b.get("a",0))==1 and str(b.get("st",""))!="ruined": works+=weight
	_target("city",clampf(people/4.0,0,1)*near)
	_target("industry",clampf(works/2.5,0,1)*near)
	_target("construction",clampf(sites/1.2,0,1)*near*(1.0-smoothstep(16.0,40.0,camera.size)))
	_target("battle",clampf(recent_fire/10.0,0,1)*(.45+.55*far))
	# vehicles moving nearby that the viewer can see
	var engines:=0.0
	var unit_defs:Dictionary=world.defs.get("UNITS",{})
	for unit in world.units.values():
		var move:=str(unit_defs.get(str(unit.type),{}).get("move",""))
		if not move in ["wheeled","tracked"] or bool(unit_defs.get(str(unit.type),{}).get("air",false)): continue
		var t:=int(unit.tile)
		if int(unit.owner)!=world.civ_id and not world.is_visible(t): continue
		var p:=g.center(t)
		var d:=Vector2(g.dx_wrap(focus.x,p.x),p.y-focus.y).length()
		if d>radius: continue
		engines+=(1.0-d/radius)*(1.0 if int(unit.get("next",-1))>=0 else .35)
	_target("engines",clampf(engines/2.5,0,1)*near*(1.0-smoothstep(14.0,34.0,camera.size)))
	# birdsong in known woodland and meadows; birds fall silent while fighting is heard
	if samples>0.0: _target("birds",clampf(land/samples,0,1)*near*(1.0-clampf(recent_fire/4.0,0,1))*(1.0-rain))


func _target(name:String,value:float) -> void:
	if beds.has(name): beds[name].target=value


## Thunder answering a lightning flash after the light-to-sound delay; far storms rumble softly.
func thunder(strength:float,delay:float) -> void:
	if not enabled or not streams.has("thunder"): return
	await get_tree().create_timer(delay).timeout
	var voice:=_free_voice("thunder")
	if voice==null: return
	voice.stream=streams.thunder
	voice.volume_db=-12.0-delay*3.0+linear_to_db(maxf(strength,.05))-clampf((camera.size-30.0)*.1,0,8)
	voice.pitch_scale=randf_range(.85,1.05)
	voice.play()


## Short interface cues for the player's own accepted actions (never for others' activity).
func cue(name:String,volume_db:=-20.0) -> void:
	if not enabled or not streams.has("ui_"+name): return
	var now:=Time.get_ticks_msec()/1000.0
	if now-float(last_cue.get(name,-10.0))<.25: return
	last_cue[name]=now
	cue_player.stream=streams["ui_"+name]; cue_player.volume_db=volume_db; cue_player.pitch_scale=randf_range(.97,1.03)
	cue_player.play()


func on_command_result(command:Dictionary,reply:Dictionary) -> void:
	if reply.has("error") and reply.error!=null: return
	var kind:=str(command.get("c",""))
	if kind in RADIO_COMMANDS: cue("radio",-22.0)
	elif kind in BUILD_COMMANDS: cue("build",-18.0)


## Story beats from the server's own notices to this player.
func on_message(m:Dictionary) -> void:
	if str(m.get("t",""))!="note" or bool(m.get("quiet",false)) and str(m.get("kind",""))!="battle": return
	match str(m.get("kind","")):
		"age","city","wonder": cue("fanfare",-16.0)
		"battle": cue("drum",-18.0)


## Own works finishing (construction or an upgrade level) close to the camera ring a soft chime.
func _on_economy() -> void:
	var seen:={}
	for b in world.buildings.values():
		if int(b.o)!=world.civ_id: continue
		var id:=int(b.id); var state:="%d:%d"%[int(b.get("d",0)),int(b.get("lv",1))]
		seen[id]=state
		if own_state.has(id) and own_state[id]!=state and int(b.get("d",0))==1 and camera.size<45.0:
			var p:=world.grid.center(int(b.t))
			if Vector2(world.grid.dx_wrap(camera.focus.x,p.x),p.y-camera.focus.z).length()<camera.size*1.2: cue("chime",-21.0)
	own_state=seen


func present(events:Array) -> void:
	if not enabled: return
	var keys:Array=world.defs.get("WEAPON_KEYS",[])
	var count:=0
	var now:=Time.get_ticks_msec()/1000.0
	for event in events:
		var kind:=str(event.get("k",""))
		if not kind in ["launch","fire","impact","hit","bhit","kill","bkill"]: continue
		var tile:=int(event.get("b",-1)) if kind in ["impact","hit","bhit","kill","bkill"] else int(event.get("a",-1))
		if tile<0: tile=int(event.get("a",-1))
		if tile<0 or tile>=world.grid.n or not world.is_visible(tile): continue
		var point:=world.grid.center(tile)
		var distance:=Vector2(world.grid.dx_wrap(camera.focus.x,point.x),point.y-camera.focus.z).length()
		if distance<camera.size*2.5: recent_fire+=1.0
		if distance>camera.size*1.5: continue
		var weapon:=""
		var index:=int(event.get("w",-1))
		if index>=0 and index<keys.size(): weapon=str(keys[index])
		var sound:=""
		match kind:
			"launch","fire":
				sound=str(WEAPON_FIRE.get(weapon,"rifle"))
				if sound in ["rifle","mg"] and camera.size>60: sound=""    # small arms are inaudible from altitude
			"impact","hit","bhit":
				sound=str(WEAPON_IMPACT.get(weapon,""))
				if sound=="" and kind!="impact": continue
			"kill","bkill":
				sound="collapse" if kind=="bkill" else "explosion"
		if sound=="" or not streams.has(sound): continue
		# a short refractory period per sound keeps sustained fire articulate instead of a wall of noise
		if now-float(last_voice_time.get(sound,-10.0))<(0.06 if sound in ["rifle","mg"] else 0.12): continue
		var voice:=_free_voice(sound)
		if voice==null: continue
		last_voice_time[sound]=now
		voice.stream=streams[sound]
		var near_db:=-14.0 if sound in ["explosion_big","artillery","collapse"] else -17.0
		voice.volume_db=near_db-clampf(distance/maxf(camera.size,1)*9.0,0,16)-clampf((camera.size-20.0)*.12,0,10)
		voice.pitch_scale=.94+posmod(int(event.get("i",event.get("p",0))),9)*.015
		voice.play(); count+=1
		if count>=5: break


## a free voice, or the quietest small-arms voice when the pool is busy with something larger
func _free_voice(sound:String) -> AudioStreamPlayer:
	for voice in voices:
		if not voice.playing: return voice
	if sound in ["rifle","mg"]: return null
	var victim:AudioStreamPlayer=null
	for voice in voices:
		if voice.stream==streams.get("rifle") or voice.stream==streams.get("mg"):
			if victim==null or voice.volume_db<victim.volume_db: victim=voice
	return victim


func _unhandled_input(event:InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.keycode==KEY_M:
		enabled=not enabled
		if not enabled: stop()
		get_viewport().set_input_as_handled()
