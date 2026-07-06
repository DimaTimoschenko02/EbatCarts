---
status: draft
version: "3.2-overlay"
date: 2026-04-30
parent: kart-physics.md
---

# v3.2 Thermal Fade Overlay

> **Status**: Draft — all 8 sections complete, pending merge review.
> **Author**: Dima + systems-designer
> **Date**: 2026-04-30
> **Merge target**: `design/gdd/kart-physics.md` after all sections approved

---

## Overview

v3.2 adds a single time-decaying overlay on top of the existing rear-grip multiplier computed in `drift_state_machine.gd`. The problem it solves: after `_engage_factor` saturates to 1.0 (~1 second after drift activation), all drift outputs become flat constants — `rear_grip_multiplier = 0.25`, `yaw_bonus = const`, `forward_assist = 0`. With every term constant, angular velocity `omega` and forward speed both plateau, giving `r = v/omega ≈ const` — a perfect circle from the instant drift activates. Players describe this as "driving straight then suddenly going in a circle" with no inertia, no arc evolution. The fix hooks into `_active_timer` (already tracked in `drift_state_machine.gd` line 122, reset on every new ACTIVE state entry) and multiplies `base_mult` by a factor `(1.0 - PEAK * exp(-t / TAU))` that starts below 1.0 at `t=0` and recovers to 1.0 asymptotically. Lower multiplier at entry = more rear slip = wider arc radius.

This overlay does NOT change: the bicycle physics tire-force math in `bicycle_physics.gd`, the `yaw_bonus` formula, `forward_assist`, `_engage_factor` envelope shape, or any v3.0/v3.1.x visual smoothing logic. It is a pure multiplicative layer inserted at one point in `drift_state_machine.gd::update()`. At `t > 5*TAU` (approximately 4 seconds at default `TAU=0.8`) `exp(-t/TAU) < 0.007`, making the factor indistinguishable from 1.0 — byte-identical behavior to pre-v3.2. The resulting trajectory shape: **wide arc on entry that tightens to the steady-state constant-radius circle over approximately 3*TAU seconds**.

---

## Player Fantasy

Before v3.2, the kart's drift path snapped to a fixed-radius circle the moment `_engage_factor` reached saturation — roughly one second after initiating a drift. The steering felt like a light-switch: straight, then circle, with nothing in between. This contradicted the core Player Fantasy from the main GDD (line 88): "машина тяжёлая — у неё масса и угловая инерция, которые чувствуются" — a heavy, drifty kart that resists sudden state changes.

v3.2 restores the missing inertia of the arc itself. On drift entry rear tires have reduced grip, so the kart's body continues on a wide sweeping path while the heading slowly rotates. The circle is not gone — it emerges gradually as tires recover grip over the next ~2-3 seconds. This matches the SmashKarts.io reference feel (main GDD line 15) where the kart visibly "finds its circle" from a looser initial arc, not arriving in it instantaneously.

Three concrete moments the player will notice:

**Entry on a long straight**: The player initiates drift at full speed. For the first 0.5-1 seconds the kart takes a wide sweeping line — they can see the rear step out broadly before the arc tightens. The kart feels like it has momentum that needs to be overcome, not like it teleported onto a circular track.

**Tight chicane between obstacles**: Threading a gap requires the player to consider that the arc will be widest immediately after drift activation. Initiating drift slightly before the obstacle (not at it) lets the wide-entry phase carry the kart through, with the tighter steady-state arc arriving just in time for the next obstacle. This adds a timing dimension that was absent when the circle appeared instantly.

**Prolonged corner (holding drift for 3+ seconds)**: The arc tightens progressively and then stabilizes. The player can feel the transition from "sliding wide" to "settled into a groove" — the same tactile signature the main GDD describes as "зад тянет наружу" before the machine finds its line.

---

## Detailed Rules

### Hook location

The overlay is inserted in `scripts/physics/drift_state_machine.gd::update()`, immediately after
line 174:

```gdscript
var base_mult: float = lerp(1.0, _params.drift_rear_grip_mult, _engage_factor)
```

The two lines that follow (lines 175-176) compute the exit snap-grip overlay and compose the final
`rear_grip_mult`. The thermal fade modification goes between lines 174 and 175 — it modifies
`base_mult` in place before the exit overlay is applied:

