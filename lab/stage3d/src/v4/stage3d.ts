/**
 * Going Once — 3D saleroom moments (v4).
 *
 * v4 on top of v3:
 *  - A bidder is lit, not only their paddle: while the paddle is up, their
 *    silhouette gets a warm lift and their seat a warm pool of light (both
 *    fade to a faint level for the leader, off when outbid). Fixes left-side
 *    bidders sitting in the dark.
 *  - Hammer camera: after the stillness the camera eases into a close-up of
 *    the gavel and block (block in the right third), holds on the strike,
 *    then pulls out and turns to a medium shot of the winner (winner in their
 *    side third). The spotlight snaps to the winner as the camera turns, and
 *    the camera eases back out when the curtains close.
 *
 * Framework-free: import it from Vite, Next.js or anything else. It only reacts
 * to events. It knows nothing about money, bids or PayPal and never sends
 * anything out.
 *
 * v3 on top of v2:
 *  - The centre of the frame, behind the price, is kept clear (no lectern,
 *    rail or paddles there) and gets a soft radial scrim.
 *  - Every bidder keeps a paddle in a seat for the whole lot. A bid raises it
 *    in about 300 ms under a warm spotlight, and it settles back after about
 *    1.2 s. The leader keeps a faint brass glow.
 *  - The paddle number and name sit next to the lit paddle as crisp HTML text
 *    (at least 28 px), with a BOT tag for bots.
 *  - Hammer: 300 ms of stillness, the spotlight snaps to the winner, the gavel
 *    strikes and a brass flash sweeps the room. Front curtains close between
 *    lots and open on the next one.
 *  - Nothing moves unless an event arrives. Only a very faint dust drift
 *    remains in the beam.
 *  - Three rows with a seated silhouette in every seat.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Spring, Timeline, Tween, easeInCubic, easeInOutCubic, easeOutCubic, linear, type Ease } from "./anim";
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

/** Not part of the contract: what (if anything) crosses the price area. Lab checks only. */
export function getStage3DCentreReport(stage: Stage3D): CentreReport | null {
  return stage instanceof SaleroomStage ? stage.centreReport() : null;
}

