extends CharacterBody3D

# ── Physics ──────────────────────────────────────────────────────────────────
var MAX_SPEED      : float = 23.0
var REVERSE_MAX_SPEED: float = 13.0
var ACCELERATION   : float = 12.0
var REVERSE_ACCELERATION: float = 10.0
var BRAKE_DECEL    : float = 40.0
var COAST_DECEL    : float = 8.0
var STEERING_SPEED : float = 2.2
var HIGH_GRIP      : float = 18.0
var LOW_GRIP       : float = 0.3

# ── Network ──────────────────────────────────────────────────────────────────
const SYNC_INTERVAL := 0.033

# ── Player identity ─────────────────────────────────────────────────────────
var player_id: int = 0
var player_name: String = ""

# ── Snapshot buffer (remote karts only) ──────────────────────────────────────
var _snapshot_buffer = null  # SnapshotBufferClass instance for remote karts
var _sync_timer: float = 0.0

# ── Camera ───────────────────────────────────────────────────────────────────
var _cam_offset := Vector3(0, 4.1, 6.8)
var _cam_look_forward := 1.15
var _cam_pos    := Vector3.ZERO
var _cam_init   := false

# ── VFX ──────────────────────────────────────────────────────────────────────
var _smoke_timer: float = 0.0
var _mark_timer:  float = 0.0

# ── Collision (disabled on death) ────────────────────────────────────────────
var _original_collision_layer: int = 0
var _original_collision_mask: int = 0

# ── Debug cache ──────────────────────────────────────────────────────────────
var _dbg_fwd_vel  : float = 0.0
var _dbg_lat_vel  : float = 0.0
var _dbg_vert_vel : float = 0.0
var _dbg_angular  : float = 0.0
var _dbg_on_floor : bool  = false

# ── Input ────────────────────────────────────────────────────────────────────
var _throttle:    float = 0.0
var _steer_input: float = 0.0
var _launcher_nodes: Array[Node3D] = []
const LAUNCHER_SCENE := preload("res://scenes/launcher.tscn")
const ROCKET_SCENE := preload("res://scenes/rocket.tscn")
const SnapshotBufferClass := preload("res://scripts/snapshot_buffer.gd")
const ROCKET_SPREAD_DEG := 10.0

# ── Server-side tracking ─────────────────────────────────────────────────────
var _last_known_pos: Vector3 = Vector3.ZERO

@onready var camera:          Camera3D = $Camera3D
@onready var name_label:      Label3D  = $NameLabel
@onready var _launcher_left:  Marker3D   = $BaseCar/Socket_Left
@onready var _launcher_right: Marker3D   = $BaseCar/Socket_Right
@onready var _launcher_center:Marker3D   = $BaseCar/Socket_Center
@onready var l_drift:         Node3D   = $BaseCar/MainCar/Car2/LT/LeftDrift
@onready var r_drift:         Node3D   = $BaseCar/MainCar/Car2/RT/RightDrift
@onready var l_smoke: GPUParticles3D = $BaseCar/MainCar/Car2/LT/LeftDrift/GPUParticles3D
@onready var r_smoke: GPUParticles3D = $BaseCar/MainCar/Car2/RT/RightDrift/GPUParticles3D


func _ready() -> void:
	if player_id == 0 and name.is_valid_int():
		player_id = name.to_int()
	print("[Kart] _ready: player_id=", player_id, " name=", player_name, " my_id=", multiplayer.get_unique_id())
	_last_known_pos = global_position
	_original_collision_layer = collision_layer
	_original_collision_mask = collision_mask
	var is_local := (player_id == multiplayer.get_unique_id())
	camera.current = is_local
	name_label.text = player_name

	# Remote karts: create snapshot buffer for interpolation
	if not is_local:
		_snapshot_buffer = SnapshotBufferClass.new()

	if OS.has_feature("web"):
		var dbg_label := Label.new()
		dbg_label.text = "pid=%d my_id=%d name=%s is_local=%s cam=%s" % [player_id, multiplayer.get_unique_id(), name, is_local, camera.current]
		dbg_label.position = Vector2(10, 40 + player_id * 25)
		dbg_label.add_theme_font_size_override("font_size", 18)
		dbg_label.add_theme_color_override("font_color", Color.YELLOW)
		get_tree().root.add_child.call_deferred(dbg_label)
	add_to_group("karts")
	if l_smoke:
		l_smoke.emitting = false
	if r_smoke:
		r_smoke.emitting = false

	StateManager.kart_state_changed.connect(_on_kart_state_changed)
	StateManager.weapon_state_changed.connect(_on_weapon_state_changed)

	if OS.is_debug_build() and not OS.has_feature("web"):
		DevParams.params_changed.connect(_on_dev_params_changed)


