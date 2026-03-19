extends Control

@onready var name_input:   LineEdit = $VBox/NameRow/NameInput
@onready var ip_input:     LineEdit = $VBox/JoinRow/IPInput
@onready var status_label: Label    = $VBox/StatusLabel
@onready var host_btn:     Button   = $VBox/HostRow/HostBtn
@onready var join_btn:     Button   = $VBox/JoinRow/JoinBtn

func _ready() -> void:
	NetworkManager.server_created.connect(_on_server_created)
	NetworkManager.joined_server.connect(_on_joined_server)
	NetworkManager.connection_failed.connect(_on_connection_failed)
	ip_input.text = "127.0.0.1"

func _on_host_pressed() -> void:
	var pname := name_input.text.strip_edges()
	if pname.is_empty():
		status_label.text = "Enter your name!"
		return
	PlayerData.my_name = pname
	_set_buttons(false)
	status_label.text = "Starting server…"
	var err := NetworkManager.host_game()
	if err != OK:
		status_label.text = "Could not start server (port %d in use?)" % NetworkManager.PORT
		_set_buttons(true)

func _on_join_pressed() -> void:
	var pname := name_input.text.strip_edges()
	if pname.is_empty():
		status_label.text = "Enter your name!"
		return
	var ip := ip_input.text.strip_edges()
	if ip.is_empty():
		status_label.text = "Enter server IP!"
		return
	PlayerData.my_name = pname
	_set_buttons(false)
	status_label.text = "Connecting to %s…" % ip
	var err := NetworkManager.join_game(ip)
	if err != OK:
		status_label.text = "Failed to initiate connection!"
		_set_buttons(true)

func _on_server_created() -> void:
	status_label.text = "Server ready – loading game…"
	get_tree().change_scene_to_file("res://scenes/game.tscn")

func _on_joined_server() -> void:
	status_label.text = "Connected! Loading game…"
	get_tree().change_scene_to_file("res://scenes/game.tscn")

func _on_connection_failed() -> void:
	status_label.text = "Connection failed. Check IP and try again."
	_set_buttons(true)

func _set_buttons(enabled: bool) -> void:
	host_btn.disabled = not enabled
	join_btn.disabled = not enabled
