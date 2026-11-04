class_name GenerationScheduler
extends RefCounted
## Cooperative, prioritized jobs. Each step builds a bounded piece of geometry; only current
## revisions can commit. Callables run on the main thread unless a producer explicitly uses a
## worker with immutable inputs. Essential unit positions do not wait in this queue.

enum Priority { CRITICAL, HIGH, MEDIUM, LOW }
var _jobs := {}
var _latest := {}
var _sequence := 0
var completed := 0
var superseded := 0
var max_step_us := 0
var max_commit_us := 0
var last_slice_us := 0


func enqueue(key: String, revision: int, priority: int, step: Callable, commit: Callable) -> void:
	if revision < int(_latest.get(key, -1)):
		superseded += 1
		return
	if _jobs.has(key):
		superseded += 1
	_latest[key] = revision
	_sequence += 1
	_jobs[key] = {"key": key, "revision": revision, "priority": priority, "step": step,
		"commit": commit, "sequence": _sequence}


func cancel(key: String) -> void:
	if _jobs.has(key):
		_jobs.erase(key)
		superseded += 1
	_latest.erase(key)


func clear() -> void:
	_jobs.clear()
	_latest.clear()
	completed = 0
	superseded = 0
	max_step_us = 0
	max_commit_us = 0
	last_slice_us = 0


func has_pending(prefix := "") -> bool:
	if prefix == "":
		return not _jobs.is_empty()
	for key in _jobs:
		if str(key).begins_with(prefix):
			return true
	return false


func tick(budget_us: int) -> void:
	var started := Time.get_ticks_usec()
	while not _jobs.is_empty() and Time.get_ticks_usec() - started < budget_us:
		var keys := _jobs.keys()
		keys.sort_custom(func(a, b):
			var ja: Dictionary = _jobs[a]
			var jb: Dictionary = _jobs[b]
			return int(ja.priority) < int(jb.priority) if ja.priority != jb.priority else int(ja.sequence) < int(jb.sequence))
		var key := str(keys[0])
		var job: Dictionary = _jobs[key]
		var at := Time.get_ticks_usec()
		var done := bool((job.step as Callable).call())
		max_step_us = maxi(max_step_us, Time.get_ticks_usec() - at)
		if not _jobs.has(key) or int(_latest.get(key, -1)) != int(job.revision):
			superseded += 1
			continue
		if done:
			# Commit on a separate slice if the step consumed the remaining generation budget.
			if Time.get_ticks_usec() - started >= budget_us:
				job.step = func(): return true
				continue
			_jobs.erase(key)
			at = Time.get_ticks_usec()
			(job.commit as Callable).call()
			max_commit_us = maxi(max_commit_us, Time.get_ticks_usec() - at)
			completed += 1
		else:
			_sequence += 1
			job.sequence = _sequence
	last_slice_us = Time.get_ticks_usec() - started


func stats() -> Dictionary:
	return {"pending": _jobs.size(), "completed": completed, "superseded": superseded,
		"last_slice_ms": last_slice_us / 1000.0, "max_step_ms": max_step_us / 1000.0, "max_commit_ms": max_commit_us / 1000.0}