func _exit_tree() -> void:
	if StateManager.kart_state_changed.is_connected(_on_kart_state_changed):
		StateManager.kart_state_changed.disconnect(_on_kart_state_changed)
	if StateManager.weapon_state_changed.is_connected(_on_weapon_state_changed):
		StateManager.weapon_state_changed.disconnect(_on_weapon_state_changed)


func _on_dev_params_changed(data: Dictionary) -> void:
	MAX_SPEED      = data.get("MAX_SPEED",      MAX_SPEED)
	REVERSE_MAX_SPEED = data.get("REVERSE_MAX_SPEED", REVERSE_MAX_SPEED)
	ACCELERATION   = data.get("ACCELERATION",   ACCELERATION)
	REVERSE_ACCELERATION = data.get("REVERSE_ACCELERATION", REVERSE_ACCELERATION)
	COAST_DECEL    = data.get("COAST_DECEL",    COAST_DECEL)
	BRAKE_DECEL    = data.get("BRAKE_DECEL",    BRAKE_DECEL)
	HIGH_GRIP      = data.get("HIGH_GRIP",      HIGH_GRIP)
	LOW_GRIP       = data.get("LOW_GRIP",       LOW_GRIP)
	STEERING_SPEED = data.get("STEERING_SPEED", STEERING_SPEED)
	_cam_offset = Vector3(0.0,
		data.get("CAMERA_HEIGHT",    _cam_offset.y),
		absf(data.get("CAMERA_DISTANCE", absf(_cam_offset.z))))
	_cam_look_forward = data.get("CAMERA_LOOK_AHEAD", _cam_look_forward)
	if camera:
		camera.fov = data.get("FOV", camera.fov)


# ── State change handlers ────────────────────────────────────────────────────

func _on_kart_state_changed(peer_id: int, _from: GameStates.KartState, to: GameStates.KartState) -> void:
	if peer_id != player_id:
		return
	match to:
		GameStates.KartState.DEAD:
			_on_enter_dead()
		GameStates.KartState.RESPAWNING, GameStates.KartState.DRIVING:
			_on_enter_alive()


func _on_enter_dead() -> void:
	visible = false
	velocity = Vector3.ZERO
	collision_layer = 0
	collision_mask = 0
	_clear_launchers()


func _on_enter_alive() -> void:
	visible = true
	collision_layer = _original_collision_layer
	collision_mask = _original_collision_mask


func _on_weapon_state_changed(peer_id: int, _from: GameStates.WeaponState, to: GameStates.WeaponState) -> void:
	if peer_id != player_id:
		return
	if to == GameStates.WeaponState.ARMED:
		_spawn_launchers()
	elif to == GameStates.WeaponState.EMPTY:
		_clear_launchers()


# ── Main loop (local kart only) ──────────────────────────────────────────────

