extends Node

signal server_created
signal joined_server
signal connection_failed
signal player_connected(peer_id: int)
signal player_disconnected(peer_id: int)

const PORT := 4444

var peer: WebSocketMultiplayerPeer = null

func _ready() -> void:
	multiplayer.peer_connected.connect(_on_peer_connected)
	multiplayer.peer_disconnected.connect(_on_peer_disconnected)
	multiplayer.connected_to_server.connect(_on_connected_to_server)
	multiplayer.connection_failed.connect(_on_connection_failed)
	multiplayer.server_disconnected.connect(_on_server_disconnected)

func host_game() -> Error:
	peer = WebSocketMultiplayerPeer.new()
	var err := peer.create_server(PORT)
	if err != OK:
		push_error("Failed to create server: ", err)
		return err
	multiplayer.multiplayer_peer = peer
	print("[Server] Listening on port ", PORT)
	server_created.emit()
	return OK

func join_game(address: String) -> Error:
	peer = WebSocketMultiplayerPeer.new()
	var url := "ws://" + address + ":" + str(PORT)
	var err := peer.create_client(url)
	if err != OK:
		push_error("Failed to connect to ", url, ": ", err)
		return err
	multiplayer.multiplayer_peer = peer
	print("[Client] Connecting to ", url)
	return OK

func disconnect_from_game() -> void:
	if peer:
		peer.close()
	multiplayer.multiplayer_peer = null
	peer = null

func is_server() -> bool:
	return multiplayer.is_server()

func get_my_id() -> int:
	return multiplayer.get_unique_id()

func _on_peer_connected(id: int) -> void:
	print("Peer connected: ", id)
	player_connected.emit(id)

func _on_peer_disconnected(id: int) -> void:
	print("Peer disconnected: ", id)
	player_disconnected.emit(id)

func _on_connected_to_server() -> void:
	print("Connected! My ID: ", multiplayer.get_unique_id())
	joined_server.emit()

func _on_connection_failed() -> void:
	print("Connection failed!")
	connection_failed.emit()

func _on_server_disconnected() -> void:
	print("Server disconnected!")
	multiplayer.multiplayer_peer = null
	peer = null
