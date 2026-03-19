extends Node3D

# Builds the arena entirely from code - no external assets needed for MVP.
# Floor + perimeter walls + a few box obstacles.

const ARENA_HALF  := 30.0   # 60x60 metres playing field
const WALL_H      := 2.5
const WALL_T      := 0.8

const COLOR_FLOOR    := Color(0.25, 0.55, 0.25)   # green
const COLOR_WALL     := Color(0.55, 0.35, 0.20)   # brown
const COLOR_OBSTACLE := Color(0.60, 0.60, 0.65)   # grey-blue

func _ready() -> void:
	_build()

func _build() -> void:
	_add_static_box(Vector3.ZERO, Vector3(ARENA_HALF * 2, 0.4, ARENA_HALF * 2), COLOR_FLOOR)

	# Perimeter walls (wall=true → low friction for sliding)
	var w := ARENA_HALF
	_add_static_box(Vector3(0,   WALL_H / 2, -w), Vector3(w * 2 + WALL_T * 2, WALL_H, WALL_T), COLOR_WALL, true)
	_add_static_box(Vector3(0,   WALL_H / 2,  w), Vector3(w * 2 + WALL_T * 2, WALL_H, WALL_T), COLOR_WALL, true)
	_add_static_box(Vector3(-w,  WALL_H / 2, 0),  Vector3(WALL_T, WALL_H, w * 2), COLOR_WALL, true)
	_add_static_box(Vector3( w,  WALL_H / 2, 0),  Vector3(WALL_T, WALL_H, w * 2), COLOR_WALL, true)

	# Central obstacles (wall=true → low friction)
	_add_static_box(Vector3(12,   0.75, 12),   Vector3(2.5, 1.5, 2.5),  COLOR_OBSTACLE, true)
	_add_static_box(Vector3(-12,  0.75, -12),  Vector3(2.5, 1.5, 2.5),  COLOR_OBSTACLE, true)

	# Боковые трамплины.
	# center_y=0.66: верхняя поверхность входа вровень с полом (y=0.2), нижний торец утоплен в пол.
	# Формула: floor_top + (l/2)*sin(10°) - (h/2)*cos(10°) = 0.20 + 0.608 - 0.148 = 0.66
	_add_ramp(Vector3( 8, 0.66, 0),  10.0)   # склон вверх к -Z, въезд с +Z
	_add_ramp(Vector3(-8, 0.66, 0), -10.0)   # склон вверх к +Z, въезд с -Z

	# Высокая платформа для теста прыжков.
	# center_y=1.2 → top≈2.8м, bottom утоплен в пол.
	_add_static_box(Vector3(0, 1.2, -22), Vector3(7.0, 3.2, 6.0), COLOR_OBSTACLE, true)
	# Пандус 15°, center_y=1.30: верхняя поверхность входа вровень с полом, top≈2.79м = платформа top.
	# Формула: floor_top + (l/2)*sin(15°) - (h/2)*cos(15°) = 0.20 + 1.294 - 0.193 = 1.30
	_add_ramp(Vector3(0, 1.3, -14), 15.0, Vector3(5.0, 0.4, 10.0))

	_add_lighting()

func _add_static_box(pos: Vector3, size: Vector3, color: Color, wall: bool = false) -> void:
	var body := StaticBody3D.new()

	# Все поверхности — нулевое трение: карт управляет им сам через arcade-физику.
	# Стены дополнительно получают небольшой отскок.
	var phys_mat := PhysicsMaterial.new()
	phys_mat.friction = 0.0
	phys_mat.bounce   = 0.18 if wall else 0.0
	body.physics_material_override = phys_mat

	var mesh_inst := MeshInstance3D.new()
	var box_mesh  := BoxMesh.new()
	box_mesh.size = size
	var mat := StandardMaterial3D.new()
	mat.albedo_color = color
	box_mesh.material = mat
	mesh_inst.mesh = box_mesh
	body.add_child(mesh_inst)

	var col := CollisionShape3D.new()
	var box_shape := BoxShape3D.new()
	box_shape.size = size
	col.shape = box_shape
	body.add_child(col)

	body.position = pos
	add_child(body)

func _add_ramp(center_pos: Vector3, tilt_deg: float, ramp_size: Vector3 = Vector3(4.0, 0.3, 7.0)) -> void:
	# tilt_deg > 0 → пандус поднимается к -Z (въезд со стороны +Z)
	# tilt_deg < 0 → пандус поднимается к +Z (въезд со стороны -Z)
	# center_pos.y должен быть рассчитан так, чтобы низкий конец был у пола (y≈0.2)
	var body := StaticBody3D.new()

	var phys_mat := PhysicsMaterial.new()
	phys_mat.friction = 0.0
	phys_mat.bounce   = 0.0
	body.physics_material_override = phys_mat

	var mesh_inst := MeshInstance3D.new()
	var box_mesh  := BoxMesh.new()
	box_mesh.size = ramp_size
	var mat := StandardMaterial3D.new()
	mat.albedo_color = COLOR_WALL
	box_mesh.material = mat
	mesh_inst.mesh = box_mesh
	body.add_child(mesh_inst)

	var col := CollisionShape3D.new()
	var box_shape := BoxShape3D.new()
	box_shape.size = ramp_size
	col.shape = box_shape
	body.add_child(col)

	body.position = center_pos
	body.rotate_x(deg_to_rad(tilt_deg))   # наклон вперёд/назад, карт едет вдоль Z
	add_child(body)

func _add_lighting() -> void:
	var dir_light := DirectionalLight3D.new()
	dir_light.rotation_degrees = Vector3(-45, -30, 0)
	dir_light.light_energy = 1.2
	dir_light.shadow_enabled = true
	add_child(dir_light)

	var env_node := WorldEnvironment.new()
	var env := Environment.new()
	env.background_mode = Environment.BG_COLOR
	env.background_color = Color(0.45, 0.65, 0.9)
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = Color(0.4, 0.4, 0.5)
	env.ambient_light_energy = 0.6
	env_node.environment = env
	add_child(env_node)