export interface CentreReport {
  centre: { x0: number; y0: number; x1: number; y1: number };
  intrusions: { what: string; box: { x0: number; y0: number; x1: number; y1: number } }[];
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
const SPOT_COLOR = C.parchment.clone().lerp(C.brass, 0.55); // warm brass

// Camera: slightly raised, almost square to the stage. The price sits in the
// centre; the lectern is to the right and the seat blocks are either side of
// a wide aisle, so nothing crosses the digits.
const CAM_REST = new THREE.Vector3(-0.6, 3.3, 8.6);
const CAM_WIDE = new THREE.Vector3(-0.5, 3.9, 10.2);
const CAM_LOOK = new THREE.Vector3(0.15, 2.1, -2.5);
const CAM_FOV = 38;
/** Screen area kept clear for the price (fractions of width/height, y down). */
const CENTRE = { x0: 0.3, y0: 0.28, x1: 0.7, y1: 0.68 };
const SCRIM = { cx: 0.5, cy: 0.47, rx: 0.3, ry: 0.27, strength: 0.5 };

// The spotlight hangs above whatever it lights, a little toward the audience,
// so the beam stays over its target and never cuts across the centre.
const LAMP_HEIGHT = 7.2;
const LAMP_FORWARD = 2.4;
const SPOT_ANGLE = 0.2;
const SPOT_MAX = 120;
const HEMI = 1.3;
const RIM = 1.5; // front-side warm wash
const ENV = 0.18;

// Hammer shots
const GAVEL_SHOT_POS = new THREE.Vector3(-1.05, 0.6, 2.5); // from the sound block
const GAVEL_SHOT_LOOK = new THREE.Vector3(-1.2, -0.05, 0); // block sits in the right third
const WINNER_SHOT_POS = new THREE.Vector3(-0.9, 1.35, 4.4); // from the winner's paddle face (x mirrored by side)
const WINNER_SHOT_LOOK = new THREE.Vector3(-1.75, 0.1, -0.5);
const T_CLOSEUP = 0.3; // after the hammer event: 300 ms of stillness first
const CLOSEUP_DUR = 0.5;
const T_LIFT = 0.8; // gavel lift starts once the camera has arrived
const T_PULLOUT = 1.5; // after a short hold on the block
const PULLOUT_DUR = 1.0;
const T_SNAP = 1.85; // the spotlight snaps to the winner as the camera turns
const WINNER_HOLD = 1.8; // minimum time on the winner before easing back out

// Bidder lighting (no real lights: a shader lift on the silhouette, and an
// additive pool on the floor)
const LIFT_RAISED = 1;
const LIFT_LEADER = 0.35;
const LIFT_COLOR = new THREE.Color(0.2, 0.1, 0.035);
const POOL_COLOR = new THREE.Color("#E0A458");

const POOL = ATLAS_SLOTS; // 24 paddles, one per seat
const PADDLE_SCALE = 1.1;
const PADDLE_SIDE = 0.24; // held beside the outer shoulder, away from the centre
const FACE_CENTER = 0.39; // metres above the handle end, unscaled
const H_RAISED = 1.22;
const H_SEATED = 0.74;
const H_HIDDEN = 0.05;
const RAISE_TIME = 0.3;
const SETTLE_AFTER = 1.2;
const LEADER_GLOW = 0.3;
const IDLE_AFTER = 10; // seconds without events before throttling
const MATTE = new Set(["Velvet", "Curtain", "Carpet", "DarkWood", "Wall", "Backstage", "Silhouette"]);
const NUMBER_FONT = '"Big Shoulders Display", "Arial Narrow", "Roboto Condensed", sans-serif';

// Brass sweep on the hammer: a light crossing the room left to right.
const SWEEP_FROM = new THREE.Vector3(-8.5, 3.4, 5.5);
const SWEEP_TO = new THREE.Vector3(8.5, 3.4, -1.5);

const easeOutBack: Ease = (t) => {
  const c1 = 1.4;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

type SlotState = "hidden" | "raised" | "seated";

interface Slot {
  index: number;
  paddle: number | null;
  label: string;
  isBot: boolean;
  chair: number;
  state: SlotState;
  height: Tween;
  tilt: Spring;
  alpha: Tween;
  dim: Tween;
  glow: Tween;
  lift: Tween; // light on the bidder and their seat
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
  private camera = new THREE.PerspectiveCamera(CAM_FOV, 16 / 9, 0.1, 60);
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
  private spot = new THREE.SpotLight(SPOT_COLOR, 0, 0, SPOT_ANGLE, 0.5, 2);
  private flashLight = new THREE.PointLight(C.brass, 0, 6, 2);
  private lampPos = new THREE.Vector3();

  // Haze
  private haze!: THREE.Mesh<THREE.ConeGeometry, THREE.ShaderMaterial>;
  private dust!: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private hazeTime = 0;

  // Sprites and screen-space scrim
  private halo!: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private flashSprite!: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private glowTex: THREE.Texture | null = null;
  private scrim!: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;

  // Bidder lighting: per-seat lift on the silhouettes, warm pools on the floor
  private seatLift: THREE.InstancedBufferAttribute | null = null;
  private seatPools: THREE.InstancedMesh | null = null;
  private liftDirty = true;

  // Camera shots (hammer close-up, winner medium shot)
  private camPos = new THREE.Vector3().copy(CAM_REST);
  private camLook = new THREE.Vector3().copy(CAM_LOOK);
  private camFromPos = new THREE.Vector3().copy(CAM_REST);
  private camFromLook = new THREE.Vector3().copy(CAM_LOOK);
  private camShot: { pos: THREE.Vector3; look: THREE.Vector3 } | null = null; // null: the rest/wide shot
  private camT = new Tween(1);
  private hammerAt = -Infinity;
  private basePos = new THREE.Vector3();

  // House dressing
  private sconceGlow: THREE.InstancedMesh | null = null;
  private sconcePos: THREE.Vector3[] = [];
  private wallWash: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;

  // Animated values
  private spotLevel = new Tween(0.55);
  private spotWidth = new Tween(1);
  private house = new Tween(1);
  private drift = new Tween(1);
  private lotOpen = new Tween(0);
  private tabsClosed = new Tween(0);
  private camWide = new Tween(1);
  private camPush = new Tween(0);
  private haloLevel = new Tween(0);
  private flash = new Tween(0);
  private sweep = new Tween(0);
  private tint = new Tween(0); // reduced-motion stand-in for the flash
  private gavelAngle = new Tween(0);
  private focus = { x: new Spring(0, 1.6, 1), y: new Spring(0, 1.6, 1), z: new Spring(0, 1.6, 1) };

  // Scene objects
  private gavel: THREE.Object3D | null = null;
  private gavelRest = new THREE.Quaternion();
  private tabs: THREE.Object3D[] = [];
  private lectern: THREE.Object3D | null = null;
  private rail: THREE.Object3D | null = null;
  private lecternFocus = new THREE.Vector3(3.4, 1.62, -2.6);
  private blockPos = new THREE.Vector3(3.5, 1.6, -2.54);

  // Paddles and seats
  private atlas: PaddleAtlas;
  private paddleParts: { mesh: THREE.InstancedMesh; offset: THREE.Matrix4 }[] = [];
  private alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(POOL), 1).setUsage(THREE.DynamicDrawUsage);
  private slots: Slot[] = [];
  private seats: THREE.Vector3[] = [];
  private leader: Slot | null = null;
  private winner: Slot | null = null;
  private paddlesDirty = true;

  // Screen-space label (HTML, crisp at any resolution)
  private labelLayer: HTMLDivElement | null = null;
  private labelEl: HTMLDivElement | null = null;
  private labelNum: HTMLSpanElement | null = null;
  private labelName: HTMLSpanElement | null = null;
  private labelBot: HTMLSpanElement | null = null;
  private labelFor: Slot | null = null;
  private labelKey = "";
  private labelPos = "";

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
    this.buildScrim();
    this.buildLabel();
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
    this.layoutLabelLayer();
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
    this.labelLayer?.remove();
    this.labelLayer = this.labelEl = null;
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

  /**
   * Lab check: screen boxes (fractions, y down) of everything that must stay
   * out of the price area: the lectern, the rail, and a raised paddle in every
   * seat. Uses the camera as it is now.
   */
  centreReport(): CentreReport {
    const out: CentreReport = { centre: { ...CENTRE }, intrusions: [] };
    if (!this.loaded) return out;
    this.camera.updateMatrixWorld();
    const check = (what: string, box: THREE.Box3): void => {
      const b = this.screenBox(box);
      if (b.x1 > CENTRE.x0 && b.x0 < CENTRE.x1 && b.y1 > CENTRE.y0 && b.y0 < CENTRE.y1) out.intrusions.push({ what, box: b });
    };
    if (this.lectern) check("lectern", new THREE.Box3().setFromObject(this.lectern));
    if (this.gavel) check("gavel", new THREE.Box3().setFromObject(this.gavel));
    if (this.rail) {
      // The rail is long and thin: test it in short pieces.
      const rb = new THREE.Box3().setFromObject(this.rail);
      for (let x = rb.min.x; x < rb.max.x; x += 0.5) {
        check(`rail@${x.toFixed(1)}`, new THREE.Box3(new THREE.Vector3(x, rb.min.y, rb.min.z), new THREE.Vector3(x + 0.5, rb.max.y, rb.max.z)));
      }
    }
    this.seats.forEach((s, i) => {
      const x = paddleX(s);
      const half = 0.2 * PADDLE_SCALE;
      const top = H_RAISED + (FACE_CENTER + 0.22) * PADDLE_SCALE;
      check(`paddle@seat${i}`, new THREE.Box3(new THREE.Vector3(x - half, H_RAISED, s.z - 0.05), new THREE.Vector3(x + half, top, s.z + 0.05)));
    });
    return out;
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
    this.scene.fog = new THREE.Fog(C.velvet.clone().lerp(C.curtain, 0.35), 9, 30);
  }

  private buildLights(): void {
    this.rim.position.set(-5, 6, 7);
    this.spot.shadow.mapSize.set(1024, 1024);
    this.spot.shadow.bias = -0.0004;
    this.spot.shadow.normalBias = 0.02;
    this.spot.shadow.camera.near = 2;
    this.spot.shadow.camera.far = 12;
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
          float drift = 0.85 + 0.15 * sin(vAng * 5.0 + uTime * 0.25 + vT * 7.0) * sin(vT * 11.0 - uTime * 0.3);
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

    const N = 160;
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
          float t = fract(aSeed.x + uTime * 0.006 * (0.4 + aSeed.z));
          float ang = aSeed.y * 6.2831 + uTime * 0.025 * (aSeed.z - 0.5);
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
    this.glowTex = tex;
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

  /** A soft radial darkening behind the price, drawn last in screen space. */
  private buildScrim(): void {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: C.velvet.clone().multiplyScalar(0.6) },
        uCenter: { value: new THREE.Vector2(SCRIM.cx, 1 - SCRIM.cy) },
        uRadius: { value: new THREE.Vector2(SCRIM.rx, SCRIM.ry) },
        uStrength: { value: SCRIM.strength },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform vec2 uCenter; uniform vec2 uRadius; uniform float uStrength;
        varying vec2 vUv;
        void main() {
          float d = length((vUv - uCenter) / uRadius);
          float a = uStrength * exp(-1.6 * d * d);
          gl_FragColor = vec4(uColor, a);
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.scrim = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    this.scrim.frustumCulled = false;
    this.scrim.renderOrder = 1000;
    this.scene.add(this.scrim);
  }

  /**
   * One HTML label for the lit paddle, layered over the canvas. Text goes in
   * with textContent only (labels are untrusted).
   */
  private buildLabel(): void {
    const parent = this.canvas.parentElement;
    if (!parent || typeof document === "undefined") return;
    const layer = document.createElement("div");
    layer.setAttribute("aria-hidden", "true");
    Object.assign(layer.style, {
      position: "absolute",
      left: "0px",
      top: "0px",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      overflow: "hidden",
      zIndex: "1", // above the host's 2D layer, so its scrims never dim the label
    });
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "absolute",
      left: "0px",
      top: "0px",
      display: "flex",
      alignItems: "baseline",
      gap: "0.35em",
      padding: "0.12em 0.5em 0.16em",
      borderRadius: "0.35em",
      background: "rgba(30, 7, 20, 0.78)",
      border: "2px solid rgba(212, 162, 63, 0.85)",
      color: "#F6EDDC",
      fontFamily: NUMBER_FONT,
      whiteSpace: "nowrap",
      lineHeight: "1",
      opacity: "0",
      transition: this.reduced ? "opacity 120ms linear" : "opacity 200ms ease-out",
      willChange: "transform, opacity",
    });
    const num = document.createElement("span");
    num.style.fontWeight = "900";
    const name = document.createElement("span");
    name.style.fontWeight = "700";
    const bot = document.createElement("span");
    Object.assign(bot.style, {
      fontWeight: "800",
      background: "#F6EDDC",
      color: "#2B0A1D",
      borderRadius: "0.25em",
      padding: "0.08em 0.3em 0.04em",
      alignSelf: "center",
    });
    bot.textContent = "BOT";
    el.append(num, name, bot);
    layer.append(el);
    this.canvas.insertAdjacentElement("afterend", layer);
    this.labelLayer = layer;
    this.labelEl = el;
    this.labelNum = num;
    this.labelName = name;
    this.labelBot = bot;
  }

