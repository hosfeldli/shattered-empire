class_name CityPresentation
extends RefCounted
## Describe actual current projects and constraints, rather than an old governor log message.
static func work(world:WorldState,city:Dictionary) -> String:
	if int(city.get("fs",0))>0: return "Food shortage · add farm capacity"
	if int(city.get("iso",0))>0: return "Supply connection lost"
	for building:Dictionary in world.buildings.values():
		if int(building.get("c",-1))==int(city.get("id",-2)) and int(building.get("d",0))==0:
			return "Building %s · %d%%"%[str(world.defs.get("BUILDINGS",{}).get(building.ty,{}).get("name",building.ty)),int(building.get("p",0))]
	if float(city.get("pop",0))>=float(city.get("h",INF))-.5: return "Housing full · upgrade homes"
	if not city.get("development",{}).get("on",true): return "Automatic development off"
	return "Needs met · growing" if float(city.get("gr",0))>.05 else "Needs met · stable"
