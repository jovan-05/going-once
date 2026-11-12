// Tiny animation primitives. No framework code, no globals.

export type Ease = (t: number) => number;

export const linear: Ease = (t) => t;
export const easeOutCubic: Ease = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic: Ease = (t) => t * t * t;
export const easeInOutCubic: Ease = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const easeInQuad: Ease = (t) => t * t;

/** A value that eases from wherever it is now to a target over a fixed time. */
export class Tween {
  value: number;
  private from: number;
  private to: number;
  private t = 1;
  private dur = 0;
  private ease: Ease = easeInOutCubic;

  constructor(v: number) {
    this.value = v;
    this.from = v;
    this.to = v;
  }

  /** Retarget from the current value. A new call always replaces the old one. */
  set(target: number, dur: number, ease: Ease = easeInOutCubic): void {
    if (dur <= 0) {
      this.value = this.to = this.from = target;
      this.t = 1;
      return;
    }
    this.from = this.value;
    this.to = target;
    this.dur = dur;
    this.t = 0;
    this.ease = ease;
  }

  get target(): number {
    return this.to;
  }

  get active(): boolean {
    return this.t < 1;
  }

  step(dt: number): boolean {
    if (this.t >= 1) return false;
    this.t = Math.min(1, this.t + dt / this.dur);
    this.value = this.from + (this.to - this.from) * this.ease(this.t);
    return true;
  }
}

/**
 * Damped spring. Retargeting keeps velocity, so a new target mid-flight never
 * snaps or queues: it just bends the motion toward the newest target.
 */
export class Spring {
  value: number;
  velocity = 0;
  target: number;

  constructor(
    v: number,
    public freq: number,
    public zeta: number,
  ) {
    this.value = v;
    this.target = v;
  }

  snap(v: number): void {
    this.value = this.target = v;
    this.velocity = 0;
  }

  get active(): boolean {
    return this.value !== this.target || this.velocity !== 0;
  }

  step(dt: number): boolean {
    if (!this.active) return false;
    const w = 2 * Math.PI * this.freq;
    let rem = dt;
    while (rem > 0) {
      const h = Math.min(rem, 1 / 240);
      const a = w * w * (this.target - this.value) - 2 * this.zeta * w * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
      rem -= h;
    }
    if (Math.abs(this.target - this.value) < 1e-4 && Math.abs(this.velocity) < 1e-3) {
      this.value = this.target;
      this.velocity = 0;
      return false;
    }
    return true;
  }
}

/** Keyed, cancellable one-shot timers on the animation clock (not setTimeout). */
export class Timeline {
  private tasks = new Map<string, { at: number; fn: () => void }>();
  private now = 0;

  schedule(key: string, delay: number, fn: () => void): void {
    this.tasks.set(key, { at: this.now + delay, fn });
  }

  cancel(prefix: string): void {
    for (const k of [...this.tasks.keys()]) if (k.startsWith(prefix)) this.tasks.delete(k);
  }

  clear(): void {
    this.tasks.clear();
  }

  get pending(): boolean {
    return this.tasks.size > 0;
  }

  step(dt: number): void {
    this.now += dt;
    for (const [k, task] of [...this.tasks]) {
      if (task.at <= this.now && this.tasks.get(k) === task) {
        this.tasks.delete(k);
        task.fn();
      }
    }
  }
}
