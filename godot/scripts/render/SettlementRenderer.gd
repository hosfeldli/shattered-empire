class_name SettlementRenderer
extends Node3D
## Buildings and districts. Neighbouring finished buildings of compatible kinds and the same owner
## join into one district (the same grouping the PixiJS client uses, client/visual/DistrictMerge.js):
## a district is one ArrayMesh with shared ground (garden plots, works yard, paved square, aligned
## fields) and connecting structures across shared edges (terraces, pipe runs, rail spurs, paths).
## Every building is still its own selectable thing: picking works on the server's hex ids, and a
## selected building is outlined. All state shown here (level, progress, damage, fire, activity) is
## what the server sent; nothing is decided by the client.

const GROUP := RecipeRegistry.GROUPS
const SQRT3 := HexGrid.SQRT3

var world: WorldState
var cam: CameraController
var composition: WorldCompositionSystem
var version := -1
var districts := {}          # district key -> { node, fx, anchor, structure_sig, progress_sig, smoke }
var at_tile := {}            # tile -> building id
var district_of := {}        # building id -> district key
var refresh_queue: Array[String] = []
var refresh_pending := {}
var retiring: Array = []     # old district batches stay visible until all replacements are ready
var home_sites:={}
var site_records:={}
var _next_generation := 0
var selected_building := -1
var select_mark: MeshInstance3D
var select_copies: Array[MeshInstance3D] = []
var ruin_inst: MeshInstance3D
var ruin_sig := ""
var ruin_anchor := Vector2.ZERO
var rebuilt := 0
var construction_templates:={}
var plumes: MultiMeshInstance3D   # all chimney and fire smoke: one batch, animated here
const MAX_PUFFS := 900
const REBUILD_BUDGET_US := 1000


func setup(w: WorldState, c: CameraController, shared: WorldCompositionSystem = null) -> void:
	world = w
	cam = c
	composition = shared
	if composition == null:
		composition = WorldCompositionSystem.new()
		composition.setup(world)
	composition.graph.districts_reconciled.connect(_on_districts_reconciled)
	composition.graph.district_invalidated.connect(_on_district_invalidated)
	var t := TorusMesh.new()
	t.inner_radius = 0.82
	t.outer_radius = 0.9
	t.rings = 6
	t.ring_segments = 4
	t.material = MaterialLibrary.glow(Color(0.98, 0.9, 0.55))
	select_mark = MeshInstance3D.new()
	select_mark.mesh = t
	select_mark.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	select_mark.visible = false
	add_child(select_mark)
	for k in 2:
		var copy:=MeshInstance3D.new(); copy.mesh=t
		copy.cast_shadow=GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		copy.visible=false; add_child(copy); select_copies.append(copy)
	ruin_inst = MeshInstance3D.new()
	ruin_inst.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(ruin_inst)
	plumes = MultiMeshInstance3D.new()
	plumes.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.use_colors = true
	var puff := SphereMesh.new()
	puff.radius = 0.05
	puff.height = 0.08
	puff.radial_segments = 6
	puff.rings = 3
	puff.material = MaterialLibrary.smoke(Color(1, 1, 1), 0.55)
	mm.mesh = puff
	mm.instance_count = MAX_PUFFS
	mm.visible_instance_count = 0
	plumes.multimesh = mm
	add_child(plumes)
	world.reset.connect(_clear)
	world.welcomed.connect(_clear)


func _clear() -> void:
	for key in districts:
		composition.scheduler.cancel("district:" + str(key))
	for d in districts.values():
		(d.node as Node).queue_free()
		(d.fx as Node).queue_free()
		_free_copies(d)
	for d in retiring:
		(d.node as Node).queue_free(); (d.fx as Node).queue_free()
		_free_copies(d)
	retiring.clear()
	home_sites.clear(); construction_templates.clear()
	site_records.clear()
	districts.clear()
	at_tile = {}
	district_of = {}
	refresh_queue.clear()
	refresh_pending.clear()
	ruin_sig = ""
	if ruin_inst:
		ruin_inst.mesh = null
	version = -1


func update(_dt: float, allow_rebuild := true) -> void:
	if world.grid == null:
		return
	composition.sync()
	at_tile = composition.graph.at_tile
	district_of = composition.graph.district_of
	if allow_rebuild:
		if version != world.buildings_version:
			version = world.buildings_version
			for id in home_sites.keys():
				if not world.buildings.has(id): home_sites.erase(id)
			for id in site_records.keys():
				if not world.buildings.has(id): site_records.erase(id)
			_rebuild()
		else:
			_build_some()
	var cx := cam.focus.x
	var g := world.grid
	for d in districts.values()+retiring:
		var a: Vector2 = d.anchor
		var off := Vector3(g.near_x(a.x, cx) - a.x, 0, 0)
		(d.node as Node3D).position = off
		(d.fx as Node3D).position = off
		_place_copies(d,cx)
	_try_handoff()
	ruin_inst.position = Vector3(g.near_x(ruin_anchor.x, cx) - ruin_anchor.x, 0, 0)
	_update_plumes()
	_update_mark()


## smoke from working chimneys and burning buildings: puffs rising, drifting and fading on a loop
func _update_plumes() -> void:
	var mm := plumes.multimesh
	var g := world.grid
	var cx := cam.focus.x
	var now := Time.get_ticks_msec() / 1000.0
	var n := 0
	var cap := MAX_PUFFS if cam.size < 40.0 else 450 if cam.size < 100.0 else 180
	cap = mini(cap,composition.lod.budget("puffs",cam.size))
	for d in districts.values():
		for s in d.smoke:
			var base: Vector3 = s[0]
			var col: Color = s[1]
			var x0 := g.near_x(base.x, cx)
			for k in 6:
				if n >= cap:
					break
				var u := fposmod(now * 0.22 + k / 6.0 + base.z * 0.37, 1.0)
				var drift := composition.weather.wind * u * .4
				var p := Vector3(x0 + drift.x, base.y + u * 0.7, base.z + drift.y)
				var sc := 0.6 + u * 1.8
				mm.set_instance_transform(n, Transform3D(Basis().scaled(Vector3.ONE * sc), p))
				mm.set_instance_color(n, Color(col, (1.0 - u) * 0.8))
				n += 1
	mm.visible_instance_count = n


func _update_mark() -> void:
	var b: Dictionary = world.buildings.get(selected_building, {})
	if b.is_empty():
		select_mark.visible = false
		for copy in select_copies: copy.visible=false
		return
	var c := world.grid.center(int(b.t))
	var x := world.grid.near_x(c.x, cam.focus.x)
	select_mark.visible = true
	select_mark.position = Vector3(x, world.tile_height(int(b.t)) + 0.03, c.y)
	for k in select_copies.size():
		var copy:MeshInstance3D=select_copies[k]
		copy.position=select_mark.position+Vector3(world.grid.period*(-1 if k==0 else 1),0,0)
		copy.visible=world.grid.wrap and absf(copy.position.x-cam.focus.x)<cam.view_half_width()+1


