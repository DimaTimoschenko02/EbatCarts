// Vertical (Y-axis) physics — separated from bicyclePhysics.ts because it is
// axis-orthogonal to the XZ bicycle model and needed its own state machine
// (grounded ground-follow vs. ballistic airborne). Pure compute module, no
// THREE — see vertical.test.ts.
//
// Player feedback this implements (owner playtest, 2026-07): "driving off a
// ramp lip should launch the kart into the air — right now it just glides
// along the heightfield, glued to the ground no matter how steep the drop."
// FOLLOW-UP feedback (same day, second playtest): "drove up the trampoline
// ramp in the middle of the map and nothing happened — no launch at all."
// Root cause: the original launch detector only fired when the ground fell
// away FASTER than free-fall could (a cliff/dropoff). It deliberately never
// fired when a ramp simply flattens out at the top — but that IS the classic
// trampoline case: the kart was climbing at the ramp's slope rate, the ramp
// stops climbing, and the kart's own upward inertia should carry it into the
// air.
//
// Design: while grounded, y exp-follows the sampled ground height exactly
// like the pre-existing kart.ts step 8b did (same shape, parameterized as
// `groundFollowRate`) — AS LONG AS the ground is still holding the kart up.
//
// Launch detector (rate-based, NOT position-based — see below for why):
// each tick we track `state.vy`, the kart's own current vertical rate (kept
// equal to the ground-follow-implied rate while grounded — i.e. the exact
// rate the kart would need to still be glued to the surface), and compare it
// to `groundRateNow`, the RAW instantaneous rate-of-rise of the sampled
// ground height itself this tick (`(groundHeight - previousGroundHeight) /
// dt`, no smoothing). If the kart's own vy is climbing faster than the
// ground currently offers — by more than `airborneDropThreshold`, a small
// tunable margin that also acts as the anti-jitter hysteresis band for
// heightfield micro-noise — nothing is holding the kart down anymore and it
// launches, carrying its last ground-following vertical rate as `vy`. This
// single comparison covers both launch shapes with no separate cases:
//   - Cliff / ramp lip: groundRateNow crashes to a huge negative number
//     (ground height drops far in one tick) while vy is small → launch,
//     carrying roughly vy ≈ 0 (near-level "walked off the edge" launch).
//   - Ramp flattening while still climbing fast: groundRateNow drops to ~0
//     the instant the slope ends, but vy (the climb rate the kart had a
//     moment ago) is still large → launch, carrying that climb rate upward —
//     the actual trampoline effect.
// On a continuous, unbroken slope groundRateNow stays (within heightfield
// sampling noise) equal to the kart's own vy every tick — no launch, matching
// "driving smoothly up a ramp must never trigger a launch."
//
// WHY RATE-BASED, NOT A POSITION/FREEFALL COMPARISON: an earlier version of
// this detector compared a freefall-predicted `y` against the sampled ground
// height directly. That looked right on paper but never actually launched at
// cruise speed: the ground-follow exp filter has an inherent STEADY-STATE
// LAG while climbing a slope (state.y trails the true ramp height by
// `climbRate / groundFollowRate` — up to ~0.4m at cruise speed on the
// arena_slice ramp). The instant the ramp flattens, the filter still has
// that ~0.4m of banked catch-up motion left to deliver, which swamped the
// freefall/ground gap the launch check was looking for and silently ate the
// signal into a few extra ticks of ordinary-looking climb. Comparing RATES
// (vy vs. the raw ground slope) instead of absolute heights sidesteps the
// lag entirely, since it never reads state.y at all.
//
// A SLOW crawl up a ramp that then flattens implies a small vy, well under
// the threshold — no launch, or one so small it's imperceptible; a fast
// cruise implies a large vy, well past the threshold, on the very first flat
// tick — an immediate, clearly felt launch. See vertical.test.ts "launch off
// a flattening ramp top" block for the concrete speed numbers this was tuned
// against (arena_slice ramp geometry).
//
// While airborne: pure ballistic (vy -= g*dt; y += vy*dt), no ground-follow,
// no re-launch logic — horizontal input/physics are the CALLER's
// responsibility to suspend (see kart.ts step 8b wiring), this module only
// ever touches y/vy/airborne (groundHeightPrev is bookkeeping only, callers
// don't need to read it).
//
// Landing: snaps to the sampled ground height once within `landingMargin`
// of it AND already descending (vy <= 0) — the vy<=0 guard stops the kart
// from "landing" on itself in the very tick it just launched upward from a
// point that happens to be close to the (now much lower) new ground sample.
// No bounce: vy resets to 0 on landing, matching the "pure inertia, no
// physics interaction while airborne" brief (nothing partially elastic).

