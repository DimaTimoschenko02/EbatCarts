// Interpolation buffer for a single remote kart's reported pose. Pure math,
// no THREE/colyseus imports, so it's unit-testable in isolation (see
// snapshotBuffer.test.ts) — same "physics/ has no engine deps" convention as
// src/physics/*.
//
// Design: each incoming network update is pushed with its arrival wall-clock
// time. Sampling always asks for the state at `now - delayMs` ("render in
// the past"): this guarantees we're interpolating BETWEEN two already-
// received snapshots instead of extrapolating past the last known one, at
// the cost of ~delayMs of visible latency for remote karts. No extrapolation
// is implemented — outside the buffered range we clamp to the nearest edge
// snapshot, which reads as "remote kart pauses" rather than "flies off
// wildly" if updates stop arriving (disconnect, packet loss).
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

// Smooths server send-cadence JITTER into a nominal, evenly-spaced clock
// BEFORE the timestamp ever reaches SnapshotBuffer.push(). Without this, the
// receive-time timestamp (performance.now() at the moment the onChange
// callback fires) goes straight into the buffer, and even a perfectly steady
// 30Hz sender produces juddery interpolation on the receiving end — the
// buffer's spacing is exactly as noisy as the network path, timer
// coalescing, GC pauses, etc. One instance per remote kart (see
// remoteKarts.ts) since each peer's arrival jitter is independent.
//
// Model: track an EMA-smoothed estimate of the real inter-arrival interval
// (so one outlier — a delayed packet — can't yank the estimate), lay
// snapshots on a uniform i*interval grid derived from that estimate, and
// apply a slow phase-correction nudge back toward the actual arrival clock
// so estimation error can't accumulate into permanent drift over a long
// session (e.g. if the sender's true rate differs slightly from our assumed
// nominal interval).
const NOMINAL_INTERVAL_MS = 1000 / 30; // matches netClient's 30Hz send rate
const INTERVAL_EMA_ALPHA = 0.1; // how fast the interval estimate adapts to real jitter/rate
const PHASE_CORRECTION_ALPHA = 0.02; // slow pull toward real time; must stay well below INTERVAL_EMA_ALPHA or jitter leaks back through

export class JitterResampler {
  private smoothedInterval = NOMINAL_INTERVAL_MS;
  private lastArrival: number | null = null;
  private nominal: number | null = null;

  // Maps a raw arrival wall-clock timestamp to a smoothed nominal timestamp.
  // Feed the RESULT into SnapshotBuffer.push({t: ...}), never the raw
  // arrival time directly.
  resample(arrivalMs: number): number {
    if (this.lastArrival === null || this.nominal === null) {
      this.lastArrival = arrivalMs;
      this.nominal = arrivalMs;
      return arrivalMs;
    }
    const observed = arrivalMs - this.lastArrival;
    this.lastArrival = arrivalMs;
    // Clamp: a single huge gap (tab backgrounded, packet-loss burst) or a
    // near-zero gap (duplicate/out-of-order delivery) must not yank the
    // smoothed estimate off course in one step.
    const clamped = Math.min(NOMINAL_INTERVAL_MS * 4, Math.max(NOMINAL_INTERVAL_MS * 0.25, observed));
    this.smoothedInterval += (clamped - this.smoothedInterval) * INTERVAL_EMA_ALPHA;
    this.nominal += this.smoothedInterval;
    this.nominal += (arrivalMs - this.nominal) * PHASE_CORRECTION_ALPHA;
    return this.nominal;
  }
}

export class SnapshotBuffer {
  private readonly buf: Snapshot[] = [];

  push(snap: Snapshot): void {
    this.buf.push(snap);
    if (this.buf.length > MAX_BUFFERED) this.buf.shift();
  }

  get length(): number {
    return this.buf.length;
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
