class_name NativeWorldLabels
extends Control
## Stable world-space membership, projected every frame. Pennants identify received troops;
## resources use small material pictograms. Input remains in the shared map controller.
const SHORT:={"rifle_squad":"Rifles","mortar_team":"Mortars","scout_buggy":"Scouts","armored_car":"Armored car","supply_truck":"Supply","field_gun":"Field guns","mech_infantry":"Mech infantry","sp_artillery":"Artillery","missile_battery":"Missiles","air_defense":"Air defense","special_forces":"Special forces","autonomous_tank":"Auto tanks","strike_swarm":"Swarm","exo_infantry":"Exo infantry","oneway_drone":"Strike drone","recon_drone":"Recon drone","tank":"Tanks"}
const DEPOSITS:=[[],["Oil","oil"],["Iron ore","ore"],["Coal","coal"],["Rare earth","rare"],["Stone","materials"],["Fish","food"],["Salvage","materials"]]
var app:Node
var font:Font
var banners:Array=[]
var markers:Array=[]
var icons:={}
var unit_icons:={}
var active:=false
var slots:={}
var groups:={}
var snapshot:=-1
var epoch:=-1
var last_zoom:=0.0
var zoom_settled:=0.0
var lock_layout:=false
var banner_style:StyleBoxFlat
static var last_us:=0     # --perf: time of the last refresh
var layout_frame:=0
var layout_phase:=0
var pending:Array=[]
var layout_snapshot:=-1
var layout_zoom:=0.0

func setup(game:Node) -> void:
	app=game; set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	font=load("res://assets/fonts/BarlowSemiCondensed-SemiBold.ttf")
	mouse_filter=Control.MOUSE_FILTER_IGNORE
	banner_style=NativeUI.style(NativeUI.PANEL,Color(1,1,1,.14),2)
	for resource in range(1,DEPOSITS.size()): icons[resource]=load("res://assets/icons/resources/deposit-%d.svg"%resource)
	for type in MilitaryModelLibrary.TYPES: unit_icons[type]=load("res://assets/icons/units/%s.svg"%type)

func banner_at(point:Vector2) -> Dictionary:
	if not active: return {}
	for record in banners:
		if (record.rect as Rect2).has_point(point): return record
	return {}

func marker_at(point:Vector2) -> Dictionary:
	if not active: return {}
	for record in markers:
		if (record.rect as Rect2).has_point(point): return record
	return {}

func order_point(point:Vector2) -> Vector2:
	var record:=banner_at(point)
	if not record.is_empty() and not record.ids.is_empty():
		return app.cam.to_screen(app.military.draw_positions.get(record.ids[0],Vector3.ZERO))
	return point

func _badge(key:String,anchor:Vector2,tile_offset:Vector2,occupied:Array) -> Rect2:
	var width:=26.0
	var offsets:=[Vector2(0,-32),Vector2(0,-62),Vector2(0,-92),Vector2(30,-32),Vector2(-30,-32)]
	var preferred:=int(slots.get(key,0)); var choices:=[preferred]
	for index in offsets.size():
		if index!=preferred: choices.append(index)
	for index:int in choices:
		var rect:=Rect2(anchor+tile_offset+offsets[index]-Vector2(width*.5,0),Vector2(width,width))
		if not Rect2(Vector2(8,94),size-Vector2(16,106)).encloses(rect): continue
		if not (lock_layout and slots.has(key)):
			var hit:=false
			var probe:=rect.grow(3)
			for other:Rect2 in occupied:
				if other.intersects(probe): hit=true; break
			if hit: continue
		occupied.append(rect); slots[key]=index; return rect
	return Rect2()