export interface VerticalParams {
  gravity: number; // VERTICAL_GRAVITY — downward accel while airborne (m/s²)
  groundFollowRate: number; // VERTICAL_GROUND_FOLLOW_RATE — exp-follow rate while grounded (/s)
  airborneDropThreshold: number; // VERTICAL_AIRBORNE_DROP_THRESHOLD — how far (m/s) the kart's own vertical rate must exceed the ground's current rate-of-rise to trigger a launch — in EITHER direction (cliff drop or ramp-top launch); also the anti-jitter margin
  landingMargin: number; // VERTICAL_LANDING_MARGIN — clearance (m) below which an airborne kart snaps to the ground
}

export interface VerticalState {
  y: number;
  vy: number;
  airborne: boolean;
  // Raw ground height sampled last tick — bookkeeping for the launch
  // detector's instantaneous ground-rate estimate, see header comment. Not
  // meaningful to callers; null only before the first tick / first ground
  // sample.
  groundHeightPrev: number | null;
}

export interface VerticalInput {
  // Ground height at the kart's (already horizontally-integrated) XZ this
  // tick, or null when there's no mapped cell there (defensive — normal
  // horizontal collision in kart.ts already prevents entering unmapped
  // cells, see step 8, so this should not occur in practice).
  groundHeight: number | null;
  dt: number;
}

export function createVerticalState(y: number): VerticalState {
  return { y, vy: 0, airborne: false, groundHeightPrev: null };
}

export function stepVertical(state: VerticalState, inp: VerticalInput, p: VerticalParams): VerticalState {
  const dt = inp.dt;

  if (!state.airborne) {
    if (inp.groundHeight === null) {
      // No ground info under the kart — fail safe into freefall (carrying
      // whatever vertical rate we had) rather than staying glued to a stale
      // height forever. Shouldn't happen in practice (see VerticalInput doc).
      return { y: state.y, vy: state.vy, airborne: true, groundHeightPrev: state.groundHeightPrev };
    }

    // Raw, unsmoothed rate-of-rise of the sampled ground this tick. null
    // previous sample (first tick ever) means "unknown" — treat as matching
    // the kart's own rate so the very first tick can never spuriously launch.
    const groundRateNow =
      state.groundHeightPrev === null ? state.vy : (inp.groundHeight - state.groundHeightPrev) / Math.max(dt, 1e-6);

    if (state.vy - groundRateNow > p.airborneDropThreshold) {
      // The kart's own vertical momentum is now climbing (or simply not
      // falling as fast as) the ground beneath it — nothing is holding it
      // down anymore. Position stays put this tick (don't snap to the new
      // ground sample); vy carries the last ground-following rate, which is
      // exactly the trampoline effect for a kart still climbing when the
      // ramp ends, or a near-level launch when walking off a flat cliff.
      return { y: state.y, vy: state.vy, airborne: true, groundHeightPrev: inp.groundHeight };
    }

    const followAlpha = 1 - Math.exp(-p.groundFollowRate * dt);
    const candidateY = state.y + (inp.groundHeight - state.y) * followAlpha;
    const impliedVy = (candidateY - state.y) / Math.max(dt, 1e-6);
    return { y: candidateY, vy: impliedVy, airborne: false, groundHeightPrev: inp.groundHeight };
  }

  // Airborne: ballistic, no ground-follow, no re-derivation from input.
  const vy = state.vy - p.gravity * dt;
  const y = state.y + vy * dt;
  const groundHeightPrev = inp.groundHeight ?? state.groundHeightPrev;
  if (inp.groundHeight !== null && vy <= 0 && y <= inp.groundHeight + p.landingMargin) {
    return { y: inp.groundHeight, vy: 0, airborne: false, groundHeightPrev: inp.groundHeight }; // no bounce
  }
  return { y, vy, airborne: true, groundHeightPrev };
}