func building_at(tile: int) -> int:
	return int(at_tile.get(tile, -1))


func is_building() -> bool:
	return not refresh_queue.is_empty() or composition.scheduler.has_pending("district:")


# ------------------------------------------------------------------ districts
func _rebuild() -> void:
	# Topology belongs to the semantic graph. Ruins are still a separate authoritative render layer.
	composition.sync()
	_build_ruins()


func _on_districts_reconciled(upserted: Array, removed: Array) -> void:
	for key in removed:
		if not districts.has(key):
			continue
		var old:Dictionary=districts[key]
		if (old.node as MeshInstance3D).mesh!=null:
			retiring.append(old)
		else:
			(old.node as Node).queue_free(); (old.fx as Node).queue_free()
			_free_copies(old)
		districts.erase(key)
		composition.scheduler.cancel("district:" + str(key))
	for key in upserted:
		var ids: Array = composition.graph.districts[key].ids
		var rec: Dictionary = districts.get(key, {})
		if rec.is_empty():
			var mi := MeshInstance3D.new()
			var fx := MeshInstance3D.new()
			fx.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
			add_child(mi)
			add_child(fx)
			var first: WorldStateAdapter.BuildingRecord = composition.adapter.buildings[ids[0]]
			rec = {"node": mi, "fx": fx, "ids": ids, "anchor": world.grid.center(first.tile), "structure_sig": "", "progress_sig": "", "smoke": [],"ready":false}
			districts[key] = rec
		rec.ids = ids
		rec.ready=false
		_queue_refresh(key)
	_try_handoff()


func _try_handoff() -> void:
	if retiring.is_empty(): return
	var keep:=[]
	for old in retiring:
		var ready:=true
		for id in old.ids:
			var key:=str(composition.graph.district_of.get(id,""))
			if key!="" and (not districts.has(key) or not districts[key].get("ready",false)):
				ready=false; break
		if ready:
			(old.node as Node).queue_free(); (old.fx as Node).queue_free()
			_free_copies(old)
		else: keep.append(old)
	retiring=keep
	var staged:={}
	for old in retiring:
		for id in old.ids:
			var key:=str(composition.graph.district_of.get(id,""))
			if key!="": staged[key]=true
	for key in districts:
		var show:=not staged.has(key)
		(districts[key].node as Node3D).visible=show
		(districts[key].fx as Node3D).visible=show
		if not show:
			for pair in districts[key].get("copies",[]):
				(pair[0] as Node3D).hide(); (pair[1] as Node3D).hide()


func _free_copies(rec:Dictionary) -> void:
	for pair in rec.get("copies",[]):
		(pair[0] as Node).queue_free(); (pair[1] as Node).queue_free()


func _place_copies(rec:Dictionary,cx:float) -> void:
	if not world.grid.wrap: return
	var source:MeshInstance3D=rec.node
	var effects:MeshInstance3D=rec.fx
	var bounds:=source.mesh.get_aabb() if source.mesh else AABB(Vector3(rec.anchor.x-1,0,rec.anchor.y-1),Vector3(2,1,2))
	var primary:=source.position.x
	var copies:Array=rec.get("copies",[])
	for k in 2:
		var offset:=primary+world.grid.period*(-1 if k==0 else 1)
		var visible_:bool=source.visible and bounds.end.x+offset>=cx-cam.view_half_width() and bounds.position.x+offset<=cx+cam.view_half_width()
		if copies.size()<=k:
			if not visible_: continue
			while copies.size()<=k:
				var geometry:=MeshInstance3D.new(); var fx:=MeshInstance3D.new()
				fx.cast_shadow=GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
				add_child(geometry); add_child(fx); copies.append([geometry,fx])
		var geometry:MeshInstance3D=copies[k][0]; var fx:MeshInstance3D=copies[k][1]
		geometry.mesh=source.mesh; fx.mesh=effects.mesh
		geometry.position=Vector3(offset,0,0); fx.position=geometry.position
		geometry.visible=visible_; fx.visible=visible_
	rec.copies=copies


func _on_district_invalidated(key: String, flags: int) -> void:
	if districts.has(key):
		if flags & WorldStateAdapter.Change.CONTEXT:
			districts[key].structure_sig = ""
		_queue_refresh(key)


func _queue_refresh(key: String) -> void:
	if not refresh_pending.has(key):
		refresh_pending[key] = true
		refresh_queue.append(key)


func _refresh_district(key: String, list: Array) -> void:
	var rec: Dictionary = districts[key]
	var structure_sig := _structure_signature(list)
	var progress_sig := _progress_signature(list)
	if rec.structure_sig != structure_sig:
		rec.structure_sig = structure_sig
		_queue_build(key, list)
	elif (rec.node as MeshInstance3D).mesh!=null:
		rec.ready=true
	if rec.progress_sig != progress_sig:
		rec.progress_sig = progress_sig
		_build_progress(rec, list)


func _structure_signature(list: Array) -> String:
	var parts := PackedStringArray()
	for b in list:
		# Damage stages alter the static tint, but progress, fire and activity never rebuild this mesh.
		parts.append("%d:%s:%d:%d:%s:%d:%d:%d" % [int(b.id), b.ty, int(b.get("o", -1)), int(b.get("d", 0)), str(b.get("st", ""))=="ruined", int(b.get("lv", 1)), (0 if int(b.get("hp",100))>=85 else 1 if int(b.get("hp",100))>=60 else 2 if int(b.get("hp",100))>=35 else 3), int(b.get("ti", 0))])
	return "|".join(parts)


func _progress_signature(list: Array) -> String:
	var parts := PackedStringArray()
	for b in list:
		parts.append("%d:%d:%d:%d" % [int(b.id), int(b.get("p", 0)) / 10, int(b.get("f", 0)), int(b.get("a", 0))])
	return "|".join(parts)


func _queue_build(key: String, list: Array) -> void:
	_next_generation += 1
	var job := _begin_district(key, list)
	job["generation"] = _next_generation
	districts[key]["generation"] = _next_generation
	var priority := GenerationScheduler.Priority.HIGH
	if (districts[key].ids as Array).has(selected_building):
		priority = GenerationScheduler.Priority.CRITICAL
	composition.scheduler.enqueue("district:" + key, _next_generation, priority, _step_district.bind(job), _commit_district.bind(job))