func _members() -> void:
	var world:WorldState=app.world
	if epoch!=world.world_epoch: slots.clear(); epoch=world.world_epoch; snapshot=-1
	if snapshot==world.snapshot_count: return
	snapshot=world.snapshot_count; groups.clear()
	for id in world.units:
		var unit:Dictionary=world.units[id]; var tile:=int(unit.tile)
		if tile<0 or not world.known[tile] or not world.is_visible(tile) and int(unit.owner)!=world.civ_id: continue
		# Hex and type membership never depends on camera position, zoom or screen buckets.
		var key:=str([int(unit.owner),str(unit.type),tile])
		if not groups.has(key): groups[key]={"key":key,"ids":[],"owner":int(unit.owner),"type":str(unit.type)}
		groups[key].ids.append(int(id))
	var tiles:={}
	for key in groups:
		var record:Dictionary=groups[key]; var tile_key:=str([record.owner,world.units[record.ids[0]].tile])
		if not tiles.has(tile_key): tiles[tile_key]=[]
		tiles[tile_key].append(key)
	for list:Array in tiles.values():
		list.sort()
		for index in list.size(): groups[list[index]].offset=Vector2((index%3-(mini(3,list.size())-1)*.5)*30,-(index/3)*30)
	for key in slots.keys():
		if not groups.has(key): slots.erase(key)


## one badge per owner per screen cell; the cell grows when even that would crowd the screen
func _aggregate(candidates:Array) -> Array:
	var cell:=40.0
	var out:=_cluster(candidates,cell)
	while out.size()>120 and cell<400.0:
		cell*=1.6; out=_cluster(candidates,cell)
	return out


func _cluster(candidates:Array,cell:float) -> Array:
	var cells:={}
	for group:Dictionary in candidates:
		var key:=(int(group.owner)+1)*1000000+(floori(group.anchor.x/cell)+500)*1000+floori(group.anchor.y/cell)+500   # integer key
		if not cells.has(key): cells[key]={"key":"c|%d"%key,"ids":[],"owner":group.owner,"types":{},"anchor":Vector2.ZERO,"hp":0.0,"n":0,"selected":false,"veteran":0,"offset":Vector2.ZERO,"cluster":true,"priority":-INF}
		var c:Dictionary=cells[key]
		c.world=(c.get("world",Vector3.ZERO) as Vector3)+(group.get("world",Vector3.ZERO) as Vector3)*group.ids.size()
		c.ids.append_array(group.ids); c.anchor+=group.anchor*group.ids.size(); c.hp+=float(group.hp)*group.ids.size(); c.n+=group.ids.size()
		c.types[group.type]=int(c.types.get(group.type,0))+group.ids.size()
		c.selected=c.selected or group.selected; c.veteran=maxi(int(c.veteran),int(group.get("veteran",0))); c.priority=maxf(float(c.priority),float(group.priority))
	var out:=[]
	for c:Dictionary in cells.values():
		c.anchor/=maxi(1,int(c.n)); c.hp/=maxi(1,int(c.n)); c.world=(c.world as Vector3)/maxi(1,int(c.n))
		var best:=""; var most:=-1
		for type in c.types:
			if int(c.types[type])>most: most=int(c.types[type]); best=str(type)
		c.type=best
		out.append(c)
	return out


func _show_deposits() -> bool:
	if app.command_tools.mode=="build": return true
	for id in app.military.selected:
		if str(app.world.units.get(id,{}).get("type",""))=="colonist": return true
	return false


## Full layout at once (selection changes, tests). The per-frame path below spreads the same work
## over three frames: grouping, candidates, then clustering and placement.
func refresh() -> void:
	if not _active(): return
	_members()
	_place(_candidates())


func _active() -> bool:
	active=app.world.ready_ and not app.shell.is_blocking() and not app.shell.world_hidden
	if not active: banners.clear(); markers.clear(); queue_redraw()
	return active


