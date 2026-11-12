/**
 * Going Once — 3D saleroom moments.
 *
 * Framework-free: import it from Vite, Next.js or anything else. It only reacts
 * to events. It knows nothing about money, bids or PayPal and never sends
 * anything out.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import {
  Spring,
  Timeline,
  Tween,
  easeInCubic,
  easeInOutCubic,
  easeOutCubic,
  linear,
} from "./anim";
import { ATLAS_SLOTS, PaddleAtlas, cleanLabel } from "./paddleAtlas";

// ---------------------------------------------------------------------------
// Public API (integration contract — keep stable)
// ---------------------------------------------------------------------------

export interface Stage3DOptions {
  /** URL of saleroom.glb */
  modelUrl: string;
  /** When true: no camera moves, no strikes, only instant fades. */
  reducedMotion?: boolean;
  /** "high" | "low" — low halves pixel ratio, drops post-processing and haze. */
  quality?: "high" | "low";
}

export type Stage3DEvent =
  | { type: "lot_opened"; lotNumber: number; lotTitle: string }
  | { type: "bid"; paddle: number; label: string; isBot: boolean; isLeader: true }
  | { type: "outbid"; paddle: number }
  | { type: "going_once" }
  | { type: "going_twice" }
  | { type: "hammer"; paddle: number; label: string } // the gavel strikes
  | { type: "sold_confirmed" } // PayPal capture COMPLETED
  | { type: "lot_passed" }
  | { type: "paused" }
  | { type: "resumed" };

export interface Stage3D {
  handle(event: Stage3DEvent): void;
  resize(width: number, height: number): void;
  setQuality(q: "high" | "low"): void;
  dispose(): void; // free GPU memory, stop the render loop, remove listeners
  readonly ready: Promise<void>; // resolves when the model has loaded
}

/** Not part of the contract: read-only numbers for the playground's readout. */
export interface Stage3DStats {
  fps: number;
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  rendering: "continuous" | "idle-15fps" | "stopped";
}

export function getStage3DStats(stage: Stage3D): Stage3DStats | null {
  return stage instanceof SaleroomStage ? stage.stats() : null;
}

export function createStage3D(canvas: HTMLCanvasElement, opts: Stage3DOptions): Stage3D {
  try {
    return new SaleroomStage(canvas, opts);
  } catch (err) {
    return inertStage(
      new Error(`Stage3D: WebGL is unavailable (${err instanceof Error ? err.message : String(err)})`),
    );
  }
}

function inertStage(error: Error): Stage3D {
  const ready = Promise.reject(error);
  ready.catch(() => undefined); // the host decides whether to log it
  return {
    handle: () => undefined,
    resize: () => undefined,
    setQuality: () => undefined,
    dispose: () => undefined,
    ready,
  };
}

// ---------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------

const C = {
  velvet: new THREE.Color("#2B0A1D"),
  curtain: new THREE.Color("#4A1430"),
  brass: new THREE.Color("#D4A23F"),
  parchment: new THREE.Color("#F6EDDC"),
  smoke: new THREE.Color("#B79AA6"),
};
const SPOT_COLOR = C.parchment.clone().lerp(C.brass, 0.45);

// Room layout (three.js units, Y up; the audience looks toward -Z)
const CAM_REST = new THREE.Vector3(-0.5, 1.1, 7.6);
const CAM_WIDE = new THREE.Vector3(-0.9, 1.45, 9.0);
const CAM_LOOK = new THREE.Vector3(-0.35, 1.38, -2.0);
const SPOT_POS = new THREE.Vector3(0.4, 7.4, 2.4);
const SPOT_ANGLE = 0.2;
const SPOT_MAX = 190;
const HEMI = 1.3;
const RIM = 1.5; // front-side warm wash: gives the curtain folds and chairs their shape
const ENV = 0.18;

const POOL = ATLAS_SLOTS; // 24 paddles
const PADDLE_SCALE = 1.1;
const FACE_CENTER = 0.39; // metres above the handle end, unscaled
const H_RAISED = 1.22;
const H_LOWERED = 0.42;
const H_HIDDEN = 0.05;
const PADDLE_ROWS = 4; // paddles come from the four rows nearest the stage
const IDLE_AFTER = 10;
const MATTE = new Set(["Velvet", "Curtain", "Carpet", "DarkWood"]); // seconds without events before throttling

type SlotState = "hidden" | "raised" | "lowered";

interface Slot {
  index: number;
  paddle: number | null;
  label: string;
  isBot: boolean;
  chair: number;
  state: SlotState;
  height: Spring;
  tilt: Spring;
  alpha: Tween;
  dim: Tween;
  glow: Tween;
  roll: number;
  lastUsed: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class SaleroomStage implements Stage3D {
  readonly ready: Promise<void>;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 60);
  private reduced: boolean;
  private quality: "high" | "low";
  private width = 1;
  private height = 1;

  private dead = false;
  private loaded = false;
  private preReady: Stage3DEvent[] = [];
  private raf = 0;
  private lastFrame = -1;
  private lastRender = -1;
  private clock = 0; // seconds of animation time
  private lastEventAt = 0;
  private renderMode: Stage3DStats["rendering"] = "stopped";
  private frameTimes: number[] = [];
  private lastInfo = { calls: 0, triangles: 0 };

  private timeline = new Timeline();
  private disposables: { dispose(): void }[] = [];

  // Lights
  private hemi = new THREE.HemisphereLight(C.smoke.clone().lerp(C.parchment, 0.4), C.velvet, HEMI);
  private rim = new THREE.DirectionalLight(C.parchment.clone().lerp(C.brass, 0.35), RIM);
  private spot = new THREE.SpotLight(SPOT_COLOR, 0, 0, SPOT_ANGLE, 0.55, 2);
  private flashLight = new THREE.PointLight(C.brass, 0, 4, 2);

