class_name NativeRecipeInspector
extends PanelContainer
## F9 developer inspector: why the hex under the cursor looks the way it does. Shows the semantic
## graph's explanation (region, network, building recipe and identity, history, units, battle),
## world-recipe versions and generation/scheduler statistics. Read-only and presentation-only.
var app: Node
var text: RichTextLabel
var elapsed := 0.0


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
	if not visible: return
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
	lines.append("[color=#98a5ab]graph %s[/color]" % JSON.stringify(stats.graph))
	lines.append("[color=#98a5ab]scheduler %s · sync %.2f ms[/color]" % [JSON.stringify(stats.scheduler), float(stats.sync_ms)])
	lines.append("[color=#98a5ab]world recipes %s[/color]" % JSON.stringify(stats.get("world_recipes", {})))
	if not (stats.recipe_errors as Array).is_empty(): lines.append("[color=#e0806a]recipe errors: %s[/color]" % str(stats.recipe_errors))
	text.text = "\n".join(lines)