```gdscript
# v3.2 Thermal Fade: rear tire grip is reduced at ACTIVE entry, recovers to
# baseline over drift_grip_release_tau seconds. Produces wide initial arc
# that tightens to the steady-state circle. At t >> 5*TAU degrades to
# byte-identical pre-v3.2 behavior.
var release_factor: float = 1.0 - _params.drift_grip_release_peak * exp(-_active_timer / maxf(_params.drift_grip_release_tau, 0.05))
base_mult *= release_factor
base_mult = maxf(base_mult, 0.05)
```

The remaining lines (exit snap-grip overlay, `rear_grip_mult` composition) are unchanged.

### Behavior per state

**IDLE**: `_active_timer` is 0 (cleared at line 143 on IDLE entry from EXITING). The SM returns
`_idle_output()` which hard-returns `rear_grip_multiplier: 1.0` — the `base_mult` calculation
on line 174 is never reached. Thermal fade has no effect.

**ARMING**: `_engage_factor` is ramping up but `_active_timer` is 0 (not yet reset — it remains
at its previous value from the last EXITING-to-IDLE transition, which cleared it to 0 at line 143).
Crucially, the SM transitions ARMING → ACTIVE at line 121 and resets `_active_timer = 0.0` at
line 122 before any `update()` call executes the line-174 block with ACTIVE semantics. So on the
first frame of ACTIVE, `_active_timer` is 0. The ARMING state itself never sets `base_mult` in the
drift dictionary — it falls through to the shared computation block, but `_engage_factor` is
low enough that `base_mult` is still near 1.0. Thermal fade is negligible here in practice.

**ACTIVE**: Full effect. `_active_timer` increments each frame (`_active_timer += delta` at
line 136, inside the `State.ACTIVE` branch). At entry t=0, `release_factor = 1 - PEAK`, so
`base_mult` is compressed to `(1 - PEAK) * drift_rear_grip_mult * engage_factor`. With PEAK=0.6,
`drift_rear_grip_mult=0.35`, `_engage_factor` fully saturated: `base_mult = 0.4 * 0.35 = 0.14`.
This recovers asymptotically toward `0.35 * engage_factor` over ~3*TAU seconds.

**EXITING**: `_active_timer` is NOT incremented in EXITING (line 136 is inside the
`State.ACTIVE` match arm — the EXITING arm only increments `_exit_timer`). The timer freezes
at whatever value it held at the moment ACTIVE ended. If the drift was long (t >> TAU),
`release_factor` ≈ 1.0, so the thermal fade has no effect during EXITING — `base_mult` is
near baseline before the exit snap-grip overlay is applied on top. If the drift was very short
(t < TAU), `release_factor < 1.0` during EXITING, meaning the kart exits drift with still-reduced
base grip. The exit snap-grip overlay (`_recovery_factor` term) still fires normally on top,
so the net effect is that exit snap-back remains strong.

### Clamp rule

`base_mult = maxf(base_mult, 0.05)` is applied after the thermal fade multiply, before
`base_mult` is consumed by the exit snap-grip overlay composition on line 175. The minimum 0.05
ensures rear grip never reaches zero regardless of PEAK value or formula inputs. At zero grip
the tire force in `bicycle_physics.gd` evaluates to exactly 0 N, leaving residual lateral
velocity uncontrolled; at PEAK > 1.0 (out of spec) the expression `1 - PEAK * exp(0)` goes
negative without this clamp, which would invert the tire force sign.

### Re-entry semantics

Every new ACTIVE state entry (whether from a fresh drift or from re-entering after EXITING)
resets `_active_timer = 0.0` at line 122 unconditionally. The thermal fade wide-entry phase
is therefore fresh for every activation. There is no "warm tire" memory across drift
re-engagements. This is intentional: each initiation is a new event from the player's
perspective.

### Order of operations

```
base_mult  ←  lerp(1.0, drift_rear_grip_mult, engage_factor)    [line 174]
base_mult  ←  base_mult * release_factor(t)                     [v3.2 addition]
base_mult  ←  maxf(base_mult, 0.05)                             [clamp]
overlay    ←  (drift_exit_grip_mult - 1.0) * _recovery_factor   [line 175, unchanged]
rear_grip_mult  ←  base_mult + overlay                          [line 176, unchanged]
inp.rear_grip_multiplier  ←  rear_grip_mult                     [caller, unchanged]
```

