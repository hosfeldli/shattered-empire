class_name AssetLibrary
extends RefCounted
## Imported authored components are flattened once, keeping material slot names as the contract.
## The resulting arrays join the same district batch as procedural geometry.

static var _cache := {}


static func residential(variant: int) -> Array:
	return _load_component("res://assets/buildings/residential_%d.glb" % posmod(variant, 3))


## A reusable modern component by stable id (assets/components/<id>.glb, authored from
## ComponentKit). A missing asset falls back to the source definition so nothing disappears.
static func component(id:String) -> Array:
	var path:="res://assets/components/%s.glb"%id
	if _cache.has(path): return _cache[path]
	if ResourceLoader.exists(path): return _load_component(path)
	var kit:=ComponentKit.build(id)
	var merged:=[]
	for material in kit.parts:
		var part:Array=kit.parts[material]
		var arrays:=[]; arrays.resize(Mesh.ARRAY_MAX)
		arrays[Mesh.ARRAY_VERTEX]=PackedVector3Array(part[0]); arrays[Mesh.ARRAY_NORMAL]=PackedVector3Array(part[1])
		arrays[Mesh.ARRAY_TEX_UV]=PackedVector2Array(part[3])
		merged.append({"material":material,"arrays":arrays,"transform":Transform3D.IDENTITY})
	_cache[path]=merged
	return merged


static func unit_component(name:String) -> Array:
	return _load_component("res://assets/units/%s.glb"%name)


static func _load_component(path:String) -> Array:
	if _cache.has(path):
		return _cache[path]
	var result := []
	var scene := load(path) as PackedScene
	if scene:
		var root := scene.instantiate() as Node3D
		_collect(root, Transform3D.IDENTITY, result)
		root.free()
	# Bake component transforms and join material slots once at load, avoiding dozens of window
	# surface transforms each time another residential parcel is composed.
	var kit:=MeshKit.new()
	kit.component(result,Transform3D.IDENTITY)
	var merged:=[]
	for material in kit.parts:
		var part:Array=kit.parts[material]
		var arrays:=[]; arrays.resize(Mesh.ARRAY_MAX)
		arrays[Mesh.ARRAY_VERTEX]=PackedVector3Array(part[0]); arrays[Mesh.ARRAY_NORMAL]=PackedVector3Array(part[1])
		arrays[Mesh.ARRAY_TEX_UV]=PackedVector2Array(part[3])
		merged.append({"material":material,"arrays":arrays,"transform":Transform3D.IDENTITY})
	_cache[path] = merged
	return merged


static func _collect(node: Node3D, parent: Transform3D, result: Array) -> void:
	var transform := parent * node.transform
	if node is MeshInstance3D:
		var mesh := (node as MeshInstance3D).mesh
		for surface in mesh.get_surface_count():
			var material := mesh.surface_get_material(surface)
			var key := str(material.resource_name) if material else "concrete"
			if not MaterialLibrary.SPECS.has(key):
				push_error("Unknown authored material slot: " + key)
				continue
			result.append({"material": key, "arrays": mesh.surface_get_arrays(surface), "transform": transform})
	for child in node.get_children():
		if child is Node3D:
			_collect(child, transform, result)
