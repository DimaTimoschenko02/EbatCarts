// Vertical (Y-axis) physics — separated from bicyclePhysics.ts because it is
// axis-orthogonal to the XZ bicycle model and needed its own state machine
// (grounded ground-follow vs. ballistic airborne). Pure compute module, no
// THREE — see vertical.test.ts.
//
// Player feedback this implements (owner playtest, 2026-07): "driving off a
// ramp lip should launch the kart into the air — right now it just glides
// along the heightfield, glued to the ground no matter how steep the drop."
//
// Design: while grounded, y exp-follows the sampled ground height exactly
// like the pre-existing kart.ts step 8b did (same shape, now parameterized
// as `groundFollowRate`). The KEY addition is a launch detector: each tick we
// also track the INSTANTANEOUS vertical rate that follow is currently
// producing (`impliedVy` — for a smooth ramp this converges to slope ×
// horizontal speed, i.e. exactly the vertical velocity you'd have if welded
// to the surface). We compare the height delta the follow filter wants to
// apply this tick (`candidateDrop`) against the delta gravity alone would
// produce if the kart were already falling at that same impliedVy
// (`freeFallDrop`, from the PREVIOUS tick's impliedVy carried in state.vy).
//
// On a continuous slope those two numbers stay almost equal every tick (the
// ground "falls away" at exactly the rate the kart is already moving
// vertically) — no launch. At a ramp lip / cliff, the actual terrain drops
// away MUCH faster than gravity could have pulled the kart down from its
// current vertical rate — that gap (beyond `airborneDropThreshold`, a small
// tunable margin that also acts as the anti-jitter hysteresis band for
// heightfield micro-noise) is the launch signal. The kart goes airborne
// carrying its last ground-following vertical rate as `vy` — which is
// POSITIVE while climbing a ramp, so a kart that leaves the ramp mid-climb
// genuinely launches upward, not just falls. A flat runout after a ramp
// (height stops rising but doesn't drop) never triggers this — impliedVy
// smoothly relaxes toward 0 instead, exactly the "smoothly reach the top,
// keep driving" case the game already had working.
//
// While airborne: pure ballistic (vy -= g*dt; y += vy*dt), no ground-follow,
// no re-launch logic — horizontal input/physics are the CALLER's
// responsibility to suspend (see kart.ts step 8b wiring), this module only
// ever touches y/vy/airborne.
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
  airborneDropThreshold: number; // VERTICAL_AIRBORNE_DROP_THRESHOLD — excess descent rate (m/s) beyond free-fall needed to trigger a launch; also the anti-jitter margin
  landingMargin: number; // VERTICAL_LANDING_MARGIN — clearance (m) below which an airborne kart snaps to the ground
}

export interface VerticalState {
  y: number;
  vy: number;
  airborne: boolean;
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
  return { y, vy: 0, airborne: false };
}

export function stepVertical(state: VerticalState, inp: VerticalInput, p: VerticalParams): VerticalState {
  const dt = inp.dt;

  if (!state.airborne) {
    if (inp.groundHeight === null) {
      // No ground info under the kart — fail safe into freefall (carrying
      // whatever vertical rate we had) rather than staying glued to a stale
      // height forever. Shouldn't happen in practice (see VerticalInput doc).
      return { y: state.y, vy: state.vy, airborne: true };
    }

    const followAlpha = 1 - Math.exp(-p.groundFollowRate * dt);
    const candidateY = state.y + (inp.groundHeight - state.y) * followAlpha;
    const candidateDrop = candidateY - state.y; // negative while descending
    const impliedVy = candidateDrop / Math.max(dt, 1e-6);

    // How far gravity alone would drop the kart this tick if it were already
    // falling at the PREVIOUS tick's follow-implied vertical rate.
    const freeFallDrop = state.vy * dt - 0.5 * p.gravity * dt * dt;

    if (candidateDrop < freeFallDrop - p.airborneDropThreshold * dt) {
      // Ground fell away faster than gravity could — launch. Position stays
      // put this tick (don't snap down to the new, much-lower ground); vy
      // carries the ground-following rate we had, which is exactly the
      // trampoline effect for a kart still climbing when the ramp ends.
      return { y: state.y, vy: state.vy, airborne: true };
    }

    return { y: candidateY, vy: impliedVy, airborne: false };
  }

  // Airborne: ballistic, no ground-follow, no re-derivation from input.
  const vy = state.vy - p.gravity * dt;
  const y = state.y + vy * dt;
  if (inp.groundHeight !== null && vy <= 0 && y <= inp.groundHeight + p.landingMargin) {
    return { y: inp.groundHeight, vy: 0, airborne: false }; // no bounce
  }
  return { y, vy, airborne: true };
}