The clamp applies only to the thermal-fade-modified `base_mult`. The exit snap-grip overlay
is added on top afterward, which can push `rear_grip_mult` above 1.0 during recovery — this is
correct pre-v3.2 behavior and is unchanged.

---

## Formulas

### Core overlay formula

```
release_factor(t) = 1.0 - PEAK * exp(-t / TAU)
base_mult_final   = max(0.05, base_mult_pre * release_factor(t))
```

**Variable definitions:**

| Symbol | Code name | Type | Range | Description |
|--------|-----------|------|-------|-------------|
| `t` | `_active_timer` | float (s) | [0, ∞) | Seconds elapsed since last ACTIVE state entry; reset to 0.0 at each ACTIVE entry (line 122) |
| `PEAK` | `drift_grip_release_peak` | float | [0.0, 0.9] | Fraction of base grip removed at t=0. 0 = no overlay (pre-v3.2). 0.9 = maximum safe release (clamp may activate). |
| `TAU` | `drift_grip_release_tau` | float (s) | [0.3, 2.0] | Time constant of exponential recovery. At t=TAU, exp term has decayed to 1/e ≈ 0.368 of its initial value. Inner `maxf(TAU, 0.05)` prevents division by zero. |
| `base_mult_pre` | `base_mult` before overlay | float | (0, 1] | Output of `lerp(1.0, drift_rear_grip_mult, _engage_factor)`. At full saturation (engage=1.0): equals `drift_rear_grip_mult`. |
| `base_mult_final` | `base_mult` after overlay | float | [0.05, 1] | Clamped result fed into exit snap-grip composition. |

**Why this formula direction.** In `bicycle_physics.gd`, the rear tire produces lateral force
`f_rear = -rear_grip_eff * tanh(v_lat_rear / sat) * sat` where `rear_grip_eff = REAR_GRIP * inp.rear_grip_multiplier`. Lower multiplier → lower restoring force → rear lateral velocity persists longer each tick → kart takes a wider arc. To achieve **wide arc on entry, tightening to steady-state circle**, we need `base_mult` to be at its minimum at t=0 and recover toward its baseline. The factor `(1 - PEAK * exp(-t/TAU))` starts at `(1 - PEAK)` and recovers to 1, so multiplication decreases `base_mult` at entry and allows it to recover — correct direction. The previously proposed `(1 + PEAK * exp)` form increases `base_mult` at entry (more grip = tighter arc = opposite of intent) and was incorrect.

### Worked examples

Parameters: PEAK=0.6, TAU=0.8 s, `drift_rear_grip_mult`=0.35, `_engage_factor`=1.0

Therefore `base_mult_pre` = `lerp(1.0, 0.35, 1.0)` = **0.35** at full saturation.

| t (s) | exp(-t/0.8) | release_factor | base_mult_final | Arc behavior |
|-------|-------------|----------------|-----------------|--------------|
| 0.0 | 1.000 | 0.400 | max(0.05, 0.35 × 0.400) = **0.140** | Widest arc — rear steps out broadly |
| 0.4 | 0.607 | 0.636 | 0.35 × 0.636 = **0.223** | Arc visibly tightening |
| 0.8 (=TAU) | 0.368 | 0.779 | 0.35 × 0.779 = **0.273** | Mid recovery — arc still slightly wide |
| 1.6 (=2×TAU) | 0.135 | 0.919 | 0.35 × 0.919 = **0.322** | Near steady-state |
| 4.0 (=5×TAU) | 0.007 | 0.996 | 0.35 × 0.996 = **0.349** | Indistinguishable from pre-v3.2 (0.35) |

Note: the prompt's worked examples used `drift_rear_grip_mult=0.25`. The actual default in
`kart_physics_resource.gd` is **0.35**. All values above use the real default. The formula is
identical; only the magnitude of `base_mult_pre` differs.

### Boundary example: PEAK=0.9 at t=0

```
release_factor = 1 - 0.9 * exp(0) = 1 - 0.9 = 0.10
base_mult_pre  = 0.35  (at engage=1.0)
base_mult raw  = 0.35 * 0.10 = 0.035
base_mult_final = max(0.05, 0.035) = 0.05   ← clamp activates
```

