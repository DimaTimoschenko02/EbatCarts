// Interpolation buffer for a single remote kart's reported pose. Pure math,
// no THREE/colyseus imports, so it's unit-testable in isolation (see
// snapshotBuffer.test.ts) — same "physics/ has no engine deps" convention as
// src/physics/*.
//
// Design: each incoming network update is pushed with its arrival wall-clock
// time. Sampling always asks for the state at `now - delayMs` ("render in
// the past"): this guarantees we're USUALLY interpolating BETWEEN two
// already-received snapshots instead of extrapolating, at the cost of
// ~delayMs of visible latency for remote karts.
//
// Short-horizon extrapolation (see RemoteInterpolator.update() below) is the
// one exception, added to bridge GENUINE network silence — e.g. a Wi-Fi
// power-save cycle queuing several packets and delivering them together —
// which no amount of delay/smoothing tuning on the receiving end can hide,
// since the position data for that window truly hasn't arrived yet. Bounded
// to MAX_EXTRAPOLATION_MS and based on a smoothed recent-velocity estimate
// (not the raw last two samples, which would amplify jitter) so it decays
// into a full stop — never "flies off wildly" — if updates stop arriving
// entirely (disconnect, packet loss). Sampling far outside the buffered
// range in either direction (extrapolation budget exhausted, or before the
// very first snapshot) still clamps to the nearest edge snapshot.
export interface Snapshot {
  t: number; // ms, Date.now()-style arrival timestamp
  x: number;
  y: number;
  z: number;
  yaw: number; // radians
}

const MAX_BUFFERED = 32; // ~1.07s at 30Hz — plenty for a 100ms render delay