func _physics_process(delta: float) -> void:
	# Remote karts: no physics, interpolation happens in _process
	if multiplayer.get_unique_id() != player_id:
		return

	if not StateManager.can_move(player_id):
		return

	_throttle    = Input.get_axis("move_backward", "move_forward")
	_steer_input = Input.get_axis("steer_right",   "steer_left")

	if not is_on_floor():
		velocity.y -= 35.0 * delta
	else:
		velocity.y = 0

	var forward_dir = -global_transform.basis.z
	var side_dir = global_transform.basis.x

	var effective_throttle := _throttle
	if _throttle == 0.0 and _steer_input != 0.0:
		effective_throttle = 0.55
	var target_speed := 0.0
	if effective_throttle > 0.0:
		target_speed = effective_throttle * MAX_SPEED
	elif effective_throttle < 0.0:
		target_speed = effective_throttle * REVERSE_MAX_SPEED
	var current_fwd_speed = velocity.dot(forward_dir)

	if effective_throttle > 0.0:
		current_fwd_speed = move_toward(current_fwd_speed, target_speed, ACCELERATION * delta)
	elif effective_throttle < 0.0:
		current_fwd_speed = move_toward(current_fwd_speed, target_speed, REVERSE_ACCELERATION * delta)
	else:
		current_fwd_speed = lerp(current_fwd_speed, 0.0, 1.2 * delta)

	var rotation_speed = STEERING_SPEED
	if _throttle == 0:
		rotation_speed *= 1.25
	var steer_sign := 1.0
	if current_fwd_speed < -0.5:
		steer_sign = -1.0
	rotate_y(_steer_input * steer_sign * rotation_speed * delta)

	var current_side_speed = velocity.dot(side_dir)
	var drift_resistance := 3.8 if _steer_input != 0.0 else 4.8
	current_side_speed = lerp(current_side_speed, 0.0, drift_resistance * delta)

	velocity = (forward_dir * current_fwd_speed) + (side_dir * current_side_speed) + Vector3(0, velocity.y, 0)

	move_and_slide()
	_update_vfx(delta)

	if Input.is_action_just_pressed("fire") and StateManager.can_fire(player_id):
		_fire()

	if OS.has_feature("web"):
		var local_vel := global_transform.basis.inverse() * velocity
		var kart_state := StateManager.get_kart_state(player_id)
		var weapon_state := StateManager.get_weapon_state(player_id)
		var js_code := "window.kartMetrics = {x:%.2f, y:%.2f, z:%.2f, speed:%.2f, fwdSpeed:%.2f, latSpeed:%.2f, rotY:%.2f, hp:%d, weapon:%s, isDead:%s, onFloor:%s, steer:%.2f, throttle:%.2f}" % [
			global_position.x, global_position.y, global_position.z,
			velocity.length(),
			local_vel.z,
			local_vel.x,
			rad_to_deg(global_rotation.y),
			GameManager.players.get(player_id, {}).get("hp", 0),
			"true" if weapon_state == GameStates.WeaponState.ARMED else "false",
			"true" if kart_state == GameStates.KartState.DEAD else "false",
			"true" if is_on_floor() else "false",
			_steer_input,
			_throttle
		]
		JavaScriptBridge.eval(js_code)

	if OS.is_debug_build():
		var h : float = 0.0
		var space := get_world_3d().direct_space_state
		var query := PhysicsRayQueryParameters3D.create(
			global_position, global_position + Vector3.DOWN * 10.0)
		query.exclude = [get_rid()]
		var hit := space.intersect_ray(query)
		if hit:
			h = global_position.y - (hit.position as Vector3).y
		DebugOverlay.update({
			"fwd":      _dbg_fwd_vel,
			"lat":      _dbg_lat_vel,
			"vert":     _dbg_vert_vel,
			"drift":    rad_to_deg(atan2(absf(_dbg_lat_vel), maxf(absf(_dbg_fwd_vel), 0.1))),
			"height":   h,
			"angular":  _dbg_angular,
			"on_floor": _dbg_on_floor,
			"hp":       GameManager.players.get(player_id, {}).get("hp", 0),
			"weapon":   StateManager.get_weapon_state(player_id) == GameStates.WeaponState.ARMED,
			"peer_id":  player_id,
			"is_server": multiplayer.is_server(),
			"pos":      global_position,
		})

	# Send position sync (skip if DEAD)
	if StateManager.can_move(player_id):
		_sync_timer += delta
		if _sync_timer >= SYNC_INTERVAL:
			_sync_timer = 0.0
			var ts := Time.get_ticks_msec()
			var game_world := get_tree().current_scene
			if multiplayer.is_server() and game_world and "synced_peers" in game_world:
				for pid in game_world.synced_peers:
					if pid != player_id:
						_rpc_sync.rpc_id(pid, global_position, global_rotation, velocity, ts)
			else:
				_rpc_sync.rpc(global_position, global_rotation, velocity, ts)


