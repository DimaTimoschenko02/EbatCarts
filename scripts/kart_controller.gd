extends RigidBody3D

# ── Физика ───────────────────────────────────────────────────────────────────
var MAX_SPEED      : float = 35.0    # м/с
var ACCELERATION   : float = 12.0   # м/с² — разгон
var BRAKE_DECEL    : float = 40.0   # м/с² — торможение/реверс
var COAST_DECEL    : float = 8.0    # м/с² — накат (газ отпущен)
var STEERING_SPEED : float = 2.2    # рад/с при максимальной скорости
var HIGH_GRIP      : float = 18.0   # боковое сцепление на малой скорости (цепкий)
var LOW_GRIP       : float = 0.3    # боковое сцепление при заносе (скользкий)

# ── Сеть ─────────────────────────────────────────────────────────────────────
const SYNC_INTERVAL  := 0.05

# ── Состояние игрока ─────────────────────────────────────────────────────────
var player_id: int = 0
var player_name: String = ""

var current_hp: int = 100
var has_weapon: bool = false
var is_dead: bool = false

# ── Сеть: интерполяция ───────────────────────────────────────────────────────
var _net_pos: Vector3
var _net_rot: Vector3
var _sync_timer: float = 0.0

# ── Камера ────────────────────────────────────────────────────────────────────
var _cam_offset := Vector3(0, 3.5, 7.5)
var _cam_pos    := Vector3.ZERO
var _cam_init   := false

# ── Визуал ────────────────────────────────────────────────────────────────────
var _smoke_timer: float = 0.0
var _mark_timer:  float = 0.0

# ── Debug кэш (заполняется в _integrate_forces, читается в _physics_process) ──
var _dbg_fwd_vel  : float = 0.0
var _dbg_lat_vel  : float = 0.0
var _dbg_vert_vel : float = 0.0
var _dbg_angular  : float = 0.0
var _dbg_on_floor : bool  = false

# ── Ввод ─────────────────────────────────────────────────────────────────────
var _throttle:    float = 0.0
var _steer_input: float = 0.0

@onready var camera:          Camera3D = $Camera3D
@onready var name_label:      Label3D  = $NameLabel
@onready var _launcher_left:  Node3D   = $KartModel/LauncherLeft
@onready var _launcher_right: Node3D   = $KartModel/LauncherRight
@onready var _launcher_center:Node3D   = $KartModel/LauncherCenter

func _ready() -> void:
	_net_pos = global_position
	_net_rot = global_rotation
	camera.current = (player_id == multiplayer.get_unique_id())
	name_label.text = player_name
	add_to_group("karts")
	# Удалённые карты двигаем вручную — без симуляции физики
	if player_id != multiplayer.get_unique_id():
		freeze = true
	if OS.is_debug_build() and not OS.has_feature("web"):
		DevParams.params_changed.connect(_on_dev_params_changed)

func _on_dev_params_changed(data: Dictionary) -> void:
	MAX_SPEED      = data.get("MAX_SPEED",      MAX_SPEED)
	ACCELERATION   = data.get("ACCELERATION",   ACCELERATION)
	COAST_DECEL    = data.get("COAST_DECEL",    COAST_DECEL)
	BRAKE_DECEL    = data.get("BRAKE_DECEL",    BRAKE_DECEL)
	HIGH_GRIP      = data.get("HIGH_GRIP",      HIGH_GRIP)
	LOW_GRIP       = data.get("LOW_GRIP",       LOW_GRIP)
	STEERING_SPEED = data.get("STEERING_SPEED", STEERING_SPEED)
	_cam_offset = Vector3(0.0,
		data.get("CAMERA_HEIGHT",    _cam_offset.y),
		absf(data.get("CAMERA_DISTANCE", absf(_cam_offset.z))))
	if camera:
		camera.fov = data.get("FOV", camera.fov)

# ── Основной цикл ─────────────────────────────────────────────────────────────

func _physics_process(delta: float) -> void:
	if is_dead:
		return

	if multiplayer.get_unique_id() == player_id:
		_throttle    = Input.get_axis("move_backward", "move_forward")
		_steer_input = Input.get_axis("steer_right",   "steer_left")
		if Input.is_action_just_pressed("fire") and has_weapon:
			_fire()
		_try_spawn_smoke(delta)
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
				"hp":       current_hp,
				"weapon":   has_weapon,
				"peer_id":  player_id,
				"is_server": multiplayer.is_server(),
				"pos":      global_position,
			})
		_sync_timer += delta
		if _sync_timer >= SYNC_INTERVAL:
			_sync_timer = 0.0
			_rpc_sync.rpc(global_position, global_rotation, linear_velocity)
	else:
		# Плавная интерполяция позиции удалённого карта
		global_position = global_position.lerp(_net_pos, 12.0 * delta)
		global_rotation = Vector3(
			lerp_angle(global_rotation.x, _net_rot.x, 12.0 * delta),
			lerp_angle(global_rotation.y, _net_rot.y, 12.0 * delta),
			lerp_angle(global_rotation.z, _net_rot.z, 12.0 * delta)
		)

