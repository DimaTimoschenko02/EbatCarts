# Debug Overlay + Hot-Reload Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an F3 debug overlay showing live physics values, and a JSON hot-reload system for tweaking parameters without restarting the game.

**Architecture:** Two new Autoloads (`DevParams`, `DebugOverlay`) are registered in `project.godot`. `DevParams` polls `dev_params.json` every 0.5s and emits `params_changed`. `DebugOverlay` owns a `CanvasLayer + Label` and is updated each `_physics_process` from the local kart. Physics-thread values are cached via `_dbg_*` variables in `_integrate_forces`, then read on the main thread in `_physics_process`.

**Tech Stack:** Godot 4.6, GDScript, `FileAccess.get_modified_time()`, `PhysicsRayQueryParameters3D`

---

## Chunk 1: Autoloads + project.godot

### Task 1: Create `dev_params.json`

**Files:**
- Create: `dev_params.json` (project root)

- [ ] **Step 1: Create `dev_params.json`**

```json
{
  "MAX_SPEED": 35.0,
  "ACCELERATION": 12.0,
  "COAST_DECEL": 8.0,
  "BRAKE_DECEL": 40.0,
  "HIGH_GRIP": 18.0,
  "LOW_GRIP": 1.0,
  "STEERING_SPEED": 2.2,
  "ROCKET_SPEED": 28.0,
  "ROCKET_LIFETIME": 6.0,
  "EXPLOSION_RADIUS": 3.5,
  "DAMAGE": 50,
  "CAMERA_DISTANCE": 7.5,
  "CAMERA_HEIGHT": 3.5,
  "FOV": 75.0
}
```

- [ ] **Step 2: Verify JSON is valid**

Run: `python -m json.tool dev_params.json`
Expected: prints formatted JSON with no error.

---

### Task 2: Create `scripts/dev_params.gd`

**Files:**
- Create: `scripts/dev_params.gd`

- [ ] **Step 1: Create `scripts/dev_params.gd`**

```gdscript
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
	var result := JSON.parse_string(file.get_as_text())
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
```

---

### Task 3: Create `scripts/debug_overlay.gd`

**Files:**
- Create: `scripts/debug_overlay.gd`

- [ ] **Step 1: Create `scripts/debug_overlay.gd`**

```gdscript
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
```

---

### Task 4: Register Autoloads + F3 input in `project.godot`

**Files:**
- Modify: `project.godot`

- [ ] **Step 1: Add Autoloads**

In `project.godot`, find the `[autoload]` section (currently ends after `PlayerData=...`) and add two lines:

```ini
DebugOverlay="*res://scripts/debug_overlay.gd"
DevParams="*res://scripts/dev_params.gd"
```

- [ ] **Step 2: Add `debug_toggle` input action**

In `project.godot`, in the `[input]` section, add after the last action (`fire={...}`):

```ini
debug_toggle={
"deadzone": 0.5,
"events": [Object(InputEventKey,"resource_local_to_scene":false,"resource_name":"","device":-1,"window_id":0,"alt_pressed":false,"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,"pressed":false,"keycode":0,"physical_keycode":4194334,"key_label":0,"unicode":0,"location":0,"echo":false,"script":null)
]
}
```

Note: `physical_keycode=4194334` = F3 key in Godot 4.

- [ ] **Step 3: Validate with Godot headless**

Run: `"C:\Godot_v4.6.1-stable_win64_console.exe" --headless --check-only --quit --path "C:\do_chego_doshel_progress\smash-karts-clone" 2>&1`
Expected: only version line, no errors.

- [ ] **Step 4: Manual smoke-test**

Open game in editor, start it. Open Output panel. `DevParams` should print nothing (or no warnings). F3 should show/hide an empty `[DEBUG]` label. Check Output for any Autoload errors.

---

## Chunk 2: Kart + Rocket integration

### Task 5: Update `kart_controller.gd`

**Files:**
- Modify: `scripts/kart_controller.gd`

- [ ] **Step 1: Change physics constants from `const` to `var`**

Replace the physics constants block at the top of the file:

```gdscript
# ── Физика ───────────────────────────────────────────────────────────────────
var MAX_SPEED      : float = 35.0    # м/с
var ACCELERATION   : float = 12.0   # м/с² — разгон
var BRAKE_DECEL    : float = 40.0   # м/с² — торможение/реверс
var COAST_DECEL    : float = 8.0    # м/с² — накат (газ отпущен)
var STEERING_SPEED : float = 2.2    # рад/с при максимальной скорости
var HIGH_GRIP      : float = 18.0   # боковое сцепление на малой скорости (цепкий)
var LOW_GRIP       : float = 1.0    # боковое сцепление при заносе (скользкий)
```

- [ ] **Step 2: Add debug cache variables**

After the `_mark_timer` line in the visual section, add:

```gdscript
# ── Debug кэш (заполняется в _integrate_forces, читается в _physics_process) ──
var _dbg_fwd_vel  : float = 0.0
var _dbg_lat_vel  : float = 0.0
var _dbg_vert_vel : float = 0.0
var _dbg_angular  : float = 0.0
var _dbg_on_floor : bool  = false
```

