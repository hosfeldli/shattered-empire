class_name NativeRecipeInspector
extends PanelContainer
## F9 developer inspector: why the hex under the cursor looks the way it does. Shows the semantic
## graph's explanation (region, network, building recipe and identity, history, units, battle),
## world-recipe versions and generation/scheduler statistics. Read-only and presentation-only.
var app: Node
var text: RichTextLabel
var elapsed := 0.0
var overlay: MeshInstance3D
var overlay_key := ""


func setup(game: Node) -> void:
	app = game
	theme = NativeUI.theme()
	add_theme_stylebox_override("panel", NativeUI.style(Color(.03, .045, .055, .94), Color(NativeUI.TEAL, .4), 10, 6, true))
	custom_minimum_size = Vector2(420, 0)
	text = RichTextLabel.new(); text.bbcode_enabled = true; text.fit_content = true; text.scroll_active = false
	text.custom_minimum_size = Vector2(400, 0); text.add_theme_font_size_override("normal_font_size", 12)
	add_child(text)
	hide()


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_F9:
		visible = not visible
		get_viewport().set_input_as_handled()


func _process(dt: float) -> void:
	if not visible:
		if overlay: overlay.mesh = null; overlay_key = ""
		return
	_overlay()
	position = Vector2(get_viewport_rect().size.x - size.x - 12, 66)
	elapsed += dt
	if elapsed < .25: return
	elapsed = 0.0
	var tile: int = app.map_overlay.hover
	var lines := ["[b][color=#6fbfc4]Recipe inspector[/color][/b]  (F9)"]
	var info: Dictionary = app.composition.explain_tile(tile)
	if not info.get("available", false):
		lines.append("[color=#98a5ab]%s[/color]" % str(info.get("reason", "Hover a known hex")))
	else:
		lines.append("Hex %d · %s" % [tile, "visible" if info.visible else "remembered"])
		if info.has("region"): lines.append("Region: %s (%d hexes)" % [info.region.kind, int(info.region.tiles)])
		if info.has("network"): lines.append("Transport network: %d hexes%s" % [int(info.network.tiles), " · rail" if info.network.rail else ""])
		if info.has("building") and info.building.get("available", false):
			var b: Dictionary = info.building
			var recipe: Dictionary = b.get("recipe", {})
			lines.append("[b]Building[/b] %s · recipe %s@%s · grammar %s" % [str(b.node.get("data", {}).get("type", "?")), str(recipe.get("id", "fallback")), str(recipe.get("version", "?")), str(recipe.get("grammar", "?"))])
			lines.append("  matched: %s" % JSON.stringify(recipe.get("matched", {})))
			lines.append("  relationships: %s" % ", ".join((b.get("relationships", {}) as Dictionary).keys()))
			lines.append("  identity: layout %s · roof %s · detail %s" % [str(b.identity.get("layout_seed", "")), str(b.identity.get("roof_seed", "")), str(b.identity.get("detail_seed", ""))])
			for event in (info.get("history", []) as Array).slice(-4):
				lines.append("  %s · %s" % [app.hud._clock(float(event[0])), str(event[1])])
		for unit in info.get("units", []):
			lines.append("Unit %s · links %s" % [str(unit.node.get("type", "?")), ", ".join((unit.links as Dictionary).keys())])
		if info.has("battle"): lines.append("Battle region: %d hexes · intensity %.1f" % [(info.battle.tiles as Array).size(), float(info.battle.intensity)])
	var stats: Dictionary = app.composition.stats()
	lines.append("[color=#98a5ab]overlay: teal district · amber parcel · red road edges[/color]")
	lines.append("[color=#98a5ab]graph %s[/color]" % JSON.stringify(stats.graph))
	lines.append("[color=#98a5ab]scheduler %s · sync %.2f ms[/color]" % [JSON.stringify(stats.scheduler), float(stats.sync_ms)])
	lines.append("[color=#98a5ab]world recipes %s[/color]" % JSON.stringify(stats.get("world_recipes", {})))
	if not (stats.recipe_errors as Array).is_empty(): lines.append("[color=#e0806a]recipe errors: %s[/color]" % str(stats.recipe_errors))
	text.text = "\n".join(lines)


## World overlays for the hovered hex: the building's district (every hex in it), its planned
## parcel footprint, and the real road edges leaving the hex. Developer view only.
func _overlay() -> void:
	if overlay == null:
		overlay = MeshInstance3D.new(); overlay.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		app.add_child(overlay)
	var tile: int = app.map_overlay.hover
	var world: WorldState = app.world
	if tile < 0 or world.grid == null: overlay.mesh = null; return
	var id: int = app.settlements.building_at(tile)
	var key := "%d:%d:%d:%d" % [tile, id, world.buildings_version, int(app.cam.focus.x)]
	if key == overlay_key: return
	overlay_key = key
	var kit := MeshKit.new()
	var g := world.grid
	var district := str(app.composition.graph.district_of.get(id, ""))
	var tiles := [tile]
	if district != "" and app.composition.graph.districts.has(district):
		tiles = []
		for other in app.composition.graph.districts[district].ids:
			if world.buildings.has(int(other)): tiles.append(int(world.buildings[int(other)].t))
	for t in tiles:
		var c := g.center(int(t)); c.x = g.near_x(c.x, app.cam.focus.x)
		for k in 6:
			var a: Vector2 = c + g.corners[k] * .95; var b: Vector2 = c + g.corners[(k + 1) % 6] * .95
			kit.strip("glow:6fbfc4", Vector3(a.x, world.ground_height(a.x, a.y) + .04, a.y), Vector3(b.x, world.ground_height(b.x, b.y) + .04, b.y), .02)
	var site: Dictionary = app.settlements.site_records.get(id, {})
	var corners: Array = site.get("corners", [])
	for k in corners.size():
		var a: Vector2 = corners[k]; var b: Vector2 = corners[(k + 1) % corners.size()]
		var shift: float = g.near_x(a.x, app.cam.focus.x) - a.x
		kit.strip("glow:e4bd76", Vector3(a.x + shift, world.ground_height(a.x, a.y) + .05, a.y), Vector3(b.x + shift, world.ground_height(b.x, b.y) + .05, b.y), .015)
	var c2 := g.center(tile); c2.x = g.near_x(c2.x, app.cam.focus.x)
	for d in 6:
		if ((world.road[tile] >> (d * 4)) & 7) == 0: continue
		var e := c2 + g.dir_vec[d] * (HexGrid.SQRT3 * .5)
		kit.strip("glow:ed766a", Vector3(c2.x, world.ground_height(c2.x, c2.y) + .06, c2.y), Vector3(e.x, world.ground_height(e.x, e.y) + .06, e.y), .012)
	overlay.mesh = kit.commit() if not kit.is_empty() else null
