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
	var intensities:={}
	for record in world.bf.get("i",[]): intensities[int(record[0])]=clampf(float(record[1])/3.0,0,1)
	for record in world.bf.get("c",[]): intensities[int(record[0])]=maxf(float(intensities.get(int(record[0]),0)),clampf(float(record[1])*.25,0,1))
	if intensities.is_empty():
		composition.scheduler.cancel("battlefield-scar")
		terrain.terrain_mat.set_shader_parameter("battle_active",0.0); return
	var image:=Image.create(world.grid.w,world.grid.h,false,Image.FORMAT_R8)
	var state:={"next":0}; var tiles:=intensities.keys()
	composition.scheduler.enqueue("battlefield-scar",revision,GenerationScheduler.Priority.HIGH,func():
		var end:=mini(int(state.next)+64,tiles.size())
		for index in range(int(state.next),end):
			var tile:=int(tiles[index])
			image.set_pixel(tile%world.grid.w,tile/world.grid.w,Color(float(intensities[tile]),0,0))
		state.next=end
		return end==tiles.size(),func():
			terrain.terrain_mat.set_shader_parameter("battle_scar",ImageTexture.create_from_image(image))
			terrain.terrain_mat.set_shader_parameter("battle_cells",Vector2(world.grid.w,world.grid.h))
			terrain.terrain_mat.set_shader_parameter("battle_active",1.0))
