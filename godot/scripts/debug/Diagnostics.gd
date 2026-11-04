class_name Diagnostics
extends CanvasLayer
## Frame-time and network diagnostics (F3) and the benchmark mode used to compare against the
## PixiJS client. CPU time is the frame's process time plus the renderer's measured CPU time;
## GPU time is the renderer's measured GPU time for the viewport. With --bench the client runs a
## scripted camera (idle, continuous zoom, pan across the seam), writes percentiles to a JSON file
## and quits.

var world: WorldState
var net: NetworkClient
var cam: CameraController
var terrain: WorldRenderer
var military: MilitaryRenderer
var label: Label
var samples_frame: Array = []
var samples_cpu: Array = []
var samples_gpu: Array = []
var bench_seconds := 0.0
var bench_out := ""
var bench_phase := ""
var bench_t := 0.0
var bench_results := {}
var bench_started := false
var bench_wait := 0.0
var _vp_rid: RID
var _marker: Node
var samples_render: Array = []
var sub := {}                  # subsystem -> Array of ms this phase
var net_ms: Array = []
var probe_at := 0.0
var probe_out := ""
var probe_extra: Callable
var _last_frame_us := 0
# The common zoom range supported by both clients at a 768-pixel viewport height. Pixi's max
# zoom is 4, which corresponds to 16 native world units (768 / (4 * 12)).
const BENCH_MIN_SIZE := 16.0
const BENCH_MAX_SIZE := 110.0


func setup(w: WorldState, n: NetworkClient, c: CameraController, t: WorldRenderer, m: MilitaryRenderer) -> void:
	world = w
	net = n
	cam = c
	terrain = t
	military = m
	layer = 20
	label = Label.new()
	label.position = Vector2(12, 60)
	label.add_theme_font_size_override("font_size", 13)
	label.add_theme_color_override("font_color", Color(0.95, 0.95, 0.9))
	label.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.8))
	label.add_theme_constant_override("outline_size", 4)
	label.visible = false
	add_child(label)
	# script time per frame: from a marker that processes first to this node, which processes last
	process_priority = 1000
	_marker = FrameMarker.new()
	_marker.process_priority = -1000
	add_child(_marker)
	_vp_rid = get_viewport().get_viewport_rid()
	RenderingServer.viewport_set_measure_render_time(_vp_rid, true)


func _unhandled_input(e: InputEvent) -> void:
	if e is InputEventKey and (e as InputEventKey).pressed and (e as InputEventKey).keycode == KEY_F3:
		label.visible = not label.visible


func _process(_dt: float) -> void:
	# Engine delta is smoothed and can be quantized by vsync. Benchmark actual frame intervals.
	var now := Time.get_ticks_usec()
	var dt := float(now - _last_frame_us) / 1000000.0 if _last_frame_us > 0 else 1.0 / 60.0
	_last_frame_us = now
	# script time of this frame (all _process callbacks, including network decode and the renderers)
	var cpu: float = (Time.get_ticks_usec() - _marker.t) / 1000.0
	_push(samples_render, RenderingServer.viewport_get_measured_render_time_cpu(_vp_rid) + RenderingServer.get_frame_setup_time_cpu())
	var gpu := RenderingServer.viewport_get_measured_render_time_gpu(_vp_rid)
	_push(samples_frame, dt * 1000.0)
	_push(samples_cpu, cpu)
	_push(samples_gpu, gpu)
	record_subsystems({"network": net.frame_work_us, "json_decode": net.frame_decode_us, "async_json_decode": net.frame_async_decode_us, "state_dispatch": net.frame_dispatch_us})
	if label.visible and Engine.get_process_frames() % 10 == 0:
		label.text = _report()
	if bench_seconds > 0.0:
		_bench(dt)
	if probe_at > 0.0 and Time.get_ticks_msec() / 1000.0 >= probe_at:
		probe_at = 0.0
		_probe()


## picking accuracy: project known hex centres (on the terrain surface) to the screen and pick them
## back with the camera's ray-over-height-field test, at the current zoom and pitch
func pick_test(samples := 400) -> Dictionary:
	var g := world.grid
	var vp := get_viewport().get_visible_rect().size
	var rng := RandomNumberGenerator.new()
	rng.seed = 99
	var ok := 0
	var tried := 0
	var relief := 0.0
	var tries := 0
	while tried < samples and tries < samples * 50:
		tries += 1
		var t := rng.randi() % g.n
		if not world.known[t]:
			continue
		var c := g.center(t)
		var x := g.near_x(c.x, cam.focus.x)
		var p := Vector3(x, maxf(world.ground_height(x, c.y), 0.0), c.y)
		var s := cam.to_screen(p)
		if s.x < 0.0 or s.y < 0.0 or s.x >= vp.x or s.y >= vp.y:
			continue
		tried += 1
		relief = maxf(relief, world.height[t])
		if cam.pick_tile(s) == t:
			ok += 1
	return {"size": cam.size, "pitch": cam.pitch_deg(), "samples": tried, "correct": ok, "accuracy": float(ok) / maxf(1.0, tried), "max_height_sampled": relief}