Tire force is at its minimum but nonzero. Kart is loose but does not spin out uncontrollably.

### TAU zero-guard

Inside the formula: `maxf(_params.drift_grip_release_tau, 0.05)`. This is evaluated each frame.
If a tuner sets TAU to 0 in `dev_params.json` mid-session, the divisor becomes 0.05 rather than
0, and the overlay decays extremely fast — effectively pre-v3.2 behavior within one frame.
No crash, no NaN.

---

## Edge Cases

**PEAK > 0.9 (out of safe range)**
`release_factor` at t=0 evaluates to `1 - PEAK`, which goes below 0.1 and may go negative if
PEAK > 1.0. The `maxf(base_mult, 0.05)` clamp prevents negative values from reaching
`bicycle_physics.gd`. At PEAK=1.0 exactly: `raw = 0.35 * 0 = 0`, clamped to 0.05 — kart is
very loose but tire force does not flip sign. At PEAK=1.5: `raw = 0.35 * (-0.5) = -0.175`,
clamped to 0.05 — same outcome. Clamped floor guarantees the worst case is "kart enters wide arc
as if on ice" rather than "kart spins uncontrollably due to inverted force". The inspector `@export`
in `KartPhysicsResource` does not enforce [0,0.9] at runtime; enforcement is documentation and
`param_tuner.html` slider limits only.

**TAU < 0.05 s (out of safe range)**
Inner `maxf(_params.drift_grip_release_tau, 0.05)` clamps the divisor. At TAU=0.01 (mistyped),
effective TAU becomes 0.05 s. The overlay decays to exp(-1) ≈ 37% of initial within 0.05 s,
and to < 1% within 0.25 s. Result: wide-entry phase is imperceptible (sub-frame on 60 Hz).
Behavior is effectively pre-v3.2. No crash.

**Very short drift (player initiates then releases within 0.2 s)**
`_active_timer` reaches ~0.2 s before SM transitions to EXITING. At PEAK=0.6, TAU=0.8:
`release_factor(0.2) = 1 - 0.6 * exp(-0.25) = 1 - 0.6 * 0.779 = 0.532`. The arc is still
notably wide when the kart exits drift. It never resolves into a circle. This is acceptable —
short taps are intended to produce quick slides, not full circles. The wide-entry phase simply
defines the shape of a short tap too.

**Rapid re-engagement (release + re-enter within 0.5 s)**
Each ACTIVE entry unconditionally resets `_active_timer = 0.0` at line 122. Re-engaging produces
a fresh wide-entry phase. A player who repeatedly taps steer at the entry threshold can keep
triggering new thermal fade cycles. In theory this keeps the kart perpetually wide. In practice:
the ARMING state requires `drift_enter_debounce = 0.12 s` of held conditions, and exit requires
`drift_exit_steer < 0.35` — a fast tap-tap cycle through the hysteresis band is physically
constrained by these timers. The minimum cycle time is approximately `exit_duration (0.3s) +
enter_debounce (0.12s) = 0.42 s`, which is itself nearly `0.5 * TAU`. The wide-entry phase will
partially overlap the new entry, but this is detectable in play only with deliberate exploit
attempts, not normal cornering.

**Drift held longer than 5×TAU (>4 s at defaults)**
`exp(-5) ≈ 0.0067`, so `release_factor ≈ 1 - 0.6 * 0.0067 = 0.996`. `base_mult_final ≈
0.35 * 0.996 = 0.349`. Difference from pre-v3.2: 0.001 — below any perceptible threshold.
Arc behavior is identical to v3.1.x for sustained drifts. This is the backward-compatibility
guarantee: long-held drifts do not change.

**Hot-reload of PEAK or TAU mid-drift via dev_params.json**
`drift_state_machine.gd` holds a reference `_params: KartPhysicsResource`. When
`kart_controller.gd::_on_dev_params_changed` fires, it writes new values directly into the
same resource object that `_params` points to. New PEAK and TAU take effect on the very next
`update()` call. `_active_timer` is NOT reset — the overlay "snaps" to the new curve at the
current t value. For example: if the player is 1.0 s into a drift and the tuner raises PEAK from
0.6 to 0.8, `release_factor` instantly changes from 0.634 to 0.507, pulling `base_mult` lower.
The kart briefly feels looser. This snap is a known artifact of hot-reload; it only occurs in
dev mode and does not affect shipped builds.