  /** Keep the label layer exactly over the canvas, and size the type. */
  private layoutLabelLayer(): void {
    const layer = this.labelLayer;
    const parent = this.canvas.parentElement;
    if (!layer || !parent || !this.labelEl) return;
    const c = this.canvas.getBoundingClientRect();
    const p = parent.getBoundingClientRect();
    Object.assign(layer.style, {
      left: `${c.left - p.left}px`,
      top: `${c.top - p.top}px`,
      width: `${c.width || this.width}px`,
      height: `${c.height || this.height}px`,
    });
    const w = c.width || this.width;
    // At least 28 px for the name and tag; the number is larger.
    const small = Math.max(28, Math.round(w * 0.0175));
    this.labelName!.style.fontSize = `${small}px`;
    this.labelBot!.style.fontSize = `${Math.max(28, Math.round(small * 0.85))}px`;
    this.labelNum!.style.fontSize = `${Math.max(40, Math.round(w * 0.028))}px`;
    this.labelPos = "";
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
    this.lectern = lectern;
    this.rail = root.getObjectByName("Rail") ?? null;
    this.tabs = ["Tab_L", "Tab_R"].map((n) => root.getObjectByName(n)).filter((o): o is THREE.Object3D => !!o);
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
    const receivers = ["Stage", "Curtain_L", "Curtain_R", "Tab_L", "Tab_R", "Lectern", "SoundBlock"];
    for (const n of receivers) root.getObjectByName(n)?.traverse((x) => ((x as THREE.Mesh).isMesh ? ((x as THREE.Mesh).receiveShadow = true) : 0));
    for (const o of [lectern, this.gavel, block]) o.traverse((x) => ((x as THREE.Mesh).isMesh ? ((x as THREE.Mesh).castShadow = true) : 0));

    const patron = root.getObjectByName("Patron") ?? null;
    this.instanceChairs(root, patron);
    this.buildDressing(root, box);
    this.buildPaddlePool(paddle);
    paddle.removeFromParent();
  }

  /**
   * Linked-duplicate chairs from Blender become one InstancedMesh per
   * material, and every seat gets a seated silhouette (one more draw).
   */
  private instanceChairs(root: THREE.Object3D, patron: THREE.Object3D | null): void {
    const chairs: THREE.Object3D[] = [];
    root.traverse((o) => {
      if (/^Chair\d*$/.test(o.name)) chairs.push(o);
    });
    if (chairs.length === 0) return;
    // Seat order: front row first, inside out, alternating sides. Chairs are
    // sorted first so silhouette instance i is seat i.
    const at = (o: THREE.Object3D): THREE.Vector3 => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
    chairs.sort((ca, cb) => {
      const a = at(ca);
      const b = at(cb);
      return a.z - b.z || Math.abs(a.x) - Math.abs(b.x) || a.x - b.x;
    });
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
      this.seats.push(new THREE.Vector3().setFromMatrixPosition(chair.matrixWorld));
    }
    for (const p of parts.values()) {
      const im = new THREE.InstancedMesh(p.geo, p.mat, p.matrices.length);
      p.matrices.forEach((m, i) => im.setMatrixAt(i, m));
      im.instanceMatrix.needsUpdate = true;
      im.name = "Chairs";
      this.scene.add(im);
    }

