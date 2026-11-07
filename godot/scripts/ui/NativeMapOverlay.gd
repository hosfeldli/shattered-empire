class_name NativeMapOverlay
extends Control
## Crisp tactical outlines, authoritative formation frontage and fog-safe hover information.
var app:Node
var high_contrast:=false
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

func _point(tile:int,corner:=-1,reference_x:=NAN) -> Vector2:
	var world:WorldState=app.world; var center:=world.grid.center(tile)
	var position:=Vector3(world.grid.near_x(center.x,app.cam.focus.x if is_nan(reference_x) else reference_x),world.tile_height(tile),center.y)
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
	if not app.world.ready_ or app.shell.is_blocking(): return
	if hover>=0 and app.command_tools.mode=="select": _outline(hover,Color(1,1,.9,.4),1)
	for id in app.input.selected_buildings:
		if app.world.buildings.has(id): _outline(int(app.world.buildings[id].t),Color("77e7ff") if high_contrast else NativeUI.GOLD,3 if high_contrast else 2)
	if app.cam.size<40:
		var shown:=0
		for id in app.world.units:
			var unit:Dictionary=app.world.units[id]
			if float(unit.get("hp",100))>=70 or not app.military.draw_positions.has(id): continue
			var point:Vector2=app.cam.to_screen(app.military.draw_positions[id])+Vector2(-9,-12)
			draw_rect(Rect2(point,Vector2(18,3)),Color(.08,.09,.1,.9))
			draw_rect(Rect2(point,Vector2(18*clampf(float(unit.hp)/100.0,0,1),3)),Color("77e7ff") if high_contrast else Color("e5a176"))
			shown+=1
			if shown>=128: break
	var formations:={}
	for id in app.military.selected:
		var formation:=int(app.world.units.get(id,{}).get("formation",0))
		if formation>0: formations[formation]=true
	for formation in app.world.econ.get("formations",[]):
		if not formations.has(int(formation.id)) or formation.get("line",[]).size()!=2: continue
		var first:=int(formation.line[0]); var second:=int(formation.line[1])
		if first<0 or second<0 or first>=app.world.grid.n or second>=app.world.grid.n: continue
		var first_x:float=app.world.grid.near_x(app.world.grid.center(first).x,app.cam.focus.x)
		var a:=_point(first,-1,first_x); var b:=_point(second,-1,first_x)
		draw_line(a,b,Color(.45,.8,.95,.85),2,true)
		draw_circle(a,3,NativeUI.GOLD); draw_circle(b,3,NativeUI.GOLD)

func _describe(tile:int,detailed:=false) -> String:
	var world:WorldState=app.world; var lines:=[]
	var building_id:int=app.settlements.building_at(tile)
	if building_id>=0:
		var building:Dictionary=world.buildings[building_id]
		var definition:Dictionary=world.defs.get("BUILDINGS",{}).get(building.ty,{})
		lines.append(str(definition.get("name",building.ty))+" · "+str(world.civ_by_id.get(int(building.o),{}).get("name","Unknown")))
		lines.append("%s · health %d%%%s"%[str(building.st).capitalize(),int(building.hp)," · level %d"%int(building.lv) if int(building.get("lv",1))>1 else ""])
		if int(building.get("d",0))==0: lines.append("Construction: %d%%"%int(building.get("p",0)))
		if building.get("w")!=null: lines.append("Production: "+str(building.w).replace("input:","needs "))
		if int(building.get("mem",0))==1:
			var ago:=maxi(0,int(world.server_time)-int(building.get("ls",0)))
			lines.append("As last seen %d:%02d ago · may have changed"%[ago/60,ago%60])
		elif not (building.get("wk",[]) as Array).is_empty():
			var works:Array=building.wk
			lines.append("%s · %d%%"%["Under repair" if str(works[0])=="r" else "Upgrade works",int(works[1])])
	var terrain:Variant=world.defs.get("TERRAIN",[])
	var biome:=world.biome(tile)
	if terrain is Array and biome<terrain.size():
		var definition:Dictionary=terrain[biome]
		lines.append(str(definition.get("name","Terrain")))
		if detailed:
			var move:Variant=definition.get("move")
			lines.append("Base movement: %s× · varies by unit and roads"%str(move) if move is float or move is int else "Movement: depends on crossing and unit type")
			lines.append("Terrain fertility: %d%% · site rules still apply"%int(float(definition.get("fert",0))*100))
	if world.is_river(tile): lines.append("River · use an authorized crossing")
	if world.deposit(tile)>0:
		var resources:Variant=world.defs.get("RESOURCE",[])
		if resources is Array and world.deposit(tile)<resources.size(): lines.append(str(resources[world.deposit(tile)].get("name","Resource deposit")))
	if not world.is_visible(tile): lines.append("Last explored information · outside current sight")
	return "\n".join(lines)

func _process(dt:float) -> void:
	if not app.world.ready_ or app.shell.is_blocking(): tooltip.hide(); return
	# Screen-space overlays must follow the camera every frame, independently of hover picking.
	queue_redraw()
	var mouse:=get_viewport().get_mouse_position()
	if not get_viewport_rect().has_point(mouse): hover=-1; tooltip.hide(); queue_redraw(); return
	settled=settled+dt if mouse.distance_to(last_mouse)<3 else 0.0
	last_mouse=mouse; timer+=dt
	if timer>=.1:
		timer=0; hover=app.cam.pick_tile(mouse)
		if hover<0 or app.world.known[hover]==0: hover=-1
		queue_redraw()
	var detailed:=Input.is_key_pressed(KEY_ALT)
	tooltip.visible=(settled>.45 or detailed) and hover>=0 and get_viewport().gui_get_hovered_control()==null
	if tooltip.visible:
		var resource:Dictionary=app.world_labels.marker_at(mouse)
		var banner:Dictionary=app.world_labels.banner_at(mouse)
		body_label.text=_describe(hover,true) if detailed else resource.text+" deposit · click for production and shortage details" if not resource.is_empty() else banner.text+" · click to select" if not banner.is_empty() else _describe(hover)
		tooltip.reset_size()
		tooltip.position=mouse+Vector2(20,22)
		tooltip.position.x=minf(tooltip.position.x,size.x-tooltip.size.x-8)
		tooltip.position.y=minf(tooltip.position.y,size.y-tooltip.size.y-8)
