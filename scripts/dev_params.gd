extends Node

signal params_changed(data: Dictionary)

const _PATH := "res://dev_params.json"

var _mtime : int        = 0
var _data  : Dictionary = {}

func _ready() -> void:
	if not OS.is_debug_build() or OS.has_feature("web"):
		return
	_load()
	var t := Timer.new()
	t.wait_time = 0.5
	t.autostart  = true
	t.timeout.connect(_poll)
	add_child(t)

func _load() -> void:
	var file := FileAccess.open(_PATH, FileAccess.READ)
	if not file:
		push_warning("DevParams: cannot open " + _PATH)
		return
	var result: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	if result is Dictionary:
		_data  = result
		_mtime = FileAccess.get_modified_time(_PATH)
		params_changed.emit(_data)
	else:
		push_warning("DevParams: JSON parse error in " + _PATH)

func _poll() -> void:
	var t := FileAccess.get_modified_time(_PATH)
	if t != _mtime:
		_load()

func get_param(key: String, default: Variant) -> Variant:
	return _data.get(key, default)