func _build_some() -> void:
	var t0 := Time.get_ticks_usec()
	while not refresh_queue.is_empty() and Time.get_ticks_usec() - t0 < REBUILD_BUDGET_US:
		var key: String = refresh_queue.pop_front()
		refresh_pending.erase(key)
		if districts.has(key):
			var list := []
			for id in districts[key].ids:
				list.append(world.buildings[id])
			_refresh_district(key, list)
	var remaining := REBUILD_BUDGET_US - (Time.get_ticks_usec() - t0)
	if remaining > 0:
		composition.scheduler.tick(remaining)


func _begin_district(key: String, list: Array) -> Dictionary:
	var g := world.grid
	var anchor := g.center(int(list[0].t))
	districts[key].anchor = anchor
	var by_tile := {}
	for b in list:
		by_tile[int(b.t)] = b
	var group: String = GROUP.get(list[0].ty, "") if list.size() > 1 else ""
	return {"key": key, "list": list, "next": 0, "kit": MeshKit.new(), "by_tile": by_tile, "anchor": anchor, "group": group}


func _step_district(job: Dictionary) -> bool:
	if not districts.has(job.key) or int(districts[job.key].get("generation", -1)) != int(job.generation):
		return true
	var list: Array = job.list
	if int(job.next) >= list.size():
		if not job.has("surfaces"):
			job.surfaces=(job.kit as MeshKit).parts.keys(); job.surface_next=0; job.mesh=ArrayMesh.new()
		if int(job.surface_next)<job.surfaces.size():
			(job.kit as MeshKit).commit_surface(job.mesh,job.surfaces[int(job.surface_next)])
			job.surface_next+=1
		return int(job.surface_next)==job.surfaces.size()
	var building:Dictionary=list[int(job.next)]
	if str(building.ty)=="house" and int(building.get("d",0))==1:
		if not job.has("house_part"):
			_append_building(building,job,true)
			job.house_part=0
			return false
		var tile:=int(building.t); var center:=world.grid.center(tile); var anchor:Vector2=job.anchor
		(job.kit as MeshKit).set_frame(Vector3(anchor.x+world.grid.dx_wrap(anchor.x,center.x),world.tile_height(tile),center.y),0)
		_parcel_frame(job.kit,building)
		_house_part(job.kit,building,int(job.house_part),_tint(building))
		job.house_part+=1
		if int(job.house_part)<2+mini(int(building.get("lv",1)),3): return false
		job.erase("house_part")
	else:
		_append_building(building, job)
	job.next += 1
	return false


func _commit_district(job: Dictionary) -> void:
	if not districts.has(job.key) or int(districts[job.key].get("generation", -1)) != int(job.generation):
		return
	(districts[job.key].node as MeshInstance3D).mesh = job.get("mesh")
	districts[job.key].ready=true
	_try_handoff()
	rebuilt += 1


func _append_building(b: Dictionary, job: Dictionary, skip_model := false) -> void:
	var g := world.grid
	var anchor: Vector2 = job.anchor
	var kit: MeshKit = job.kit
	var group := str(job.group)
	var by_tile: Dictionary = job.by_tile
	var t := int(b.t)
	var c2 := g.center(t)
	var lc := Vector3(anchor.x + g.dx_wrap(anchor.x, c2.x), world.tile_height(t), c2.y)
	kit.set_frame(lc, 0.0)
	if int(b.get("d", 0)) == 1 and not skip_model:
		if not _parcel_frame(kit,b): return
		if str(b.ty)!="house" and str(b.ty)!="farm": _foundation(kit,Vector2(.25,.20))
		_building(kit, b, _tint(b))
	if group != "":
		for d in [0, 4, 5]:
			var nb: int = g.nb[t * 6 + d]
			if by_tile.has(nb):
				var c3 := g.center(nb)
				var lc2 := Vector3(lc.x + g.dx_wrap(c2.x, c3.x), world.tile_height(nb), c3.y)
				kit.set_frame(Vector3.ZERO, 0.0)
				_connect(kit, group, lc, lc2, b, by_tile[nb])


## Frequently changing progress, fire and activity stay out of the district mesh. Construction and
## fire are tiny companion meshes; smoke is just a list consumed by the shared MultiMesh batch.
func _build_progress(rec: Dictionary, list: Array) -> void:
	var g := world.grid
	var anchor := g.center(int(list[0].t))
	rec.anchor = anchor
	var kit := MeshKit.new()
	var smokes: Array = []
	for b in list:
		var t := int(b.t)
		var c2 := g.center(t)
		var lc := Vector3(anchor.x + g.dx_wrap(anchor.x, c2.x), world.tile_height(t), c2.y)
		kit.set_frame(lc, 0.0)
		if not _parcel_frame(kit,b): continue
		if int(b.get("d", 0)) == 0:
			_construction(kit, b, _tint(b))
		if int(b.get("f", 0)) == 1:
			kit.box("glow:ff8a2a", Vector3(0, 0.05, 0), Vector3(0.3, 0.12, 0.25), Color.WHITE)
		_append_smoke(smokes, b, Transform3D(kit.basis,kit.origin))
	(rec.fx as MeshInstance3D).mesh = kit.commit() if not kit.is_empty() else null
	rec.smoke = smokes


func _append_smoke(smokes: Array, b: Dictionary, frame: Transform3D) -> void:
	var active := int(b.get("a", 0)) == 1
	var ty := str(b.ty)
	if active and ty in ["steel_mill", "refinery", "munitions_plant", "electronics_plant", "motor_works", "heavy_assembly", "robotics_complex", "drone_works", "salvage"]:
		smokes.append([frame * Vector3(0.36, 0.665, -0.22), Color(0.55, 0.53, 0.5)])
	elif active and ty == "power_plant":
		for z in [-0.18, 0.18]:
			smokes.append([frame * Vector3(0.2, 0.425, z), Color(0.86, 0.86, 0.86)])
	if int(b.get("f", 0)) == 1:
		smokes.append([frame * Vector3(0, 0.3, 0), Color(0.2, 0.18, 0.17)])


func _tint(b: Dictionary) -> Color:
	var st := str(b.get("st", ""))
	var hp := int(b.get("hp", 100))
	var c := Color.WHITE
	if st == "damaged" or hp < 50:
		c = Color(0.62, 0.58, 0.55)
	return c


func _rng(b: Dictionary, purpose := "layout") -> RandomNumberGenerator:
	var recipe: Dictionary = composition.graph.matches.get(int(b.id), {})
	if recipe.is_empty():
		for candidate in composition.registry.recipes:
			if str(b.ty) in candidate.get("types",[]) or "*" in candidate.get("types",[]): recipe=candidate; break
	# Site/type identity can be reconstructed before the server allocates a building ID. The
	# placement ghost and accepted building therefore retain the same architecture and siting.
	return composition.identities.rng_for("site:%d:%s" % [int(b.t),str(b.ty)], str(recipe.get("id", "fallback.structure")), int(recipe.get("version", 1)), purpose)