# ── Arcade физика (_integrate_forces — правильный способ по документации Godot) ──
#
# _integrate_forces вызывается движком ВНУТРИ физического шага, после применения
# гравитации, но до разрешения контактов. Это единственное место, где безопасно
# переопределять linear_velocity/angular_velocity (docs.godotengine.org → RigidBody3D).

func _integrate_forces(state: PhysicsDirectBodyState3D) -> void:
	if is_dead or multiplayer.get_unique_id() != player_id:
		return

	var delta : float   = state.step
	var fwd   : Vector3 = -state.transform.basis.z
	var right : Vector3 =  state.transform.basis.x

	# Проекция на текущий базис для вычисления тяги
	var fwd_vel : float = state.linear_velocity.dot(fwd)

	# Тяга / торможение — изменяем ТОЛЬКО переднюю составляющую скорости.
	# Боковая и вертикальная скорости не тронуты → занос накапливается естественно.
	var new_fwd_vel: float
	if _throttle > 0.0:
		new_fwd_vel = move_toward(fwd_vel,  MAX_SPEED * _throttle,          ACCELERATION * delta)
	elif _throttle < 0.0:
		new_fwd_vel = move_toward(fwd_vel, -MAX_SPEED * 0.4 * (-_throttle), BRAKE_DECEL  * delta)
	else:
		new_fwd_vel = move_toward(fwd_vel, 0.0, COAST_DECEL * delta)
	state.linear_velocity += fwd * (new_fwd_vel - fwd_vel)

	# Боковое сцепление — медленно гасим боковую составляющую.
	# Высокая скорость + поворот = низкое сцепление = занос сохраняется долго.
	var speed_n    : float = clampf(absf(fwd_vel) / MAX_SPEED, 0.0, 1.0)
	var turn_effort: float = absf(_steer_input)
	var grip_mix   : float = clampf(speed_n * turn_effort * 0.7, 0.0, 1.0)
	var grip       : float = lerpf(HIGH_GRIP, LOW_GRIP, grip_mix)
	var lat_vel    : float = state.linear_velocity.dot(right)
	state.linear_velocity -= right * lat_vel * clampf(grip * delta, 0.0, 1.0)

	# Поворот
	var steer_authority: float = lerpf(0.35, 1.0, speed_n)
	var fwd_sign       : float = signf(fwd_vel) if absf(fwd_vel) > 0.5 else signf(_throttle)
	var target_yaw     : float = _steer_input * STEERING_SPEED * steer_authority * fwd_sign
	state.angular_velocity = Vector3(0.0, lerpf(state.angular_velocity.y, target_yaw, 7.0 * delta), 0.0)

	_dbg_fwd_vel  = new_fwd_vel
	_dbg_lat_vel  = lat_vel
	_dbg_vert_vel = state.linear_velocity.y
	_dbg_angular  = state.angular_velocity.y
	_dbg_on_floor = state.get_contact_count() > 0

# ── Камера ────────────────────────────────────────────────────────────────────

func _process(delta: float) -> void:
	if multiplayer.get_unique_id() != player_id or not camera:
		return
	var flat_basis := Basis(Vector3.UP, global_rotation.y)
	var target_pos := global_position + flat_basis * _cam_offset
	if not _cam_init:
		_cam_pos  = target_pos
		_cam_init = true
	_cam_pos = _cam_pos.lerp(target_pos, 6.0 * delta)
	camera.global_position = _cam_pos
	camera.look_at(global_position + Vector3.UP * 0.5, Vector3.UP)

# ── Стрельба ──────────────────────────────────────────────────────────────────

func _fire() -> void:
	has_weapon = false
	_launch_visual()
	_show_fire_flash()
	if multiplayer.is_server():
		var spawn_pos: Vector3 = global_position - global_transform.basis.z * 2.2 + Vector3.UP * 0.8
		_rpc_spawn_rocket.rpc(player_id, spawn_pos, global_rotation)
	else:
		_rpc_request_fire.rpc_id(1)

func _launch_visual() -> void:
	if _launcher_left:
		_launcher_left.launch()
	if _launcher_right:
		_launcher_right.launch()
	if _launcher_center:
		_launcher_center.launch()

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
	m.global_position = flash_pos
	scene.add_child(m)
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
	var spawn_pos: Vector3 = kart.global_position - kart.global_transform.basis.z * 2.2 + Vector3.UP * 0.8
	var spawn_rot: Vector3 = kart.global_rotation
	_rpc_spawn_rocket.rpc(shooter_id, spawn_pos, spawn_rot)

