extends Area3D

var SPEED            : float = 28.0
var DAMAGE           : int   = 50
var EXPLOSION_RADIUS : float = 3.5
var LIFETIME         : float = 6.0

var shooter_id: int = 0
var _age: float = 0.0
var _exploded: bool = false
var _trail_timer: float = 0.025   # сразу первый след при спавне

func _ready() -> void:
	body_entered.connect(_on_body_entered)
	if OS.is_debug_build() and not OS.has_feature("web"):
		DevParams.params_changed.connect(_on_dev_params_changed)

func _on_dev_params_changed(data: Dictionary) -> void:
	SPEED            = data.get("ROCKET_SPEED",      SPEED)
	DAMAGE           = data.get("DAMAGE",             DAMAGE)
	EXPLOSION_RADIUS = data.get("EXPLOSION_RADIUS",   EXPLOSION_RADIUS)
	LIFETIME         = data.get("ROCKET_LIFETIME",    LIFETIME)

func _physics_process(delta: float) -> void:
	_age += delta
	if _age >= LIFETIME:
		_explode()
		return
	global_position -= global_transform.basis.z * SPEED * delta
	_trail_timer += delta
	if _trail_timer >= 0.025:
		_trail_timer = 0.0
		_spawn_trail()

func _spawn_trail() -> void:
	var p := MeshInstance3D.new()
	var sm := SphereMesh.new()
	sm.radius = 0.14
	sm.height = 0.28
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(1.0, 0.45, 0.05, 0.85)
	mat.emission_enabled = true
	mat.emission = Color(1.0, 0.25, 0.0)
	mat.emission_energy_multiplier = 5.0
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	sm.material = mat
	p.mesh = sm
	p.global_position = global_position + global_transform.basis.z * 0.35
	get_tree().current_scene.add_child(p)
	var tw := p.create_tween()
	tw.set_parallel(true)
	tw.tween_property(p, "scale", Vector3.ZERO, 0.22)
	tw.tween_callback(p.queue_free).set_delay(0.22)

func _on_body_entered(body: Node) -> void:
	if _exploded or _age < 0.1:
		return
	if body is RigidBody3D and body.player_id == shooter_id:
		return
	_explode()

func _explode() -> void:
	if _exploded:
		return
	_exploded = true

	if multiplayer.is_server():
		for kart in get_tree().get_nodes_in_group("karts"):
			if global_position.distance_to(kart.global_position) <= EXPLOSION_RADIUS:
				kart.take_damage(DAMAGE, shooter_id)

	# Ракета существует на всех клиентах — каждый показывает взрыв локально.
	# RPC не нужен: нет проблемы с authority и нет лишнего трафика.
	_spawn_explosion_vfx(global_position)
	queue_free()

func _spawn_explosion_vfx(pos: Vector3) -> void:
	var scene := get_tree().current_scene
	# 1. Яркая белая вспышка — быстро вспыхивает и гаснет
	_add_exp_sphere(scene, pos, 0.0, 1.2, Color(1.0, 1.0, 0.95, 1.0), Color(1.0, 1.0, 0.8), 22.0, 0.22)
	# 2. Оранжевое среднее облако
	_add_exp_sphere(scene, pos, 0.0, 2.8, Color(1.0, 0.55, 0.08, 0.7), Color(1.0, 0.35, 0.0), 7.0, 0.38)
	# 3. Тёмное внешнее кольцо
	_add_exp_sphere(scene, pos, 0.5, 4.2, Color(0.85, 0.22, 0.0, 0.25), Color(0.7, 0.15, 0.0), 2.0, 0.48)
	# 4. Искры разлетаются в стороны
	for i in range(8):
		var angle := i * TAU / 8.0 + randf() * 0.4
		var dest := pos + Vector3(cos(angle), randf_range(0.3, 1.0), sin(angle)) * randf_range(1.2, 2.5)
		_add_exp_spark(scene, pos, dest)

func _add_exp_sphere(parent: Node, pos: Vector3, start_s: float, end_s: float,
		color: Color, emission: Color, energy: float, duration: float) -> void:
	var m := MeshInstance3D.new()
	var sm := SphereMesh.new()
	sm.radius = 1.0
	sm.height = 2.0
	var mat := StandardMaterial3D.new()
	mat.albedo_color = color
	mat.emission_enabled = true
	mat.emission = emission
	mat.emission_energy_multiplier = energy
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	sm.material = mat
	m.mesh = sm
	m.scale = Vector3.ONE * start_s
	m.global_position = pos
	parent.add_child(m)
	var tw := m.create_tween()
	tw.tween_property(m, "scale", Vector3.ONE * end_s, duration * 0.55)
	tw.tween_property(m, "scale", Vector3.ZERO, duration * 0.45)
	tw.tween_callback(m.queue_free)

func _add_exp_spark(parent: Node, origin: Vector3, dest: Vector3) -> void:
	var m := MeshInstance3D.new()
	var sm := SphereMesh.new()
	sm.radius = 0.1
	sm.height = 0.2
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(1.0, 0.85, 0.15, 1.0)
	mat.emission_enabled = true
	mat.emission = Color(1.0, 0.65, 0.0)
	mat.emission_energy_multiplier = 12.0
	sm.material = mat
	m.mesh = sm
	m.global_position = origin
	parent.add_child(m)
	var tw := m.create_tween()
	tw.set_parallel(true)
	tw.tween_property(m, "global_position", dest, 0.28)
	tw.tween_property(m, "scale", Vector3.ZERO, 0.28).set_delay(0.08)
	tw.tween_callback(m.queue_free).set_delay(0.28)