func preview_mesh(type:String,tile:int,adjacency:=true,level:=1,tier:=0,hp:=100,state:="operational") -> ArrayMesh:
	if world.grid==null or tile<0 or tile>=world.grid.n or world.known[tile]==0: return null
	var record:={"id":-tile-2,"ty":type,"t":tile,"o":world.civ_id,"d":1,"hp":hp,"lv":level,"st":state,"ti":tier}
	var kit:=MeshKit.new(); var center:=world.grid.center(tile)
	kit.set_frame(Vector3(center.x,world.tile_height(tile),center.y),0)
	if not _parcel_frame(kit,record): return null
	if not type in ["house","farm"]: _foundation(kit,Vector2(.25,.20))
	_building(kit,record,Color.WHITE)
	var group:=str(GROUP.get(type,""))
	if adjacency and not group.is_empty():
		for direction in 6:
			var neighbor:=world.grid.nb[tile*6+direction]
			var other:Dictionary=world.buildings.get(at_tile.get(neighbor,-1),{})
			if other.is_empty() or int(other.o)!=world.civ_id or int(other.get("d",0))!=1 or GROUP.get(str(other.ty),"")!=group: continue
			var p:=world.grid.center(neighbor)
			var a:=Vector3(center.x,world.tile_height(tile),center.y)
			var b:=Vector3(center.x+world.grid.dx_wrap(center.x,p.x),world.tile_height(neighbor),p.y)
			kit.set_frame(Vector3.ZERO,0)
			if direction in [0,4,5]: _connect(kit,group,a,b,record,other)
			else: _connect(kit,group,b,a,other,record)
	# Temporary records are render-only and never enter the authoritative graph or picking map.
	home_sites.erase(record.id); site_records.erase(record.id)
	return kit.commit() if not kit.is_empty() else null


func parcel_transform(b:Dictionary) -> Transform3D:
	var rng:=_rng(b,"parcel")
	var offset:=Vector3(rng.randf_range(-.045,.045),0,rng.randf_range(-.045,.045))
	var yaw:=rng.randf_range(-PI,PI)
	if GROUP.get(str(b.ty),"")=="farm":
		var region:=composition.identities.rng_for("agriculture:%d"%world._chunk_of(int(b.t)),"field.orientation",1,"layout")
		yaw=region.randf_range(-PI,PI)+rng.randf_range(-.10,.10)
	# Waterfront structures and extraction cuts retain their geographic alignment.
	if str(b.ty) in ["port","mine","quarry"]: yaw=rng.randf_range(-.12,.12)
	return Transform3D(Basis(Vector3.UP,yaw),offset)


func _parcel_frame(kit:MeshKit,b:Dictionary) -> bool:
	var variation:=parcel_transform(b)
	if str(b.ty)!="house":
		var half:=Vector2(.54,.44)
		if str(b.ty)=="town": half=Vector2(.48,.4)
		elif str(b.ty)=="farm": half=Vector2(.23,.2)
		elif str(b.ty)=="airfield": half=Vector2(.79,.54)
		elif str(b.ty)=="fort": half=Vector2(.86,.86)
		elif str(b.ty)=="wonder": half=Vector2(.42,.42)
		var site:=composition.sites.plan(int(b.t),Vector2(variation.origin.x,variation.origin.z),variation.basis.get_euler().y,half)
		site_records[int(b.id)]=site
		if site.valid:
			var planned:Transform3D=site.transform
			planned.origin.x=world.grid.near_x(planned.origin.x,kit.origin.x)
			kit.basis=planned.basis; kit.origin=planned.origin
			return true
		return false
	var frame:=Transform3D(kit.basis,kit.origin)*variation
	kit.basis=frame.basis; kit.origin=frame.origin
	return true


# ------------------------------------------------------------------ foundations and connections
func _foundation(kit:MeshKit,half:Vector2) -> void:
	for x in [-half.x,half.x]:
		for z in [-half.y,half.y]:
			var point:=kit.xf(Vector3(x,0,z))
			var ground:=world.ground_height(point.x,point.z)
			var depth:=maxf(0.0,point.y-ground)
			if depth>.018:
				var scale_:float=kit.basis.get_scale().y
				kit.box("stone",Vector3(x,-depth/scale_,z),Vector3(.045,depth/scale_+.015,.045))


func _connect(kit: MeshKit, group: String, a: Vector3, b: Vector3, ba: Dictionary, bb: Dictionary) -> void:
	if composition.sites.crosses_water(int(ba.t),Vector2(a.x,a.z),Vector2(b.x,b.z),.5): return
	var mid := (a + b) * 0.5
	var dir := Vector2(b.x - a.x, b.z - a.z)
	var yaw := atan2(-dir.y, dir.x)
	var along := Vector3(dir.x, 0, dir.y).normalized()
	var across := along.cross(Vector3.UP)
	var y := maxf(a.y, b.y) + 0.02
	var edge := "edge:%d:%d" % [mini(int(ba.t), int(bb.t)), maxi(int(ba.t), int(bb.t))]
	var rng := composition.identities.rng_for(edge, "connection." + group, 1, "layout")
	match group:
		"res":
			# a terrace of row houses straddling the shared edge, facing the street
			var walls := _wall_mat(rng)
			var n := 3
			for k in n:
				var off := (k - (n - 1) * 0.5) * 0.17
				var p := mid + across * off
				var ground:=world.ground_height(p.x,p.z)+.016
				kit.box(walls, Vector3(p.x, ground, p.z), Vector3(0.26, 0.17 + 0.05 * int(ba.get("lv", 1)), 0.15), Color(1, 1, 1).darkened(rng.randf() * 0.12), yaw)
				kit.gable(_roof_mat(rng), Vector3(p.x, ground + 0.17 + 0.05 * int(ba.get("lv", 1)), p.z), 0.15, 0.26, 0.08, Color(1, 1, 1), yaw + PI * 0.5)
		"ind":
			# a pipe run on trestles and a rail spur between the plants
			var len := Vector2(b.x - a.x, b.z - a.z).length()
			kit.box("steel", Vector3(mid.x, y + 0.2, mid.z) + across * 0.25, Vector3(len, 0.035, 0.035), Color(0.9, 0.9, 0.9), yaw)
			for f in [-0.3, 0.0, 0.3]:
				var p: Vector3 = mid + along * (f * len) + across * 0.25
				kit.box("steel", Vector3(p.x, y, p.z), Vector3(0.025, 0.2, 0.025), Color(0.8, 0.8, 0.8))
			kit.box("ballast", Vector3(mid.x, y - 0.01, mid.z) - across * 0.2, Vector3(len, 0.02, 0.12), Color(1, 1, 1), yaw)
			kit.box("steel", Vector3(mid.x, y + 0.01, mid.z) - across * 0.23, Vector3(len, 0.012, 0.012), Color(0.7, 0.7, 0.7), yaw)
			kit.box("steel", Vector3(mid.x, y + 0.01, mid.z) - across * 0.17, Vector3(len, 0.012, 0.012), Color(0.7, 0.7, 0.7), yaw)
		"civ":
			var len := Vector2(b.x - a.x, b.z - a.z).length()
			_ground_path(kit,a,b,.4,"paving",Color(.95,.94,.9))
			for s in [-1.0, 1.0]:
				var p: Vector3 = mid + across * (0.3 * s)
				kit.cylinder("bark", Vector3(p.x, y, p.z), 0.015, 0.1, 5)
				kit.cone("foliage", Vector3(p.x, y + 0.08, p.z), 0.08, 0.2, 6)
		"com":
			var len := Vector2(b.x - a.x, b.z - a.z).length()
			for k in 3:
				var p := mid + along * ((k - 1) * len * 0.25) + across * 0.18
				kit.box("timber", Vector3(p.x, y, p.z), Vector3(0.14, 0.08, 0.1), Color(1, 1, 1), yaw)
				kit.gable("canvas", Vector3(p.x, y + 0.08, p.z), 0.12, 0.16, 0.05, _awning(rng), yaw)
		"ext":
			var len := Vector2(b.x - a.x, b.z - a.z).length()
			_ground_path(kit,a,b,.16,"soil",Color(.9,.85,.78))
		"farm":
			pass


