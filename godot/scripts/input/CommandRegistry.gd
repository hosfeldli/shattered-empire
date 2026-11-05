class_name CommandRegistry
extends RefCounted
## Shared definitions, ownership checks, pending feedback and server submission for native orders.
signal finished(command:Dictionary,reply:Dictionary)
var world:WorldState
var net:NetworkClient
var actions:Array=[]
var pending:=0
var report:Callable

func setup(w:WorldState,n:NetworkClient,feedback:Callable) -> void:
	world=w; net=n; report=feedback
	actions=JSON.parse_string(FileAccess.get_file_as_string("res://recipes/ui_actions.json"))

func definition(id:String) -> Dictionary:
	for action in actions:
		if action.id==id: return action
	return {}

func issue(id:String,bindings:Dictionary,callback:=Callable()) -> void:
	var action:=definition(id)
	if action.is_empty():
		if report.is_valid(): report.call("This command is unavailable",false)
		return
	submit(NativeWorkspace.bind_command(action.command,bindings),callback)

func submit(command:Dictionary,callback:=Callable()) -> void:
	if world.spectator and not command.get("c","") in ["placement","roadPlan","bridgePlan","trenchPlan","follow","speed","fog","aiDiag"]:
		var reply:={"error":"Spectators cannot issue gameplay orders"}
		if callback.is_valid(): callback.call(reply)
		elif report.is_valid(): report.call(str(reply.error),false)
		return
	pending+=1
	net.cmd(command,func(reply):
		pending=maxi(0,pending-1); finished.emit(command,reply)
		if callback.is_valid(): callback.call(reply)
		elif report.is_valid(): report.call(str(reply.error) if reply.get("error")!=null else "Order accepted",reply.get("error")==null))

func train(buildings:Array,type:String,count:=1,per_building:=false,repeat_:=false) -> void:
	var facilities:=buildings.filter(func(id):return world.buildings.has(id) and int(world.buildings[id].o)==world.civ_id and type in world.defs.get("BUILDINGS",{}).get(world.buildings[id].ty,{}).get("trains",[]))
	if facilities.is_empty():
		report.call("Select a production building that can train this unit",false); return
	var command:Dictionary
	if facilities.size()==1 and count==1: command=NativeWorkspace.bind_command(definition("train").command,{"building":facilities[0],"type":type})
	else: command={"c":"batchTrain","buildings":facilities,"unit":type,"count":count,"each":mini(count,8) if per_building else 0,"policy":"partial","requestId":"native-training-%d"%Time.get_ticks_usec()}
	submit(command,func(reply):
		var ok:bool=reply.get("error")==null
		report.call("Training queued" if ok else str(reply.error),ok)
		if ok and repeat_: issue("repeat",{"buildings":facilities,"type":type}))
