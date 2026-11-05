class_name CombatPresentationDirector
extends RefCounted
## Scale and importance choose how many real events are presented. No synthetic shots or hits.
const MAJOR := ["launch","impact","kill","bkill"]
var world: WorldState
var camera: CameraController
var lod: LODManager
var dropped := 0


func select(events: Array) -> Array:
	var ordered:=events.duplicate()
	ordered.sort_custom(func(a,b): return str(a.get("k","")) in MAJOR and not str(b.get("k","")) in MAJOR)
	var result:=[]
	var budget:=24 if camera.size>72 else 60 if lod.quality=="low" else 120
	budget=maxi(6,roundi(budget*lod.particle_scale))
	for event in ordered:
		if camera.size>72 and str(event.get("k","")) not in MAJOR: dropped+=1; continue
		var tile:=int(event.get("b",event.get("a",-1)))
		if tile<0: tile=int(event.get("a",-1))
		if tile<0 or tile>=world.grid.n: dropped+=1; continue
		var p:=world.grid.center(tile)
		if absf(world.grid.near_x(p.x,camera.focus.x)-camera.focus.x)>camera.view_half_width()+8 or absf(p.y-camera.focus.z)>camera.size+8:
			dropped+=1; continue
		if result.size()>=budget: dropped+=1; continue
		result.append(event)
	return result