## --probe: after a delay, report what the client has synchronized (Phase 1 acceptance check)
func start_probe(seconds: float, out: String, extra: Callable) -> void:
	probe_at = Time.get_ticks_msec() / 1000.0 + seconds
	probe_out = out
	probe_extra = extra


func _probe() -> void:
	var known := 0
	var vis := 0
	if world.grid:
		for i in world.grid.n:
			known += world.known[i]
			if world.is_visible(i):
				vis += 1
	var roads := 0
	if world.grid:
		for i in world.grid.n:
			if world.road[i] != 0:
				roads += 1
	var r := {
		"net": {"state": net.state, "proto": net.proto, "caps": net.caps, "connections": net.connections, "msgs": net.msgs_in, "mb_in": snappedf(net.bytes_in / 1048576.0, 0.01), "rtt_ms": net.rtt_ms},
		"world": {"ready": world.ready_, "civ": world.civ_id, "map": [world.grid.w, world.grid.h] if world.grid else [], "server_time": world.server_time, "snapshots": world.snapshot_count, "snapshot_rate": snappedf(world.snapshot_rate(), 0.01),
			"units": world.units.size(), "own_units": world.units.values().filter(func(u): return int(u.owner) == world.civ_id).size(), "buildings": world.buildings.size(), "cities": world.cities.size(), "geo_known_hexes": known, "visible_hexes": vis,
			"playback_lag_s": snappedf(world.server_time - world.render_time, 0.01), "has_weather": not world.wx.is_empty(), "road_hexes": roads, "craters": (world.bf.get("c", []) as Array).size(), "trenches": world.fw.size()},
		"render": {"chunks_built": terrain.chunks_built, "chunk_queue": terrain.dirty.size(), "terrain_last_build_ms": snappedf(terrain.last_build_ms, 0.01), "terrain_max_build_ms": snappedf(terrain.max_build_ms, 0.01), "memory_static_mb": snappedf(Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0, 0.01), "units_drawn": military.drawn, "units_batched": military.batched, "unit_batches": military.batches.size(), "camera": [cam.focus.x, cam.focus.z, cam.size]},
	}
	if probe_extra.is_valid():
		r["extra"] = probe_extra.call()
	var txt := JSON.stringify(r, "  ")
	print("PROBE ", txt)
	if probe_out != "":
		var f := FileAccess.open(probe_out, FileAccess.WRITE)
		if f:
			f.store_string(txt)
	get_tree().quit()


func record_subsystems(us: Dictionary) -> void:
	for k in us.keys():
		if not sub.has(k):
			sub[k] = []
		_push(sub[k], us[k] / 1000.0)


func _push(a: Array, v: float) -> void:
	a.append(v)
	if a.size() > 600 and bench_phase == "":
		a.pop_front()


static func pct(a: Array, p: float) -> float:
	if a.is_empty():
		return 0.0
	var s := a.duplicate()
	s.sort()
	return float(s[mini(s.size() - 1, int(s.size() * p))])


static func avg(a: Array) -> float:
	if a.is_empty():
		return 0.0
	var t := 0.0
	for v in a:
		t += float(v)
	return t / a.size()


func _report() -> String:
	var lines := PackedStringArray()
	lines.append("FPS %d   frame %.2f ms (p95 %.2f, p99 %.2f)" % [Engine.get_frames_per_second(), avg(samples_frame), pct(samples_frame, 0.95), pct(samples_frame, 0.99)])
	lines.append("script %.2f ms (p95 %.2f)   GPU %.2f ms (p95 %.2f)" % [avg(samples_cpu), pct(samples_cpu, 0.95), avg(samples_gpu), pct(samples_gpu, 0.95)])
	lines.append("draw calls %d   primitives %dk   video mem %d MB" % [Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME), int(Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME) / 1000), int(Performance.get_monitor(Performance.RENDER_VIDEO_MEM_USED) / 1048576)])
	lines.append("net %s proto %d caps %s   rtt %d ms   msgs %d   %.1f MB in" % [net.state, net.proto, str(net.caps), int(net.rtt_ms), net.msgs_in, net.bytes_in / 1048576.0])
	lines.append("snapshots %.1f/s   buffer %d   playback %.2f s behind   server t=%.1f" % [world.snapshot_rate(), world.snaps.size(), world.server_time - world.render_time, world.server_time])
	lines.append("units %d drawn %d   buildings %d   chunks built %d (queue %d, last %.1f ms)" % [world.units.size(), military.drawn, world.buildings.size(), terrain.chunks_built, terrain.dirty.size(), terrain.last_build_ms])
	lines.append("camera x=%.1f z=%.1f size %.1f pitch %.0f   recentred %d" % [cam.focus.x, cam.focus.z, cam.size, cam.pitch_deg(), cam.recentred])
	return "\n".join(lines)


## benchmark: wait for the land to finish building, then idle / zoom sweep / pan across the seam
func start_bench(seconds: float, out: String) -> void:
	bench_seconds = seconds
	bench_out = out


