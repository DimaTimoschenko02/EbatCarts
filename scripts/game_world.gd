extends Node3D

const KART_SCENE := preload("res://scenes/player_kart.tscn")

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
var _players: Dictionary = {}  # { pid: { name: String, pos: Vector3 } }
var synced_peers: Array[int] = []

@onready var karts: Node3D = $Karts
@onready var hud: CanvasLayer = $HUD


func _ready() -> void:
	print("[GameWorld] _ready: is_server=", multiplayer.is_server(), " my_id=", multiplayer.get_unique_id())

	if multiplayer.is_server():
		print("[GameWorld] Server mode - spawning host kart")
		synced_peers.append(1)
		_spawn_for_player(1, PlayerData.my_name)
		NetworkManager.player_disconnected.connect(_on_player_disconnected)
	else:
		print("[GameWorld] Client mode - telling server we're ready")
		_register.rpc_id(1, PlayerData.my_name)

	GameManager.scores_updated.connect(hud.update_scores)
	StateManager.kart_state_changed.connect(_on_kart_state_changed)


func _exit_tree() -> void:
	if GameManager.scores_updated.is_connected(hud.update_scores):
		GameManager.scores_updated.disconnect(hud.update_scores)
	if StateManager.kart_state_changed.is_connected(_on_kart_state_changed):
		StateManager.kart_state_changed.disconnect(_on_kart_state_changed)
	if multiplayer.is_server() and NetworkManager.player_disconnected.is_connected(_on_player_disconnected):
		NetworkManager.player_disconnected.disconnect(_on_player_disconnected)


# ── Client → Server: "я загрузился, вот моё имя" ────────────────────────────

@rpc("any_peer", "call_remote", "reliable")
func _register(player_name: String) -> void:
	if not multiplayer.is_server():
		return
	var pid := multiplayer.get_remote_sender_id()
	print("[GameWorld] _register from pid=", pid, " name=", player_name)

	# 1. Send full world state FIRST (before spawning karts)
	_rpc_world_state.rpc_id(pid, _build_world_state())

	# 2. Spawn existing karts for new client
	for existing_pid in _players:
		var info = _players[existing_pid]
		var kart_node = karts.get_node_or_null(str(existing_pid))
		var pos = kart_node.global_position if kart_node else info["pos"]
		_rpc_spawn_kart.rpc_id(pid, existing_pid, info["name"], pos)

	# 3. Spawn new player's kart (on all clients)
	_spawn_for_player(pid, player_name)

	# 4. Peer ready for sync RPCs (all spawns sent reliable → arrive in order)
	synced_peers.append(pid)

	# 5. Send current states
	StateManager.sync_state_to_peer(pid)


# ── World State (late join sync) ─────────────────────────────────────────────

func _build_world_state() -> Dictionary:
	var pickup_states := {}
	for pickup in get_tree().get_nodes_in_group("pickups"):
		if pickup.has_method("_set_state"):
			pickup_states[pickup.get_path()] = pickup.active

	return {
		"scores": GameManager.players.duplicate(true),
		"pickups": pickup_states,
		"match_state": StateManager.get_match_state(),
	}


@rpc("authority", "call_remote", "reliable")
func _rpc_world_state(state: Dictionary) -> void:
	print("[GameWorld] Received world_state")
	# Apply scores
	if "scores" in state:
		GameManager.players = state["scores"]
		GameManager.scores_updated.emit(GameManager.players)

	# Apply pickup states
	if "pickups" in state:
		for path in state["pickups"]:
			var pickup := get_node_or_null(path)
			if pickup and pickup.has_method("_set_state"):
				pickup._set_state(state["pickups"][path])


# ── Spawning ──────────────────────────────────────────────────────────────────

func _spawn_for_player(pid: int, player_name: String) -> void:
	print("[GameWorld] Spawning kart for pid=", pid, " name=", player_name)
	GameManager.register_player(pid, player_name)
	var idx := _spawn_index
	_spawn_index += 1
	var spawn_pos := SPAWN_POINTS[idx % SPAWN_POINTS.size()]

	_players[pid] = { "name": player_name, "pos": spawn_pos }

	_rpc_spawn_kart.rpc(pid, player_name, spawn_pos)


@rpc("authority", "call_local", "reliable")
func _rpc_spawn_kart(pid: int, player_name: String, spawn_pos: Vector3) -> void:
	if karts.has_node(str(pid)):
		return
	print("[GameWorld] _rpc_spawn_kart: pid=", pid, " name=", player_name)
	var kart := KART_SCENE.instantiate()
	kart.player_id   = pid
	kart.player_name = player_name
	kart.name        = str(pid)
	kart.position    = spawn_pos
	karts.add_child(kart, true)


# ── State changes ────────────────────────────────────────────────────────────

func _on_kart_state_changed(peer_id: int, _from: GameStates.KartState, to: GameStates.KartState) -> void:
	if to == GameStates.KartState.RESPAWNING:
		_on_kart_respawning(peer_id)


func _on_kart_respawning(pid: int) -> void:
	if not multiplayer.is_server():
		return
	var kart := karts.get_node_or_null(str(pid)) as CharacterBody3D
	if not kart:
		return
	var spawn_pos := SPAWN_POINTS[randi() % SPAWN_POINTS.size()]
	kart.respawn.rpc(spawn_pos)
	StateManager.server_respawn_complete(pid)


# ── Player disconnect ─────────────────────────────────────────────────────────

func _on_player_disconnected(pid: int) -> void:
	if not multiplayer.is_server():
		return
	# Broadcast disconnect to all clients BEFORE cleanup
	_rpc_kart_disconnect.rpc(pid)
	GameManager.unregister_player(pid)
	_players.erase(pid)
	synced_peers.erase(pid)
	var kart := karts.get_node_or_null(str(pid))
	if kart:
		kart.queue_free()


@rpc("authority", "call_remote", "reliable")
func _rpc_kart_disconnect(pid: int) -> void:
	print("[GameWorld] Kart disconnect: pid=", pid)
	GameManager.players.erase(pid)
	var kart := karts.get_node_or_null(str(pid))
	if kart:
		kart.queue_free()
