extends SceneTree
var failures:Array=[]
var checks:=0
func check(ok:bool,reason:String) -> void:
	checks+=1
	if not ok: failures.append(reason)

func _initialize() -> void:
	call_deferred("run")

func run() -> void:
	var original:=MeshKit.new(); original.set_frame(Vector3(14,.4,9),.35)
	original.box("brick",Vector3.ZERO,Vector3(.4,.8,.4)); original.box("glass",Vector3(0,.4,.202),Vector3(.25,.25,.004))
	var before:=var_to_bytes(original.parts)
	var record:={"id":81,"t":42,"ty":"electronics_plant","hp":100,"st":"operational"}
	var intact:=MeshKit.new(); BuildingLifecycle.append(intact,original,record)
	check(var_to_bytes(intact.parts)==before,"intact structures changed during copying")
	var ruined:=MeshKit.new(); record.hp=0; record.st="ruined"
	BuildingLifecycle.append(ruined,original,record)
	var high:=0.0; var inverse:=original.basis.inverse()
	for part in ruined.parts.values():
		for vertex:Vector3 in part[0]: high=maxf(high,(inverse*(vertex-original.origin)).y)
	check(high<=.201,"ruined walls retain uncut spikes above the collapse plane")
	var again:=MeshKit.new(); BuildingLifecycle.append(again,original,record)
	check(var_to_bytes(ruined.parts)==var_to_bytes(again.parts),"damage appearance depends on generation order")
	check(var_to_bytes(original.parts)==before,"damage corrupted a shared construction template")
	record.hp=100; record.st="operational"
	var partial:=MeshKit.new(); BuildingLifecycle.append(partial,original,record,.65)
	var ceiling:=.8*(.65-.32)/.63
	for part in partial.parts.values():
		for vertex:Vector3 in part[0]: check((inverse*(vertex-original.origin)).y<=ceiling+.001,"unfinished geometry appears above its construction front")
	var complete:=MeshKit.new(); BuildingLifecycle.append(complete,original,record,1.0)
	check(var_to_bytes(complete.parts)==before,"completed construction does not match the final building")
	for type in MilitaryModelLibrary.TYPES:
		var mesh:=MilitaryModelLibrary.build(type,Color("567bc4"))
		check(mesh!=null and mesh.get_surface_count()>0,"missing role-specific unit model: "+type)
	print("DEVELOPMENT_TESTS ",JSON.stringify({"checks":checks,"failures":failures}))
	quit(0 if failures.is_empty() else 1)