func _bench(dt: float) -> void:
	if not bench_started:
		if world.snapshot_count > 5 and terrain.dirty.is_empty() and terrain.chunks_built > 0 and not get_parent().settlements.is_building() and world.server_time >= bench_wait:
			bench_started = true
			bench_phase = "idle"
			bench_t = 0.0
			if bench_wait > 0.0 and world.spectator:
				# a developed scene: back to normal speed, looking at the biggest city
				net.cmd({"c": "speed", "speed": 1})
				cam.focus_tile(get_parent()._tour_target(), 30.0)
			_reset_samples()
		return
	bench_t += dt
	var span := bench_seconds / 3.0
	match bench_phase:
		"zoom":
			# continuous zoom in and out under a fixed screen point, like the PixiJS measurement
			var vp := get_viewport().get_visible_rect().size
			cam.anchor_screen = vp * 0.5 + Vector2(vp.x * 0.15, 0)
			var k := fmod(bench_t, 4.0)
			cam.goal_size = clampf(cam.goal_size * pow(0.985 if k < 2.0 else 1.015, dt * 60.0), BENCH_MIN_SIZE, minf(BENCH_MAX_SIZE, cam.max_size))
		"pan":
			# steady pan east, across the seam at least once
			cam.goal_size = 30.0
			cam.focus.x += 30.0 * dt
	if bench_t >= span:
		bench_results[bench_phase] = _summary()
		_reset_samples()
		bench_t = 0.0
		if bench_phase == "idle":
			bench_phase = "zoom"
		elif bench_phase == "zoom":
			bench_phase = "pan"
			cam.size = 30.0
			cam.goal_size = 30.0
			cam.focus.x = world.grid.period * 0.85
		else:
			_finish()


func _summary() -> Dictionary:
	var over50 := 0
	for v in samples_frame:
		if float(v) > 50.0:
			over50 += 1
	return {
		"frames": samples_frame.size(), "fps": samples_frame.size() / maxf(0.001, avg(samples_frame) * samples_frame.size() / 1000.0),
		"frame_p50": pct(samples_frame, 0.5), "frame_p95": pct(samples_frame, 0.95), "frame_p99": pct(samples_frame, 0.99), "frame_max": pct(samples_frame, 1.0), "over50": over50,
		"script_avg": avg(samples_cpu), "script_p95": pct(samples_cpu, 0.95), "script_p99": pct(samples_cpu, 0.99), "render_cpu_avg": avg(samples_render), "render_cpu_p95": pct(samples_render, 0.95), "render_cpu_p99": pct(samples_render, 0.99), "gpu_avg": avg(samples_gpu), "gpu_p95": pct(samples_gpu, 0.95),
		"draw_calls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME), "units": world.units.size(), "buildings": world.buildings.size(),
		"recentred": cam.recentred,
		"script": _sub_summary(),
	}


func _sub_summary() -> Dictionary:
	var out := {}
	for k in sub.keys():
		out[k] = {"avg": snappedf(avg(sub[k]), 0.001), "p99": snappedf(pct(sub[k], 0.99), 0.001), "max": snappedf(pct(sub[k], 1.0), 0.001)}
	return out


func _reset_samples() -> void:
	sub.clear()
	samples_render.clear()
	samples_frame.clear()
	samples_cpu.clear()
	samples_gpu.clear()


func _finish() -> void:
	var vp := get_viewport().get_visible_rect().size
	var px := get_viewport().get_texture().get_size()
	bench_results["meta"] = {"viewport": [vp.x, vp.y], "renderer": RenderingServer.get_current_rendering_method(), "adapter": RenderingServer.get_video_adapter_name(), "quality": get_parent().quality, "scale": get_window().content_scale_factor, "pixels": [px.x, px.y], "screen_scale": DisplayServer.screen_get_scale(), "godot": Engine.get_version_info().string, "map": [world.grid.w, world.grid.h], "server_time": world.server_time, "clock": "monotonic_usec", "gpu_supported": avg(samples_gpu) > 0.0}
	bench_results.meta["gpu_supported"] = float(bench_results.idle.gpu_avg) > 0.0
	bench_results.meta["fps_limit"] = Engine.max_fps
	bench_results.meta["camera_size_range"] = [BENCH_MIN_SIZE, minf(BENCH_MAX_SIZE, cam.max_size)]
	bench_results.meta["memory_static_mb"] = snappedf(Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0, 0.01)
	bench_results.meta["terrain_max_build_ms"] = snappedf(terrain.max_build_ms, 0.01)
	var txt := JSON.stringify(bench_results, "  ")
	print("BENCH ", txt)
	if bench_out != "":
		var f := FileAccess.open(bench_out, FileAccess.WRITE)
		if f:
			f.store_string(txt)
			f.close()
	bench_seconds = 0.0
	get_tree().quit()


class FrameMarker extends Node:
	var t := 0

	func _process(_dt: float) -> void:
		t = Time.get_ticks_usec()
