extends RefCounted


class Snapshot:
	var timestamp_ms: int
	var pos: Vector3
	var rot: Vector3
	var vel: Vector3

	func _init(ts: int, p: Vector3, r: Vector3, v: Vector3) -> void:
		timestamp_ms = ts
		pos = p
		rot = r
		vel = v


const BUFFER_DELAY_MS: int = 100
const MAX_SNAPSHOTS: int = 8
const EXTRAPOLATE_MAX_MS: int = 150
const TELEPORT_THRESHOLD: float = 10.0

var _snapshots: Array = []  # Array of Snapshot
var _head: int = 0
var _force_teleport: bool = false


func push(timestamp_ms: int, pos: Vector3, rot: Vector3, vel: Vector3) -> void:
	# Discard out-of-order packets
	if _snapshots.size() > 0:
		var latest := _get_latest()
		if latest and timestamp_ms <= latest.timestamp_ms:
			return
		# Teleport detection — clear buffer to avoid interpolating between old and new position
		if latest and pos.distance_to(latest.pos) > TELEPORT_THRESHOLD:
			_force_teleport = true
			_snapshots.clear()
			_head = 0

	var snap := Snapshot.new(timestamp_ms, pos, rot, vel)
	if _snapshots.size() < MAX_SNAPSHOTS:
		_snapshots.append(snap)
	else:
		_snapshots[_head] = snap
	_head = (_head + 1) % MAX_SNAPSHOTS


func sample(render_time_ms: int) -> Dictionary:
	# Returns { "pos": Vector3, "rot": Vector3, "valid": bool }
	if _snapshots.size() == 0:
		return { "pos": Vector3.ZERO, "rot": Vector3.ZERO, "valid": false }

	# Force teleport: snap to latest position
	if _force_teleport:
		_force_teleport = false
		var latest := _get_latest()
		return { "pos": latest.pos, "rot": latest.rot, "valid": true }

	# Sort by timestamp for bracket search
	var sorted := _get_sorted()

	# Find two snapshots bracketing render_time
	var snap_a: Snapshot = null
	var snap_b: Snapshot = null
	for i in range(sorted.size() - 1):
		if sorted[i].timestamp_ms <= render_time_ms and sorted[i + 1].timestamp_ms >= render_time_ms:
			snap_a = sorted[i]
			snap_b = sorted[i + 1]
			break

	# Found bracket — interpolate
	if snap_a and snap_b:
		var duration := snap_b.timestamp_ms - snap_a.timestamp_ms
		var t: float = 0.0
		if duration > 0:
			t = clampf(float(render_time_ms - snap_a.timestamp_ms) / float(duration), 0.0, 1.0)
		return {
			"pos": snap_a.pos.lerp(snap_b.pos, t),
			"rot": Vector3(
				lerp_angle(snap_a.rot.x, snap_b.rot.x, t),
				lerp_angle(snap_a.rot.y, snap_b.rot.y, t),
				lerp_angle(snap_a.rot.z, snap_b.rot.z, t)
			),
			"valid": true
		}

	# No future snapshot — try extrapolation
	var latest := sorted[-1] as Snapshot
	var elapsed_ms := render_time_ms - latest.timestamp_ms
	if elapsed_ms > 0 and elapsed_ms <= EXTRAPOLATE_MAX_MS:
		var elapsed_sec := float(elapsed_ms) / 1000.0
		return {
			"pos": latest.pos + latest.vel * elapsed_sec,
			"rot": latest.rot,
			"valid": true
		}

	# Beyond extrapolation limit — freeze at last known
	if elapsed_ms > EXTRAPOLATE_MAX_MS:
		return { "pos": latest.pos, "rot": latest.rot, "valid": true }

	# Render time before all snapshots — use earliest
	return { "pos": sorted[0].pos, "rot": sorted[0].rot, "valid": true }


func force_teleport() -> void:
	_force_teleport = true
	_snapshots.clear()
	_head = 0


func _get_latest() -> Snapshot:
	if _snapshots.size() == 0:
		return null
	var latest: Snapshot = _snapshots[0]
	for snap: Snapshot in _snapshots:
		if snap.timestamp_ms > latest.timestamp_ms:
			latest = snap
	return latest


func _get_sorted() -> Array:
	var sorted := _snapshots.duplicate()
	sorted.sort_custom(func(a: Snapshot, b: Snapshot) -> bool:
		return a.timestamp_ms < b.timestamp_ms
	)
	return sorted