// Shortest-arc angle lerp: avoids the remote kart visibly spinning the long
// way around when yaw crosses the +-PI wrap boundary. Exported so
// remoteKarts.ts can reuse it for the post-interpolation exp-smoothing pass
// (see RemoteKartManager.update).
export function lerpAngle(a: number, b: number, t: number): number {
  let diff = (b - a) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

// Standard C1-continuous 0..1 ease between edges lo/hi — used instead of a
// hard threshold anywhere a continuous value needs to gate another
// continuous value (see .claude/rules/smooth-values.md).
function smoothstep(lo: number, hi: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

// --- History: the JitterResampler that used to live here -------------------
// A previous round tried to fix arrival judder by reconstructing a synthetic
// "nominal" clock (EMA-estimated interval + a slow phase-correction nudge)
// and feeding THAT into SnapshotBuffer instead of the raw arrival timestamp.
// It introduced a worse bug: render.ts samples the buffer at
// `performance.now() - RENDER_DELAY_MS` — real wall-clock time — while the
// resampler's "nominal" clock advances at its own *estimated* rate. Any
// steady-state mismatch between that estimate and the sender's true cadence
// (sender timer drift as small as 1%, or an EMA bias introduced by a single
// burst of near-simultaneous arrivals — e.g. a Wi-Fi adapter's power-save
// mode queuing several packets and flushing them together) is corrected at
// only 2%/sample, far too slow to track a persistent rate error. The nominal
// clock silently falls behind or ahead of real time, the render pointer
// eventually outruns the buffer's newest (nominal) timestamp, sample()
// clamps to the last known snapshot (freeze), and when the next real update
// lands the interpolation replays the accumulated real position delta over a
// deceptively small nominal time span — a fast whip-catch-up. Reproduced in
// a controlled simulation: a mere 1% sender-cadence drift alone produced
// near-total freezes (minRatio ~0.02) followed by rush-catch-up frames
// (maxRatio ~1.7x true speed), matching the reported "smooth ~1s, sudden
// rev, smooth again" symptom almost exactly.
//
// Fix (see RemoteInterpolator below): buffer RAW arrival timestamps — same
// clock domain the render loop already uses, so no synthetic-vs-real clock
// drift is possible by construction — and instead absorb genuine arrival
// jitter/bursts with an ADAPTIVE render delay that grows with the worst
// recently observed inter-arrival gap and decays slowly when the network
// calms down. See RemoteInterpolator for the full model.

export class SnapshotBuffer {
  private readonly buf: Snapshot[] = [];

  push(snap: Snapshot): void {
    this.buf.push(snap);
    if (this.buf.length > MAX_BUFFERED) this.buf.shift();
  }

  get length(): number {
    return this.buf.length;
  }

  // Timestamp of the most recent buffered snapshot, or null if empty. Used
  // by RemoteInterpolator to detect buffer underrun (render pointer about to
  // outrun the newest data) for the catch-up telemetry counter.
  get newestTime(): number | null {
    return this.buf.length ? this.buf[this.buf.length - 1].t : null;
  }

  // The most recent buffered snapshot in full, or null if empty. Used by
  // RemoteInterpolator as the extrapolation anchor when renderTime runs past
  // it (see file header).
  get newest(): Snapshot | null {
    return this.buf.length ? this.buf[this.buf.length - 1] : null;
  }

  // Interpolated pose at `renderTime` (same clock as the `t` passed to
  // push()). Returns null if nothing has ever been pushed. Clamps to the
  // oldest/newest snapshot when renderTime falls outside the buffered range
  // (no extrapolation — see file header).
  sample(renderTime: number): Snapshot | null {
    const n = this.buf.length;
    if (n === 0) return null;
    if (n === 1 || renderTime <= this.buf[0].t) return this.buf[0];
    if (renderTime >= this.buf[n - 1].t) return this.buf[n - 1];

    // Find the bracketing pair. Linear scan is fine at n<=32.
    for (let i = 0; i < n - 1; i++) {
      const a = this.buf[i];
      const b = this.buf[i + 1];
      if (renderTime >= a.t && renderTime <= b.t) {
        const span = b.t - a.t;
        const t = span > 0 ? (renderTime - a.t) / span : 0;
        return {
          t: renderTime,
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          z: a.z + (b.z - a.z) * t,
          yaw: lerpAngle(a.yaw, b.yaw, t),
        };
      }
    }
    return this.buf[n - 1]; // unreachable given the bounds checks above
  }
}

export interface RenderPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

// How far behind wall-clock time we render a remote kart when the network is
// calm. Kept at the same 100ms previously tuned in remoteKarts.ts (shooter
// game, player explicitly asked for minimal added latency) — this is the
// FLOOR of the adaptive delay below, not a fixed value anymore.
const BASE_RENDER_DELAY_MS = 100;
// Ceiling on how far the adaptive delay is allowed to grow even under a
// nasty burst — beyond this a stall is a real disconnect/loss event, not
// something worth hiding behind ever-more latency.
const MAX_RENDER_DELAY_MS = 400;
// The delay tracks a "held peak" of recently observed inter-arrival gaps
// (a burst's silent gap, not the average) so the buffer stays a step ahead
// of the render pointer even right after a burst. Continuous multiplicative
// decay (not a reset) per smooth-values.md — the peak relaxes back down once
// the network calms down instead of snapping. Deliberately slow (~6.7s time
// constant): a recurring burst pattern (e.g. a Wi-Fi power-save cycle firing
// every ~1-1.5s) needs the held peak to persist across SEVERAL cycles, not
// decay away between one burst and the next — a faster decay here chases its
// own tail forever (delay relaxes back down right before the next burst
// hits, gets caught underprepared again every single cycle).
const GAP_PEAK_DECAY_RATE = 0.15; // 1/s
// Headroom multiplier over the held peak gap — the delay needs to exceed
// the worst gap, not just match it, or the render pointer still grazes the
// buffer edge right at the worst moment.
const DELAY_MARGIN = 1.4;
// How fast the APPLIED delay chases its target. Deliberately slow: a delay
// change shifts what "now" means for sampling, so an abrupt delay jump would
// itself look like a hitch. Framerate-independent per smooth-values.md.
const DELAY_CHASE_RATE = 3; // 1/s
// Post-interpolation exp-filter smoothing rate — cleans up residual stair-
// stepping from snapshot-to-snapshot transitions. A SINGLE fixed rate can't
// serve both cases well: ordinary jitter only ever compresses about one
// packet's worth of motion into a tight arrival cluster (small snap, wants a
// snappy filter so it doesn't feel laggy), while a real burst (Wi-Fi
// power-save queuing several packets) compresses several packets' worth of
// motion into one (small snap, needs a much slower filter to avoid a visible
// catch-up rush, per smooth-values.md's "two speeds" pattern). Rather than
// pick one compromise rate, the rate itself continuously eases between a
// calm value and a burst value based on the SAME held-peak-gap signal that
// drives the adaptive delay above — smoothstep, not a threshold flip, so
// there's no discrete rate jump either.
const RENDER_SMOOTH_RATE_CALM = 12; // normal jitter, snappy
const RENDER_SMOOTH_RATE_BURST = 4; // mid-burst-recovery, spreads the catch-up over many frames
const RENDER_SMOOTH_RATE_LO_GAP_MS = 50; // peak gap below this: fully calm rate
const RENDER_SMOOTH_RATE_HI_GAP_MS = 140; // peak gap above this: fully burst rate
// How smoothly the velocity ESTIMATE (used only for short-horizon
// extrapolation, below) reacts to each new snapshot. Slower than the
// position smoothing rates above on purpose — velocity is a derivative, so
// it amplifies jitter noise far more than position does; a jumpy estimate
// would make extrapolated motion during a stale-data gap visibly worse than
// just holding still.
const VELOCITY_EMA_ALPHA = 0.25;
// How far past the newest buffered snapshot we're willing to extrapolate
// using the smoothed velocity estimate before giving up and holding still.
// Sized to comfortably bridge a single Wi-Fi-power-save-style burst gap
// (a handful of packets held for a few hundred ms) without extrapolating
// so far that a genuine disconnect drifts the kart into a wall.
const MAX_EXTRAPOLATION_MS = 300;
// Assumed real time elapsed per received snapshot, used ONLY for the
// velocity estimate that feeds extrapolation — matches netClient.ts's
// SEND_INTERVAL_MS (30Hz, and deliberately never skipped, see that file).
// Using the ARRIVAL gap between pushes here instead would be wrong: over a
// reliable, ordered transport (Colyseus/WebSocket) every push represents
// exactly one send-tick's worth of real motion no matter how bunched-up its
// delivery was. A burst can compress 7 packets' arrivals into 15ms — using
// that 15ms (or the ~200ms gap arrival PRECEDING the burst) as "elapsed
// time" produces wildly wrong instantaneous velocities (tens of m/s spikes,
// or near-zero underestimates) that then poison the smoothed estimate used
// to bridge the NEXT gap.
const NOMINAL_TICK_MS = 1000 / 30;

// Per-remote-kart interpolation state: buffers raw arrival timestamps (see
// the JitterResampler history note above for why NOT a synthetic clock),
// adapts its render delay to the observed jitter/burst pattern, bridges
// short genuine data gaps with velocity extrapolation, and applies a
// post-interpolation smoothing pass. Pure math, no THREE/colyseus deps —
// remoteKarts.ts is a thin wrapper that owns the THREE.Group and feeds this.
export class RemoteInterpolator {
  private readonly buffer = new SnapshotBuffer();
  private lastArrival: number | null = null;
  private lastPushedPose: RenderPose | null = null;
  private peakGapMs = 0;
  private appliedDelayMs = BASE_RENDER_DELAY_MS;
  private readonly smoothPos: { x: number; y: number; z: number };
  private smoothYaw: number;
  private readonly velocity = { x: 0, y: 0, z: 0 };
  private wasStalled = false;
  private underrunEvents = 0;

  constructor(initial: RenderPose) {
    this.smoothPos = { x: initial.x, y: initial.y, z: initial.z };
    this.smoothYaw = initial.yaw;
  }

  // Feed a freshly-arrived network snapshot. `arrivalMs` and the `nowMs`
  // passed to update() MUST be the same clock (performance.now() in
  // production, see file header) — mixing clock domains is exactly the bug
  // this replaced.
  push(arrivalMs: number, pose: RenderPose): void {
    if (this.lastArrival !== null) {
      const gap = arrivalMs - this.lastArrival;
      if (gap > this.peakGapMs) this.peakGapMs = gap;
    }
    if (this.lastPushedPose !== null) {
      // Fixed nominal dt, NOT the arrival gap — see NOMINAL_TICK_MS above.
      const dt = NOMINAL_TICK_MS / 1000;
      const instVel = {
        x: (pose.x - this.lastPushedPose.x) / dt,
        y: (pose.y - this.lastPushedPose.y) / dt,
        z: (pose.z - this.lastPushedPose.z) / dt,
      };
      this.velocity.x += (instVel.x - this.velocity.x) * VELOCITY_EMA_ALPHA;
      this.velocity.y += (instVel.y - this.velocity.y) * VELOCITY_EMA_ALPHA;
      this.velocity.z += (instVel.z - this.velocity.z) * VELOCITY_EMA_ALPHA;
    }
    this.lastArrival = arrivalMs;
    this.lastPushedPose = pose;
    this.buffer.push({ t: arrivalMs, x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw });
  }

  // Call once per rendered frame. Returns the smoothed render pose.
  update(nowMs: number, dtSec: number): RenderPose {
    this.peakGapMs *= Math.exp(-GAP_PEAK_DECAY_RATE * dtSec);
    const targetDelay = Math.min(
      MAX_RENDER_DELAY_MS,
      Math.max(BASE_RENDER_DELAY_MS, this.peakGapMs * DELAY_MARGIN)
    );
    this.appliedDelayMs += (targetDelay - this.appliedDelayMs) * (1 - Math.exp(-DELAY_CHASE_RATE * dtSec));

    const renderTime = nowMs - this.appliedDelayMs;
    const newestSnap = this.buffer.newest;
    const overshootMs = newestSnap !== null ? renderTime - newestSnap.t : -Infinity;
    const stalled = overshootMs >= MAX_EXTRAPOLATION_MS;
    if (stalled && !this.wasStalled) this.underrunEvents++;
    this.wasStalled = stalled;

    // Bridge a genuine data gap (renderTime ran past the newest snapshot —
    // see file header) with short-horizon constant-velocity extrapolation
    // instead of freezing outright. Past MAX_EXTRAPOLATION_MS we give up and
    // fall through to SnapshotBuffer.sample()'s own clamp-to-last behavior,
    // which holds the last extrapolated-or-real position steady rather than
    // extrapolating a lost connection off into the distance.
    const s = overshootMs > 0 && overshootMs < MAX_EXTRAPOLATION_MS && newestSnap
      ? {
          t: renderTime,
          x: newestSnap.x + (this.velocity.x * overshootMs) / 1000,
          y: newestSnap.y + (this.velocity.y * overshootMs) / 1000,
          z: newestSnap.z + (this.velocity.z * overshootMs) / 1000,
          yaw: newestSnap.yaw,
        }
      : this.buffer.sample(renderTime);
    if (s) {
      const burstiness = smoothstep(RENDER_SMOOTH_RATE_LO_GAP_MS, RENDER_SMOOTH_RATE_HI_GAP_MS, this.peakGapMs);
      const smoothRate = RENDER_SMOOTH_RATE_CALM + (RENDER_SMOOTH_RATE_BURST - RENDER_SMOOTH_RATE_CALM) * burstiness;
      const alpha = 1 - Math.exp(-smoothRate * dtSec);
      this.smoothPos.x += (s.x - this.smoothPos.x) * alpha;
      this.smoothPos.y += (s.y - this.smoothPos.y) * alpha;
      this.smoothPos.z += (s.z - this.smoothPos.z) * alpha;
      this.smoothYaw = lerpAngle(this.smoothYaw, s.yaw, alpha);
    }
    return { x: this.smoothPos.x, y: this.smoothPos.y, z: this.smoothPos.z, yaw: this.smoothYaw };
  }

  // Diagnostics surfaced through window.__net (see net/index.ts) so jitter
  // and catch-up behavior can be eyeballed during a live playtest.
  get stats(): { delayMs: number; jitterMs: number; underruns: number } {
    return { delayMs: this.appliedDelayMs, jitterMs: this.peakGapMs, underruns: this.underrunEvents };
  }
}