# ── Camera + Remote interpolation ────────────────────────────────────────────

func _process(delta: float) -> void:
	if multiplayer.get_unique_id() == player_id:
		# Local kart: camera only
		if not camera:
			return
		var flat_basis := Basis(Vector3.UP, global_rotation.y)
		var target_pos := global_position + flat_basis * _cam_offset
		if not _cam_init:
			_cam_pos  = target_pos
			_cam_init = true
		_cam_pos = _cam_pos.lerp(target_pos, 6.0 * delta)
		camera.global_position = _cam_pos
		var forward_flat := -flat_basis.z
		var look_at_pt := global_position + forward_flat * _cam_look_forward + Vector3.UP * 0.55
		camera.look_at(look_at_pt, Vector3.UP)
	else:
		# Remote kart: snapshot buffer interpolation
		if not _snapshot_buffer:
			return
		if StateManager.get_kart_state(player_id) == GameStates.KartState.DEAD:
			return
		var render_time := NetworkManager.get_synced_time() - SnapshotBufferClass.BUFFER_DELAY_MS
		var state: Dictionary = _snapshot_buffer.sample(render_time)
		if state["valid"]:
			global_position = state["pos"]
			global_rotation = state["rot"]


# ── Firing ───────────────────────────────────────────────────────────────────

func _fire() -> void:
	var muzzle_transforms := _launch_visual()
	_show_fire_flash()
	if multiplayer.is_server():
		StateManager.server_consume_weapon(player_id)
		for i in range(muzzle_transforms.size()):
			var tr := muzzle_transforms[i]
			var rocket_dir := _apply_rocket_spread(tr.basis.z.normalized(), i, muzzle_transforms.size())
			_rpc_spawn_rocket.rpc(player_id, tr.origin, rocket_dir)
	else:
		_rpc_request_fire.rpc_id(1)


func _launch_visual() -> Array[Transform3D]:
	var result: Array[Transform3D] = []
	for launcher in _launcher_nodes:
		var muzzle := launcher.get_node_or_null("Muzzle") as Marker3D
		if muzzle:
			result.append(muzzle.global_transform)
		if launcher.has_method("launch"):
			launcher.launch()
	return result


func _show_fire_flash() -> void:
	var flash_pos := global_position - global_transform.basis.z * 2.2 + Vector3.UP * 0.4
	var scene := get_tree().current_scene
	var m := MeshInstance3D.new()
	var sm := SphereMesh.new()
	sm.radius = 1.0
	sm.height = 2.0
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(1.0, 1.0, 0.9, 1.0)
	mat.emission_enabled = true
	mat.emission = Color(1.0, 1.0, 0.8)
	mat.emission_energy_multiplier = 22.0
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	sm.material = mat
	m.mesh = sm
	m.scale = Vector3.ZERO
	scene.add_child(m)
	m.global_position = flash_pos
	var tw := m.create_tween()
	tw.tween_property(m, "scale", Vector3.ONE * 0.75, 0.06)
	tw.tween_property(m, "scale", Vector3.ZERO, 0.12)
	tw.tween_callback(m.queue_free)


@rpc("any_peer", "call_remote", "reliable")
func _rpc_request_fire() -> void:
	if not multiplayer.is_server():
		return
	var shooter_id := multiplayer.get_remote_sender_id()
	var kart := get_parent().get_node_or_null(str(shooter_id))
	if not kart:
		return
	if not StateManager.can_fire(shooter_id):
		return
	var muzzle_transforms: Array[Transform3D] = kart._launch_visual()
	kart._show_fire_flash()
	StateManager.server_consume_weapon(shooter_id)
	for i in range(muzzle_transforms.size()):
		var tr := muzzle_transforms[i]
		var rocket_dir: Vector3 = kart._apply_rocket_spread(tr.basis.z.normalized(), i, muzzle_transforms.size())
		_rpc_spawn_rocket.rpc(shooter_id, tr.origin, rocket_dir)