    // Silhouettes: the template sits on the first chair; copy it to every seat.
    if (patron) {
      const template = chairs.find((c) => c.name === "Chair") ?? chairs[0]!;
      const inv = new THREE.Matrix4().copy(template.matrixWorld).invert();
      const meshes: THREE.Mesh[] = [];
      patron.traverse((o) => ((o as THREE.Mesh).isMesh ? meshes.push(o as THREE.Mesh) : 0));
      for (const pm of meshes) {
        const offset = new THREE.Matrix4().multiplyMatrices(inv, pm.matrixWorld);
        const geo = pm.geometry.clone();
        const lift = new THREE.InstancedBufferAttribute(new Float32Array(chairs.length), 1).setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute("aLift", lift);
        this.seatLift = lift;
        const mat = (pm.material as THREE.MeshLambertMaterial).clone();
        patchLift(mat);
        const im = new THREE.InstancedMesh(geo, mat, chairs.length);
        chairs.forEach((c, i) => im.setMatrixAt(i, new THREE.Matrix4().multiplyMatrices(c.matrixWorld, offset)));
        im.instanceMatrix.needsUpdate = true;
        im.name = "Patrons";
        this.scene.add(im);
      }
      patron.removeFromParent();
    }
    chairs.forEach((c) => c.removeFromParent());
  }

  /**
   * Depth cues that cost one draw each: soft contact shadows under every
   * chair and the lectern, camera-facing halos on the wall sconces, and a warm
   * wash on the wall around each sconce.
   */
  private buildDressing(root: THREE.Object3D, lecternBox: THREE.Box3): void {
    const tex = this.glowTex;
    if (!tex) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

    const blobs: THREE.Matrix4[] = this.seats.map((p) =>
      m.clone().compose(new THREE.Vector3(p.x, 0.012, p.z), q, new THREE.Vector3(0.95, 0.95, 1)),
    );
    const lc = lecternBox.getCenter(new THREE.Vector3());
    blobs.push(m.clone().compose(new THREE.Vector3(lc.x, lecternBox.min.y + 0.012, lc.z), q, new THREE.Vector3(1.6, 1.4, 1)));
    const shadowMat = new THREE.MeshBasicMaterial({
      map: tex,
      color: 0x000000,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      fog: false,
    });
    const shadows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), shadowMat, blobs.length);
    blobs.forEach((b, i) => shadows.setMatrixAt(i, b));
    shadows.renderOrder = 1;
    shadows.name = "ContactShadows";
    this.scene.add(shadows);

    // Warm pools on the floor under a lit bidder (colour = 0 when off).
    const poolMat = new THREE.MeshBasicMaterial({
      map: tex,
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), poolMat, this.seats.length);
    const black = new THREE.Color(0, 0, 0);
    this.seats.forEach((p, i) => {
      pools.setMatrixAt(i, m.clone().compose(new THREE.Vector3(p.x, 0.016, p.z + 0.1), q, new THREE.Vector3(1.9, 1.7, 1)));
      pools.setColorAt(i, black);
    });
    pools.instanceColor?.setUsage(THREE.DynamicDrawUsage);
    pools.renderOrder = 2;
    pools.name = "SeatPools";
    this.seatPools = pools;
    this.scene.add(pools);

    root.traverse((o) => {
      if (/^Sconce\d+$/.test(o.name)) this.sconcePos.push(new THREE.Vector3().setFromMatrixPosition(o.matrixWorld));
    });
    if (this.sconcePos.length === 0) return;
    const glowMat = new THREE.MeshBasicMaterial({
      map: tex,
      color: new THREE.Color("#FFC877"),
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    });
    this.sconceGlow = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.9, 0.9), glowMat, this.sconcePos.length);
    this.sconceGlow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sconceGlow.frustumCulled = false;
    this.sconceGlow.renderOrder = 6;
    this.scene.add(this.sconceGlow);

    const washMat = new THREE.MeshBasicMaterial({
      map: tex,
      color: new THREE.Color("#C9874A"),
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: true,
    });
    const wash = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), washMat, this.sconcePos.length);
    this.sconcePos.forEach((p, i) => {
      const side = Math.sign(p.x) || 1;
      const face = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (-side * Math.PI) / 2);
      wash.setMatrixAt(
        i,
        m.clone().compose(new THREE.Vector3(p.x + side * 0.33, p.y + 0.15, p.z), face, new THREE.Vector3(2.4, 3.4, 1)),
      );
    });
    wash.renderOrder = 4;
    this.wallWash = wash;
    this.scene.add(wash);
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
        height: new Tween(H_HIDDEN),
        tilt: new Spring(0, 1.3, 0.45),
        alpha: new Tween(0),
        dim: new Tween(0),
        glow: new Tween(0),
        lift: new Tween(0),
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
    if (this.camShot) this.moveCamera(null, this.reduced ? 0 : 1.4);
    this.leader = null;
    this.winner = null;
    this.showLabel(null);
    for (const s of this.slots) if (s.state !== "hidden") this.hideSlot(s, true);
    this.focusTo(this.lecternFocus);
    this.spotLevel.set(1, 1.2, easeInOutCubic);
    this.spotWidth.set(1, 0.6);
    this.drift.set(1, 0.6);
    this.haloLevel.set(0, 0.3);
    this.flash.set(0, 0);
    this.sweep.set(0, 0);
    this.tint.set(0, 0.2);
    this.gavelAngle.set(0, this.reduced ? 0 : 0.3);
    this.lotOpen.set(1, 1.2, easeInOutCubic);
    this.tabsClosed.set(0, this.reduced ? 0 : 1.4, easeInOutCubic);
    if (!this.reduced) {
      this.camWide.set(0, 1.4, easeInOutCubic);
      this.camPush.set(0, 1.4, easeInOutCubic);
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
    this.timeline.cancel("settle");
    if (this.camShot) this.moveCamera(null, 0.8);
    this.winner = null;
    const slot = this.acquire(paddle);
    slot.label = label;
    slot.isBot = isBot;
    this.atlas.draw(slot.index, { paddle, label, isBot });

    const prev = this.leader;
    if (prev && prev !== slot) {
      prev.glow.set(0, 0.3);
      prev.lift.set(0, 0.4);
      if (prev.state === "raised") this.settle(prev, 0.35);
    }
    this.leader = slot;
    this.raise(slot);
    this.focusTo(this.faceWorld(slot, H_RAISED));
    this.spotLevel.set(1, this.reduced ? 0 : 0.25);
    this.haloLevel.set(0.55, this.reduced ? 0.2 : 0.3);
    this.showLabel(slot);

    // After ~1.2 s it settles back into the seat; the spotlight follows it
    // down and the leader keeps a faint brass glow.
    this.timeline.schedule("settle", SETTLE_AFTER, () => {
      if (this.leader !== slot) return;
      this.settle(slot, 0.5);
      slot.glow.set(LEADER_GLOW, 0.5);
      slot.lift.set(LIFT_LEADER, 0.6);
      this.focusTo(this.faceWorld(slot, H_SEATED));
      this.spotLevel.set(0.7, 0.5);
      this.haloLevel.set(0.22, 0.5);
    });
  }

  private onOutbid(paddle: number): void {
    const slot = this.slots.find((s) => s.paddle === paddle && s.state !== "hidden");
    if (!slot) return;
    if (this.leader === slot) {
      this.leader = null;
      this.timeline.cancel("settle");
      this.focusTo(this.lecternFocus);
      this.haloLevel.set(0, 0.4);
      this.spotLevel.set(0.55, 0.5);
      this.showLabel(null);
    }
    // The paddle stays in its seat for the rest of the lot, dimmed.
    if (slot.state === "raised") this.settle(slot, 0.35);
    slot.glow.set(0, 0.3);
    slot.lift.set(0, 0.4);
    slot.dim.set(1, 0.4, easeOutCubic);
    this.paddlesDirty = true;
  }

  private onTension(width: number, drift: number): void {
    this.spotWidth.set(width, 0.5, easeInOutCubic);
    this.drift.set(drift, 0.5);
  }

  private onHammer(paddle: number, label: string): void {
    this.timeline.cancel("strike");
    this.timeline.cancel("settle");
    let slot = this.slots.find((s) => s.paddle === paddle && s.state !== "hidden") ?? null;
    if (!slot) {
      slot = this.acquire(paddle);
      if (label) slot.label = label;
      this.atlas.draw(slot.index, { paddle, label: slot.label, isBot: slot.isBot });
      slot.state = "seated";
      slot.height.set(H_SEATED, 0);
      slot.alpha.set(1, 0.2, linear);
    }
    const w = slot;
    if (this.leader && this.leader !== w) {
      this.leader.glow.set(0, 0.2);
      this.leader.lift.set(0, 0.3);
    }
    this.winner = w;
    this.leader = w;
    this.hammerAt = this.clock;
    this.drift.set(0, 0.15); // stillness

    const toWinner = (): void => {
      this.raise(w, true);
      this.focusSnap(this.faceWorld(w, H_RAISED));
      this.spotLevel.set(1, 0);
      this.spotWidth.set(0.9, 0);
      this.haloLevel.set(0.7, 0.15);
      w.glow.set(0.8, 0.2);
      this.showLabel(w);
    };

    if (this.reduced) {
      // No camera moves and no swing: a brass colour change, then the snap.
      this.timeline.schedule("strike:snap", 0.3, () => {
        toWinner();
        this.tint.set(1, 0.2, linear);
        this.timeline.schedule("strike:tintOff", 0.9, () => this.tint.set(0, 0.5));
      });
      return;
    }

    // During the strike the spotlight stays on the lectern.
    this.focusTo(this.lecternFocus);
    this.spotLevel.set(1, 0.3);
    this.haloLevel.set(0, 0.2);
    this.showLabel(null);

    this.timeline.schedule("strike:closeup", T_CLOSEUP, () => this.moveCamera(this.gavelShot(), CLOSEUP_DUR));
    this.timeline.schedule("strike:lift", T_LIFT, () => this.gavelAngle.set(0.62, 0.17, easeOutCubic));
    this.timeline.schedule("strike:down", T_LIFT + 0.17, () => this.gavelAngle.set(0, 0.085, easeInCubic));
    this.timeline.schedule("strike:impact", T_LIFT + 0.255, () => {
      this.flash.set(1, 0, linear);
      this.flash.set(0, 0.5, easeOutCubic);
      this.sweep.set(0, 0);
      this.sweep.set(1, 0.75, linear);
      this.camPush.set(0.5, 0.25, easeOutCubic);
      this.gavelAngle.set(0.09, 0.07, easeOutCubic);
      this.timeline.schedule("strike:settle", 0.07, () => this.gavelAngle.set(0, 0.2, easeInOutCubic));
    });
    this.timeline.schedule("strike:pullout", T_PULLOUT, () => {
      this.camPush.set(0, PULLOUT_DUR, easeInOutCubic);
      this.moveCamera(this.winnerShot(w), PULLOUT_DUR);
    });
    this.timeline.schedule("strike:snap", T_SNAP, toWinner);
  }

  private onSoldConfirmed(): void {
    const w = this.winner ?? this.leader;
    if (w) {
      w.glow.set(1, 0.3, easeOutCubic);
      this.haloLevel.set(1, 0.3, easeOutCubic);
    }
    this.timeline.cancel("sold");
    // Let the 2D Sold and receipt moment play, then close the curtains, but
    // not before the camera has held on the winner for a moment.
    const winnerShown = this.reduced ? 0 : this.hammerAt + T_PULLOUT + PULLOUT_DUR + WINNER_HOLD - this.clock;
    this.timeline.schedule("sold:ease", Math.max(1.2, winnerShown), () => {
      for (const s of this.slots) if (s.state !== "hidden") this.hideSlot(s, false, 0.9);
      this.leader = null;
      this.winner = null;
      this.showLabel(null);
      this.haloLevel.set(0, 0.9);
      this.focusTo(this.lecternFocus);
      this.spotLevel.set(0.55, 0.9);
      this.spotWidth.set(1, 0.9);
      this.drift.set(1, 0.9);
      this.lotOpen.set(0, 0.9);
      this.closeTabs(0.4);
      if (!this.reduced) {
        this.camPush.set(0, 1.4);
        this.camWide.set(1, 1.4);
        this.moveCamera(null, 1.6); // ease back out as the curtains close
      }
    });
  }

  private onLotPassed(): void {
    this.timeline.cancel("strike");
    this.timeline.cancel("sold");
    this.timeline.cancel("settle");
    this.spotLevel.set(0.5, 0.8);
    this.haloLevel.set(0, 0.5);
    for (const s of this.slots) if (s.state !== "hidden") this.hideSlot(s, false, 0.8);
    this.leader = null;
    this.winner = null;
    this.showLabel(null);
    this.focusTo(this.lecternFocus);
    this.lotOpen.set(0, 0.8);
    this.spotWidth.set(1, 0.8);
    this.drift.set(1, 0.8);
    if (this.camShot) this.moveCamera(null, 1.2);
    this.closeTabs(0.8);
  }

  /** Ease the camera from wherever it is to a shot (null: the rest/wide shot). */
  private moveCamera(to: { pos: THREE.Vector3; look: THREE.Vector3 } | null, dur: number): void {
    if (this.reduced && to) return;
    this.camFromPos.copy(this.camPos);
    this.camFromLook.copy(this.camLook);
    this.camShot = to;
    this.camT.set(0, 0);
    if (dur > 0) this.camT.set(1, dur, easeInOutCubic);
    else this.camT.set(1, 0);
  }

  private gavelShot(): { pos: THREE.Vector3; look: THREE.Vector3 } {
    return {
      pos: this.blockPos.clone().add(GAVEL_SHOT_POS),
      look: this.blockPos.clone().add(GAVEL_SHOT_LOOK),
    };
  }

  /** Medium shot: the winner in their side third, the centre left for the price. */
  private winnerShot(w: Slot): { pos: THREE.Vector3; look: THREE.Vector3 } {
    const face = this.faceWorld(w, H_RAISED);
    const side = face.x < 0 ? -1 : 1;
    const mirror = (v: THREE.Vector3): THREE.Vector3 => new THREE.Vector3(v.x * side, v.y, v.z);
    return { pos: face.clone().add(mirror(WINNER_SHOT_POS)), look: face.clone().add(mirror(WINNER_SHOT_LOOK)) };
  }

  private closeTabs(delay: number): void {
    this.timeline.schedule("sold:tabs", delay, () => this.tabsClosed.set(1, this.reduced ? 0 : 1.4, easeInOutCubic));
  }

  // ----- paddle pool -------------------------------------------------------

  private acquire(paddle: number): Slot {
    let slot = this.slots.find((s) => s.paddle === paddle);
    if (!slot) {
      const free = this.slots.filter((s) => s.state === "hidden" && s.alpha.value === 0 && s !== this.leader);
      const pickFrom = free.length ? free : this.slots.filter((s) => s !== this.leader);
      slot = pickFrom.reduce((a, b) => (a.lastUsed <= b.lastUsed ? a : b));
      if (slot.state !== "hidden") {
        // More bidders than seats: the longest-idle paddle gives up its seat.
        slot.alpha.set(0, 0);
        slot.state = "hidden";
      }
      slot.paddle = paddle;
      slot.chair = this.chairFor(paddle, slot);
      slot.dim.set(0, 0);
      slot.glow.set(0, 0);
      slot.lift.set(0, 0);
    }
    slot.lastUsed = this.clock;
    this.timeline.cancel(`hide:${slot.index}`);
    return slot;
  }

  private chairFor(paddle: number, self: Slot): number {
    const n = Math.max(1, this.seats.length);
    const taken = new Set(this.slots.filter((s) => s !== self && s.state !== "hidden").map((s) => s.chair));
    let c = (paddle * 7 + 3) % n;
    for (let i = 0; i < n && taken.has(c); i++) c = (c + 1) % n;
    return c;
  }

  /** Up into the light in ~300 ms. */
  private raise(slot: Slot, hold = false): void {
    this.timeline.cancel(`hide:${slot.index}`);
    const fresh = slot.alpha.value === 0 || slot.state === "hidden";
    if (fresh) {
      slot.height.set(H_SEATED, 0);
      slot.dim.set(0, 0);
      slot.glow.set(0, 0);
    }
    slot.state = "raised";
    slot.dim.set(0, 0.2);
    slot.lift.set(LIFT_RAISED, this.reduced ? 0.2 : 0.25);
    if (!hold) slot.glow.set(0.6, 0.25);
    if (this.reduced) {
      slot.height.set(H_RAISED, 0);
      slot.tilt.snap(0);
      slot.alpha.set(1, 0.2, linear);
    } else {
      slot.height.set(H_RAISED, RAISE_TIME, easeOutBack);
      slot.tilt.target = 0;
      slot.tilt.velocity -= 2.0; // a little flick as the arm goes up
      slot.alpha.set(1, 0.1, linear);
    }
    this.paddlesDirty = true;
  }

  /** Back down into the seat, still visible. */
  private settle(slot: Slot, dur: number): void {
    if (slot.state === "hidden") return;
    slot.state = "seated";
    slot.height.set(H_SEATED, this.reduced ? 0 : dur, easeInOutCubic);
    this.paddlesDirty = true;
  }

  private hideSlot(slot: Slot, quick: boolean, dur = 0.5): void {
    this.timeline.cancel(`hide:${slot.index}`);
    slot.state = "hidden";
    slot.glow.set(0, quick ? 0.15 : dur * 0.6);
    slot.lift.set(0, quick ? 0.15 : dur * 0.6);
    if (this.reduced) {
      slot.alpha.set(0, 0.2, linear);
    } else {
      slot.height.set(H_HIDDEN, quick ? 0.2 : dur, easeInCubic);
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
    return new THREE.Vector3(paddleX(s), h + FACE_CENTER * PADDLE_SCALE, s.z);
  }

  // ----- label -------------------------------------------------------------

  private showLabel(slot: Slot | null): void {
    this.labelFor = slot;
    const el = this.labelEl;
    if (!el) return;
    if (!slot || slot.paddle === null) {
      el.style.opacity = "0";
      this.labelKey = "";
      return;
    }
    const name = showName(slot.paddle, slot.label) ? slot.label : "";
    const key = `${slot.paddle}|${name}|${slot.isBot}`;
    if (key !== this.labelKey) {
      this.labelKey = key;
      this.labelNum!.textContent = String(slot.paddle);
      this.labelName!.textContent = name;
      this.labelName!.style.display = name ? "" : "none";
      this.labelBot!.style.display = slot.isBot ? "" : "none";
      this.labelPos = "";
    }
    el.style.opacity = "1";
  }

  /** Place the label just above the lit paddle, never over the price area. */
  private updateLabel(): void {
    const el = this.labelEl;
    const slot = this.labelFor;
    if (!el || !slot || el.style.opacity === "0") return;
    const w = this.canvas.clientWidth || this.width;
    const h = this.canvas.clientHeight || this.height;
    const s = this.seatOf(slot);
    const top = slot.height.value + (FACE_CENTER + 0.3) * PADDLE_SCALE;
    this.tmpV.set(paddleX(s), top, s.z).project(this.camera);
    let x = (this.tmpV.x * 0.5 + 0.5) * w;
    let y = (-this.tmpV.y * 0.5 + 0.5) * h;
    const lw = el.offsetWidth || 160;
    const lh = el.offsetHeight || 50;
    let left = x - lw / 2;
    let topPx = y - lh - 6;
    // Keep it off the centre (the price) and inside the frame.
    const cx0 = CENTRE.x0 * w;
    const cx1 = CENTRE.x1 * w;
    const cy0 = CENTRE.y0 * h;
    const cy1 = CENTRE.y1 * h;
    if (left < cx1 && left + lw > cx0 && topPx < cy1 && topPx + lh > cy0) {
      left = x < w / 2 ? cx0 - lw - 8 : cx1 + 8;
    }
    left = Math.min(Math.max(8, left), w - lw - 8);
    topPx = Math.min(Math.max(8, topPx), h - lh - 8);
    x = Math.round(left);
    y = Math.round(topPx);
    const pos = `${x},${y}`;
    if (pos !== this.labelPos) {
      this.labelPos = pos;
      el.style.transform = `translate(${x}px, ${y}px)`;
    }
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
    if (hazeOn) this.hazeTime += dt * this.drift.value; // the only idle motion: faint dust
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
   * straight through three's state cache (see v1 for why not
   * copyTextureToTexture).
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
    this.updateLabel();
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
      this.lotOpen,
      this.tabsClosed,
      this.camWide,
      this.camPush,
      this.haloLevel,
      this.flash,
      this.sweep,
      this.tint,
      this.gavelAngle,
    ]) {
      if (t.step(dt)) busy = true;
    }
    if (this.camT.step(dt)) {
      busy = true;
      this.paddlesDirty = true; // paddles turn to face the moving camera
    }
    for (const s of [this.focus.x, this.focus.y, this.focus.z]) if (s.step(dt)) busy = true;
    for (const s of this.slots) {
      let moved = false;
      if (s.height.step(dt)) moved = true;
      if (s.tilt.step(dt)) moved = true;
      if (s.alpha.step(dt)) moved = true;
      if (s.dim.step(dt)) moved = true;
      if (s.glow.step(dt)) moved = true;
      if (s.lift.step(dt)) {
        moved = true;
        this.liftDirty = true;
      }
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
  private down = new THREE.Vector3(0, -1, 0);

  private placeCamera(): void {
    const cam = this.camera;
    // The rest/wide shot, or a hammer shot, blended from wherever it was.
    this.basePos.lerpVectors(CAM_REST, CAM_WIDE, this.camWide.value);
    const toPos = this.camShot ? this.camShot.pos : this.basePos;
    const toLook = this.camShot ? this.camShot.look : CAM_LOOK;
    const t = this.camT.value;
    this.camPos.lerpVectors(this.camFromPos, toPos, t);
    this.camLook.lerpVectors(this.camFromLook, toLook, t);
    this.tmpV.subVectors(this.camLook, this.camPos).multiplyScalar(0.06 * this.camPush.value);
    cam.position.copy(this.camPos).add(this.tmpV);
    cam.lookAt(this.camLook);
    cam.updateMatrixWorld();
  }

  private updateScene(): void {
    // Camera: fixed rest shot; it only moves on events (lot open, hammer).
    this.placeCamera();
    const cam = this.camera;

    // Sconce halos face the camera and follow the house lights.
    if (this.sconceGlow) {
      this.tmpS.setScalar(0.35 + 0.65 * this.house.value);
      this.sconcePos.forEach((p, i) => {
        this.tmpM.compose(p, cam.quaternion, this.tmpS);
        this.sconceGlow!.setMatrixAt(i, this.tmpM);
      });
      this.sconceGlow.instanceMatrix.needsUpdate = true;
      if (this.wallWash) this.wallWash.material.opacity = 0.32 * this.house.value;
    }

    // Lights
    const house = this.house.value;
    const sweep = this.sweep.value;
    const sweepPulse = sweep > 0 && sweep < 1 ? Math.sin(Math.PI * sweep) : 0;
    this.hemi.intensity = HEMI * house;
    this.rim.intensity = RIM * house + 1.6 * sweepPulse;
    const fx = this.focus.x.value;
    const fy = this.focus.y.value;
    const fz = this.focus.z.value;
    this.lampPos.set(fx, LAMP_HEIGHT, fz + LAMP_FORWARD);
    this.spot.position.copy(this.lampPos);
    this.spot.target.position.set(fx, fy, fz);
    this.spot.target.updateMatrixWorld();
    this.spot.angle = SPOT_ANGLE * this.spotWidth.value;
    this.spot.intensity = SPOT_MAX * this.spotLevel.value * (0.8 + 0.2 * house);

    // Haze cone from the lamp to the focus (faint; the dust barely drifts)
    if (this.haze.visible) {
      this.tmpV.set(fx, fy, fz).sub(this.lampPos);
      const len = this.tmpV.length();
      const r = len * Math.tan(this.spot.angle) * 0.9;
      this.haze.position.copy(this.lampPos);
      this.haze.quaternion.setFromUnitVectors(this.down, this.tmpV.normalize());
      this.haze.scale.set(r, len, r);
      const level = this.spotLevel.value * (0.8 + 0.2 * house);
      this.haze.material.uniforms.uOpacity!.value = 0.04 * level;
      this.haze.material.uniforms.uTime!.value = this.hazeTime;
      this.dust.material.uniforms.uOpacity!.value = 0.3 * level;
      this.dust.material.uniforms.uTime!.value = this.hazeTime;
      this.dust.material.uniforms.uSize!.value = (30 * this.renderer.getPixelRatio()) / Math.max(r, 0.4);
    }

    // Halo follows the focus, offset toward the camera
    const haloLevel = this.haloLevel.value;
    this.tmpV.set(fx, fy, fz).sub(cam.position).normalize().multiplyScalar(-0.12);
    this.halo.position.set(fx, fy, fz).add(this.tmpV);
    this.halo.quaternion.copy(cam.quaternion);
    this.halo.material.opacity = 0.42 * haloLevel;
    this.halo.visible = haloLevel > 0.002;

    // Hammer flash at the block, the brass sweep across the room, or (reduced
    // motion) a steady colour change
    const f = this.flash.value;
    const tint = this.tint.value;
    if (sweepPulse > 0) {
      this.flashLight.position.lerpVectors(SWEEP_FROM, SWEEP_TO, easeInOutCubic(sweep));
      this.flashLight.distance = 18;
      this.flashLight.intensity = 1.6 * this.lotOpen.value + 120 * sweepPulse;
    } else {
      this.flashLight.position.copy(this.blockPos).add(this.tmpV.set(-0.1, 0.5, 0.1));
      this.flashLight.distance = 6;
      this.flashLight.intensity = 1.6 * this.lotOpen.value + 5 * f + 1.6 * tint;
    }
    this.flashSprite.visible = f > 0.002 || tint > 0.002;
    this.flashSprite.material.opacity = 0.9 * f + 0.25 * tint;
    this.flashSprite.scale.setScalar(0.5 + 0.8 * (1 - f) * (f > 0 ? 1 : 0) + 0.3 * tint);
    this.flashSprite.quaternion.copy(cam.quaternion);

    // Gavel
    if (this.gavel) {
      this.tmpQ.setFromAxisAngle(this.zAxis, this.gavelAngle.value);
      this.gavel.quaternion.copy(this.gavelRest).multiply(this.tmpQ);
    }

    // Front curtains: gathered at the sides when open, drawn across between lots
    const closed = this.tabsClosed.value;
    for (const t of this.tabs) {
      t.scale.x = 0.2 + 0.8 * closed;
      t.visible = true;
    }

    if (this.paddlesDirty) this.updatePaddles();
    if (this.liftDirty) this.updateSeatLight();
  }

  /** Copy each bidder's light level onto their seat's silhouette and floor pool. */
  private updateSeatLight(): void {
    this.liftDirty = false;
    const lift = this.seatLift;
    const pools = this.seatPools;
    if (!lift && !pools) return;
    const n = this.seats.length;
    const level = new Float32Array(n);
    for (const s of this.slots) {
      if (s.paddle === null) continue;
      const i = s.chair % Math.max(1, n);
      level[i] = Math.max(level[i] ?? 0, s.lift.value * s.alpha.value);
    }
    for (let i = 0; i < n; i++) {
      const v = (level[i] ?? 0) * (0.6 + 0.4 * this.house.value);
      if (lift) lift.setX(i, v);
      if (pools) pools.setColorAt(i, this.tmpC.copy(POOL_COLOR).multiplyScalar(0.55 * v));
    }
    if (lift) lift.needsUpdate = true;
    if (pools?.instanceColor) pools.instanceColor.needsUpdate = true;
  }

  private updatePaddles(): void {
    this.paddlesDirty = false;
    const cam = this.camera.position;
    for (const s of this.slots) {
      const a = s.alpha.value;
      this.alphaAttr.setX(s.index, a);
      const seat = this.seatOf(s);
      const x = paddleX(seat);
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

  /** Screen box (fractions, y down) of a world box under the current camera. */
  private screenBox(box: THREE.Box3): { x0: number; y0: number; x1: number; y1: number } {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      this.tmpV.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      this.tmpV.project(this.camera);
      const sx = this.tmpV.x * 0.5 + 0.5;
      const sy = -this.tmpV.y * 0.5 + 0.5;
      x0 = Math.min(x0, sx);
      x1 = Math.max(x1, sx);
      y0 = Math.min(y0, sy);
      y1 = Math.max(y1, sy);
    }
    const r = (v: number): number => Math.round(v * 1000) / 1000;
    return { x0: r(x0), y0: r(y0), x1: r(x1), y1: r(y1) };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function paddleX(seat: THREE.Vector3): number {
  return seat.x + (seat.x < 0 ? -PADDLE_SIDE : PADDLE_SIDE);
}

function validPaddle(p: unknown): p is number {
  return typeof p === "number" && Number.isInteger(p) && p >= 0 && p <= 99999;
}

/** A label that only repeats "Paddle N" adds nothing next to the number. */
function showName(paddle: number, label: string): boolean {
  if (!label) return false;
  return label.toLowerCase().replace(/\s+/g, "") !== `paddle${paddle}`;
}

/**
 * Per-instance warm lift on the seated silhouettes: light from the camera
 * side and above, so a lit bidder reads against the dark room.
 */
function patchLift(mat: THREE.MeshLambertMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLiftColor = { value: LIFT_COLOR };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aLift;\nvarying float vLift;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLift = aLift;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vLift;\nuniform vec3 uLiftColor;")
      .replace(
        "#include <opaque_fragment>",
        `float liftN = 0.25 + 0.75 * pow(max(dot(normalize(normal), normalize(vec3(0.0, 0.55, 0.85))), 0.0), 1.5);
outgoingLight += vLift * uLiftColor * liftN;
#include <opaque_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => "patron-lift";
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