**Floating-point underflow in `exp(-t/TAU)`**
IEEE 754 double underflows `exp` to 0.0 at argument ≈ −745. With TAU=0.3 (minimum safe), this
requires t ≈ 0.3 × 745 ≈ 223 s of continuous ACTIVE drift — impossible in any match. At float
precision (single), underflow at argument ≈ −87.3 requires t ≈ 26 s. Still well beyond any
plausible drift duration. `release_factor` evaluating to 1.0 in this case is safe: `base_mult`
returns to steady-state baseline, which is the intended asymptote.

---

## Dependencies

### Reads from

| Source | Field / variable | Where defined |
|--------|-----------------|---------------|
| `KartPhysicsResource` | `drift_grip_release_peak` | New field — added in this version |
| `KartPhysicsResource` | `drift_grip_release_tau` | New field — added in this version |
| `DriftStateMachine` | `_active_timer` | Existing — line 24, reset at line 122 |
| `DriftStateMachine` | `_engage_factor` | Existing — line 27 |
| `KartPhysicsResource` | `drift_rear_grip_mult` | Existing — consumed as input to `lerp()` on line 174 |

### Writes to

`base_mult` (local variable, `drift_state_machine.gd::update()`) → flows into `rear_grip_mult`
→ written into the returned Dictionary as `"rear_grip_multiplier"` → consumed by
`kart_controller.gd` → passed as `inp.rear_grip_multiplier` to `bicycle_physics.gd::step()`.

### Files modified

| File | Change |
|------|--------|
| `scripts/kart_physics_resource.gd` | Add 2 `@export` fields in new `@export_group("Drift Thermal Fade v3.2 (wide-entry overlay)")` |
| `resources/kart_physics_default.tres` | Add the 2 keys: `drift_grip_release_peak = 0.6`, `drift_grip_release_tau = 0.8` |
| `scripts/physics/drift_state_machine.gd` | Insert 3 lines after line 174 (release_factor computation, multiply, clamp) |
| `scripts/kart_controller.gd` | `_on_dev_params_changed`: add reads for `DRIFT_GRIP_RELEASE_PEAK` and `DRIFT_GRIP_RELEASE_TAU` from `dev_params.json` |
| `dev_params.json` | Add 2 keys with `_*` description comments per `.claude/rules/param-tuner-descriptions.md` |
| `tools/param_tuner.html` | Add 2 entries to PARAMS dict with slider ranges, Russian descriptions |
| `tests/test_drift_state_machine.gd` | Adjust `test_rear_grip_multiplier_only_in_active` (see Acceptance Criteria); add `test_thermal_fade_widens_entry` and `test_thermal_fade_recovers` |

### Files NOT modified

- `scripts/physics/bicycle_physics.gd` — tire force math is unchanged; the overlay operates
  purely on the multiplier fed in, not on the physics internals.
- `scripts/physics/physics_input.gd` / `physics_state.gd` — the `inp.rear_grip_multiplier`
  field already exists; contract is unchanged.
- `scripts/camera_rig.gd` — no camera behavior change.
- `scripts/debug_wheel_trails.gd` — no trail behavior change; thermal fade affects physics
  radius only, not trail recording logic.

### Bicycle physics interaction (detail)

In `bicycle_physics.gd::step()`:

```gdscript
var rear_grip_eff: float = REAR_GRIP * inp.rear_grip_multiplier
var f_rear: float = -rear_grip_eff * tanh(v_lat_rear / sat) * sat
```

The thermal fade reduces `inp.rear_grip_multiplier` at drift entry. Lower `rear_grip_eff` →
lower `f_rear` magnitude → rear lateral velocity `v_lat_rear` decays less per tick → larger
steady-state lateral speed → wider turning radius via `r = v_forward / omega`. The connection
is through the nonlinear `tanh` saturation: in the linear region (small `v_lat_rear`) the
relationship is proportional; as grip drops toward 0.05, the tire effectively saturates at a
much lower force ceiling.

### Reverse dependency note

`kart-physics.md` (parent document, Drift State Machine section) must be updated to reference
this overlay when v3.2 is merged: the rear-grip multiplier formula is no longer just
`lerp(1.0, drift_rear_grip_mult, engage)` but includes the thermal fade layer.

