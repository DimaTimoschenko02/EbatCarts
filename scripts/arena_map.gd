extends Node3D

# Подстраивается под визуальную карту (low_poly_map.glb).
# Все параметры — @export, чтобы можно было менять прямо в инспекторе Godot.

@export var floor_size   : Vector2 = Vector2(70.0, 70.0)  # X, Z размер арены в метрах
@export var floor_y      : float   = 0.0                  # Y верхней поверхности пола карты
@export var wall_height  : float   = 4.0
@export var wall_thickness: float  = 1.0

const COLOR_WALL := Color(0.3, 0.3, 0.35, 0.55)

func _ready() -> void:
	_build_floor()
	_build_walls()

func _build_floor() -> void:
	var thickness := 0.5
	var pos := Vector3(0.0, floor_y - thickness * 0.5, 0.0)
	var size := Vector3(floor_size.x, thickness, floor_size.y)
	_add_physics_box(pos, size)

func _build_walls() -> void:
	var hx := floor_size.x * 0.5
	var hz := floor_size.y * 0.5
	var wy := floor_y + wall_height * 0.5
	var wsize_xz := Vector3(floor_size.x + wall_thickness * 2.0, wall_height, wall_thickness)
	var wsize_z  := Vector3(wall_thickness, wall_height, floor_size.y)

	_add_wall(Vector3(0.0,  wy, -hz), wsize_xz)  # север
	_add_wall(Vector3(0.0,  wy,  hz), wsize_xz)  # юг
	_add_wall(Vector3(-hx,  wy, 0.0), wsize_z)   # запад
	_add_wall(Vector3( hx,  wy, 0.0), wsize_z)   # восток

func _add_wall(pos: Vector3, size: Vector3) -> void:
	var body := _add_physics_box(pos, size)

	# Полупрозрачный визуал стены
	var mesh_inst := MeshInstance3D.new()
	var box_mesh  := BoxMesh.new()
	box_mesh.size = size
	var mat := StandardMaterial3D.new()
	mat.albedo_color    = COLOR_WALL
	mat.transparency    = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.cull_mode       = BaseMaterial3D.CULL_DISABLED
	mat.shading_mode    = BaseMaterial3D.SHADING_MODE_UNSHADED
	box_mesh.material   = mat
	mesh_inst.mesh      = box_mesh
	body.add_child(mesh_inst)

func _add_physics_box(pos: Vector3, size: Vector3) -> StaticBody3D:
	var body := StaticBody3D.new()
	var phys_mat := PhysicsMaterial.new()
	phys_mat.friction = 0.0
	phys_mat.bounce   = 0.15
	body.physics_material_override = phys_mat
	body.position = pos

	var col   := CollisionShape3D.new()
	var shape := BoxShape3D.new()
	shape.size = size
	col.shape  = shape
	body.add_child(col)
	add_child(body)
	return body
