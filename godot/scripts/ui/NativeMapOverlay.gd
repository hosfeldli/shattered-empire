class_name NativeMapOverlay
extends Control
## Crisp tactical outlines, authoritative formation frontage and fog-safe hover information.
var app:Node
var tooltip:PanelContainer
var body_label:Label
var hover:=-1
var timer:=0.0
var settled:=0.0
var last_mouse:=Vector2.INF

func setup(game:Node) -> void:
	app=game; set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); mouse_filter=Control.MOUSE_FILTER_IGNORE
	tooltip=PanelContainer.new(); tooltip.theme=NativeUI.theme(); tooltip.mouse_filter=Control.MOUSE_FILTER_IGNORE; add_child(tooltip)
	body_label=NativeUI.label(tooltip,"",14); body_label.custom_minimum_size.x=260; body_label.mouse_filter=Control.MOUSE_FILTER_IGNORE; tooltip.hide()

func _point(tile:int,corner:=-1) -> Vector2:
	var world:WorldState=app.world; var center:=world.grid.center(tile)
	var position:=Vector3(world.grid.near_x(center.x,app.cam.focus.x),world.tile_height(tile),center.y)
	if corner>=0:
		var offset:Vector2=world.grid.corners[corner]*.95
		position.x+=offset.x; position.z+=offset.y; position.y=world.ground_height(position.x,position.z)+.025
	return app.cam.to_screen(position)

func _outline(tile:int,color:Color,width:=1.5) -> void:
	if tile<0 or tile>=app.world.grid.n or app.world.known[tile]==0: return
	var points:=PackedVector2Array()
	for corner in 6: points.append(_point(tile,corner))
	points.append(points[0]); draw_polyline(points,color,width,true)

func _draw() -> void:
	if not app.world.ready_ or app.shell.is_blocking() or app.workspace.panel.visible: return
	if hover>=0 and app.command_tools.mode=="select": _outline(hover,Color(1,1,.9,.4),1)
	for id in app.input.selected_buildings:
		if app.world.buildings.has(id): _outline(int(app.world.buildings[id].t),NativeUI.GOLD,2)
	var formations:={}
	for id in app.military.selected:
		var formation:=int(app.world.units.get(id,{}).get("formation",0))
		if formation>0: formations[formation]=true
	for formation in app.world.econ.get("formations",[]):
		if not formations.has(int(formation.id)) or formation.get("line",[]).size()!=2: continue
		var a:=_point(int(formation.line[0])); var b:=_point(int(formation.line[1]))
		draw_line(a,b,Color(.45,.8,.95,.85),2,true)
		draw_circle(a,3,NativeUI.GOLD); draw_circle(b,3,NativeUI.GOLD)

func _describe(tile:int) -> String:
	var world:WorldState=app.world; var lines:=[]
	var building_id:int=app.settlements.building_at(tile)
	if building_id>=0:
		var building:Dictionary=world.buildings[building_id]
		var definition:Dictionary=world.defs.get("BUILDINGS",{}).get(building.ty,{})
		lines.append(str(definition.get("name",building.ty))+" · "+str(world.civ_by_id.get(int(building.o),{}).get("name","Unknown")))
		lines.append("%s · health %d%%"%[str(building.st).capitalize(),int(building.hp)])
		if int(building.get("d",0))==0: lines.append("Construction: %d%%"%int(building.get("p",0)))
		if building.get("w")!=null: lines.append("Production: "+str(building.w).replace("input:","needs "))
	var terrain:Variant=world.defs.get("TERRAIN",[])
	var biome:=world.biome(tile)
	if terrain is Array and biome<terrain.size(): lines.append(str(terrain[biome].get("name","Terrain")))
	if world.is_river(tile): lines.append("River · use an authorized crossing")
	if world.deposit(tile)>0:
		var resources:Variant=world.defs.get("RESOURCE",[])
		if resources is Array and world.deposit(tile)<resources.size(): lines.append(str(resources[world.deposit(tile)].get("name","Resource deposit")))
	if not world.is_visible(tile): lines.append("Last explored information · outside current sight")
	return "\n".join(lines)

func _process(dt:float) -> void:
	if not app.world.ready_ or app.shell.is_blocking() or app.workspace.panel.visible: tooltip.hide(); return
	var mouse:=get_viewport().get_mouse_position()
	if not get_viewport_rect().has_point(mouse): hover=-1; tooltip.hide(); queue_redraw(); return
	settled=settled+dt if mouse.distance_to(last_mouse)<3 else 0.0
	last_mouse=mouse; timer+=dt
	if timer>=.1:
		timer=0; hover=app.cam.pick_tile(mouse)
		if hover<0 or app.world.known[hover]==0: hover=-1
		queue_redraw()
	tooltip.visible=settled>.45 and hover>=0 and get_viewport().gui_get_hovered_control()==null
	if tooltip.visible:
		body_label.text=_describe(hover)
		tooltip.position=mouse+Vector2(20,22)
		tooltip.position.x=minf(tooltip.position.x,size.x-tooltip.size.x-8)
		tooltip.position.y=minf(tooltip.position.y,size.y-tooltip.size.y-8)
