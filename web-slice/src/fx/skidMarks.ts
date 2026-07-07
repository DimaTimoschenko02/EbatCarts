// Per-rear-wheel skid trails. Primary purpose in the slice: DIAGNOSTIC —
// any kink or discontinuity in the drift transitions shows up immediately
// as a visible angle in the trail arc, which is exactly what we tune against.
//
// Trails record continuously (not only "while drifting"): color/alpha encode
// slip intensity, so normal driving leaves a faint line and hard slip leaves
// a bright one. A ring buffer of line segments keeps GPU memory bounded.
import * as THREE from "three";

const FAINT = new THREE.Color(0x223344); // no slip — barely visible path line
const HOT = new THREE.Color(0x00ffee); // full slip — bright cyan

export class SkidTrail {
  private readonly maxSegments: number;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  private cursor = 0; // next segment slot (ring)
  private prev: THREE.Vector3 | null = null;

  readonly object: THREE.LineSegments;

  constructor(maxSegments = 4000) {
    this.maxSegments = maxSegments;
    this.positions = new Float32Array(maxSegments * 2 * 3);
    this.colors = new Float32Array(maxSegments * 2 * 3);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setDrawRange(0, 0);
    const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 });
    this.object = new THREE.LineSegments(this.geometry, material);
    this.object.frustumCulled = false;
  }

  // Add a sample point for this wheel. intensity in [0..1] drives color.
  addSample(point: THREE.Vector3, intensity: number): void {
    if (this.prev === null) {
      this.prev = point.clone();
      return;
    }
    // Skip zero-length segments (kart standing still).
    if (this.prev.distanceToSquared(point) < 1e-6) return;

    const i = this.cursor % this.maxSegments;
    const p = this.positions;
    const c = this.colors;
    const base = i * 6;
    p[base + 0] = this.prev.x; p[base + 1] = this.prev.y; p[base + 2] = this.prev.z;
    p[base + 3] = point.x; p[base + 4] = point.y; p[base + 5] = point.z;

    const col = FAINT.clone().lerp(HOT, THREE.MathUtils.clamp(intensity, 0, 1));
    c[base + 0] = col.r; c[base + 1] = col.g; c[base + 2] = col.b;
    c[base + 3] = col.r; c[base + 4] = col.g; c[base + 5] = col.b;

    this.cursor++;
    const used = Math.min(this.cursor, this.maxSegments);
    this.geometry.setDrawRange(0, used * 2);
    (this.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;

    this.prev.copy(point);
  }

  // Break the line (teleport / reset) without clearing history.
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

  constructor(scene: THREE.Scene, wheelbase: number, trackWidth: number) {
    this.halfWb = wheelbase * 0.5;
    this.halfTrack = trackWidth * 0.5;
    scene.add(this.left.object);
    scene.add(this.right.object);
  }

  // Call from the physics loop. Records a segment roughly every minStep meters
  // of kart travel. Godot convention: rear axle sits at +Z in body frame
  // (forward = -Z), right wheel at +X.
  update(pos: THREE.Vector3, yaw: number, slipIntensity: number, minStep = 0.08): void {
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
    this.left.addSample(wheelWorld(-this.halfTrack, this.halfWb), slipIntensity);
    this.right.addSample(wheelWorld(this.halfTrack, this.halfWb), slipIntensity);
  }

  breakLine(): void {
    this.left.breakLine();
    this.right.breakLine();
  }

  clear(): void {
    this.left.clear();
    this.right.clear();
  }
}
