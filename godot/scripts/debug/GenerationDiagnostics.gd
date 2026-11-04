class_name GenerationDiagnostics
extends CanvasLayer
## F4 developer inspector: recipe rationale, identity channels, authority and local graph links.
## Hidden during ordinary play. No graph data is sourced outside the viewer's WorldState.

var composition: WorldCompositionSystem
var settlements: SettlementRenderer
var camera: CameraController
var panel: PanelContainer
var text: RichTextLabel
var lines: MeshInstance3D
var _key := ""
var _anchor := Vector2.ZERO


func setup(system: WorldCompositionSystem, renderer: SettlementRenderer, cam: CameraController, parent: Node3D) -> void:
	composition = system
	settlements = renderer
	camera = cam
	layer = 30
	panel = PanelContainer.new()
	panel.position = Vector2(12, 85)
	panel.custom_minimum_size = Vector2(430, 480)
	panel.size = Vector2(430, 480)
	panel.visible = false
	var margin := MarginContainer.new()
	for side in ["left", "right", "top", "bottom"]:
		margin.add_theme_constant_override("margin_" + side, 12)
	panel.add_child(margin)
	text = RichTextLabel.new()
	text.bbcode_enabled = false
	text.selection_enabled = true
	text.add_theme_font_size_override("normal_font_size", 13)
	margin.add_child(text)
	add_child(panel)
	lines = MeshInstance3D.new()
	lines.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	lines.material_override = MaterialLibrary.glow(Color(0.35, 1.0, 0.75), 0.85)
	lines.visible = false
	parent.add_child(lines)


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_F4:
		panel.visible = not panel.visible
		lines.visible = panel.visible
		_key = ""
		get_viewport().set_input_as_handled()


func _process(_dt: float) -> void:
	if panel == null or not panel.visible or composition.world.grid == null:
		return
	var id := settlements.selected_building
	var key := "%d:%d:%s" % [id, composition.graph.revision, composition.lod.scale_name(camera.size)]
	if key != _key:
		_key = key
		var explanation := composition.explain_building(id)
		explanation["site"] = settlements.site_records.get(id,settlements.home_sites.get(id,{})) if explanation.get("available",false) else {}
		explanation["lod"] = composition.lod.scale_name(camera.size)
		explanation["generation"] = composition.scheduler.stats()
		text.text = "Living World inspector · F4\nSelect a building to inspect its recipe.\n\n" + JSON.stringify(explanation, "  ")
		_draw_links(id)
	lines.position.x = composition.world.grid.near_x(_anchor.x, camera.focus.x) - _anchor.x


func _draw_links(id: int) -> void:
	var world := composition.world
	var graph := composition.graph
	if not composition.adapter.buildings.has(id):
		lines.mesh = null
		return
	var tile: int = composition.adapter.buildings[id].tile
	_anchor = world.grid.center(tile)
	var mesh := ImmediateMesh.new()
	var vertices: Array[Vector3] = []
	var links: Dictionary = graph.edges.get("building:%d" % id, {})
	for targets in links.values():
		for target in targets:
			var node: Dictionary = graph.nodes.get(target, {})
			var data: Dictionary = node.get("data", {})
			var to := int(data.get("tile", data.get("a", -1)))
			if to < 0:
				continue
			var c := world.grid.center(to)
			vertices.append(Vector3(_anchor.x, world.tile_height(tile) + 0.12, _anchor.y))
			vertices.append(Vector3(_anchor.x + world.grid.dx_wrap(_anchor.x, c.x), world.tile_height(to) + 0.12, c.y))
	if not vertices.is_empty():
		mesh.surface_begin(Mesh.PRIMITIVE_LINES)
		for vertex in vertices:
			mesh.surface_add_vertex(vertex)
		mesh.surface_end()
	lines.mesh = mesh
