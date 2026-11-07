extends SceneTree
## Exports the modern component library (ComponentKit) to glTF binaries in assets/components.
## Run:  godot --headless --path godot --script res://tools/build_components.gd
## then  godot --headless --editor --path godot --quit   (imports the new .glb files)
## Each surface carries a material named after its MaterialLibrary slot; the runtime replaces it
## with the shared library material, so the assets stay consistent with procedural geometry.


func _init() -> void:
	var count := 0
	for id in ComponentKit.IDS:
		var kit := ComponentKit.build(id)
		if kit.is_empty():
			push_error("component %s is empty" % id)
			continue
		var mesh := kit.commit()
		for surface in mesh.get_surface_count():
			var source := mesh.surface_get_material(surface)
			var key := str(source.resource_name) if source else "concrete"
			var material := StandardMaterial3D.new()
			material.resource_name = key
			var spec: Dictionary = MaterialLibrary.SPECS.get(key, MaterialLibrary.SPECS.concrete)
			material.albedo_color = spec.c
			material.roughness = float(spec.get("r", .9))
			material.metallic = float(spec.get("m", 0.0))
			mesh.surface_set_material(surface, material)
		var root := Node3D.new(); root.name = id
		var instance := MeshInstance3D.new(); instance.name = id + "_mesh"; instance.mesh = mesh
		root.add_child(instance); instance.owner = root
		get_root().add_child(root)
		var document := GLTFDocument.new()
		var state := GLTFState.new()
		var error := document.append_from_scene(root, state)
		if error == OK: error = document.write_to_filesystem(state, "res://assets/components/%s.glb" % id)
		if error != OK: push_error("export failed for %s: %s" % [id, error_string(error)])
		else: count += 1
		root.queue_free()
	print("Exported %d/%d components to assets/components" % [count, ComponentKit.IDS.size()])
	quit()