  // Haze
  private haze!: THREE.Mesh<THREE.ConeGeometry, THREE.ShaderMaterial>;
  private dust!: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private hazeTime = 0;

  // Sprites (camera-facing additive quads)
  private halo!: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private flashSprite!: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

  // Animated values
  private spotLevel = new Tween(0.55);
  private spotWidth = new Tween(1);
  private house = new Tween(1);
  private drift = new Tween(1);
  private curtains = new Tween(0);
  private camWide = new Tween(1);
  private camPush = new Tween(0);
  private haloLevel = new Tween(0);
  private flash = new Tween(0);
  private tint = new Tween(0); // reduced-motion stand-in for the flash
  private gavelAngle = new Tween(0);
  private focus = { x: new Spring(0, 1.25, 1), y: new Spring(0, 1.25, 1), z: new Spring(0, 1.25, 1) };

  // Scene objects
  private gavel: THREE.Object3D | null = null;
  private gavelRest = new THREE.Quaternion();
  private curtainL: THREE.Object3D | null = null;
  private curtainR: THREE.Object3D | null = null;
  private curtainLX = 0;
  private curtainRX = 0;
  private lecternFocus = new THREE.Vector3(1.8, 1.62, -2.6);
  private blockPos = new THREE.Vector3(1.94, 1.6, -2.54);

