extends Node3D

var _muzzle: Marker3D
var _missile_visual: Node3D

func _ready() -> void:
	_muzzle = $Muzzle
	_missile_visual = $Muzzle/MissileVisual

func launch() -> void:
	if not _missile_visual:
		return
	_missile_visual.show()
	_missile_visual.scale = Vector3.ONE
	_missile_visual.position = Vector3.ZERO

	var tween := create_tween()
	tween.set_parallel(true)
	tween.tween_property(_missile_visual, "position:z", 0.8, 0.18)
	tween.tween_property(_missile_visual, "scale", Vector3(0.3, 0.3, 0.3), 0.18)
	tween.chain().tween_callback(_missile_visual.hide)
