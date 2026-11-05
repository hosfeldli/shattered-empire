class_name ResearchPresentation
extends RefCounted
## A read-only view of the received research rules; the server still validates every queue.
var world:WorldState
func _init(w:WorldState) -> void: world=w

func missing(key:String) -> Array:
	return world.defs.get("TECHS",{}).get(key,{}).get("req",[]).filter(func(item):return not item in world.econ.get("techs",[]))

func ready(key:String) -> bool:
	return int(world.defs.get("TECHS",{}).get(key,{}).get("age",0))<=int(world.econ.get("age",0)) and missing(key).is_empty() and not key in world.econ.get("techs",[])

func status(key:String) -> String:
	if key in world.econ.get("techs",[]): return "Complete"
	if world.econ.get("research")==key: return "Researching"
	if key in world.econ.get("queue",[]): return "Queued"
	if ready(key): return "Available now"
	var age:=int(world.defs.get("TECHS",{}).get(key,{}).get("age",0))
	if age>int(world.econ.get("age",0)):
		var ages:Array=world.defs.get("AGES",[])
		return "Requires "+str(ages[age].name) if age<ages.size() else "Requires a later era"
	return "Needs prerequisites"

func unlocks(key:String) -> Array:
	var result:=[]
	for catalog in ["BUILDINGS","UNITS"]:
		for item:Dictionary in world.defs.get(catalog,{}).values():
			if item.get("tech")==key and not item.get("obsolete",false) and not item.get("rebelOnly",false): result.append(str(item.get("name","")))
	return result

func path(key:String,result:Array=[],visiting:Dictionary={}) -> Array:
	if key in world.econ.get("techs",[]) or key in result or visiting.has(key): return result
	visiting[key]=true
	for prerequisite in world.defs.get("TECHS",{}).get(key,{}).get("req",[]): path(str(prerequisite),result,visiting)
	result.append(key); visiting.erase(key)
	return result

func estimate(key:String) -> String:
	if not world.defs.get("TECHS",{}).has(key): return "Choose a project"
	var rate:=float(world.econ.get("researchRate",0))
	if rate<=0: return "No research output"
	var cost:=float(world.defs.get("TECHS",{}).get(key,{}).get("cost",0))
	var earned:=float(world.econ.get("progress",0)) if world.econ.get("research")==key else float(world.econ.get("techProgress",{}).get(key,0))
	var seconds:=ceili(maxf(0,cost-earned)/rate)
	return "~%dm %02ds"%[seconds/60,seconds%60] if seconds>=60 else "~%ds"%seconds
