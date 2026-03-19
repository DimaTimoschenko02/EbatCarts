extends Area3D

const RESPAWN_TIME := 10.0

var active: bool = true

@onready var pickup_mesh: MeshInstance3D = $PickupMesh

func _ready() -> void:
	body_entered.connect(_on_body_entered)

func _process(delta: float) -> void:
	if active:
		pickup_mesh.rotate_y(delta * 2.0)

func _on_body_entered(body: Node) -> void:
	if not multiplayer.is_server():
		return
	if not active:
		return
	if not body is RigidBody3D:
		return
	if body.has_weapon:
		return

	# Give weapon to the kart (RPC to owner client)
	body.give_weapon.rpc_id(body.player_id)
	_set_state(false)
	_rpc_set_state.rpc(false)

	get_tree().create_timer(RESPAWN_TIME).timeout.connect(func():
		_set_state(true)
		_rpc_set_state.rpc(true)
	)

func _set_state(on: bool) -> void:
	active = on
	pickup_mesh.visible = on
	set_deferred("monitoring", on)

@rpc("authority", "call_remote")
func _rpc_set_state(on: bool) -> void:
	_set_state(on)
