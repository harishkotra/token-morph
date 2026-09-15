import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { sampleScatterToParticles, type SampleResult } from './sampler';

export type Phase = 'idle' | 'calling' | 'laying-out' | 'morphing' | 'identical' | 'error';

/** Amber for the older model, teal for the newer one. */
const COLOR_A = new THREE.Color('#ffb454');
const COLOR_B = new THREE.Color('#4fd6c8');

/** Fixed pool. Every run reuses these particles; nothing is allocated mid-morph. */
const POOL_SIZE = 220_000;

const VERTEX_SHADER = /* glsl */ `
  precision highp float;

  attribute vec3 aTarget;
  attribute float aSeed;
  attribute float aActive;

  uniform float uProgress;    // 0 = layout A, 1 = layout B
  uniform float uTime;
  uniform float uBurst;       // 0..1 impulse envelope during the morph
  uniform float uBurstRadius;
  uniform float uSize;
  uniform float uPixelRatio;
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform float uSaturation;
  uniform float uOpacity;
  uniform float uFreeze;      // 1 = locked: particles are pinned to layout A

  varying vec3  vColor;
  varying float vAlpha;
  varying float vDisplacement;

  // Cheap 3D value noise, used only for the burst direction field.
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  void main() {
    // Where this particle sits right now, ignoring any impulse.
    vec3 base = mix(position, aTarget, uProgress);

    // Particles that do not exist in the incoming layout are pushed out of frame
    // rather than left sitting on top of the new text.
    float inactive = 1.0 - aActive;
    base += normalize(base + vec3(0.001)) * inactive * 90.0;

    // Burst impulse: radial kick, peaked at the midpoint of the morph.
    vec3 dir = normalize(base + vec3(0.001));
    float wobble = hash(vec3(aSeed * 91.7, aSeed * 13.3, uTime * 0.0));
    float impulse = uBurst * uBurstRadius * (0.45 + 0.55 * wobble);
    vec3 displaced = base + dir * impulse;

    // A little breathing motion so a frozen cloud still reads as alive, but the
    // particles' *positions* never change when frozen.
    float breathe = sin(uTime * 0.9 + aSeed * 6.2831) * 0.06 * (1.0 - uFreeze);
    displaced += dir * breathe;

    vDisplacement = length(displaced - base);

    vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float sizeAttenuation = 300.0 / max(-mvPosition.z, 0.001);
    gl_PointSize = uSize * uPixelRatio * clamp(sizeAttenuation, 0.35, 3.0);

    vec3 tint = mix(uColorA, uColorB, uProgress);
    // Desaturate toward luminance when locked.
    float lum = dot(tint, vec3(0.2126, 0.7152, 0.0722));
    vColor = mix(tint, vec3(lum), uSaturation);

    // Fade particles out as they are flung away by the burst.
    vAlpha = uOpacity * (1.0 - clamp(vDisplacement / (uBurstRadius * 1.6), 0.0, 0.75));
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    // Round, soft-edged point sprite.
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;
    float edge = smoothstep(0.5, 0.16, d);

    gl_FragColor = vec4(vColor, vAlpha * edge);
  }
`;

export interface LayoutHandle {
  sample: SampleResult;
  /** Particles in the pool that this layout activates. */
  activeCount: number;
}

export interface MorphOptions {
  durationMs: number;
  burstRadius: number;
}

export interface SceneStats {
  phase: Phase;
  /** How many particles are currently off their layout-A position. */
  movedParticles: number;
  /** Peak particle displacement observed this run, in world units. */
  maxDisplacement: number;
  fps: number;
}