func _candidates() -> Array:
	var world:WorldState=app.world; var viewport:=Rect2(Vector2.ZERO,size).grow(30); var candidates:=[]
	if app.strategic.unit_labels:
		# cheap rejection first (the group's hex against the view), then one projection per group
		var focus:Vector3=app.cam.focus; var half_w:float=app.cam.view_half_width()+2.0; var half_h:float=app.cam.size+2.0
		for source:Dictionary in groups.values():
			var first:Dictionary=world.units.get(source.ids[0],{})
			if first.is_empty(): continue
			var c:Vector2=world.grid.center(int(first.tile))
			if absf(world.grid.dx_wrap(focus.x,c.x))>half_w or absf(c.y-focus.z)>half_h: continue
			var group:=source.duplicate(); var world_sum:=Vector3.ZERO; var hp:=0.0; var count:=0; var selected:=false
			for id in source.ids:
				var unit:Dictionary=world.units.get(id,{})
				if unit.is_empty() or not app.military.draw_positions.has(id): continue
				if int(unit.owner)!=world.civ_id and not world.is_visible(int(unit.tile)): continue
				world_sum+=app.military.draw_positions[id]; hp+=float(unit.hp); count+=1; selected=selected or app.military.selected.has(id)
				group.veteran=maxi(int(group.get("veteran",0)),int(unit.get("veteran",0)))
			if count==0: continue
			group.world=world_sum/count
			var anchor:Vector2=app.cam.to_screen(world_sum/count+Vector3(0,.22,0))
			if not viewport.has_point(anchor): continue
			group.anchor=anchor; group.hp=hp/count; group.selected=selected
			group.priority=(10000 if selected else 0)+(2000 if group.owner!=world.civ_id else 0)-anchor.distance_to(size*.5)
			candidates.append(group)
	return candidates


func _place(candidates:Array) -> void:
	banners.clear(); markers.clear()
	if not active: queue_redraw(); return
	var world:WorldState=app.world; var viewport:=Rect2(Vector2.ZERO,size).grow(30)
	# candidates were projected a frame or two ago: bring them up to the current camera
	for group:Dictionary in candidates:
		if group.has("world"):
			var now:Vector2=app.cam.to_screen((group.world as Vector3)+Vector3(0,.22,0))
			group.anchor=now
	# Many groups on screen (big armies, zoomed out): aggregate per owner and screen cell into one
	# badge with the most common unit's icon and the total count, so troops never vanish.
	if candidates.size()>36: candidates=_aggregate(candidates)
	candidates.sort_custom(func(a,b):return a.priority>b.priority)
	var occupied:=[]
	for group:Dictionary in candidates:
		if banners.size()>=160: break
		var name_:String=str(SHORT.get(group.type,world.defs.get("UNITS",{}).get(group.type,{}).get("name",group.type)))
		var text:=name_+(" ×%d"%group.ids.size() if group.ids.size()>1 else "")
		# clusters are a cell apart already (wider than a badge): placed directly, no overlap search
		var rect:=Rect2(group.anchor+Vector2(-13,-32),Vector2(26,26)) if group.get("cluster",false) else _badge(group.key,group.anchor,group.offset,occupied)
		if rect.size==Vector2.ZERO: continue
		group.rect=rect; group.text=text; banners.append(group)
	if app.strategic.resource_markers and app.cam.size<52 and _show_deposits():
		var resources:=[]
		for list in app.strategic.deposits.values():
			for tile:int in list:
				if not world.known[tile]: continue
				if app.settlements.building_at(tile)>=0: continue
				var resource:=world.deposit(tile)
				if resource<1 or resource>=DEPOSITS.size(): continue
				var p:=world.grid.center(tile)
				var point:=Vector3(world.grid.near_x(p.x,app.cam.focus.x),world.tile_height(tile)+.08,p.y)
				var anchor:Vector2=app.cam.to_screen(point)+Vector2(8,-8)
				if not viewport.has_point(anchor): continue
				resources.append({"tile":tile,"resource":resource,"text":DEPOSITS[resource][0],"good":DEPOSITS[resource][1],"anchor":anchor,"distance":anchor.distance_to(size*.5)})
		resources.sort_custom(func(a,b):return a.distance<b.distance)
		for record:Dictionary in resources:
			if markers.size()>=128: break
			var rect:=Rect2(record.anchor-Vector2(10,10),Vector2(20,20))
			if occupied.any(func(other):return (other as Rect2).grow(2).intersects(rect)): continue
			record.rect=rect; occupied.append(rect); markers.append(record)
	queue_redraw()

