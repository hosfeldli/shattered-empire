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


## Normally only current revisions commit. The exception is a long-running job (LONG_JOB steps
## or more): a newer revision then waits until it finishes and commits, because restarting a large
## district on every change could livelock it and leave its buildings unrendered indefinitely.
const LONG_JOB := 16
var _deferred := {}


func enqueue(key: String, revision: int, priority: int, step: Callable, commit: Callable) -> void:
	if revision < int(_latest.get(key, -1)):
		superseded += 1
		return
	_sequence += 1
	var job := {"key": key, "revision": revision, "priority": priority, "step": step,
		"commit": commit, "sequence": _sequence, "steps": 0}
	if _jobs.has(key) and int(_jobs[key].get("steps", 0)) >= LONG_JOB:
		if _deferred.has(key): superseded += 1
		_deferred[key] = job
		_jobs[key].priority = mini(int(_jobs[key].priority), priority)
		return
	if _jobs.has(key):
		superseded += 1
	_latest[key] = revision
	_jobs[key] = job


func cancel(key: String) -> void:
	_deferred.erase(key)
	if _jobs.has(key):
		_jobs.erase(key)
		superseded += 1
	_latest.erase(key)


func clear() -> void:
	_jobs.clear()
	_deferred.clear()
	_latest.clear()
	completed = 0
	superseded = 0
	max_step_us = 0
	max_commit_us = 0
	last_slice_us = 0


func has_pending(prefix := "") -> bool:
	if prefix == "":
		return not _jobs.is_empty() or not _deferred.is_empty()
	for key in _jobs.keys() + _deferred.keys():
		if str(key).begins_with(prefix):
			return true
	return false


func _next_key() -> String:
	# linear selection: sorting every pending job on every step dominated large late-game queues
	var best := ""; var best_priority := 99; var best_sequence := 1 << 62
	for key in _jobs:
		var job: Dictionary = _jobs[key]
		var p := int(job.priority); var q := int(job.sequence)
		if p < best_priority or p == best_priority and q < best_sequence:
			best = key; best_priority = p; best_sequence = q
	return best


func tick(budget_us: int) -> void:
	var started := Time.get_ticks_usec()
	while not _jobs.is_empty() and Time.get_ticks_usec() - started < budget_us:
		var key := _next_key()
		var job: Dictionary = _jobs[key]
		var at := Time.get_ticks_usec()
		job.steps = int(job.get("steps", 0)) + 1
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
			if _deferred.has(key):
				var next_job: Dictionary = _deferred[key]
				_deferred.erase(key)
				_latest[key] = int(next_job.revision)
				_jobs[key] = next_job
		else:
			_sequence += 1
			job.sequence = _sequence
	last_slice_us = Time.get_ticks_usec() - started


func stats() -> Dictionary:
	return {"pending": _jobs.size(), "deferred": _deferred.size(), "completed": completed, "superseded": superseded,
		"last_slice_ms": last_slice_us / 1000.0, "max_step_ms": max_step_us / 1000.0, "max_commit_ms": max_commit_us / 1000.0}