# ------------------------------------------------------------------ buildings
func _construction(kit: MeshKit, b: Dictionary, _tint_: Color) -> void:
	var progress:=clampf(float(b.get("p",0))/100.0,0,1)
	var key:=str([b.id,b.ty,b.t,b.get("lv",1),world.geometry_revision,kit.origin,kit.basis])
	if not construction_templates.has(key):
		if construction_templates.size()>=128: construction_templates.clear()
		var full:=MeshKit.new(); full.basis=kit.basis; full.origin=kit.origin
		var complete:Dictionary=b.duplicate(); complete.hp=100; complete.d=1; complete.st="operational"
		_compose_building(full,complete,Color.WHITE)
		construction_templates[key]=full
	BuildingLifecycle.construction(kit,construction_templates[key],b,progress)


func _wall_mat(rng: RandomNumberGenerator) -> String:
	# No birth-era record is transmitted. A neutral, versioned base palette stays stable across
	# the observing empire's era advances instead of silently rebuilding every other city too.
	return "brick" if rng.randf() < 0.65 else "plaster"


func _roof_mat(rng: RandomNumberGenerator) -> String:
	return "roof_tile" if rng.randf() < 0.6 else "roof_slate"


func _awning(rng: RandomNumberGenerator) -> Color:
	var opts := [Color(0.95, 0.9, 0.8), Color(0.75, 0.45, 0.35), Color(0.55, 0.62, 0.5), Color(0.6, 0.58, 0.7)]
	return opts[rng.randi() % opts.size()]


func _house_part(kit:MeshKit,b:Dictionary,index:int,tint:Color) -> void:
	var structure:=MeshKit.new(); structure.basis=kit.basis; structure.origin=kit.origin
	_compose_house_part(structure,b,index,tint)
	var condition:Dictionary=b.duplicate(); condition._skip_rubble=index>0
	BuildingLifecycle.append(kit,structure,condition)

func _compose_house_part(kit: MeshKit, b: Dictionary, index: int, tint: Color) -> void:
	var rng:=_rng(b,"home:%d"%index)
	var slots:=[Vector2(-.28,-.29),Vector2(.29,-.24),Vector2(-.29,.29),Vector2(.28,.31),Vector2(.01,.015)]
	var slot:Vector2=slots[index]
	slot+=Vector2(rng.randf_range(-.035,.035),rng.randf_range(-.035,.035))
	var color:=tint.darkened(rng.randf()*.15)
	var position:=Vector3(slot.x,.02,slot.y)
	var variant:=int(_rng(b,"architecture:%d"%index).randi()%3)
	var damage:=clampf((65.0-float(b.get("hp",100)))/100.0,0,.65)
	var yaw:=kit.basis.get_euler().y+rng.randf_range(-.18,.18)
	var cache:Dictionary=home_sites.get(int(b.id),{})
	if int(cache.get("revision",-1))!=world.geometry_revision:
		cache={"revision":world.geometry_revision,"sites":{}}
		home_sites[int(b.id)]=cache
	var site:Dictionary=cache.sites.get(index,{})
	if site.is_empty():
		var preferred:=kit.xf(position)
		var center:=world.grid.center(int(b.t))
		var offset:=Vector2(world.grid.dx_wrap(center.x,preferred.x),preferred.z-center.y)
		var reserved:=[]
		for earlier in cache.sites:
			if int(earlier)<index and cache.sites[earlier].get("valid",false): reserved.append(cache.sites[earlier])
		site=composition.sites.plan(int(b.t),offset,yaw,Vector2(.18,.21),reserved)
		cache.sites[index]=site
	if not site.get("valid",false): return
	var parent:=Transform3D(kit.basis,kit.origin)
	var transform:Transform3D=site.transform
	transform.origin.x=world.grid.near_x(transform.origin.x,kit.origin.x)
	kit.set_frame(transform.origin,float(site.yaw))
	_foundation(kit,site.half_size)
	if index<3:
		kit.component(AssetLibrary.residential(variant),Transform3D(Basis().scaled(Vector3.ONE*.72*float(site.scale)),Vector3.ZERO),color,damage)
	else:
		var height:=.28 if index==3 else .42
		kit.box("brick",Vector3(0,.02,0),Vector3(.23,height,.27),color)
		kit.box("roof_slate",Vector3(0,height+.02,0),Vector3(.25,.02,.29),color)
		for floor_ in 2 if index==3 else 3:
			for x in [-.065,.065]:
				for z in [-.136,.136]: kit.box("glass",Vector3(x,.07+floor_*.12,z),Vector3(.045,.055,.004))
			for x in [-.116,.116]: kit.box("glass",Vector3(x,.07+floor_*.12,0),Vector3(.004,.055,.07))
	kit.basis=parent.basis; kit.origin=parent.origin


