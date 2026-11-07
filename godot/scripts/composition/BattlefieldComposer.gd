class_name BattlefieldComposer
extends RefCounted
## A continuous scar field complements the server's discrete craters and wrecks. Intensity is
## sampled from received records only; the texture changes appearance, never terrain/path rules.
var composition: WorldCompositionSystem
var terrain: WorldRenderer
var version := -1
var revision := 0


func setup(system: WorldCompositionSystem, renderer: WorldRenderer) -> void:
	composition=system; terrain=renderer
	system.world.econ_applied.connect(sync)
	system.world.welcomed.connect(clear)
	system.world.reset.connect(clear)


func clear() -> void:
	version=-1; revision+=1
	composition.scheduler.cancel("battlefield-scar")
	terrain.terrain_mat.set_shader_parameter("battle_active",0.0)


func sync() -> void:
	var world:=composition.world
	if version==world.bf_version: return
	version=world.bf_version; revision+=1
	# Warzone material field (brief §4): R intensity, G scorch, B track wear (+ heavy-track flag),
	# A ground class for terrain-specific scars (0 soil, 1 rock, 2 sand, 3 wetland, 4 urban).
	var fields:={}
	var touch:=func(tile:int) -> Array:
		if not fields.has(tile): fields[tile]=[0.0,0.0,0.0,0.0]
		return fields[tile]
	for record in world.bf.get("i",[]): touch.call(int(record[0]))[0]=clampf(float(record[1])/3.0,0,1)
	for record in world.bf.get("c",[]):
		var f:Array=touch.call(int(record[0])); f[0]=maxf(float(f[0]),clampf(float(record[1])*.25,0,1))
	for record in world.bf.get("sc",[]): touch.call(int(record[0]))[1]=clampf(float(record[1])/10.0,0,1)
	# historical scars: the faint, long-lived trace of an old front (weaker than live damage)
	for record in world.bf.get("hs",[]):
		var f:Array=touch.call(int(record[0])); f[0]=maxf(float(f[0]),clampf(float(record[1])/10.0,0,1)*.35)
	for record in world.bf.get("wr",[]):
		var f:Array=touch.call(int(record[0])); f[2]=clampf(float(record[1])/10.0,0,1)*(1.0 if int(record[2])==2 else .7)
	if fields.is_empty():
		composition.scheduler.cancel("battlefield-scar")
		terrain.terrain_mat.set_shader_parameter("battle_active",0.0); return
	var image:=Image.create(world.grid.w,world.grid.h,false,Image.FORMAT_RGBA8)
	var state:={"next":0}; var tiles:=fields.keys()
	composition.scheduler.enqueue("battlefield-scar",revision,GenerationScheduler.Priority.HIGH,func():
		var end:=mini(int(state.next)+64,tiles.size())
		for index in range(int(state.next),end):
			var tile:=int(tiles[index]); var f:Array=fields[tile]
			image.set_pixel(tile%world.grid.w,tile/world.grid.w,Color(float(f[0]),float(f[1]),float(f[2]),float(_ground_class(world,tile))/4.0))
		state.next=end
		return end==tiles.size(),func():
			terrain.terrain_mat.set_shader_parameter("battle_scar",ImageTexture.create_from_image(image))
			terrain.terrain_mat.set_shader_parameter("battle_cells",Vector2(world.grid.w,world.grid.h))
			terrain.terrain_mat.set_shader_parameter("battle_active",1.0))


static func _ground_class(world:WorldState,tile:int) -> int:
	if world.urban_bits.size()>tile>>3 and (int(world.urban_bits[tile>>3])>>(tile&7))&1==1: return 4
	match world.biome(tile):
		8,9,10: return 1
		5: return 2
		7: return 3
	return 0