@rpc("authority", "call_local", "reliable")
func _rpc_spawn_rocket(shooter_id: int, pos: Vector3, dir: Vector3) -> void:
	var rocket := ROCKET_SCENE.instantiate()
	get_tree().current_scene.add_child(rocket)
	rocket.shooter_id = shooter_id
	rocket.global_position = pos
	rocket.direction = dir.normalized()
	rocket.look_at(pos + dir.normalized(), Vector3.UP)


func _apply_rocket_spread(base_dir: Vector3, index: int, total: int) -> Vector3:
	if total < 3:
		return base_dir
	var yaw_deg := 0.0
	if index == 0:
		yaw_deg = -ROCKET_SPREAD_DEG
	elif index == 1:
		yaw_deg = ROCKET_SPREAD_DEG
	var spread_basis := Basis(Vector3.UP, deg_to_rad(yaw_deg))
	return (spread_basis * base_dir).normalized()


# ── Drift VFX ────────────────────────────────────────────────────────────────

func _update_vfx(delta: float) -> void:
	if not l_smoke or not r_smoke: return

	var local_velocity = global_transform.basis.inverse() * velocity
	var forward_speed = abs(local_velocity.z)
	var side_speed = abs(local_velocity.x)
	var hard_steer: bool = abs(_steer_input) > 0.55
	var moving_drift: bool = forward_speed > 4.0 and side_speed > 2.2
	var spin_turn: bool = abs(_throttle) < 0.15 and abs(_steer_input) > 0.8 and forward_speed > 1.2
	var is_drifting := is_on_floor() and hard_steer and (moving_drift or spin_turn)

	if l_smoke.emitting != is_drifting:
		l_smoke.emitting = is_drifting
	if r_smoke.emitting != is_drifting:
		r_smoke.emitting = is_drifting

	l_drift.visible = true
	r_drift.visible = true


# ── Network sync ─────────────────────────────────────────────────────────────

@rpc("any_peer", "unreliable")
func _rpc_sync(pos: Vector3, rot: Vector3, vel: Vector3, timestamp_ms: int) -> void:
	var sender := multiplayer.get_remote_sender_id()
	if sender != player_id:
		return

	# Server-side: teleport validation + timeout tracking
	if multiplayer.is_server():
		NetworkManager.update_last_packet(sender)
		var dist := _last_known_pos.distance_to(pos)
		if dist > SnapshotBufferClass.TELEPORT_THRESHOLD:
			push_warning("[Kart] Teleport rejected for peer %d: dist=%.1f" % [sender, dist])
			return
		_last_known_pos = pos

	# Remote kart: push to snapshot buffer
	if _snapshot_buffer:
		_snapshot_buffer.push(timestamp_ms, pos, rot, vel)


# ── Weapon visuals ───────────────────────────────────────────────────────────

func _spawn_launchers() -> void:
	_clear_launchers()
	var sockets: Array[Marker3D] = [_launcher_left, _launcher_right, _launcher_center]
	for socket in sockets:
		if not socket:
			continue
		var launcher := LAUNCHER_SCENE.instantiate() as Node3D
		socket.add_child(launcher)
		launcher.transform = Transform3D.IDENTITY
		_launcher_nodes.append(launcher)


func _clear_launchers() -> void:
	for launcher in _launcher_nodes:
		if is_instance_valid(launcher):
			launcher.queue_free()
	_launcher_nodes.clear()


# ── Damage (server-side entry point) ─────────────────────────────────────────

func take_damage(damage: int, attacker_id: int) -> void:
	if not multiplayer.is_server():
		return
	if not StateManager.can_take_damage(player_id):
		return
	GameManager.deal_damage(player_id, attacker_id, damage)


# ── Respawn (visual reset, called via RPC from game_world) ───────────────────

@rpc("authority", "call_local", "reliable")
func respawn(spawn_pos: Vector3) -> void:
	global_position = spawn_pos
	velocity = Vector3.ZERO
	_throttle = 0.0
	_steer_input = 0.0
	_last_known_pos = spawn_pos
	if _snapshot_buffer:
		_snapshot_buffer.force_teleport()
	GameManager.reset_hp(player_id)