func _ground_path(kit:MeshKit,a:Vector3,b:Vector3,width:float,material:String,color:Color) -> void:
	var direction:=Vector2(b.x-a.x,b.z-a.z).normalized()
	var side:=Vector3(-direction.y,0,direction.x)*width*.5
	for k in 6:
		var start:=a.lerp(b,k/6.0); var finish:=a.lerp(b,(k+1)/6.0)
		var points:=[start-side,start+side,finish+side,finish-side]
		for i in 4:
			points[i].y=world.ground_height(points[i].x,points[i].z)+.016
		kit.quad(material,points[0],points[1],points[2],points[3],color,Vector3.UP)


func _building(kit: MeshKit, b: Dictionary, tint: Color) -> void:
	var structure:=MeshKit.new(); structure.basis=kit.basis; structure.origin=kit.origin
	_compose_building(structure,b,tint)
	BuildingLifecycle.append(kit,structure,b)

func _compose_building(kit:MeshKit,b:Dictionary,tint:Color) -> void:
	var rng := _rng(b)
	var lv := int(b.get("lv", 1))
	var recipe: Dictionary = composition.graph.matches.get(int(b.id), {})
	var ty: String = str(recipe.get("grammar", b.ty))
	var definition:Dictionary=world.defs.get("BUILDINGS",{}).get(str(b.ty),{})
	DevelopedBuildingLibrary.development(kit,b,definition,tint)
	if DevelopedBuildingLibrary.compose(kit,b,ty,tint): return
	match ty:
		"house":
			var n := 2 + mini(lv, 3)
			for k in n:
				_house_part(kit,b,k,tint)
			kit.cone("foliage", Vector3(0.05, 0.02, 0.0), 0.12, 0.3, 7, tint)
		"town":
			var tier := int(b.get("ti",0))
			_city_growth(kit,tier,tint)
			var w := 0.5
			kit.box("stone", Vector3(0, 0.025, 0), Vector3(w, 0.28, 0.34), tint)
			kit.gable("roof_slate", Vector3(0, 0.305, 0), 0.34, w, 0.14, tint, PI * 0.5)
			kit.box("glass", Vector3(0, 0.14, 0.171), Vector3(w * 0.8, 0.08, 0.005), tint)
			kit.box("stone", Vector3(-w * 0.5 + 0.08, 0.025, -0.1), Vector3(0.13, 0.62, 0.13), tint * 1.03)
			kit.cone("roof_slate", Vector3(-w * 0.5 + 0.08, 0.645, -0.1), 0.1, 0.18, 4, tint)
			for k in 4:
				kit.cylinder("stone", Vector3(-0.15 + 0.1 * k, 0.025, 0.21), 0.018, 0.22, 6, tint)
			kit.box("steel", Vector3(0.22, 0.31, -0.08), Vector3(0.008, 0.25, 0.008))
			kit.box("team:" + world.civ_color(int(b.o)).to_html(false), Vector3(0.24, 0.48, -0.08), Vector3(0.05, 0.035, 0.004))
		"academy", "university":
			var big := 1.25 if ty == "university" else 1.0
			kit.box("stone", Vector3(0, 0.025, 0), Vector3(0.55 * big, 0.26, 0.3), tint)
			kit.box("glass", Vector3(0, 0.1, 0.152), Vector3(0.5 * big, 0.12, 0.005), tint)
			kit.box("stone", Vector3(0, 0.285, 0), Vector3(0.58 * big, 0.03, 0.33), tint)
			for k in 6:
				kit.cylinder("stone", Vector3(-0.2 * big + 0.08 * big * k, 0.025, 0.19), 0.016, 0.26, 6, tint)
			if ty == "university":
				kit.cylinder("roof_slate", Vector3(0, 0.315, 0), 0.12, 0.1, 10, tint, 0.0)
		"comms_tower":
			kit.box("concrete", Vector3(0, 0.025, 0), Vector3(0.2, 0.1, 0.2), tint)
			kit.cylinder("steel", Vector3(0, 0.1, 0), 0.06, 0.9, 4, tint, 0.012)
			kit.cylinder("steel", Vector3(0.05, 0.7, 0), 0.07, 0.02, 10, tint)
		"market":
			for k in 6:
				var a := TAU * k / 6.0
				var p := Vector3(cos(a) * 0.38, 0.03, sin(a) * 0.38)
				kit.box("timber", p, Vector3(0.14, 0.08, 0.12), tint, -a)
				kit.gable("canvas", p + Vector3(0, 0.08, 0), 0.12, 0.16, 0.05, _awning(rng), -a + PI * 0.5)
			kit.box("brick", Vector3(0, 0.03, 0), Vector3(0.3, 0.2, 0.22), tint)
			kit.gable("roof_tile", Vector3(0, 0.23, 0), 0.22, 0.3, 0.1, tint, PI * 0.5)
		"port":
			kit.box("timber", Vector3(0.5, 0.0, 0), Vector3(0.7, 0.04, 0.16), tint)
			kit.box("brick", Vector3(-0.2, 0.03, 0), Vector3(0.36, 0.18, 0.26), tint)
			kit.gable("roof_slate", Vector3(-0.2, 0.21, 0), 0.26, 0.36, 0.08, tint, PI * 0.5)
			kit.box("steel", Vector3(0.45, 0.04, 0.12), Vector3(0.03, 0.42, 0.03), Color(0.85, 0.6, 0.25))
			kit.box("steel", Vector3(0.55, 0.44, 0.12), Vector3(0.28, 0.025, 0.025), Color(0.85, 0.6, 0.25))
		"farm":
			_fields(kit, b, tint)
		"mine":
			kit.box("steel", Vector3(-0.1, 0.02, -0.05), Vector3(0.025, 0.5, 0.025), tint)
			kit.box("steel", Vector3(0.1, 0.02, -0.05), Vector3(0.025, 0.5, 0.025), tint)
			kit.box("steel", Vector3(0, 0.5, -0.05), Vector3(0.24, 0.05, 0.06), tint)
			kit.cylinder("steel", Vector3(0, 0.55, -0.05), 0.05, 0.01, 10, tint)
			kit.box("timber", Vector3(0.0, 0.02, 0.2), Vector3(0.3, 0.12, 0.16), tint)
			kit.gable("roof_slate", Vector3(0.0, 0.14, 0.2), 0.16, 0.3, 0.06, tint, PI * 0.5)
			kit.cone("rock", Vector3(0.35, 0.0, -0.25), 0.28, 0.24, 7, tint * Color(0.75, 0.72, 0.7))
			_ore_outcrop(kit, rng, tint)
		"quarry":
			for k in 3:
				kit.box("rock", Vector3(-0.1 + 0.08 * k, -0.06 * k, 0), Vector3(0.5 - 0.12 * k, 0.06, 0.45 - 0.1 * k), tint * (1.0 - 0.08 * k))
			kit.box("stone", Vector3(0.38, 0.02, 0.25), Vector3(0.16, 0.1, 0.12), tint)
		"lumber":
			kit.box("timber", Vector3(-0.1, 0.02, 0), Vector3(0.4, 0.16, 0.22), tint)
			kit.gable("roof_slate", Vector3(-0.1, 0.18, 0), 0.22, 0.4, 0.08, tint, PI * 0.5)
			for k in 4:
				kit.box("bark", Vector3(0.3, 0.02 + 0.035 * (k % 2), -0.15 + 0.08 * k), Vector3(0.3, 0.035, 0.035), tint)
		"oil_well":
			kit.box("steel", Vector3(0, 0.02, 0), Vector3(0.05, 0.22, 0.05), tint)
			kit.box("steel", Vector3(0.02, 0.24, 0), Vector3(0.34, 0.03, 0.03), tint)
			kit.box("char", Vector3(-0.14, 0.17, 0), Vector3(0.05, 0.08, 0.05), tint)
			kit.cylinder("steel", Vector3(0.3, 0.02, 0.25), 0.1, 0.16, 10, tint * Color(0.9, 0.9, 0.85))
		"steel_mill", "refinery", "munitions_plant", "electronics_plant", "motor_works", "heavy_assembly", "robotics_complex", "drone_works", "salvage":
			var w := 0.62 + (0.1 if ty in ["heavy_assembly", "steel_mill"] else 0.0)
			kit.box("brick", Vector3(-0.05, 0.025, 0), Vector3(w, 0.2, 0.42), tint)
			kit.sawtooth("steel", "glass", Vector3(-0.05, 0.225, 0), w, 0.42, 0.08, 4, tint, PI * 0.5)
			var chim := Vector3(0.36, 0.025, -0.22)
			kit.cylinder("brick", chim, 0.05, 0.62, 8, tint, 0.04)
			if ty == "refinery":
				for k in 3:
					kit.cylinder("steel", Vector3(0.3, 0.025, 0.05 + 0.13 * k), 0.06, 0.18, 10, tint)
			if ty == "steel_mill":
				kit.cylinder("steel", Vector3(0.3, 0.025, 0.15), 0.09, 0.42, 10, tint * 0.8, 0.06)
		"power_plant":
			kit.box("concrete", Vector3(-0.2, 0.025, 0), Vector3(0.36, 0.22, 0.3), tint)
			for k in 2:
				var p := Vector3(0.2, 0.025, -0.18 + 0.36 * k)
				kit.cylinder("concrete", p, 0.16, 0.24, 12, tint, 0.11)
				kit.cylinder("concrete", p + Vector3(0, 0.24, 0), 0.11, 0.14, 12, tint, 0.13)
		"fusion_plant":
			kit.box("concrete", Vector3(0, 0.025, 0), Vector3(0.6, 0.12, 0.5), tint)
			kit.cylinder("glass", Vector3(0, 0.145, 0), 0.22, 0.12, 14, tint, 0.12)
			kit.cylinder("glass", Vector3(0, 0.265, 0), 0.12, 0.08, 14, tint, 0.0)
		"barracks", "camp":
			if ty == "camp":
				for k in 4:
					var a := TAU * k / 4.0
					kit.gable("canvas", Vector3(cos(a) * 0.3, 0.02, sin(a) * 0.3), 0.14, 0.2, 0.12, tint, -a)
			else:
				for k in 2:
					kit.box("concrete", Vector3(-0.2 + 0.4 * k, 0.025, 0), Vector3(0.3, 0.14, 0.5), tint)
					kit.box("roof_slate", Vector3(-0.2 + 0.4 * k, 0.165, 0), Vector3(0.32, 0.02, 0.52), tint)
			kit.box("steel", Vector3(0, 0.02, 0.32), Vector3(0.008, 0.35, 0.008))
			kit.box("team:" + world.civ_color(int(b.o)).to_html(false), Vector3(0.025, 0.31, 0.32), Vector3(0.05, 0.035, 0.004))
		"guard_post":
			for x in [-0.08, 0.08]:
				for z in [-0.08, 0.08]:
					kit.box("timber", Vector3(x, 0.02, z), Vector3(0.025, 0.38, 0.025), tint)
			kit.box("timber", Vector3(0, 0.38, 0), Vector3(0.24, 0.1, 0.24), tint)
			kit.gable("roof_slate", Vector3(0, 0.48, 0), 0.24, 0.24, 0.08, tint)
		"bunker", "missile_silo":
			kit.box("concrete", Vector3(0, 0.0, 0), Vector3(0.4, 0.12, 0.34), tint * 0.92)
			kit.box("char", Vector3(0, 0.07, 0.171), Vector3(0.24, 0.025, 0.005), tint)
			if ty == "missile_silo":
				kit.cylinder("steel", Vector3(0.3, 0.0, 0.2), 0.12, 0.03, 12, tint)
		"fort":
			for k in 6:
				var a := deg_to_rad(-60.0 + 60.0 * k)
				kit.box("stone", Vector3(cos(a) * 0.62, 0.02, sin(a) * 0.62), Vector3(0.08, 0.18, 0.7), tint, -a)
				var ca := deg_to_rad(-90.0 + 60.0 * k)
				kit.cylinder("stone", Vector3(cos(ca) * 0.72, 0.02, sin(ca) * 0.72), 0.08, 0.24, 8, tint)
			kit.box("stone", Vector3(0, 0.02, 0), Vector3(0.3, 0.22, 0.3), tint)
		"airfield":
			kit.box("asphalt", Vector3(0, 0.02, 0), Vector3(1.5, 0.015, 0.2), tint)
			kit.box("paving", Vector3(0, 0.03, 0), Vector3(1.4, 0.005, 0.015), Color(1.6, 1.6, 1.5))
			kit.box("steel", Vector3(0, 0.02, 0.4), Vector3(0.4, 0.16, 0.26), tint)
			kit.gable("steel", Vector3(0, 0.18, 0.4), 0.26, 0.4, 0.08, tint, PI * 0.5)
		"aa_battery":
			kit.cylinder("canvas", Vector3(0, 0.02, 0), 0.22, 0.07, 10, tint * Color(0.8, 0.75, 0.6), 0.2)
			kit.box("steel", Vector3(0, 0.09, 0), Vector3(0.08, 0.06, 0.08), tint)
			kit.box("steel", Vector3(0.08, 0.15, 0), Vector3(0.2, 0.015, 0.015), tint, 0.0)
		"shield_generator":
			kit.box("concrete", Vector3(0, 0.02, 0), Vector3(0.4, 0.1, 0.4), tint)
			kit.cone("steel", Vector3(0, 0.12, 0), 0.18, 0.3, 10, tint)
		"depot":
			for k in 2:
				kit.box("steel", Vector3(-0.2 + 0.4 * k, 0.02, 0), Vector3(0.3, 0.16, 0.5), tint * Color(0.8, 0.82, 0.85))
				kit.gable("steel", Vector3(-0.2 + 0.4 * k, 0.18, 0), 0.3, 0.5, 0.07, tint)
			for k in 4:
				kit.box("timber", Vector3(0.0, 0.02, -0.3 + 0.2 * k), Vector3(0.08, 0.08, 0.08), tint)
		"wonder":
			kit.box("stone", Vector3(0, 0.02, 0), Vector3(0.7, 0.1, 0.7), tint)
			kit.cylinder("stone", Vector3(0, 0.12, 0), 0.14, 1.1, 4, tint, 0.02)
		_:
			kit.box("concrete", Vector3(0, 0.02, 0), Vector3(0.42, 0.2, 0.36), tint)
			kit.box("steel", Vector3(0, 0.22, 0), Vector3(0.44, 0.02, 0.38), tint)
