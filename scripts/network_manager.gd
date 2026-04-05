extends Node

signal server_created
signal joined_server
signal connection_failed
signal player_connected(peer_id: int)
signal player_disconnected(peer_id: int)
signal ping_updated(rtt_ms: int)

const PORT := 4444
const TIMEOUT_MS: int = 5000
const PING_INTERVAL_S: float = 2.0

var peer: WebSocketMultiplayerPeer = null
var current_ping: int = 0

# Server time offset (computed from ping/pong)
var _server_time_offset: int = 0

# Server-side: track last packet time per peer for timeout detection
var _last_packet_time: Dictionary = {}  # { pid: int (msec) }
var _ping_timer: float = 0.0


func _ready() -> void:
	multiplayer.peer_connected.connect(_on_peer_connected)
	multiplayer.peer_disconnected.connect(_on_peer_disconnected)
	multiplayer.connected_to_server.connect(_on_connected_to_server)
	multiplayer.connection_failed.connect(_on_connection_failed)
	multiplayer.server_disconnected.connect(_on_server_disconnected)


func _process(delta: float) -> void:
	if multiplayer.multiplayer_peer == null:
		return
	if not multiplayer.has_multiplayer_peer():
		return

	# Client: send ping every PING_INTERVAL_S
	if not multiplayer.is_server() and multiplayer.get_connection_status() == MultiplayerPeer.CONNECTION_CONNECTED:
		_ping_timer += delta
		if _ping_timer >= PING_INTERVAL_S:
			_ping_timer = 0.0
			print("[Ping] Sending ping to server, ts=", Time.get_ticks_msec())
			_rpc_ping.rpc_id(1, Time.get_ticks_msec())

	# Server: check timeouts
	if multiplayer.is_server():
		_check_timeouts()


func get_synced_time() -> int:
	if multiplayer.is_server():
		return Time.get_ticks_msec()
	return Time.get_ticks_msec() + _server_time_offset


func update_last_packet(pid: int) -> void:
	_last_packet_time[pid] = Time.get_ticks_msec()


func _check_timeouts() -> void:
	var now := Time.get_ticks_msec()
	for pid in _last_packet_time.keys():
		if now - _last_packet_time[pid] > TIMEOUT_MS:
			push_warning("[NetworkManager] Timeout for peer %d (no packets for %dms)" % [pid, now - _last_packet_time[pid]])
			_last_packet_time.erase(pid)
			multiplayer.multiplayer_peer.disconnect_peer(pid)


# ── Connection management ────────────────────────────────────────────────────

func host_game() -> Error:
	peer = WebSocketMultiplayerPeer.new()
	var err := peer.create_server(PORT)
	if err != OK:
		push_error("Failed to create server: ", err)
		return err
	multiplayer.multiplayer_peer = peer
	print("[Server] Listening on port ", PORT)
	server_created.emit()
	ping_updated.emit(0)
	return OK


func join_game(address: String) -> Error:
	print("[NetworkManager] join_game called with address: ", address)
	peer = WebSocketMultiplayerPeer.new()
	var url := _build_ws_url(address)
	print("[NetworkManager] Built WS URL: ", url)
	if url.is_empty():
		push_error("Failed to build websocket URL from address: ", address)
		return ERR_INVALID_PARAMETER
	var err := peer.create_client(url)
	if err != OK:
		push_error("Failed to connect to ", url, ": ", err)
		return err
	multiplayer.multiplayer_peer = peer
	print("[Client] Connecting to ", url)
	return OK


func _build_ws_url(address: String) -> String:
	var value := address.strip_edges()
	if value.is_empty():
		return ""
	if value.begins_with("ws://") or value.begins_with("wss://"):
		return value
	if value.begins_with("http://"):
		return "ws://" + value.substr(7)
	if value.begins_with("https://"):
		return "wss://" + value.substr(8)
	if value.contains(":"):
		return "ws://" + value
	return "ws://" + value + ":" + str(PORT)


func disconnect_from_game() -> void:
	if peer:
		peer.close()
	multiplayer.multiplayer_peer = null
	peer = null
	_last_packet_time.clear()
	_server_time_offset = 0
	current_ping = 0


func is_server() -> bool:
	return multiplayer.is_server()


func get_my_id() -> int:
	return multiplayer.get_unique_id()


# ── Ping/Pong ────────────────────────────────────────────────────────────────

@rpc("any_peer", "call_remote", "unreliable")
func _rpc_ping(client_timestamp: int) -> void:
	if not multiplayer.is_server():
		return
	var sender := multiplayer.get_remote_sender_id()
	update_last_packet(sender)
	_rpc_pong.rpc_id(sender, client_timestamp, Time.get_ticks_msec())


@rpc("authority", "call_remote", "unreliable")
func _rpc_pong(original_timestamp: int, server_time: int) -> void:
	var rtt_ms := Time.get_ticks_msec() - original_timestamp
	print("[Pong] RTT=", rtt_ms, "ms")
	current_ping = rtt_ms
	# Compute server time offset: server_time was captured mid-flight
	_server_time_offset = server_time + (rtt_ms / 2) - Time.get_ticks_msec()
	ping_updated.emit(rtt_ms)


# ── Connection callbacks ─────────────────────────────────────────────────────

func _on_peer_connected(id: int) -> void:
	print("Peer connected: ", id)
	if multiplayer.is_server():
		_last_packet_time[id] = Time.get_ticks_msec()
	player_connected.emit(id)


func _on_peer_disconnected(id: int) -> void:
	print("Peer disconnected: ", id)
	_last_packet_time.erase(id)
	player_disconnected.emit(id)


func _on_connected_to_server() -> void:
	print("Connected! My ID: ", multiplayer.get_unique_id())
	_ping_timer = 0.0
	joined_server.emit()


func _on_connection_failed() -> void:
	print("Connection failed!")
	connection_failed.emit()


func _on_server_disconnected() -> void:
	print("Server disconnected!")
	multiplayer.multiplayer_peer = null
	peer = null
	_last_packet_time.clear()
