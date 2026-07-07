// Space sky dome + starfield. Purely cosmetic backdrop for the vertical
// slice — scene.background / fog stay in place for the map's fog falloff,
// this just fills the far distance so the horizon isn't a flat color wall.
import * as THREE from "three";

const ZENITH = new THREE.Color(0x07071c); // straight up — near-black blue/violet
const HORIZON = new THREE.Color(0x251342); // low angle — dark violet

// One-shot generation only (Math.random with no per-frame dependency) —
// the sky and stars never change after createSpaceSky() runs.
export function createSpaceSky(scene: THREE.Scene): void {
  scene.add(buildDome());
  scene.add(buildStars());
}

function buildDome(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(200, 32, 16);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: ZENITH },
      uHorizon: { value: HORIZON },
    },
    vertexShader: `
      varying vec3 vWorldDir;
      void main() {
        vWorldDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      varying vec3 vWorldDir;
      void main() {
        // Below the horizon the sky is a flat zenith color — nothing to
        // gradient toward down there, the "horizon" band only matters above.
        float t = smoothstep(0.0, 0.6, max(vWorldDir.y, 0.0));
        vec3 color = mix(uHorizon, uZenith, t);
        gl_FragColor = vec4(color, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return mesh;
}

function buildStars(): THREE.Points {
  const COUNT = 1200;
  const RADIUS = 190;
  const positions = new Float32Array(COUNT * 3);
  const colors = new Float32Array(COUNT * 3);

  for (let i = 0; i < COUNT; i++) {
    // Bias toward the upper hemisphere, allow a bit below the horizon so
    // the dome doesn't look empty near the skyline when the camera tilts up.
    const y = THREE.MathUtils.lerp(-0.15, 1.0, Math.random());
    const phi = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const x = Math.cos(phi) * r;
    const z = Math.sin(phi) * r;

    positions[i * 3 + 0] = x * RADIUS;
    positions[i * 3 + 1] = y * RADIUS;
    positions[i * 3 + 2] = z * RADIUS;

    const roll = Math.random();
    let color: THREE.Color;
    if (roll < 0.05) {
      color = new THREE.Color(0xaad4ff); // cool blue-white
    } else if (roll < 0.1) {
      color = new THREE.Color(0xffe4a8); // warm gold
    } else {
      const shade = THREE.MathUtils.lerp(0.45, 1.0, Math.random()); // dull grey → white
      color = new THREE.Color(shade, shade, shade);
    }
    colors[i * 3 + 0] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 1.5,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    fog: false,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return points;
}
