extends Node

signal scores_updated(scores: Dictionary)
signal player_died(victim_id: int, killer_id: int)
signal player_respawned(player_id: int)

# { player_id: { name, kills, deaths, hp } }
var players: Dictionary = {}

const MAX_HP := 100
const RESPAWN_DELAY := 3.0

func register_player(player_id: int, player_name: String) -> void:
	players[player_id] = {
		"name": player_name,
		"kills": 0,
		"deaths": 0,
		"hp": MAX_HP
	}
	print("Registered: ", player_name, " (id=", player_id, ")")

func unregister_player(player_id: int) -> void:
	players.erase(player_id)

func deal_damage(victim_id: int, attacker_id: int, damage: int) -> void:
	if not multiplayer.is_server():
		return
	if victim_id not in players:
		return
	players[victim_id]["hp"] -= damage
	if players[victim_id]["hp"] <= 0:
		players[victim_id]["hp"] = 0
		_process_kill(victim_id, attacker_id)

func _process_kill(victim_id: int, killer_id: int) -> void:
	if victim_id in players:
		players[victim_id]["deaths"] += 1
	if killer_id in players and killer_id != victim_id:
		players[killer_id]["kills"] += 1
	_rpc_kill.rpc(victim_id, killer_id, players)
	get_tree().create_timer(RESPAWN_DELAY).timeout.connect(
		func(): _do_respawn(victim_id)
	)

@rpc("authority", "call_local", "reliable")
func _rpc_kill(victim_id: int, killer_id: int, new_scores: Dictionary) -> void:
	players = new_scores
	player_died.emit(victim_id, killer_id)
	scores_updated.emit(players)

func _do_respawn(player_id: int) -> void:
	if not multiplayer.is_server():
		return
	if player_id not in players:
		return
	players[player_id]["hp"] = MAX_HP
	_rpc_respawn.rpc(player_id, players)

@rpc("authority", "call_local", "reliable")
func _rpc_respawn(player_id: int, new_scores: Dictionary) -> void:
	players = new_scores
	player_respawned.emit(player_id)
	scores_updated.emit(players)

func get_scores_sorted() -> Array:
	var arr := []
	for pid in players:
		arr.append({"id": pid, "data": players[pid]})
	arr.sort_custom(func(a, b): return a["data"]["kills"] > b["data"]["kills"])
	return arr