func _draw() -> void:
	if not active: return
	var alpha:=1.0-smoothstep(42.0,52.0,app.cam.size)
	for record in markers:
		draw_texture_rect(icons[record.resource],record.rect,false,Color(1,1,1,alpha))
	for record in banners:
		var rect:Rect2=record.rect; var anchor:Vector2=record.anchor
		var color:Color=app.world.civ_color(int(record.owner)).lightened(.12)
		var edge:Color=NativeUI.GOLD if record.selected else color
		draw_line(anchor,Vector2(rect.get_center().x,rect.end.y),Color(edge,.35),1,true)
		draw_circle(rect.get_center(),13,Color("172229"))
		draw_arc(rect.get_center(),12.5,0,TAU,32,edge,2 if record.selected else 1.3,true)
		draw_texture_rect(unit_icons[record.type],rect.grow(-3),false)
		if record.ids.size()>1:
			var point:=rect.position+Vector2(19,27); var text:=str(record.ids.size())
			draw_string_outline(font,point,text,HORIZONTAL_ALIGNMENT_LEFT,-1,12,4,Color("11191f"))
			draw_string(font,point,text,HORIZONTAL_ALIGNMENT_LEFT,-1,12,NativeUI.TEXT)
		# veterancy: up to three gold chevrons above the badge, earned in combat (server rank)
		for rank in int(record.get("veteran",0)):
			var c:=Vector2(rect.get_center().x,rect.position.y-3-rank*4)
			draw_polyline(PackedVector2Array([c+Vector2(-5,1),c+Vector2(0,-2),c+Vector2(5,1)]),Color("11191f"),3.2,true)
			draw_polyline(PackedVector2Array([c+Vector2(-5,1),c+Vector2(0,-2),c+Vector2(5,1)]),NativeUI.GOLD,1.6,true)
		if record.selected or float(record.hp)<75:
			draw_rect(Rect2(rect.position+Vector2(5,rect.size.y-3),Vector2(rect.size.x-6,2)),Color("273338"))
			draw_rect(Rect2(rect.position+Vector2(5,rect.size.y-3),Vector2((rect.size.x-6)*clampf(record.hp/100.0,0,1),2)),Color("deac82") if record.hp<50 else edge)

func _follow_camera() -> void:
	for record:Dictionary in banners:
		if not record.has("world"): continue
		var anchor:Vector2=app.cam.to_screen((record.world as Vector3)+Vector3(0,.22,0))
		var shift:Vector2=anchor-(record.anchor as Vector2)
		record.anchor=anchor; record.rect=Rect2((record.rect as Rect2).position+shift,(record.rect as Rect2).size)
	queue_redraw()


func select_banner(record:Dictionary,add:=false) -> void:
	if not add: app.military.selected.clear(); app.input.selected_buildings.clear(); app.settlements.selected_building=-1
	app.input.selected_army=-1
	for id in record.ids:
		if app.world.units.has(id): app.military.selected[int(id)]=true
	app.input.selection_changed.emit(); refresh()

func _process(dt:float) -> void:
	if absf(app.cam.size-last_zoom)>.002: zoom_settled=0.0
	else: zoom_settled+=dt
	last_zoom=app.cam.size; lock_layout=zoom_settled<.18
	var t0:=Time.get_ticks_usec()
	# full layout every third frame (and at once on zoom or new data); in between the placed badges
	# only follow the camera, so a large army costs a fraction of a frame
	layout_frame+=1
	if not _active(): last_us=Time.get_ticks_usec()-t0; return
	match layout_phase:
		2:
			_place(pending); pending=[]; layout_phase=0
		1:
			pending=_candidates(); layout_phase=2; _follow_camera()
		_:
			var changed:bool=app.world.snapshot_count!=layout_snapshot or absf(app.cam.size-layout_zoom)>.002
			if changed or layout_frame%3==0 or banners.is_empty():
				layout_snapshot=app.world.snapshot_count; layout_zoom=app.cam.size
				_members(); layout_phase=1
			_follow_camera()
	last_us=Time.get_ticks_usec()-t0
