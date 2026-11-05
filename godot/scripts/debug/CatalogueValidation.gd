class_name CatalogueValidation
extends RefCounted
## Actual server definitions drive the catalogue. These are explicitly labelled presentation
## fixtures, not invented authoritative units placed into the running match.
var app:Node
var directory:String
var entries:Array=[]
var checks:={}

func signature(mesh:Mesh) -> String:
	var bytes:=PackedByteArray()
	for surface in mesh.get_surface_count():
		var vertices:PackedVector3Array=mesh.surface_get_arrays(surface)[Mesh.ARRAY_VERTEX]
		bytes.append_array(vertices.to_byte_array())
	return bytes.hex_encode().md5_text()

func vertices(mesh:Mesh) -> int:
	var count:=0
	for surface in mesh.get_surface_count(): count+=mesh.surface_get_array_len(surface)
	return count

func atlas(title:String,models:Array,name_:String) -> void:
	if DisplayServer.get_name()=="headless": return
	var layer:=CanvasLayer.new(); layer.layer=200; app.add_child(layer)
	var panel:=PanelContainer.new(); panel.theme=NativeUI.theme(); panel.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); layer.add_child(panel)
	var column:=VBoxContainer.new(); panel.add_child(column)
	NativeUI.label(column,title,22,NativeUI.GOLD)
	NativeUI.label(column,"Presentation fixture · real server catalogue · no simulation changes",13,NativeUI.MUTED)
	var grid:=GridContainer.new(); grid.columns=6; grid.size_flags_vertical=Control.SIZE_EXPAND_FILL; column.add_child(grid)
	for record in models:
		var cell:=VBoxContainer.new(); cell.size_flags_horizontal=Control.SIZE_EXPAND_FILL; cell.size_flags_vertical=Control.SIZE_EXPAND_FILL; cell.add_theme_constant_override("separation",0); grid.add_child(cell)
		var thumb:=NativeModelThumbnail.new(); thumb.size_flags_vertical=Control.SIZE_EXPAND_FILL; cell.add_child(thumb); thumb.setup(record.mesh)
		NativeUI.label(cell,str(record.label),13)
	for frame in 6: await app.get_tree().process_frame
	await RenderingServer.frame_post_draw
	app.get_viewport().get_texture().get_image().save_png(directory+"/"+name_+".png")
	layer.queue_free(); await app.get_tree().process_frame

func run(game:Node,out:String) -> Dictionary:
	app=game; directory=out
	var world:WorldState=app.world; var color:=world.civ_color(world.civ_id)
	var unit_models:=[]; var fingerprints:={}; var all_units:=true
	for type in world.defs.get("UNITS",{}):
		var definition:Dictionary=world.defs.UNITS[type]
		var model:ArrayMesh=app.military._build_model(type,color)
		if definition.get("cat")=="tracked":
			var kit:=MeshKit.new(); var hull:ArrayMesh=model; var turret:ArrayMesh=app.military._build_turret(color,type)
			# The runtime rotates these separately. The catalogue shows the whole assembled unit.
			for source in [hull,turret]:
				for surface in source.get_surface_count():
					var arrays:Array=source.surface_get_arrays(surface); var material:Material=source.surface_get_material(surface)
					kit.component([{"arrays":arrays,"transform":Transform3D.IDENTITY,"material":material.resource_name}],Transform3D.IDENTITY)
			model=kit.commit()
		var digest:=signature(model); fingerprints[digest]=true
		all_units=all_units and type in MilitaryModelLibrary.TYPES and model.get_surface_count()>0
		entries.append({"kind":"unit","type":type,"age":definition.get("age",0),"vertices":vertices(model),"signature":digest})
		unit_models.append({"label":"%s · era %d"%[definition.name,int(definition.get("age",0))],"mesh":model})
	checks.every_unit_has_explicit_visual=all_units
	checks.unit_silhouettes_distinct=fingerprints.size()==world.defs.UNITS.size()
	await atlas("Troops · Reclamation to Advanced Systems",unit_models,"troop-catalogue")
	var buildings:=[]; var upgrades:=[]; var damage_models:=[]; var all_buildings:=true; var levels:=true; var damage:=true
	for type in world.defs.get("BUILDINGS",{}):
		var definition:Dictionary=world.defs.BUILDINGS[type]
		if definition.get("obsolete",false) or definition.get("rebelOnly",false): continue
		var model:ArrayMesh=app.settlements.preview_mesh(type,world.start_tile,false)
		all_buildings=all_buildings and model!=null and model.get_surface_count()>0
		if model==null: continue
		buildings.append({"label":"%s · era %d"%[definition.name,int(definition.get("age",0))],"mesh":model})
		entries.append({"kind":"building","type":type,"age":definition.get("age",0),"level":1,"vertices":vertices(model),"signature":signature(model)})
		var can_upgrade:bool=type=="house" or type!="town" and definition.has("jobs") and (definition.has("produce") or int(definition.get("power",0))>0)
		if can_upgrade:
			var previous:=vertices(model)
			for level in [2,3]:
				var expanded:ArrayMesh=app.settlements.preview_mesh(type,world.start_tile,false,level)
				levels=levels and vertices(expanded)>previous; previous=vertices(expanded)
				entries.append({"kind":"building","type":type,"age":definition.get("age",0),"level":level,"vertices":previous,"signature":signature(expanded)})
		if type in ["house","steel_mill","electronics_plant","fusion_plant"]:
			for level in [1,2,3]: upgrades.append({"label":"%s · level %d"%[definition.name,level],"mesh":app.settlements.preview_mesh(type,world.start_tile,false,level)})
		if type in DevelopedBuildingLibrary.TYPES:
			var intact:=vertices(model)
			for hp in [70,45,20,0]:
				var damaged:ArrayMesh=app.settlements.preview_mesh(type,world.start_tile,false,1,0,hp,"ruined" if hp==0 else "damaged")
				damage=damage and damaged!=null and signature(damaged)!=signature(model)
				entries.append({"kind":"damage","type":type,"hp":hp,"vertices":vertices(damaged),"intact_vertices":intact})
			if int(definition.get("age",0))>=3:
				damage_models.append({"label":"%s · intact"%definition.name,"mesh":model})
				damage_models.append({"label":"%s · ruined"%definition.name,"mesh":app.settlements.preview_mesh(type,world.start_tile,false,1,0,0,"ruined")})
	checks.every_building_has_visual=all_buildings; checks.all_upgrade_levels_change_geometry=levels; checks.advanced_damage_stages=damage
	await atlas("Building catalogue · all five eras",buildings,"building-catalogue")
	for tier in 4: upgrades.append({"label":["Town","City","Metropolis","Megacity"][tier],"mesh":app.settlements.preview_mesh("town",world.start_tile,false,1,tier)})
	await atlas("Development · stable original structures plus additions",upgrades,"development-levels")
	await atlas("Advanced industry · intact and ruined",damage_models,"advanced-destruction")
	var file:=FileAccess.open(directory+"/catalogue-validation.json",FileAccess.WRITE); file.store_string(JSON.stringify({"checks":checks,"entries":entries},"  ")); file.close()
	return checks
