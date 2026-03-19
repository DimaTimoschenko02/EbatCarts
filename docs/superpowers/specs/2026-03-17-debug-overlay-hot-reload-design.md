# Debug Overlay + Hot-Reload Parameters

**Date:** 2026-03-17
**Project:** smash-karts-clone
**Goal:** Speed up iteration by making physics values visible on-screen and allowing parameter tuning without restarting Godot.

---

## Problem

Two bottlenecks slow down development:

1. **Communication**: screenshots convey no dynamic information (speed, drift angle, lateral velocity). Describing physics problems in text is imprecise.
2. **Iteration cycle**: every physics or geometry tweak requires restarting the game to test.

---

## Solution Overview

Two independent systems:

1. **Debug HUD Overlay** — in-game display toggled with F3. Shows physics and state values in real time. Screenshots with overlay become precise bug reports.
2. **Hot-Reload Parameter System** — `dev_params.json` file watched by an Autoload. Changes apply immediately without restart. **Desktop editor only** — does not run in HTML5 builds.

---

## Part 1: Debug HUD Overlay

### Toggle
- `F3` key toggles visibility (added to input map as `debug_toggle`)
- Off by default; uses `OS.is_debug_build()` guard so it compiles out of release

### Display layout (top-left corner, monospace Label)

```
[DEBUG]
fwd: 31.4  lat: 8.7  vert: -2.1  drift: 15°
height: 0.21m   angular: 1.8 rad/s   on_floor: YES
HP: 100   weapon: YES   peer: 1 (server)
pos: (12.3, 0.4, -7.1)
```

### Values shown

| Value | Source | Why useful |
|-------|--------|-----------|
| `fwd` m/s | `linear_velocity.dot(-global_transform.basis.z)` | Forward momentum, separate from total speed |
| `lat` m/s | `linear_velocity.dot(global_transform.basis.x)` | Lateral slide — primary drift indicator |
| `vert` m/s | `linear_velocity.y` | Jump/landing detection |
| `drift` degrees | `rad_to_deg(atan2(lat, fwd))` | Intuitive drift angle |
| `height` m | `intersect_ray` downward in `_physics_process` | Ramp/jump debugging |
| `angular` rad/s | `angular_velocity.y` (cached from `_integrate_forces`) | Steering responsiveness |
| `on_floor` | `state.get_contact_count() > 0` (cached in `_integrate_forces`) | Ground detection |
| `HP` | kart `hp` variable | No need to open second window |
| `weapon` | `has_weapon` | Pickup confirmation |
| `peer` | kart reads `multiplayer.get_unique_id()` + `is_server()` | Multiplayer context |
| `pos` | `global_position` rounded to 1 decimal | Geometry alignment |

### Thread safety

`_integrate_forces` runs on the physics thread. **All debug values are cached into plain member variables inside `_integrate_forces` and `DebugOverlay.update(data)` is called from `_physics_process` (main thread).** This avoids modifying Node properties from a background thread.

Variables cached in kart: `_dbg_fwd_vel`, `_dbg_lat_vel`, `_dbg_vert_vel`, `_dbg_angular_y`, `_dbg_on_floor`.

### Implementation

- New Autoload: `scripts/debug_overlay.gd`
- Built entirely in code in `_ready()` — no separate `.tscn` needed (consistent with existing Autoloads in `project.godot`)
- Node hierarchy built in `_ready()`: `self (Node)` → `CanvasLayer` → `Label`
- Kart's `_physics_process` calls `DebugOverlay.update(data: Dictionary)` only for the local player
- `height` computed via `PhysicsRayQueryParameters3D` + `get_world_3d().direct_space_state.intersect_ray()` in `_physics_process` (no `RayCast3D` node needed)
- Collision wireframes are **not included** — they require editor tooling and cannot be toggled at runtime in Godot 4

---

## Part 2: Hot-Reload Parameter System

### Platform constraint
Active only when `OS.is_debug_build() and not OS.has_feature("web")`. The HTML5 export target has no writable filesystem and `FileAccess.get_modified_time()` on `res://` paths returns 0. This system is desktop-editor-only and compiles out in release/HTML5 builds.

### File: `dev_params.json` (project root)

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

Note: `ROCKET_LIFETIME` is initialised to 6.0 to match current `rocket.gd` behaviour.

### Autoload: `scripts/dev_params.gd`

- On `_ready()`: read `dev_params.json`, store `_mtime` (file modification time), emit `params_changed`
- `Timer` fires every 0.5s; compare current `get_modified_time()` to `_mtime`; if changed, re-read and emit
- Signal: `params_changed(data: Dictionary)`
- Guard: entire `_ready()` and timer callback skip if `not OS.is_debug_build() or OS.has_feature("web")`

### Consumer integration

- `kart_controller.gd`: `const` → `var` for all tunable values; connect to `DevParams.params_changed` in `_ready()`
- `rocket.gd`: same pattern for `ROCKET_*` and `DAMAGE` values
- Camera values (FOV, distance, height): updated in `kart_controller.gd` `_process` camera block

### Workflow

1. Game is running in editor
2. Claude edits `dev_params.json` (e.g. `LOW_GRIP: 1.0 → 0.5`)
3. Within 0.5s, kart applies new value — no restart needed
4. User tests immediately, reports result in one line
5. Once values are settled, copy them back to `kart_controller.gd` as final defaults

---

## File Changes

| File | Change |
|------|--------|
| `scripts/debug_overlay.gd` | **New** Autoload — CanvasLayer + Label built in code |
| `scripts/dev_params.gd` | **New** Autoload — file watcher + `params_changed` signal |
| `scripts/kart_controller.gd` | `const` → `var` for tunable values; add `_dbg_*` cache vars; connect to DevParams; call DebugOverlay.update() from `_physics_process`; add `_on_floor` via `state.get_contact_count()` in `_integrate_forces`; height raycast in `_physics_process` |
| `scripts/rocket.gd` | `const` → `var` for ROCKET_SPEED, ROCKET_LIFETIME, EXPLOSION_RADIUS, DAMAGE; connect to DevParams |
| `project.godot` | Register `DebugOverlay` and `DevParams` Autoloads; add `debug_toggle` input action (F3 key) |
| `dev_params.json` | **New** file in project root |

---

## Out of Scope

- Collision wireframe toggle at runtime (requires editor tooling, not available in Godot 4 runtime)
- Network sync of debug values (each client shows own state)
- Saving tuned values back to `dev_params.json` automatically
- GUT unit tests (separate future task)
