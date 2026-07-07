// Per-rear-wheel skid trails — GAMEPLAY feature (was diagnostic-only in the
// physics-port slice; the diagnostic role is closed, see .claude memory
// decision_v3_2 / P1 closure notes). Trails now record ONLY while the kart is
// actually drifting, and each recorded segment fades out and disappears after
// SKID_TTL_SEC seconds. Normal driving leaves no mark at all.
//
// Time comes in as a parameter (sim time accumulated by the caller from fixed
// physics dt), never performance.now() — keeps this module a pure function of
// its inputs and testable without a running render loop (smooth-values.md).
import * as THREE from "three";

const HOT = new THREE.Color(0x00ffee); // full slip while drifting — bright cyan

// How long a recorded segment stays visible before fully fading to nothing.
export const SKID_TTL_SEC = 10;

// engageFactor gate: below LO the kart isn't meaningfully drifting (no trail
// at all); at/above HI it's fully engaged (full trail intensity). Between the
// two the gate ramps smoothly via THREE.MathUtils.smoothstep — this is what
// keeps the trail's appearance/disappearance free of a hard on/off pop even
// though *recording* itself is gated (smooth-values.md: continuous values
// must not jump; the underlying color intensity here is continuous, only the
// decision "is there a new point to add" is gated at the point where that
// continuous value is already ~0).
const ENGAGE_GATE_LO = 0.12;
const ENGAGE_GATE_HI = 0.25;

// Pure fade curve used both by SkidTrail's per-frame recolor pass and by the
// unit test below. ageSec <= 0 -> fully bright, ageSec >= ttlSec -> fully
// gone, eased (not linear) in between so the tail doesn't visibly "chop".
export function fadeFactorFor(ageSec: number, ttlSec = SKID_TTL_SEC): number {
  if (ageSec <= 0) return 1;
  if (ageSec >= ttlSec) return 0;
  return 1 - THREE.MathUtils.smoothstep(ageSec, 0, ttlSec);
}

// Smooth engage gate: 0 while not drifting, ramps to 1 across the band.
export function engageGateFor(engageFactor: number): number {
  return THREE.MathUtils.smoothstep(engageFactor, ENGAGE_GATE_LO, ENGAGE_GATE_HI);
}

export class SkidTrail {
  private readonly maxSegments: number;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array; // displayed (post-fade) vertex colors
  private readonly baseColors: Float32Array; // recorded (pre-fade) vertex colors
  private readonly birthTimes: Float32Array; // sim-time each segment was recorded, per segment
  private readonly geometry: THREE.BufferGeometry;
  private cursor = 0; // next segment slot (ring)
  private prev: THREE.Vector3 | null = null;

  readonly object: THREE.LineSegments;

  constructor(maxSegments = 4000) {
    this.maxSegments = maxSegments;
    this.positions = new Float32Array(maxSegments * 2 * 3);
    this.colors = new Float32Array(maxSegments * 2 * 3);
    this.baseColors = new Float32Array(maxSegments * 2 * 3);
    this.birthTimes = new Float32Array(maxSegments);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setDrawRange(0, 0);
    // Additive blending: a segment's color fades toward black as it ages, and
    // black-additive-over-anything is invisible — the fade-to-nothing and the
    // "no trail while driving normally" gate both fall out of the same simple
    // "scale color toward zero" mechanism, no separate alpha/visibility logic.
    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.object = new THREE.LineSegments(this.geometry, material);
    this.object.frustumCulled = false;
  }