  // Paddles
  private atlas: PaddleAtlas;
  private paddleParts: { mesh: THREE.InstancedMesh; offset: THREE.Matrix4 }[] = [];
  private alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(POOL), 1).setUsage(THREE.DynamicDrawUsage);
  private slots: Slot[] = [];
  private seats: THREE.Vector3[] = [];
  private preferredSeats = 1;
  private leader: Slot | null = null;
  private winner: Slot | null = null;
  private paddlesDirty = true;

  private onContextLost = (e: Event): void => {
    e.preventDefault();
    this.stopLoop();
  };
  private onContextRestored = (): void => this.wake();

  constructor(
    private canvas: HTMLCanvasElement,
    opts: Stage3DOptions,
  ) {
    this.reduced = !!opts.reducedMotion;
    this.quality = opts.quality === "low" ? "low" : "high";

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.45;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = true;
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);

    this.atlas = new PaddleAtlas(this.renderer.capabilities.getMaxAnisotropy());
    this.buildEnvironment();
    this.buildLights();
    this.buildHaze();
    this.buildSprites();
    this.applyQuality();

    const rect = canvas.getBoundingClientRect();
    this.resize(rect.width || canvas.width || 1280, rect.height || canvas.height || 720);

    this.ready = this.load(opts.modelUrl);
    this.ready.catch(() => undefined);
  }

  // ----- public ------------------------------------------------------------

  handle(event: Stage3DEvent): void {
    if (this.dead || !event || typeof event !== "object") return;
    if (!this.loaded) {
      this.preReady.push(event);
      if (this.preReady.length > 40) this.preReady.shift();
      return;
    }
    this.lastEventAt = this.clock;
    switch (event.type) {
      case "lot_opened":
        this.onLotOpened();
        break;
      case "bid":
        if (validPaddle(event.paddle)) this.onBid(event.paddle, cleanLabel(event.label), event.isBot === true);
        break;
      case "outbid":
        if (validPaddle(event.paddle)) this.onOutbid(event.paddle);
        break;
      case "going_once":
        this.onTension(0.86, 0.35);
        break;
      case "going_twice":
        this.onTension(0.74, 0.1);
        break;
      case "hammer":
        if (validPaddle(event.paddle)) this.onHammer(event.paddle, cleanLabel(event.label));
        break;
      case "sold_confirmed":
        this.onSoldConfirmed();
        break;
      case "lot_passed":
        this.onLotPassed();
        break;
      case "paused":
        this.house.set(0.5, 0.6);
        break;
      case "resumed":
        this.house.set(1, 0.6);
        break;
      default:
        return;
    }
    this.wake();
  }

  resize(width: number, height: number): void {
    if (this.dead) return;
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.applyPixelRatio();
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.wake(true);
  }

  setQuality(q: "high" | "low"): void {
    if (this.dead) return;
    this.quality = q === "low" ? "low" : "high";
    this.applyQuality();
    this.applyPixelRatio();
    this.renderer.setSize(this.width, this.height, false);
    this.wake(true);
  }

  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    this.stopLoop();
    this.timeline.clear();
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    const texs = new Set<THREE.Texture>();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) geos.add(m.geometry);
      const mm = m.material as THREE.Material | THREE.Material[] | undefined;
      if (mm) (Array.isArray(mm) ? mm : [mm]).forEach((x) => mats.add(x));
      if (o instanceof THREE.InstancedMesh) o.dispose();
      if (o instanceof THREE.Light) o.dispose(); // frees shadow-map render targets
    });
    for (const mat of mats) {
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) texs.add(v);
      mat.dispose();
    }
    geos.forEach((g) => g.dispose());
    texs.forEach((t) => t.dispose());
    this.atlas.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.scene.environment = null;
    this.scene.clear();
    this.slots = [];
    this.paddleParts = [];
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
  }

  stats(): Stage3DStats {
    const now = performance.now();
    this.frameTimes = this.frameTimes.filter((t) => now - t < 1000);
    const mem = this.renderer.info.memory;
    // Render rate over the last second, from frame intervals (so a window that
    // started while idle does not under-report).
    const ft = this.frameTimes;
    const span = ft.length > 1 ? ft[ft.length - 1]! - ft[0]! : 0;
    const fps = span > 0 ? Math.round(((ft.length - 1) * 1000) / span) : 0;
    return {
      fps,
      calls: this.lastInfo.calls,
      triangles: this.lastInfo.triangles,
      geometries: mem.geometries,
      textures: mem.textures,
      rendering: this.raf ? this.renderMode : "stopped",
    };
  }

  // ----- setup -------------------------------------------------------------

  private buildEnvironment(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    const target = pmrem.fromScene(room, 0.04);
    room.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose?.();
    });
    pmrem.dispose();
    this.disposables.push(target);
    this.scene.environment = target.texture;
    this.scene.environmentIntensity = ENV;
    this.scene.fog = new THREE.Fog(C.velvet, 16, 34);
  }

  private buildLights(): void {
    this.rim.position.set(-5, 6, 7);
    this.spot.position.copy(SPOT_POS);
    this.spot.shadow.mapSize.set(1024, 1024);
    this.spot.shadow.bias = -0.0004;
    this.spot.shadow.normalBias = 0.02;
    this.spot.shadow.camera.near = 3;
    this.spot.shadow.camera.far = 16;
    this.scene.add(this.hemi, this.rim, this.spot, this.spot.target, this.flashLight);
  }

  private buildHaze(): void {
    const geo = new THREE.ConeGeometry(1, 1, 40, 1, true);
    geo.translate(0, -0.5, 0); // apex at the origin, base at y = -1
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: SPOT_COLOR.clone().lerp(C.smoke, 0.3) },
        uOpacity: { value: 0 },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying float vT; varying float vAng; varying vec3 vN; varying vec3 vV;
        void main() {
          vT = -position.y;
          vAng = atan(position.x, position.z);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vV = normalize(-mv.xyz);
          vN = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uOpacity; uniform float uTime;
        varying float vT; varying float vAng; varying vec3 vN; varying vec3 vV;
        void main() {
          float facing = pow(abs(dot(normalize(vN), normalize(vV))), 1.8);
          float along = smoothstep(0.0, 0.12, vT) * (1.0 - smoothstep(0.7, 1.0, vT)) * mix(1.0, 0.5, vT);
          float drift = 0.78 + 0.22 * sin(vAng * 5.0 + uTime * 0.4 + vT * 7.0) * sin(vT * 11.0 - uTime * 0.55);
          gl_FragColor = vec4(uColor, facing * along * drift * uOpacity);
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.haze = new THREE.Mesh(geo, mat);
    this.haze.renderOrder = 10;
    this.haze.frustumCulled = false;

    const N = 260;
    const seeds = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) seeds[i] = Math.random();
    const dg = new THREE.BufferGeometry();
    dg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    dg.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 3));
    const dm = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uSize: { value: 26 },
        uColor: { value: C.smoke.clone() },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aSeed; uniform float uTime; uniform float uSize; varying float vA;
        void main() {
          float t = fract(aSeed.x + uTime * 0.01 * (0.4 + aSeed.z));
          float ang = aSeed.y * 6.2831 + uTime * 0.04 * (aSeed.z - 0.5);
          float r = sqrt(aSeed.z) * t * 0.85;
          vec3 p = vec3(cos(ang) * r, -t, sin(ang) * r);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * (0.5 + aSeed.z) / -mv.z;
          vA = smoothstep(0.08, 0.25, t) * (1.0 - smoothstep(0.75, 1.0, t));
        }`,
      fragmentShader: /* glsl */ `
        uniform float uOpacity; uniform vec3 uColor; varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(uColor, smoothstep(0.5, 0.0, d) * vA * uOpacity);
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.dust = new THREE.Points(dg, dm);
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 11;
    this.haze.add(this.dust);
    this.scene.add(this.haze);
  }

  private buildSprites(): void {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    if (g) {
      const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grd.addColorStop(0, "rgba(255,255,255,1)");
      grd.addColorStop(0.35, "rgba(255,255,255,0.45)");
      grd.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grd;
      g.fillRect(0, 0, 128, 128);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mk = (size: number): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({
          map: tex,
          color: C.brass,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          fog: false,
          toneMapped: false,
        }),
      );
      m.visible = false;
      m.renderOrder = 5;
      this.scene.add(m);
      return m;
    };
    this.halo = mk(1.25);
    this.flashSprite = mk(0.9);
  }

  private async load(url: string): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    let gltf;
    try {
      gltf = await loader.loadAsync(url);
    } catch (err) {
      this.failLoad(new Error(`Stage3D: could not load model "${url}" (${err instanceof Error ? err.message : String(err)})`));
      throw this.loadError;
    }
    if (this.dead) {
      disposeObject(gltf.scene);
      throw new Error("Stage3D: disposed before the model finished loading");
    }
    try {
      this.setupModel(gltf.scene);
    } catch (err) {
      disposeObject(gltf.scene);
      this.failLoad(new Error(`Stage3D: model is missing parts (${err instanceof Error ? err.message : String(err)})`));
      throw this.loadError;
    }
    this.loaded = true;
    this.warmUp();
    this.focusSnap(this.lecternFocus);
    const queued = this.preReady;
    this.preReady = [];
    queued.forEach((e) => this.handle(e));
    this.lastEventAt = this.clock;
    this.wake(true);
  }

  /**
   * Compile every program (including hidden sprites, haze and shadow passes)
   * and upload every texture now, so the first bid or hammer never stalls.
   */
  private warmUp(): void {
    const hidden: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    const castShadow = this.spot.castShadow;
    this.spot.castShadow = true;
    this.renderer.compile(this.scene, this.camera);
    this.renderer.initTexture(this.atlas.texture);
    this.atlas.takeDirty();
    this.renderer.render(this.scene, this.camera); // also builds the shadow programs
    this.spot.castShadow = castShadow;
    hidden.forEach((o) => (o.visible = false));
    this.renderer.shadowMap.needsUpdate = true;
  }

  private loadError: Error | null = null;
  private failLoad(err: Error): void {
    this.loadError = err;
    this.dispose(); // every method becomes a no-op; the 2D stage carries on alone
  }

  private setupModel(root: THREE.Object3D): void {
    this.scene.add(root);
    root.updateMatrixWorld(true);
    const need = (name: string): THREE.Object3D => {
      const o = root.getObjectByName(name);
      if (!o) throw new Error(`no object named "${name}"`);
      return o;
    };
    const paddle = need("Paddle");
    this.gavel = need("Gavel");
    const block = need("SoundBlock");
    const lectern = need("Lectern");
    this.curtainL = root.getObjectByName("Curtain_L") ?? null;
    this.curtainR = root.getObjectByName("Curtain_R") ?? null;
    this.curtainLX = this.curtainL?.position.x ?? 0;
    this.curtainRX = this.curtainR?.position.x ?? 0;
    this.gavelRest.copy(this.gavel.quaternion);

    const box = new THREE.Box3().setFromObject(lectern);
    this.lecternFocus.set((box.min.x + box.max.x) / 2, box.max.y + 0.05, (box.min.z + box.max.z) / 2);
    new THREE.Box3().setFromObject(block).getCenter(this.blockPos);
    this.blockPos.y += 0.05;
    this.flashLight.position.copy(this.blockPos).add(new THREE.Vector3(-0.1, 0.5, 0.1));
    this.flashSprite.position.copy(this.blockPos);

    // Matte room dressing uses cheap Lambert shading; brass, wood and the
    // paddle faces keep physically based shading.
    const lambert = new Map<string, THREE.MeshLambertMaterial>();
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const src = m.material as THREE.MeshStandardMaterial;
      if (MATTE.has(src.name)) {
        let l = lambert.get(src.name);
        if (!l) {
          l = new THREE.MeshLambertMaterial({ name: src.name, color: src.color });
          lambert.set(src.name, l);
        }
        src.dispose();
        m.material = l;
      }
      m.castShadow = false;
      m.receiveShadow = false;
    });
    // Shadows: only what matters under the one spotlight.
    const receivers = ["Stage", "Curtain_L", "Curtain_R", "Lectern", "SoundBlock"];
    for (const n of receivers) root.getObjectByName(n)?.traverse((x) => ((x as THREE.Mesh).isMesh ? ((x as THREE.Mesh).receiveShadow = true) : 0));
    for (const o of [lectern, this.gavel, block]) o.traverse((x) => ((x as THREE.Mesh).isMesh ? ((x as THREE.Mesh).castShadow = true) : 0));

    this.instanceChairs(root);
    this.buildPaddlePool(paddle);
    paddle.removeFromParent();
  }

  /** Linked-duplicate chairs from Blender become one InstancedMesh per material. */
  private instanceChairs(root: THREE.Object3D): void {
    const chairs: THREE.Object3D[] = [];
    root.traverse((o) => {
      if (/^Chair\d*$/.test(o.name)) chairs.push(o);
    });
    if (chairs.length === 0) return;
    const parts = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material; matrices: THREE.Matrix4[] }>();
    for (const chair of chairs) {
      chair.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = m.material as THREE.Material;
        const k = `${m.geometry.uuid}|${mat.uuid}`;
        let p = parts.get(k);
        if (!p) parts.set(k, (p = { geo: m.geometry, mat, matrices: [] }));
        p.matrices.push(m.matrixWorld.clone());
      });
      const seat = new THREE.Vector3().setFromMatrixPosition(chair.matrixWorld);
      this.seats.push(seat);
    }
    chairs.forEach((c) => c.removeFromParent());
    for (const p of parts.values()) {
      const im = new THREE.InstancedMesh(p.geo, p.mat, p.matrices.length);
      p.matrices.forEach((m, i) => im.setMatrixAt(i, m));
      im.instanceMatrix.needsUpdate = true;
      im.receiveShadow = false;
      im.castShadow = false;
      im.name = "Chairs";
      this.scene.add(im);
    }
    // Paddles rise from the rows nearest the stage (camera is behind row 5).
    const rows = [...new Set(this.seats.map((s) => s.z.toFixed(2)))].map(Number).sort((a, b) => a - b);
    const allowed = new Set(rows.slice(0, PADDLE_ROWS).map((r) => r.toFixed(2)));
    // Prefer seats right of the aisle: they sit beside the lectern, clear of
    // the centred price. Left seats are overflow when many paddles are up.
    const near = this.seats.filter((s) => allowed.has(s.z.toFixed(2)));
    const right = near.filter((s) => s.x > 0).sort((a, b) => a.z - b.z || a.x - b.x);
    const left = near.filter((s) => s.x <= 0).sort((a, b) => a.z - b.z || b.x - a.x);
    this.seats = [...right, ...left];
    this.preferredSeats = Math.max(1, right.length);
  }

  private buildPaddlePool(paddle: THREE.Object3D): void {
    const inv = new THREE.Matrix4().copy(paddle.matrixWorld).invert();
    const slotAttr = new THREE.InstancedBufferAttribute(new Float32Array(POOL * 2), 2);
    for (let i = 0; i < POOL; i++) {
      const [u, v] = PaddleAtlas.slotOffset(i);
      slotAttr.setXY(i, u, v);
    }
    paddle.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const src = m.material as THREE.MeshStandardMaterial;
      const isFace = src.name === "PaddleFace";
      const geo = m.geometry.clone();
      geo.setAttribute("aAlpha", this.alphaAttr);
      if (isFace) geo.setAttribute("aSlot", slotAttr);
      let mat: THREE.MeshStandardMaterial;
      if (isFace) {
        mat = new THREE.MeshStandardMaterial({ name: "PaddleFace", map: this.atlas.texture, roughness: 0.72, metalness: 0 });
      } else {
        mat = src.clone(); // do not patch the lectern's shared wood/brass
      }
      patchInstanced(mat, isFace);
      const im = new THREE.InstancedMesh(geo, mat, POOL);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      im.castShadow = true;
      im.name = `PaddlePool_${mat.name || "part"}`;
      const white = new THREE.Color(1, 1, 1);
      for (let i = 0; i < POOL; i++) im.setColorAt(i, white);
      // Updated on every bid: tell the driver (ANGLE/D3D11 otherwise promotes
      // idle "static" buffers and stalls when they change again).
      im.instanceColor?.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(im);
      this.paddleParts.push({ mesh: im, offset: new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld) });
    });
    if (!this.paddleParts.some((p) => p.mesh.name === "PaddlePool_PaddleFace")) {
      throw new Error('Paddle has no "PaddleFace" material slot');
    }
    for (let i = 0; i < POOL; i++) {
      this.slots.push({
        index: i,
        paddle: null,
        label: "",
        isBot: false,
        chair: i,
        state: "hidden",
        height: new Spring(H_HIDDEN, 1.55, 0.52),
        tilt: new Spring(0, 1.3, 0.45),
        alpha: new Tween(0),
        dim: new Tween(0),
        glow: new Tween(0),
        roll: ((i * 37) % 11) / 11 - 0.5,
        lastUsed: -1,
      });
    }
    this.paddlesDirty = true;
  }

  // ----- quality / sizing --------------------------------------------------

  private applyPixelRatio(): void {
    const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2);
    this.renderer.setPixelRatio(this.quality === "low" ? dpr / 2 : dpr);
  }

  private applyQuality(): void {
    const high = this.quality === "high";
    this.haze.visible = high;
    this.spot.castShadow = high;
    this.renderer.shadowMap.needsUpdate = true;
  }

  // ----- choreography ------------------------------------------------------

  private onLotOpened(): void {
    this.timeline.clear();
    this.leader = null;
    this.winner = null;
    for (const s of this.slots) if (s.state !== "hidden") this.hideSlot(s, true);
    this.focusTo(this.lecternFocus);
    this.spotLevel.set(1, 1.2, easeInOutCubic);
    this.spotWidth.set(1, 0.6);
    this.drift.set(1, 0.6);
    this.haloLevel.set(0, 0.3);
    this.flash.set(0, 0);
    this.tint.set(0, 0.2);
    this.gavelAngle.set(0, this.reduced ? 0 : 0.3);
    this.curtains.set(1, 1.2, easeInOutCubic);
    if (!this.reduced) {
      this.camWide.set(0, 1.2, easeInOutCubic);
      this.camPush.set(0, 1.2, easeInOutCubic);
    } else {
      this.camWide.set(0, 0);
      this.camPush.set(0, 0);
    }
  }

  private onBid(paddle: number, label: string, isBot: boolean): void {
    // A bid after "going once" releases the tension.
    this.spotWidth.set(1, 0.4);
    this.drift.set(1, 0.6);
    this.timeline.cancel("strike");
    this.timeline.cancel("sold");
    this.winner = null;
    const slot = this.acquire(paddle);
    slot.label = label;
    slot.isBot = isBot;
    this.atlas.draw(slot.index, { paddle, label, isBot });
    this.raise(slot);
    this.haloLevel.set(0.55, this.reduced ? 0.2 : 0.35);
  }

  private onOutbid(paddle: number): void {
    const slot = this.slots.find((s) => s.paddle === paddle && s.state !== "hidden");
    if (!slot) return;
    if (this.leader === slot) {
      this.leader = null;
      this.focusTo(this.lecternFocus);
      this.haloLevel.set(0, 0.4);
    }
    this.lower(slot, true);
  }

  private onTension(width: number, drift: number): void {
    this.spotWidth.set(width, 0.5, easeInOutCubic);
    this.drift.set(drift, 0.5);
  }

  private onHammer(paddle: number, label: string): void {
    this.timeline.cancel("strike");
    let slot = this.slots.find((s) => s.paddle === paddle && s.state !== "hidden") ?? null;
    if (!slot || this.leader !== slot) {
      slot = this.acquire(paddle);
      if (label) slot.label = label;
      this.atlas.draw(slot.index, { paddle, label: slot.label, isBot: slot.isBot });
      this.raise(slot);
    }
    this.winner = slot;
    this.haloLevel.set(0.7, 0.2);
    this.drift.set(0, 0.15);
    this.timeline.cancel(`hide:${slot.index}`);

    // 300 ms of stillness, then the strike.
    if (this.reduced) {
      this.timeline.schedule("strike:tint", 0.3, () => {
        this.tint.set(1, 0.2, linear);
        this.timeline.schedule("strike:tintOff", 0.9, () => this.tint.set(0, 0.5));
      });
      return;
    }
    this.timeline.schedule("strike:lift", 0.3, () => this.gavelAngle.set(0.62, 0.17, easeOutCubic));
    this.timeline.schedule("strike:down", 0.47, () => this.gavelAngle.set(0, 0.085, easeInCubic));
    this.timeline.schedule("strike:impact", 0.555, () => {
      this.flash.set(1, 0, linear);
      this.flash.set(0, 0.5, easeOutCubic);
      this.camPush.set(1, 0.6, easeOutCubic);
      this.gavelAngle.set(0.09, 0.07, easeOutCubic);
      this.timeline.schedule("strike:settle", 0.07, () => this.gavelAngle.set(0, 0.2, easeInOutCubic));
    });
  }

  private onSoldConfirmed(): void {
    const w = this.winner ?? this.leader;
    if (w) {
      w.glow.set(1, 0.3, easeOutCubic);
      this.haloLevel.set(1, 0.3, easeOutCubic);
    }
    this.timeline.cancel("sold");
    this.timeline.schedule("sold:ease", 0.6, () => {
      for (const s of this.slots) if (s.state !== "hidden") this.hideSlot(s, false, 0.9);
      this.leader = null;
      this.winner = null;
      this.haloLevel.set(0, 0.9);
      this.focusTo(this.lecternFocus);
      this.spotLevel.set(0.55, 0.9);
      this.spotWidth.set(1, 0.9);
      this.drift.set(1, 0.9);
      this.curtains.set(0, 0.9);
      if (!this.reduced) {
        this.camPush.set(0, 0.9);
        this.camWide.set(1, 0.9);
      }
    });
  }

  private onLotPassed(): void {
    this.timeline.cancel("strike");
    this.timeline.cancel("sold");
    this.spotLevel.set(0.5, 0.8);
    this.haloLevel.set(0, 0.5);
    for (const s of this.slots) if (s.state !== "hidden") this.hideSlot(s, false, 0.8);
    this.leader = null;
    this.winner = null;
    this.focusTo(this.lecternFocus);
    this.curtains.set(0, 0.8);
    this.spotWidth.set(1, 0.8);
    this.drift.set(1, 0.8);
  }

  // ----- paddle pool -------------------------------------------------------

  private acquire(paddle: number): Slot {
    let slot = this.slots.find((s) => s.paddle === paddle);
    if (!slot) {
      const free = this.slots.filter((s) => s.state === "hidden" && s.alpha.value === 0 && s !== this.leader);
      const pickFrom = free.length ? free : this.slots.filter((s) => s !== this.leader);
      slot = pickFrom.reduce((a, b) => (a.lastUsed <= b.lastUsed ? a : b));
      if (slot.state !== "hidden") {
        // Pool exhausted: recycle the oldest paddle instantly.
        slot.alpha.set(0, 0);
        slot.state = "hidden";
      }
      slot.paddle = paddle;
      slot.chair = this.chairFor(paddle, slot);
    }
    slot.lastUsed = this.clock;
    this.timeline.cancel(`hide:${slot.index}`);
    return slot;
  }

  private chairFor(paddle: number, self: Slot): number {
    const n = Math.max(1, this.seats.length);
    const taken = new Set(this.slots.filter((s) => s !== self && s.state !== "hidden").map((s) => s.chair));
    let c = (paddle * 7 + 3) % Math.min(n, this.preferredSeats);
    for (let i = 0; i < n && taken.has(c); i++) c = (c + 1) % n;
    return c;
  }

  private raise(slot: Slot): void {
    const prev = this.leader;
    if (prev && prev !== slot && prev.state === "raised") this.lower(prev, false);
    this.leader = slot;
    this.timeline.cancel(`hide:${slot.index}`);
    if (slot.alpha.value === 0 || slot.state === "hidden") {
      slot.height.snap(H_HIDDEN);
      slot.dim.set(0, 0);
      slot.glow.set(0, 0);
    }
    slot.state = "raised";
    slot.dim.set(0, 0.2);
    slot.glow.set(0, 0.2);
    if (this.reduced) {
      slot.height.snap(H_RAISED);
      slot.tilt.snap(0);
      slot.alpha.set(1, 0.2, linear);
    } else {
      slot.height.target = H_RAISED;
      slot.tilt.target = 0;
      slot.tilt.velocity -= 2.2; // a little flick as the arm goes up
      slot.alpha.set(1, 0.12, linear);
    }
    this.focusTo(this.faceWorld(slot, H_RAISED));
    this.paddlesDirty = true;
  }

  private lower(slot: Slot, dim: boolean): void {
    if (slot.state === "hidden") return;
    slot.state = "lowered";
    if (this.reduced) slot.height.snap(H_LOWERED);
    else slot.height.target = H_LOWERED;
    if (dim) slot.dim.set(1, 0.4, easeOutCubic);
    slot.glow.set(0, 0.3);
    this.timeline.schedule(`hide:${slot.index}`, 4, () => this.hideSlot(slot, false));
    this.paddlesDirty = true;
  }

  private hideSlot(slot: Slot, quick: boolean, dur = 0.5): void {
    this.timeline.cancel(`hide:${slot.index}`);
    slot.state = "hidden";
    slot.glow.set(0, quick ? 0.15 : dur * 0.6);
    if (this.reduced) {
      slot.alpha.set(0, 0.2, linear);
    } else {
      slot.height.target = H_HIDDEN;
      slot.alpha.set(0, quick ? 0.2 : dur, easeInCubic);
    }
    if (this.leader === slot) this.leader = null;
    this.paddlesDirty = true;
  }

  private seatOf(slot: Slot): THREE.Vector3 {
    return this.seats[slot.chair % Math.max(1, this.seats.length)] ?? new THREE.Vector3(0, 0, 2);
  }

  private faceWorld(slot: Slot, h: number): THREE.Vector3 {
    const s = this.seatOf(slot);
    return new THREE.Vector3(s.x + 0.12, h + FACE_CENTER * PADDLE_SCALE, s.z);
  }

  // ----- focus (spotlight target) -----------------------------------------

  private focusTo(p: THREE.Vector3): void {
    if (this.reduced) return this.focusSnap(p);
    this.focus.x.target = p.x;
    this.focus.y.target = p.y;
    this.focus.z.target = p.z;
  }

  private focusSnap(p: THREE.Vector3): void {
    this.focus.x.snap(p.x);
    this.focus.y.snap(p.y);
    this.focus.z.snap(p.z);
  }

  // ----- loop --------------------------------------------------------------

  private wake(forceRender = false): void {
    if (this.dead) return;
    if (forceRender) this.forceRender = true;
    if (!this.raf) {
      this.lastFrame = -1;
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  private forceRender = false;

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame = (tMs: number): void => {
    this.raf = 0;
    if (this.dead) return;
    const now = tMs / 1000;
    const dt = this.lastFrame < 0 ? 1 / 60 : Math.min(now - this.lastFrame, 0.1);
    this.lastFrame = now;

    const busy = this.loaded ? this.step(Math.min(dt, 1 / 20)) : false;
    const hazeOn = this.loaded && this.haze.visible;
    const idle = this.clock - this.lastEventAt > IDLE_AFTER;

    let render = busy || this.forceRender;
    if (!render && hazeOn) {
      if (!idle) render = true;
      else render = this.lastRender < 0 || now - this.lastRender >= 1 / 15 - 0.004;
    }
    if (hazeOn) this.hazeTime += dt * this.drift.value; // the only idle motion
    this.renderMode = busy || !idle ? "continuous" : hazeOn ? "idle-15fps" : "stopped";

    if (render && this.loaded) {
      this.forceRender = false;
      this.renderNow();
      this.lastRender = now;
    }
    if (busy || hazeOn || this.forceRender || !this.loaded) {
      this.raf = requestAnimationFrame(this.frame);
    }
  };

  /**
   * Upload changed paddle faces. Only the changed slot is sent, as raw bytes,
   * straight through three's state cache. three's copyTextureToTexture() was
   * avoided on purpose: it calls gl.getParameter() five times, and each call
   * is a synchronous GPU-process round trip in Chrome (measured ~28 ms per
   * new paddle on ANGLE/D3D11, versus ~0.1 ms for the upload itself).
   */
  private flushAtlas(): void {
    const tex = this.atlas.texture;
    const { full, slots } = this.atlas.takeDirty();
    const props = this.renderer.properties.get(tex) as { __webglTexture?: WebGLTexture };
    if (full || !props.__webglTexture) {
      tex.needsUpdate = true;
      return;
    }
    if (slots.length === 0) return;
    const gl = this.renderer.getContext();
    const state = this.renderer.state;
    state.bindTexture(gl.TEXTURE_2D, props.__webglTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    for (const slot of slots) {
      const r = PaddleAtlas.slotRect(slot);
      const px = this.atlas.slotPixels(slot);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x0, r.y0, px.width, px.height, gl.RGBA, gl.UNSIGNED_BYTE, px.data);
    }
    if (tex.generateMipmaps) gl.generateMipmap(gl.TEXTURE_2D);
    state.unbindTexture();
  }

  private renderNow(): void {
    this.flushAtlas();
    this.updateScene();
    this.renderer.render(this.scene, this.camera);
    const r = this.renderer.info.render;
    this.lastInfo = { calls: r.calls, triangles: r.triangles };
    this.frameTimes.push(performance.now());
    if (this.frameTimes.length > 240) this.frameTimes.splice(0, this.frameTimes.length - 240);
  }

  /** Advance every animation. Returns true while anything is still moving. */
  private step(dt: number): boolean {
    this.clock += dt;
    this.timeline.step(dt);
    let busy = this.timeline.pending;
    for (const t of [
      this.spotLevel,
      this.spotWidth,
      this.house,
      this.drift,
      this.curtains,
      this.camWide,
      this.camPush,
      this.haloLevel,
      this.flash,
      this.tint,
      this.gavelAngle,
    ]) {
      if (t.step(dt)) busy = true;
    }
    for (const s of [this.focus.x, this.focus.y, this.focus.z]) if (s.step(dt)) busy = true;
    for (const s of this.slots) {
      let moved = false;
      if (s.height.step(dt)) moved = true;
      if (s.tilt.step(dt)) moved = true;
      if (s.alpha.step(dt)) moved = true;
      if (s.dim.step(dt)) moved = true;
      if (s.glow.step(dt)) moved = true;
      if (moved) {
        busy = true;
        this.paddlesDirty = true;
      }
    }
    return busy;
  }

  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpE = new THREE.Euler(0, 0, 0, "YXZ");
  private tmpV = new THREE.Vector3();
  private tmpS = new THREE.Vector3();
  private tmpC = new THREE.Color();
  private zAxis = new THREE.Vector3(0, 0, 1);

  private updateScene(): void {
    // Camera: rest shot, pulled wide between lots, small push-in on the hammer.
    const cam = this.camera;
    cam.position.lerpVectors(CAM_REST, CAM_WIDE, this.camWide.value);
    this.tmpV.subVectors(CAM_LOOK, cam.position).multiplyScalar(0.06 * this.camPush.value);
    cam.position.add(this.tmpV);
    cam.lookAt(CAM_LOOK);

    // Lights
    const house = this.house.value;
    this.hemi.intensity = HEMI * house;
    this.rim.intensity = RIM * house;
    const fx = this.focus.x.value;
    const fy = this.focus.y.value;
    const fz = this.focus.z.value;
    this.spot.target.position.set(fx, fy, fz);
    this.spot.target.updateMatrixWorld();
    this.spot.angle = SPOT_ANGLE * this.spotWidth.value;
    this.spot.intensity = SPOT_MAX * this.spotLevel.value * (0.8 + 0.2 * house);

    // Haze cone from the lamp to the focus
    if (this.haze.visible) {
      this.tmpV.set(fx, fy, fz).sub(SPOT_POS);
      const len = this.tmpV.length();
      const r = len * Math.tan(this.spot.angle) * 0.9;
      this.haze.position.copy(SPOT_POS);
      this.haze.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), this.tmpV.normalize());
      this.haze.scale.set(r, len, r);
      const level = this.spotLevel.value * (0.8 + 0.2 * house);
      this.haze.material.uniforms.uOpacity!.value = 0.075 * level;
      this.haze.material.uniforms.uTime!.value = this.hazeTime;
      this.dust.material.uniforms.uOpacity!.value = 0.55 * level;
      this.dust.material.uniforms.uTime!.value = this.hazeTime;
      this.dust.material.uniforms.uSize!.value = 34 * this.renderer.getPixelRatio() / Math.max(r, 0.4);
    }

    // Halo + brass rim glow follow the focus, offset away from the camera
    const haloLevel = this.haloLevel.value;
    this.tmpV.set(fx, fy, fz).sub(cam.position).normalize().multiplyScalar(0.12);
    this.halo.position.set(fx, fy, fz).add(this.tmpV);
    this.halo.quaternion.copy(cam.quaternion);
    this.halo.material.opacity = 0.42 * haloLevel;
    this.halo.visible = haloLevel > 0.002;

    // Hammer flash (or, in reduced motion, a steady colour change)
    const f = this.flash.value;
    const tint = this.tint.value;
    // A dim lectern lamp while a lot is open, so the strike can be seen.
    this.flashLight.intensity = 0.9 * this.curtains.value + 5 * f + 1.6 * tint;
    this.flashSprite.visible = f > 0.002 || tint > 0.002;
    this.flashSprite.material.opacity = 0.9 * f + 0.25 * tint;
    this.flashSprite.scale.setScalar(0.5 + 0.8 * (1 - f) * (f > 0 ? 1 : 0) + 0.3 * tint);
    this.flashSprite.quaternion.copy(cam.quaternion);

    // Gavel
    if (this.gavel) {
      this.tmpQ.setFromAxisAngle(this.zAxis, this.gavelAngle.value);
      this.gavel.quaternion.copy(this.gavelRest).multiply(this.tmpQ);
    }

    // Curtains part slightly when a lot opens
    if (this.curtainL) this.curtainL.position.x = this.curtainLX - 0.32 * this.curtains.value;
    if (this.curtainR) this.curtainR.position.x = this.curtainRX + 0.32 * this.curtains.value;

    if (this.paddlesDirty) this.updatePaddles();
  }

  private updatePaddles(): void {
    this.paddlesDirty = false;
    const cam = this.camera.position;
    for (const s of this.slots) {
      const a = s.alpha.value;
      this.alphaAttr.setX(s.index, a);
      const seat = this.seatOf(s);
      const x = seat.x + 0.12;
      const z = seat.z;
      const yaw = Math.atan2(cam.x - x, cam.z - z);
      this.tmpE.set(-0.12 + s.tilt.value, yaw, s.roll * 0.12);
      this.tmpQ.setFromEuler(this.tmpE);
      this.tmpV.set(x, s.height.value, z);
      this.tmpS.setScalar(a > 0.001 ? PADDLE_SCALE : 0);
      this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpS);

      // Dim toward smoke (never red); glow toward warm brass.
      this.tmpC.setRGB(1, 1, 1).lerp(C.smoke, s.dim.value * 0.85).multiplyScalar(1 - 0.35 * s.dim.value);
      if (s.glow.value > 0) {
        this.tmpC.lerp(C.brass.clone().multiplyScalar(1.6).add(new THREE.Color(0.25, 0.22, 0.15)), s.glow.value * 0.45);
      }
      for (const part of this.paddleParts) {
        part.mesh.setMatrixAt(s.index, this.tmpM.clone().multiply(part.offset));
        part.mesh.setColorAt(s.index, this.tmpC);
      }
    }
    for (const part of this.paddleParts) {
      part.mesh.instanceMatrix.needsUpdate = true;
      if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
    }
    this.alphaAttr.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validPaddle(p: unknown): p is number {
  return typeof p === "number" && Number.isInteger(p) && p >= 0 && p <= 99999;
}

/** Per-instance alpha (and atlas slot for the face) on a standard material. */
function patchInstanced(mat: THREE.MeshStandardMaterial, withSlot: boolean): void {
  mat.transparent = true;
  mat.onBeforeCompile = (shader) => {
    if (withSlot) shader.uniforms.uSlotScale = { value: new THREE.Vector2(...PaddleAtlas.slotScale) };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute float aAlpha;
varying float vAlpha;
${withSlot ? "attribute vec2 aSlot;\nuniform vec2 uSlotScale;" : ""}`,
      )
      .replace(
        "#include <uv_vertex>",
        `#include <uv_vertex>
${withSlot ? "#ifdef USE_MAP\n  vMapUv = aSlot + uv * uSlotScale;\n#endif" : ""}`,
      )
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvAlpha = aAlpha;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vAlpha;")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.a *= vAlpha;");
  };
  mat.customProgramCacheKey = () => `paddle-instanced-${withSlot ? "face" : "part"}`;
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mm = m.material as THREE.Material | THREE.Material[] | undefined;
    if (mm) (Array.isArray(mm) ? mm : [mm]).forEach((x) => x.dispose());
  });
}