---

## Tuning Knobs

### `drift_grip_release_peak`

| Property | Value |
|----------|-------|
| Default | 0.6 |
| Safe range | [0.0, 0.9] |
| Unit | dimensionless fraction |
| Hot-reloadable | Yes, via `dev_params.json` key `DRIFT_GRIP_RELEASE_PEAK` |

Controls how much rear grip is removed at the instant drift activates (t=0). A value of 0.0
disables the overlay entirely — backward-compatible with v3.1.x behavior. Each increment
increases how far the kart's rear steps out at entry before recovering.

| Value | t=0 release_factor | base_mult at t=0 (engage=1) | Arc entry feel |
|-------|--------------------|-----------------------------|----------------|
| 0.0 | 1.000 | 0.35 | No overlay — identical to v3.1.x |
| 0.3 | 0.700 | 0.245 | Subtle widening; rear barely steps out further than v3.1.x |
| 0.6 | 0.400 | 0.140 | Noticeable wide-entry arc — **recommended starting point** |
| 0.9 | 0.100 | 0.035 → clamped to 0.05 | Near-maximum looseness; clamp activates at t=0 |

**When to raise PEAK**: the drift arc feels similar to pre-v3.2 at entry (no visible sweep before
circle). Raise toward 0.9 for more dramatic initial step-out.

**When to lower PEAK**: the entry feels uncontrollable — kart steps out so far it risks hitting
walls before arc resolves. Lower toward 0.3 to preserve the shape change while moderating
severity.

**Upper safety limit** is 0.9. Above this the clamp at 0.05 activates and feel becomes
inconsistent — initial arc is identical regardless of further PEAK increases.

---

### `drift_grip_release_tau`

| Property | Value |
|----------|-------|
| Default | 0.8 s |
| Safe range | [0.3, 2.0] s |
| Unit | seconds |
| Hot-reloadable | Yes, via `dev_params.json` key `DRIFT_GRIP_RELEASE_TAU` |

Controls how long the wide-entry phase lasts. Specifically: `3*TAU` is approximately the time
at which the arc is 95% recovered toward steady-state radius. A player making a corner of
normal match duration (~1.5-3 s) will experience the full arc evolution at default TAU.

| Value | 3×TAU (95% recovery) | Feel |
|-------|----------------------|------|
| 0.3 s | ~0.9 s | Fast snap — wide entry is brief, circle arrives quickly |
| 0.8 s | ~2.4 s | **Recommended starting point** — full arc evolution within a typical corner |
| 1.5 s | ~4.5 s | Long evolving arc; kart sweeps wide for several seconds |
| 2.0 s | ~6.0 s | Very long evolution; steady-state circle may never appear in a single corner |

**When to raise TAU**: the arc tightens faster than it feels natural — the circle "snaps in" too
quickly after the wide entry. Raise to give the evolution more breathing room.

**When to lower TAU**: drift never settles into a recognizable repeating circle during
match-length corners; the kart feels perpetually in-transition. Lower toward 0.5 to bring
steady-state circle within the first second of drift.

---

### Tuning recipe

Start with PEAK=0.6, TAU=0.8 (defaults). This is the reference feel the system was designed
around.

- Wide entry not noticeable enough → raise PEAK toward 0.9 first (stronger effect at same arc
  length).
- Entry too violent (kart undershoots exit of turn) → lower PEAK toward 0.3.
- Arc never settles / feels "muddy" → lower TAU toward 0.5.
- Circle arrives too abruptly after entry → raise TAU toward 1.2.
- Disable entirely for comparison → set PEAK=0.0 (TAU is irrelevant at PEAK=0).

---

## Acceptance Criteria

### Automated tests (`tests/test_drift_state_machine.gd`)

- [ ] **`test_rear_grip_multiplier_only_in_active` adjusted**: the assertion that
  `rear_grip_multiplier ≈ 0.35` must wait until `_active_timer > 5 * TAU = 4.0 s` (≈240 frames
  at 60 Hz) before asserting `|mult - 0.35| < 0.02`. The current test at line 161 runs only
  120 frames (~2 s), which with the thermal fade active would yield `mult ≈ 0.32` — a false
  failure. Update the loop count to 300 frames (5.0 s) and update the assertion comment.