## fields in rows aligned east-west, so neighbouring farms read as one stretch of countryside
func _fields(kit: MeshKit, b: Dictionary, tint: Color) -> void:
	var rows := 7
	for k in rows:
		var z := -0.78 + 1.56 * (k + 0.5) / rows
		var az := absf(z) + 0.5 * 1.56 / rows
		var half := 0.8 if az <= 0.5 else 0.8 * maxf(0.0, (1.0 - az) / 0.5)
		if half <= 0.05:
			continue
		var crop := Color(1, 1, 1).lerp(Color(0.85, 0.78, 0.55), float((int(b.t) + k) % 3) * 0.3)
		for segment in 8:
			var x0:=lerpf(-half,half,segment/8.0); var x1:=lerpf(-half,half,(segment+1)/8.0)
			var half_row:=(1.56/rows-.01)*.5
			var points:=[kit.xf(Vector3(x0,0,z-half_row)),kit.xf(Vector3(x1,0,z-half_row)),kit.xf(Vector3(x1,0,z+half_row)),kit.xf(Vector3(x0,0,z+half_row))]
			var footprint:=[]; var fits:=true
			for point in points:
				footprint.append(Vector2(point.x,point.z))
				if world.grid.tile_at(point.x,point.z)!=int(b.t): fits=false
			if not fits or not composition.sites.clear_of_water(int(b.t),footprint,.04): continue
			for i in 4: points[i].y=world.ground_height(points[i].x,points[i].z)+.012
			kit.quad("crop" if k%2==0 else "soil",points[0],points[1],points[2],points[3],crop*tint,Vector3.UP)
	_foundation(kit,Vector2(.10,.07))
	kit.box("timber", Vector3(0.12, 0.025, 0.05), Vector3(0.2, 0.12, 0.14), tint * Color(0.85, 0.55, 0.45))
	kit.gable("roof_slate", Vector3(0.12, 0.145, 0.05), 0.14, 0.2, 0.08, tint, PI * 0.5)
	kit.cylinder("concrete", Vector3(-0.02, 0.025, 0.08), 0.04, 0.2, 8, tint, 0.0)