@rpc("authority", "call_local", "reliable")
func _rpc_spawn_rocket(shooter_id: int, pos: Vector3, rot: Vector3) -> void:
	var rocket_scene := load("res://scenes/rocket.tscn") as PackedScene
	var rocket := rocket_scene.instantiate()
	rocket.shooter_id = shooter_id
	rocket.global_position = pos
	rocket.global_rotation = rot
	get_tree().current_scene.add_child(rocket)

# ── Дымок при скольжении ──────────────────────────────────────────────────────

func _try_spawn_smoke(delta: float) -> void:
	if not is_inside_tree():
		return
	var lat_vel := absf(linear_velocity.dot(global_transform.basis.x))
	if lat_vel < 2.5:
		return
	_smoke_timer += delta
	if _smoke_timer < 0.07:
		return
	_smoke_timer = 0.0
	_mark_timer += 0.07
	var spawn_marks := _mark_timer >= 0.14
	if spawn_marks:
		_mark_timer = 0.0
	for ox in [-0.65, 0.65]:
		var sp: Vector3 = global_position + global_transform.basis.x * ox + global_transform.basis.z * 0.75 + Vector3.UP * 0.05
		_spawn_smoke_puff(sp)
		if spawn_marks:
			_spawn_tire_mark(sp)

func _spawn_tire_mark(pos: Vector3) -> void:
	var m   := MeshInstance3D.new()
	var qm  := QuadMesh.new()
	qm.size = Vector2(0.24, 0.38)
	var mat := StandardMaterial3D.new()
	mat.albedo_color  = Color(0.07, 0.07, 0.07, 0.72)
	mat.transparency  = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.shading_mode  = BaseMaterial3D.SHADING_MODE_UNSHADED
	qm.material = mat
	m.mesh = qm
	# Кладём след плашмя на пол: rotate_x(-PI/2) переводит нормаль квада вверх
	m.global_position = Vector3(pos.x, 0.22, pos.z)
	m.rotation = Vector3(-PI / 2.0, global_rotation.y, 0.0)
	get_tree().current_scene.add_child(m)
	# Живёт 3 сек, затем 1 сек плавно исчезает через альфу материала
	var tw := m.create_tween()
	tw.tween_interval(3.0)
	tw.tween_method(func(a: float) -> void: mat.albedo_color.a = a, 0.72, 0.0, 1.0)
	tw.tween_callback(m.queue_free)

func _spawn_smoke_puff(pos: Vector3) -> void:
	var m := MeshInstance3D.new()
	var sm := SphereMesh.new()
	sm.radius = 1.0
	sm.height = 2.0
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(0.72, 0.76, 0.80, 0.50)
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	sm.material = mat
	m.mesh = sm
	m.scale = Vector3.ONE * 0.12
	m.global_position = pos
	get_tree().current_scene.add_child(m)
	var tw := m.create_tween()
	tw.set_parallel(true)
	tw.tween_property(m, "scale", Vector3.ONE * randf_range(0.28, 0.42), 0.4)
	tw.tween_callback(m.queue_free).set_delay(0.4)

# ── Сетевая синхронизация ─────────────────────────────────────────────────────

@rpc("any_peer", "unreliable")
func _rpc_sync(pos: Vector3, rot: Vector3, _lvel: Vector3) -> void:
	if multiplayer.get_remote_sender_id() != player_id:
		return
	_net_pos = pos
	_net_rot = rot

# ── Оружие / урон ─────────────────────────────────────────────────────────────

@rpc("authority", "call_local", "reliable")
func give_weapon() -> void:
	if not has_weapon:
		has_weapon = true

func take_damage(damage: int, attacker_id: int) -> void:
	if not multiplayer.is_server():
		return
	GameManager.deal_damage(player_id, attacker_id, damage)
	_rpc_update_hp.rpc(GameManager.players.get(player_id, {}).get("hp", 0))

@rpc("authority", "call_local", "reliable")
func _rpc_update_hp(new_hp: int) -> void:
	current_hp = new_hp
	if current_hp <= 0 and not is_dead:
		_die()

func _die() -> void:
	is_dead = true
	visible = false
	linear_velocity  = Vector3.ZERO
	angular_velocity = Vector3.ZERO

@rpc("authority", "call_local", "reliable")
func respawn(spawn_pos: Vector3) -> void:
	is_dead = false
	visible = true
	current_hp    = GameManager.MAX_HP
	global_position  = spawn_pos
	linear_velocity  = Vector3.ZERO
	angular_velocity = Vector3.ZERO
	_throttle    = 0.0
	_steer_input = 0.0
