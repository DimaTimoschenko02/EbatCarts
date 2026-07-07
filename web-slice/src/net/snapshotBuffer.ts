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

const MAX_BUFFERED = 32; // ~1.6s at 20Hz — plenty for a 120ms render delay

// Shortest-arc angle lerp: avoids the remote kart visibly spinning the long
// way around when yaw crosses the +-PI wrap boundary.
function lerpAngle(a: number, b: number, t: number): number {
  let diff = (b - a) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
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