- [ ] **Step 3: Cache debug values at the end of `_integrate_forces`**

At the very end of `_integrate_forces` (after the `state.angular_velocity = ...` line), add:

```gdscript
	_dbg_fwd_vel  = new_fwd_vel
	_dbg_lat_vel  = lat_vel
	_dbg_vert_vel = state.linear_velocity.y
	_dbg_angular  = state.angular_velocity.y
	_dbg_on_floor = state.get_contact_count() > 0
```

- [ ] **Step 4: Connect to `DevParams` in `_ready()`**

At the end of `_ready()`, add:

```gdscript
	if OS.is_debug_build() and not OS.has_feature("web"):
		DevParams.params_changed.connect(_on_dev_params_changed)
```

- [ ] **Step 5: Add `_on_dev_params_changed` function**

Add this function after `_ready()`:

```gdscript
func _on_dev_params_changed(data: Dictionary) -> void:
	MAX_SPEED      = data.get("MAX_SPEED",      MAX_SPEED)
	ACCELERATION   = data.get("ACCELERATION",   ACCELERATION)
	COAST_DECEL    = data.get("COAST_DECEL",    COAST_DECEL)
	BRAKE_DECEL    = data.get("BRAKE_DECEL",    BRAKE_DECEL)
	HIGH_GRIP      = data.get("HIGH_GRIP",      HIGH_GRIP)
	LOW_GRIP       = data.get("LOW_GRIP",       LOW_GRIP)
	STEERING_SPEED = data.get("STEERING_SPEED", STEERING_SPEED)
	_cam_offset    = Vector3(0.0,
		data.get("CAMERA_HEIGHT",   _cam_offset.y),
		data.get("CAMERA_DISTANCE", _cam_offset.z))
	if camera:
		camera.fov = data.get("FOV", camera.fov)
```

- [ ] **Step 6: Add DebugOverlay update to `_physics_process`**

In `_physics_process`, after the existing `_try_spawn_smoke(delta)` call, add:

```gdscript
	if OS.is_debug_build() and player_id == multiplayer.get_unique_id():
		var h : float = 0.0
		var space := get_world_3d().direct_space_state
		var query := PhysicsRayQueryParameters3D.create(
			global_position, global_position + Vector3.DOWN * 10.0)
		query.exclude = [get_rid()]
		var hit := space.intersect_ray(query)
		if hit:
			h = global_position.y - (hit.position as Vector3).y
		DebugOverlay.update({
			"fwd":      _dbg_fwd_vel,
			"lat":      _dbg_lat_vel,
			"vert":     _dbg_vert_vel,
			"drift":    rad_to_deg(atan2(absf(_dbg_lat_vel), maxf(absf(_dbg_fwd_vel), 0.1))),
			"height":   h,
			"angular":  _dbg_angular,
			"on_floor": _dbg_on_floor,
			"hp":       current_hp,
			"weapon":   has_weapon,
			"peer_id":  player_id,
			"is_server": multiplayer.is_server(),
			"pos":      global_position,
		})
```

- [ ] **Step 7: Validate — no parse errors**

Run: `"C:\Godot_v4.6.1-stable_win64_console.exe" --headless --check-only --quit --path "C:\do_chego_doshel_progress\smash-karts-clone" 2>&1`
Expected: only version line.

---

### Task 6: Update `rocket.gd`

**Files:**
- Modify: `scripts/rocket.gd`

- [ ] **Step 1: Change rocket constants from `const` to `var`**

Replace the constant block at the top:

```gdscript
var SPEED            : float = 28.0
var DAMAGE           : int   = 50
var EXPLOSION_RADIUS : float = 3.5
var LIFETIME         : float = 6.0
```

- [ ] **Step 2: Connect to `DevParams` in `_ready()`**

At the end of `_ready()`, add:

```gdscript
	if OS.is_debug_build() and not OS.has_feature("web"):
		DevParams.params_changed.connect(_on_dev_params_changed)
```

- [ ] **Step 3: Add `_on_dev_params_changed` function**

Add after `_ready()`:

```gdscript
func _on_dev_params_changed(data: Dictionary) -> void:
	SPEED            = data.get("ROCKET_SPEED",      SPEED)
	DAMAGE           = data.get("DAMAGE",             DAMAGE)
	EXPLOSION_RADIUS = data.get("EXPLOSION_RADIUS",   EXPLOSION_RADIUS)
	LIFETIME         = data.get("ROCKET_LIFETIME",    LIFETIME)
```

- [ ] **Step 4: Final validation**

Run: `"C:\Godot_v4.6.1-stable_win64_console.exe" --headless --check-only --quit --path "C:\do_chego_doshel_progress\smash-karts-clone" 2>&1`
Expected: only version line, no errors.

- [ ] **Step 5: Manual end-to-end test**

1. Start game in editor
2. Press F3 — overlay appears with zeroed values
3. Press W — values update: `fwd` grows, `on_floor: YES`
4. Turn at speed — `lat` grows, `drift` angle increases
5. While game runs, change `LOW_GRIP` in `dev_params.json` from `1.0` to `0.3` and save
6. Within 1 second, kart should feel noticeably more slidey
7. Change it back to `1.0` — kart recovers normal grip
