extends Node

var _visible : bool         = false
var _canvas  : CanvasLayer
var _label   : Label

func _ready() -> void:
	if not OS.is_debug_build():
		return
	_canvas = CanvasLayer.new()
	_canvas.layer = 10
	add_child(_canvas)

	_label = Label.new()
	_label.position = Vector2(10, 10)
	_label.add_theme_font_size_override("font_size", 14)
	_label.add_theme_color_override("font_color", Color.WHITE)
	_label.add_theme_color_override("font_shadow_color", Color.BLACK)
	_label.add_theme_constant_override("shadow_offset_x", 1)
	_label.add_theme_constant_override("shadow_offset_y", 1)
	_canvas.add_child(_label)
	_canvas.hide()

func _unhandled_input(event: InputEvent) -> void:
	if not OS.is_debug_build():
		return
	if event.is_action_pressed("debug_toggle"):
		_visible = not _visible
		if _visible:
			_canvas.show()
		else:
			_canvas.hide()

func update(data: Dictionary) -> void:
	if not _visible or not _label:
		return
	var pos : Vector3 = data.get("pos", Vector3.ZERO)
	_label.text = (
		"[DEBUG]\n"
		+ "fwd: %.1f  lat: %.1f  vert: %.1f  drift: %.0f°\n" % [
			data.get("fwd",   0.0),
			data.get("lat",   0.0),
			data.get("vert",  0.0),
			data.get("drift", 0.0),
		]
		+ "height: %.2fm   angular: %.2f rad/s   on_floor: %s\n" % [
			data.get("height",   0.0),
			data.get("angular",  0.0),
			"YES" if data.get("on_floor", false) else "NO",
		]
		+ "HP: %d   weapon: %s   peer: %d (%s)\n" % [
			data.get("hp",     0),
			"YES" if data.get("weapon", false) else "NO",
			data.get("peer_id", 0),
			"server" if data.get("is_server", false) else "client",
		]
		+ "pos: (%.1f, %.1f, %.1f)" % [pos.x, pos.y, pos.z]
	)
