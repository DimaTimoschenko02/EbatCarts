extends Node3D

const KART_SCENE := preload("res://scenes/player_kart.tscn")

# Spawn points around the arena
const SPAWN_POINTS: Array[Vector3] = [
	Vector3( 7, 3.5,  0),
	Vector3(-7, 3.5,  0),
	Vector3( 0, 3.5,  7),
	Vector3( 0, 3.5, -7),
	Vector3( 5, 3.5,  5),
	Vector3(-5, 3.5, -5),
	Vector3( 5, 3.5, -5),
	Vector3(-5, 3.5,  5),
]

var _spawn_index: int = 0

@onready var karts: Node3D = $Karts
@onready var spawner: MultiplayerSpawner = $MultiplayerSpawner
@onready var hud: CanvasLayer = $HUD

func _ready() -> void:
	spawner.spawn_function = _spawn_kart_func

	if multiplayer.is_server():
		# Spawn kart for the host
		_spawn_for_player(1, PlayerData.my_name)
		# Connect for future players
		NetworkManager.player_connected.connect(_on_player_connected)
		NetworkManager.player_disconnected.connect(_on_player_disconnected)
	else:
		# Client: tell server our name so it can spawn our kart
		_register.rpc_id(1, PlayerData.my_name)

	GameManager.scores_updated.connect(hud.update_scores)
	GameManager.player_respawned.connect(_on_player_respawned)

# ── Client → Server: "hi, my name is X" ──────────────────────────────────────

@rpc("any_peer", "call_remote", "reliable")
func _register(player_name: String) -> void:
	if not multiplayer.is_server():
		return
	var pid := multiplayer.get_remote_sender_id()
	_spawn_for_player(pid, player_name)

# ── Spawning ──────────────────────────────────────────────────────────────────

func _spawn_for_player(pid: int, player_name: String) -> void:
	GameManager.register_player(pid, player_name)
	var idx := _spawn_index
	_spawn_index += 1
	spawner.spawn({"id": pid, "name": player_name, "pos": SPAWN_POINTS[idx % SPAWN_POINTS.size()]})

func _spawn_kart_func(data) -> Node:
	var kart := KART_SCENE.instantiate()
	kart.player_id   = data["id"]
	kart.player_name = data["name"]
	kart.name        = str(data["id"])
	kart.position    = data["pos"]   # local == global since Karts node is at origin
	return kart

# ── Player disconnect ─────────────────────────────────────────────────────────

func _on_player_connected(pid: int) -> void:
	# New peer connected mid-game: ask for their name
	_request_name.rpc_id(pid)

@rpc("authority", "call_remote", "reliable")
func _request_name() -> void:
	_register.rpc_id(1, PlayerData.my_name)

func _on_player_disconnected(pid: int) -> void:
	if not multiplayer.is_server():
		return
	GameManager.unregister_player(pid)
	var kart := karts.get_node_or_null(str(pid))
	if kart:
		kart.queue_free()

# ── Respawn ───────────────────────────────────────────────────────────────────

func _on_player_respawned(pid: int) -> void:
	if not multiplayer.is_server():
		return
	var kart := karts.get_node_or_null(str(pid)) as RigidBody3D
	if not kart:
		return
	var spawn_pos := SPAWN_POINTS[randi() % SPAWN_POINTS.size()]
	kart.respawn.rpc(spawn_pos)