func _ore_outcrop(kit: MeshKit, rng: RandomNumberGenerator, tint: Color) -> void:
	for k in 4:
		var p := Vector3(rng.randf_range(-0.5, 0.5), 0.0, rng.randf_range(-0.5, 0.5))
		kit.box("ore", p, Vector3(0.08, 0.06 + rng.randf() * 0.06, 0.07), tint, rng.randf() * TAU)


# ------------------------------------------------------------------ ruins
func _build_ruins() -> void:
	var sig := str(world.ruins)
	if sig == ruin_sig:
		return
	ruin_sig = sig
	var g := world.grid
	var kit := MeshKit.new()
	if world.ruins.is_empty():
		ruin_inst.mesh = null
		return
	ruin_anchor = g.center(int(world.ruins[0][0]))
	for r in world.ruins:
		var t := int(r[0])
		var c2 := g.center(t)
		var lc := Vector3(ruin_anchor.x + g.dx_wrap(ruin_anchor.x, c2.x), world.tile_height(t), c2.y)
		var rng := RandomNumberGenerator.new()
		rng.seed = t
		var overgrown := (int(r[2]) & 4) != 0
		kit.set_frame(lc, 0.0)
		kit.hex_plate("soil", Vector3(0, 0.01, 0), 0.7, Color(0.7, 0.68, 0.64), 0.2)
		for k in 7:
			var p := Vector3(rng.randf_range(-0.4, 0.4), 0.01, rng.randf_range(-0.4, 0.4))
			kit.box("stone" if k % 2 == 0 else "char", p, Vector3(0.1 + rng.randf() * 0.1, 0.04 + rng.randf() * 0.08, 0.08 + rng.randf() * 0.1), Color(0.7, 0.68, 0.64), rng.randf() * TAU)
		kit.box("brick", Vector3(-0.15, 0.01, 0.1), Vector3(0.3, 0.18 + rng.randf() * 0.1, 0.04), Color(0.6, 0.55, 0.5), 0.3)
		if overgrown:
			kit.cone("foliage", Vector3(0.2, 0.01, -0.1), 0.12, 0.2, 6)
	ruin_inst.mesh = kit.commit()

func _city_growth(kit:MeshKit,tier:int,tint:Color) -> void:
	if tier>=1:
		kit.box("brick",Vector3(-.26,.025,.25),Vector3(.22,.17,.18),tint)
		kit.gable("roof_tile",Vector3(-.26,.195,.25),.18,.22,.07,tint)
	if tier>=2:
		kit.box("concrete",Vector3(.27,.025,.12),Vector3(.18,.36,.24),tint)
		for floor_ in 3:
			for z in [-.002,.242]: kit.box("glass",Vector3(.27,.10+floor_*.10,z),Vector3(.14,.045,.004))
			for x in [.178,.362]: kit.box("glass",Vector3(x,.10+floor_*.10,.12),Vector3(.004,.045,.18))
	if tier>=3:
		kit.box("concrete",Vector3(.18,.025,-.23),Vector3(.23,.58,.20),tint)
		for floor_ in 5:
			for z in [-.332,-.128]: kit.box("glass",Vector3(.18,.095+floor_*.10,z),Vector3(.19,.045,.004))
			for x in [.063,.297]: kit.box("glass",Vector3(x,.095+floor_*.10,-.23),Vector3(.004,.045,.16))