export class ParticleScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly points: THREE.Points;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;

  private readonly positionAttr: THREE.BufferAttribute;
  private readonly targetAttr: THREE.BufferAttribute;
  private readonly activeAttr: THREE.BufferAttribute;

  private readonly basePositions: Float32Array;
  private readonly targetPositions: Float32Array;
  private readonly activeFlags: Float32Array;

  private frameHandle = 0;
  private disposed = false;

  private phase: Phase = 'idle';
  private clockStart = performance.now();
  private morphStart = 0;
  private morphDuration = 0;
  private morphing = false;
  private burstRadius = 0;

  private orbitSpeed = 0.045;
  private fpsSmoothed = 60;
  private lastFrameTime = performance.now();

  /** Particles that differ between the two layouts, counted once per morph. */
  private movedCount = 0;
  private peakDisplacement = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x07090c, 1);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x07090c, 0.011);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    this.camera.position.set(0, 0, 46);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 120;
    this.controls.enablePan = false;

    this.basePositions = sampleScatterToParticles(POOL_SIZE, 46);
    this.targetPositions = new Float32Array(this.basePositions);
    this.activeFlags = new Float32Array(POOL_SIZE).fill(1);

    this.geometry = new THREE.BufferGeometry();
    this.positionAttr = new THREE.BufferAttribute(this.basePositions, 3);
    this.targetAttr = new THREE.BufferAttribute(this.targetPositions, 3);
    this.activeAttr = new THREE.BufferAttribute(this.activeFlags, 1);
    this.positionAttr.setUsage(THREE.DynamicDrawUsage);
    this.targetAttr.setUsage(THREE.DynamicDrawUsage);
    this.activeAttr.setUsage(THREE.DynamicDrawUsage);

    const seeds = new Float32Array(POOL_SIZE);
    for (let i = 0; i < POOL_SIZE; i += 1) seeds[i] = Math.random();
    const seedAttr = new THREE.BufferAttribute(seeds, 1);

    this.geometry.setAttribute('position', this.positionAttr);
    this.geometry.setAttribute('aTarget', this.targetAttr);
    this.geometry.setAttribute('aActive', this.activeAttr);
    this.geometry.setAttribute('aSeed', seedAttr);
    this.geometry.setDrawRange(0, POOL_SIZE);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 200);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uProgress: { value: 0 },
        uTime: { value: 0 },
        uBurst: { value: 0 },
        uBurstRadius: { value: 0 },
        uSize: { value: 1.5 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        uColorA: { value: COLOR_A.clone() },
        uColorB: { value: COLOR_B.clone() },
        uSaturation: { value: 0 },
        uOpacity: { value: 0.92 },
        uFreeze: { value: 0 },
      },
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    this.resize();
    this.loop();
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    const width = parent?.clientWidth ?? window.innerWidth;
    const height = parent?.clientHeight ?? window.innerHeight;
    if (width === 0 || height === 0) return;

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.material.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio, 2);
  }

  /** Loads layout A into the live positions. The cloud snaps to it, then settles. */
  setLayoutA(sample: SampleResult): LayoutHandle {
    const count = Math.min(sample.count, POOL_SIZE);
    this.basePositions.set(sample.positions.subarray(0, count * 3));
    // Park the remaining pool far outside the view.
    for (let i = count; i < POOL_SIZE; i += 1) {
      this.basePositions[i * 3 + 0] = 400;
      this.basePositions[i * 3 + 1] = 400;
      this.basePositions[i * 3 + 2] = 400;
    }
    this.activeFlags.fill(0, 0, POOL_SIZE);
    this.activeFlags.fill(1, 0, count);

    this.targetPositions.set(this.basePositions);
    this.material.uniforms.uProgress.value = 0;
    this.material.uniforms.uFreeze.value = 0;
    this.material.uniforms.uSaturation.value = 0;
    this.material.uniforms.uBurst.value = 0;
    this.material.uniforms.uBurstRadius.value = 0;

    this.positionAttr.needsUpdate = true;
    this.targetAttr.needsUpdate = true;
    this.activeAttr.needsUpdate = true;

    this.phase = 'laying-out';
    this.movedCount = 0;
    this.peakDisplacement = 0;

    return { sample, activeCount: count };
  }

  /**
   * Freezes the cloud. Called when the two answers are byte-identical: the particles
   * are pinned to layout A and the shader is told never to move them.
   */
  lock(): void {
    this.morphing = false;
    this.phase = 'identical';
    this.material.uniforms.uFreeze.value = 1;
    this.material.uniforms.uSaturation.value = 0.55;
    this.material.uniforms.uBurst.value = 0;
    this.material.uniforms.uBurstRadius.value = 0;
    this.material.uniforms.uProgress.value = 0;
    this.targetPositions.set(this.basePositions);
    this.targetAttr.needsUpdate = true;
    // Stop the camera too. "The particles do not move" has to be literally true,
    // so nothing in the frame is allowed to drift — including the viewpoint.
    this.orbitSpeed = 0;
    this.movedCount = 0;
    this.peakDisplacement = 0;
  }

  /**
   * Morphs the live cloud from layout A to layout B.
   *
   * Counts how many particles actually have a different destination, so the
   * "particles moved" readout is a measurement, not a decoration.
   */
  morphTo(sample: SampleResult, options: MorphOptions): void {
    const count = Math.min(sample.count, POOL_SIZE);

    this.targetPositions.set(sample.positions.subarray(0, count * 3));
    for (let i = count; i < POOL_SIZE; i += 1) {
      this.targetPositions[i * 3 + 0] = 400;
      this.targetPositions[i * 3 + 1] = 400;
      this.targetPositions[i * 3 + 2] = 400;
    }

    // Measure the real movement: a particle counts as moved when its destination
    // differs from its origin by more than a pixel-scale epsilon.
    let moved = 0;
    for (let i = 0; i < POOL_SIZE; i += 1) {
      const dx = this.targetPositions[i * 3 + 0] - this.basePositions[i * 3 + 0];
      const dy = this.targetPositions[i * 3 + 1] - this.basePositions[i * 3 + 1];
      const dz = this.targetPositions[i * 3 + 2] - this.basePositions[i * 3 + 2];
      if (dx * dx + dy * dy + dz * dz > 0.0004) moved += 1;
    }
    this.movedCount = moved;

    this.activeFlags.fill(0, 0, POOL_SIZE);
    this.activeFlags.fill(1, 0, Math.max(count, this.countActiveA()));

    this.targetAttr.needsUpdate = true;
    this.activeAttr.needsUpdate = true;

    this.morphStart = performance.now();
    this.morphDuration = options.durationMs;
    this.burstRadius = options.burstRadius;
    this.morphing = true;
    this.phase = 'morphing';
    this.material.uniforms.uFreeze.value = 0;
    this.material.uniforms.uSaturation.value = 0;
    this.material.uniforms.uBurstRadius.value = options.burstRadius;
    this.orbitSpeed = 0.11;
  }

  private countActiveA(): number {
    let n = 0;
    for (let i = 0; i < POOL_SIZE; i += 1) if (this.activeFlags[i] > 0.5) n += 1;
    return n;
  }

  setPhase(phase: Phase): void {
    this.phase = phase;
  }

  /** Snaps the camera back to the framing used at the start of a run. */
  resetCamera(): void {
    this.camera.position.set(0, 0, 46);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  getStats(): SceneStats {
    return {
      phase: this.phase,
      movedParticles: this.movedCount,
      maxDisplacement: this.peakDisplacement,
      fps: Math.round(this.fpsSmoothed),
    };
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.frameHandle = requestAnimationFrame(this.loop);

    const now = performance.now();
    const dt = Math.min((now - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = now;
    if (dt > 0) this.fpsSmoothed += ((1 / dt) - this.fpsSmoothed) * 0.08;

    const elapsed = (now - this.clockStart) / 1000;
    this.material.uniforms.uTime.value = elapsed;

    if (this.morphing) {
      const t = Math.min((now - this.morphStart) / this.morphDuration, 1);
      // easeInOutCubic: slow out of A, fast through the middle, settle into B.
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.material.uniforms.uProgress.value = eased;

      // Burst envelope peaks at the midpoint of the morph.
      const burst = Math.sin(Math.PI * t) ** 2;
      this.material.uniforms.uBurst.value = burst;

      this.peakDisplacement = Math.max(this.peakDisplacement, burst * this.burstRadius);

      if (t >= 1) {
        this.morphing = false;
        this.phase = 'idle';
        this.material.uniforms.uProgress.value = 1;
        this.material.uniforms.uBurst.value = 0;
        // The morph is done: B is now the resting layout.
        this.basePositions.set(this.targetPositions);
        this.positionAttr.needsUpdate = true;
        this.orbitSpeed = 0.045;
      }
    }

    // Slow orbit during a run; OrbitControls still allows manual inspection.
    this.controls.autoRotate = false;
    this.controls.update();

    if (this.phase !== 'idle' || this.morphing) {
      const angle = this.orbitSpeed * dt;
      const x = this.camera.position.x;
      const z = this.camera.position.z;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      this.camera.position.x = x * cos - z * sin;
      this.camera.position.z = x * sin + z * cos;
      this.camera.lookAt(this.controls.target);
    }

    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.controls.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
  }
}

export { POOL_SIZE, COLOR_A, COLOR_B };