  // Add a sample point for this wheel. intensity in [0..1] drives brightness
  // (already combines slip magnitude and the drift engage gate — see
  // RearSkidMarks.update). timeSec is sim time, used later to fade this
  // segment out.
  addSample(point: THREE.Vector3, intensity: number, timeSec: number): void {
    if (this.prev === null) {
      this.prev = point.clone();
      return;
    }
    // Skip zero-length segments (kart standing still).
    if (this.prev.distanceToSquared(point) < 1e-6) return;

    const i = this.cursor % this.maxSegments;
    const p = this.positions;
    const bc = this.baseColors;
    const base = i * 6;
    p[base + 0] = this.prev.x; p[base + 1] = this.prev.y; p[base + 2] = this.prev.z;
    p[base + 3] = point.x; p[base + 4] = point.y; p[base + 5] = point.z;

    const col = HOT.clone().multiplyScalar(THREE.MathUtils.clamp(intensity, 0, 1));
    bc[base + 0] = col.r; bc[base + 1] = col.g; bc[base + 2] = col.b;
    bc[base + 3] = col.r; bc[base + 4] = col.g; bc[base + 5] = col.b;
    // Fresh segment: display at full base brightness immediately (age 0),
    // recomputeFade() will dim it on subsequent frames as it ages.
    this.colors[base + 0] = col.r; this.colors[base + 1] = col.g; this.colors[base + 2] = col.b;
    this.colors[base + 3] = col.r; this.colors[base + 4] = col.g; this.colors[base + 5] = col.b;
    this.birthTimes[i] = timeSec;

    this.cursor++;
    const used = Math.min(this.cursor, this.maxSegments);
    this.geometry.setDrawRange(0, used * 2);
    (this.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;

    this.prev.copy(point);
  }

  // Recolor every currently-drawn segment according to its age relative to
  // nowSec. Called once per physics step regardless of whether a new sample
  // was recorded, so old segments keep aging/fading even while not drifting.
  recomputeFade(nowSec: number, ttlSec = SKID_TTL_SEC): void {
    const used = Math.min(this.cursor, this.maxSegments);
    if (used === 0) return;
    const bc = this.baseColors;
    const c = this.colors;
    for (let i = 0; i < used; i++) {
      const factor = fadeFactorFor(nowSec - this.birthTimes[i], ttlSec);
      const base = i * 6;
      c[base + 0] = bc[base + 0] * factor; c[base + 1] = bc[base + 1] * factor; c[base + 2] = bc[base + 2] * factor;
      c[base + 3] = bc[base + 3] * factor; c[base + 4] = bc[base + 4] * factor; c[base + 5] = bc[base + 5] * factor;
    }
    (this.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  // Break the line (teleport / reset / drift disengaged) without clearing history.
  breakLine(): void {
    this.prev = null;
  }

  clear(): void {
    this.cursor = 0;
    this.prev = null;
    this.geometry.setDrawRange(0, 0);
  }
}

// Pair of trails bound to the rear axle of a kart.
export class RearSkidMarks {
  readonly left = new SkidTrail();
  readonly right = new SkidTrail();
  private readonly halfWb: number;
  private readonly halfTrack: number;
  private lastSamplePos = new THREE.Vector3(Infinity, 0, Infinity);
  private wasEngaged = false;

  constructor(scene: THREE.Scene, wheelbase: number, trackWidth: number) {
    this.halfWb = wheelbase * 0.5;
    this.halfTrack = trackWidth * 0.5;
    scene.add(this.left.object);
    scene.add(this.right.object);
  }

  // Call from the physics loop. Records a segment roughly every minStep meters
  // of kart travel, but ONLY while the drift engage gate is open (see
  // engageGateFor) — normal driving leaves no mark. Godot convention: rear
  // axle sits at +Z in body frame (forward = -Z), right wheel at +X.
  // `timeSec` is accumulated sim time (fixed dt sum), not wall clock — keeps
  // this deterministic/testable, per smooth-values.md + the module header.
  update(
    pos: THREE.Vector3,
    yaw: number,
    slipIntensity: number,
    engageFactor: number,
    timeSec: number,
    minStep = 0.08
  ): void {
    // Aging/fade happens every step, drifting or not, so old marks still
    // disappear on schedule while the kart is just cruising.
    this.left.recomputeFade(timeSec);
    this.right.recomputeFade(timeSec);

    const gate = engageGateFor(engageFactor);
    if (gate <= 0) {
      if (this.wasEngaged) {
        this.breakLine();
        this.lastSamplePos.set(Infinity, 0, Infinity);
      }
      this.wasEngaged = false;
      return;
    }
    this.wasEngaged = true;

    if (this.lastSamplePos.distanceToSquared(pos) < minStep * minStep) return;
    this.lastSamplePos.copy(pos);

    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const wheelWorld = (lx: number, lz: number) =>
      new THREE.Vector3(
        pos.x + lx * cos + lz * sin,
        pos.y + 0.02, // hug the ground the kart is on (plateau, ramps)
        pos.z - lx * sin + lz * cos
      );
    const intensity = THREE.MathUtils.clamp(slipIntensity, 0, 1) * gate;
    this.left.addSample(wheelWorld(-this.halfTrack, this.halfWb), intensity, timeSec);
    this.right.addSample(wheelWorld(this.halfTrack, this.halfWb), intensity, timeSec);
  }

  breakLine(): void {
    this.left.breakLine();
    this.right.breakLine();
  }

  clear(): void {
    this.left.clear();
    this.right.clear();
    this.wasEngaged = false;
    this.lastSamplePos.set(Infinity, 0, Infinity);
  }
}
