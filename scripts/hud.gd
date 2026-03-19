extends CanvasLayer

@onready var score_box:    VBoxContainer = $ScorePanel/MarginContainer/VBox
@onready var hp_bar:       ProgressBar   = $HPBar
@onready var weapon_label: Label         = $WeaponLabel
@onready var kill_feed:    VBoxContainer = $KillFeed

func _ready() -> void:
	GameManager.player_died.connect(_on_player_died)

func _process(_delta: float) -> void:
	var kart := _find_my_kart()
	if kart:
		hp_bar.value = kart.current_hp
		weapon_label.text = "[ ROCKET ]" if kart.has_weapon else "[ no weapon ]"

func update_scores(_scores: Dictionary) -> void:
	for child in score_box.get_children():
		child.queue_free()

	var header := Label.new()
	header.text = "%-16s  K   D" % "Player"
	header.add_theme_font_size_override("font_size", 13)
	header.add_theme_color_override("font_color", Color.YELLOW)
	score_box.add_child(header)

	for entry in GameManager.get_scores_sorted():
		var lbl := Label.new()
		lbl.text = "%-16s %2d %3d" % [
			entry["data"]["name"],
			entry["data"]["kills"],
			entry["data"]["deaths"]
		]
		lbl.add_theme_font_size_override("font_size", 13)
		score_box.add_child(lbl)

func _on_player_died(victim_id: int, killer_id: int) -> void:
	var victim_name: String = GameManager.players.get(victim_id, {}).get("name", "?")
	var killer_name: String = GameManager.players.get(killer_id, {}).get("name", "?")
	var msg := Label.new()
	if killer_id == victim_id:
		msg.text = "%s blew themselves up" % victim_name
	else:
		msg.text = "%s  killed  %s" % [killer_name, victim_name]
	msg.add_theme_font_size_override("font_size", 14)
	msg.add_theme_color_override("font_color", Color(1, 0.6, 0.2))
	kill_feed.add_child(msg)
	# Remove feed entry after 4 seconds
	get_tree().create_timer(4.0).timeout.connect(msg.queue_free)

func _find_my_kart() -> RigidBody3D:
	var scene := get_tree().current_scene
	if not scene:
		return null
	var karts_node := scene.get_node_or_null("Karts")
	if not karts_node:
		return null
	return karts_node.get_node_or_null(str(multiplayer.get_unique_id())) as RigidBody3D