- [ ] **New `test_thermal_fade_widens_entry`**: arrange with PEAK=0.6, TAU=0.8 added to params.
  Drive SM to ACTIVE (past debounce). On the very first ACTIVE frame (or within the first
  0.05 s), assert `rear_grip_multiplier < 0.20`. At engage_factor≈1.0 and t≈0, expected value
  is 0.14; tolerance is generous (`< 0.20`) to account for the engage envelope not yet fully
  saturated.

- [ ] **New `test_thermal_fade_recovers`**: same params. Advance time to t=4.0 s in ACTIVE
  (240 frames at 1/60 delta). Assert `|rear_grip_multiplier - 0.35| < 0.01` — overlay has
  decayed to < 0.4% of original effect.

- [ ] **`test_rear_grip_multiplier_only_in_active` mid-ramp sanity check** (lines 167-173):
  This sub-check uses a fresh SM with 20 frames (~0.33 s) and asserts
  `0.40 < mult < 0.95`. With thermal fade at t≈0.33 s, PEAK=0.6, TAU=0.8:
  `factor = 1 - 0.6 * exp(-0.41) = 0.602`, `mult ≈ 0.35 * 0.602 * engage`. Since engage is
  not yet saturated (~0.78 at 0.33 s), `mult ≈ 0.35 * 0.78 * 0.602 ≈ 0.164`. This falls
  below the current lower bound of 0.40. The assertion must be updated to `mult > 0.05` to
  accommodate the thermal fade effect during the ramp-up window. _Note: `_make_params()` must
  also set `drift_grip_release_peak = 0.6` and `drift_grip_release_tau = 0.8` for the test
  to be deterministic; without explicit values the test will break when the default .tres
  changes._

- [ ] All pre-existing drift state machine tests pass (with the two adjustments above): 13
  named tests, all green.

- [ ] All pre-existing bicycle physics tests pass unchanged (the `inp.rear_grip_multiplier`
  contract is unmodified).

### Manual playtest (30-second sessions)

- [ ] **Visible wide-entry arc**: initiate drift at full speed (~20 m/s). The kart's rear
  visibly steps further out than in v3.1.x during the first ~1 s before the arc tightens.
  Verifiable by comparison video: record v3.1.x (PEAK=0.0) vs v3.2 (PEAK=0.6).

- [ ] **Settling to steady-state circle**: hold drift for 4+ s on an open surface. By second 3,
  the arc radius should be stable — no continued tightening or widening after that point.

- [ ] **Rapid re-taps produce repeated wide-entry**: release drift, re-engage within 0.5 s,
  observe rear step-out again. Repeat 5 times. Each re-engagement should produce a perceptible
  wide sweep, not a steady-state circle immediately. This confirms `_active_timer` resets.

- [ ] **PEAK=0 backward-compat**: set `DRIFT_GRIP_RELEASE_PEAK=0` in dev_params. Drift
  behavior must be indistinguishable from a v3.1.x build. No arc difference observable in
  side-by-side comparison.

- [ ] **Hot-reload stability**: with drift active in dev mode, use param_tuner.html to change
  PEAK from 0.6 to 0.9 mid-drift. Kart should not crash, teleport, or produce an explosion
  in physics state. The kart may feel briefly looser (expected snap behavior per Edge Cases).

### Quantitative trace check

- [ ] Enable frame-by-frame `rear_grip_multiplier` logging (print in drift_state_machine or
  via existing debug overlay). At PEAK=0.6, TAU=0.8, steady throttle, sustained drift:
  - t=0 s: `mult ∈ [0.10, 0.18]` (engage_factor ramp means exact value depends on timing;
    lower bound is the thermal-fade-limited floor, upper bound accounts for sub-saturated engage)
  - t=0.8 s: `mult ∈ [0.22, 0.30]`
  - t=4.0 s: `mult ∈ [0.340, 0.360]`

### Deferred (not blocking v3.2 ship)

- [ ] **Remote kart network sync**: `_active_timer` is a local variable not currently
  synchronized over the multiplayer RPC layer. Remote karts will not exhibit thermal fade
  (they use the pre-v3.2 steady-state multiplier). Sync deferred to v3.2.x followup — tracked
  in `memory/project_v3_known_followups.md`.
