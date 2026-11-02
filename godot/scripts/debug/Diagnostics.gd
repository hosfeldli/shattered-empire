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
var _vp_rid: RID


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
	_vp_rid = get_viewport().get_viewport_rid()
	RenderingServer.viewport_set_measure_render_time(_vp_rid, true)


func _unhandled_input(e: InputEvent) -> void:
	if e is InputEventKey and (e as InputEventKey).pressed and (e as InputEventKey).keycode == KEY_F3:
		label.visible = not label.visible


func _process(dt: float) -> void:
	var cpu := Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0 + RenderingServer.viewport_get_measured_render_time_cpu(_vp_rid) + RenderingServer.get_frame_setup_time_cpu()
	var gpu := RenderingServer.viewport_get_measured_render_time_gpu(_vp_rid)
	_push(samples_frame, dt * 1000.0)
	_push(samples_cpu, cpu)
	_push(samples_gpu, gpu)
	if label.visible and Engine.get_process_frames() % 10 == 0:
		label.text = _report()
	if bench_seconds > 0.0:
		_bench(dt)


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
	lines.append("CPU %.2f ms (p95 %.2f)   GPU %.2f ms (p95 %.2f)" % [avg(samples_cpu), pct(samples_cpu, 0.95), avg(samples_gpu), pct(samples_gpu, 0.95)])
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
		if world.snapshot_count > 5 and terrain.dirty.is_empty() and terrain.chunks_built > 0:
			bench_started = true
			bench_phase = "idle"
			bench_t = 0.0
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
			cam.goal_size = clampf(cam.goal_size * (0.985 if k < 2.0 else 1.015), CameraController.MIN_SIZE, cam.max_size)
		"pan":
			cam.focus.x += cam.size * 0.6 * dt
	if bench_t >= span:
		bench_results[bench_phase] = _summary()
		_reset_samples()
		bench_t = 0.0
		if bench_phase == "idle":
			bench_phase = "zoom"
		elif bench_phase == "zoom":
			bench_phase = "pan"
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
		"cpu_avg": avg(samples_cpu), "cpu_p95": pct(samples_cpu, 0.95), "cpu_p99": pct(samples_cpu, 0.99), "gpu_avg": avg(samples_gpu), "gpu_p95": pct(samples_gpu, 0.95),
		"draw_calls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME), "units": world.units.size(), "buildings": world.buildings.size(),
		"recentred": cam.recentred,
	}


func _reset_samples() -> void:
	samples_frame.clear()
	samples_cpu.clear()
	samples_gpu.clear()


func _finish() -> void:
	var vp := get_viewport().get_visible_rect().size
	bench_results["meta"] = {"viewport": [vp.x, vp.y], "renderer": RenderingServer.get_current_rendering_method(), "adapter": RenderingServer.get_video_adapter_name(), "godot": Engine.get_version_info().string, "map": [world.grid.w, world.grid.h], "server_time": world.server_time}
	var txt := JSON.stringify(bench_results, "  ")
	print("BENCH ", txt)
	if bench_out != "":
		var f := FileAccess.open(bench_out, FileAccess.WRITE)
		if f:
			f.store_string(txt)
			f.close()
	bench_seconds = 0.0
	get_tree().quit()
