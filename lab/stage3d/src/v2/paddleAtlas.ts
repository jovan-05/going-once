import * as THREE from "three";

// One canvas holds the faces of all pooled paddles (6 x 4 slots), so every
// paddle face draws in a single instanced call.
export const ATLAS_COLS = 6;
export const ATLAS_ROWS = 4;
export const ATLAS_SLOTS = ATLAS_COLS * ATLAS_ROWS;
// 341 x 256 px per face: sharp even during the hammer push-in. Only the
// changed slot is uploaded, so the atlas size barely affects a bid.
const W = 2048;
const H = 1024;
const DESIGN_W = 2048; // paint() is written in 2048-wide design units
const DESIGN_H = 1024;

const PARCHMENT = "#F6EDDC";
const VELVET = "#2B0A1D";
const NUMBER_FONT = '"Big Shoulders Display", "Arial Narrow", "Roboto Condensed", sans-serif';

/** Untrusted text: drop control/bidi characters, collapse spaces, cut to 24 chars. */
export function cleanLabel(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const stripped = raw
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(stripped).slice(0, 24).join("");
}

export interface FaceContent {
  paddle: number;
  label: string;
  isBot: boolean;
}

export class PaddleAtlas {
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  private ctx: CanvasRenderingContext2D;
  private content: (FaceContent | null)[] = new Array(ATLAS_SLOTS).fill(null);
  private disposed = false;
  private dirty = new Set<number>();
  private needsFull = true;

  constructor(maxAnisotropy: number) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = W;
    this.canvas.height = H;
    // CPU-backed canvas: uploading from a GPU-accelerated 2D canvas forces a
    // slow readback in Chrome (measured 150 ms to 1 s per new paddle on ANGLE).
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Stage3D: 2D canvas unavailable for paddle numbers");
    this.ctx = ctx;
    ctx.fillStyle = PARCHMENT;
    ctx.fillRect(0, 0, W, H);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.flipY = false; // glTF UVs: v = 0 is the top of the face
    this.texture.anisotropy = Math.min(8, maxAnisotropy);
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;

    // Redraw once the display face has arrived (the host page loads the font).
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts) {
      fonts
        .load(`900 160px ${NUMBER_FONT}`)
        .then(() => {
          if (!this.disposed) this.redrawAll();
        })
        .catch(() => undefined);
    }
  }

  /** UV offset of a slot in atlas space (v measured from the top). */
  static slotOffset(slot: number): [number, number] {
    return [(slot % ATLAS_COLS) / ATLAS_COLS, Math.floor(slot / ATLAS_COLS) / ATLAS_ROWS];
  }

  static readonly slotScale: [number, number] = [1 / ATLAS_COLS, 1 / ATLAS_ROWS];

  /** Integer pixel rectangle of a slot on the canvas. */
  static slotRect(slot: number): { x0: number; y0: number; x1: number; y1: number } {
    const sw = W / ATLAS_COLS;
    const sh = H / ATLAS_ROWS;
    const col = slot % ATLAS_COLS;
    const row = Math.floor(slot / ATLAS_COLS);
    return {
      x0: Math.floor(col * sw),
      y0: Math.floor(row * sh),
      x1: Math.min(W, Math.ceil((col + 1) * sw)),
      y1: Math.min(H, Math.ceil((row + 1) * sh)),
    };
  }

  /** Draws a face if its content changed. Returns true when the canvas changed. */
  draw(slot: number, c: FaceContent): boolean {
    const prev = this.content[slot];
    if (prev && prev.paddle === c.paddle && prev.label === c.label && prev.isBot === c.isBot) {
      return false;
    }
    this.content[slot] = { ...c };
    this.paint(slot, c);
    this.dirty.add(slot);
    return true;
  }

  /**
   * What needs uploading since the last call: the whole atlas (first upload,
   * font swap) or just the slots that changed. The caller uploads slots with
   * a sub-image copy so a new paddle never re-sends all 8 MB.
   */
  takeDirty(): { full: boolean; slots: number[] } {
    const out = { full: this.needsFull, slots: [...this.dirty] };
    this.needsFull = false;
    this.dirty.clear();
    return out;
  }

  /** Raw RGBA pixels of one slot, for a typed-array sub-image upload. */
  slotPixels(slot: number): { data: Uint8Array; width: number; height: number } {
    const r = PaddleAtlas.slotRect(slot);
    const img = this.ctx.getImageData(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    return { data: new Uint8Array(img.data.buffer), width: img.width, height: img.height };
  }

  private redrawAll(): void {
    this.content.forEach((c, i) => {
      if (!c) return;
      this.paint(i, c);
      this.dirty.add(i);
    });
  }

  private paint(slot: number, c: FaceContent): void {
    const ctx = this.ctx;
    const sw = DESIGN_W / ATLAS_COLS;
    const sh = DESIGN_H / ATLAS_ROWS;
    const x0 = 0;
    const y0 = 0;
    const cx = sw / 2;

    ctx.save();
    ctx.translate((slot % ATLAS_COLS) * (W / ATLAS_COLS), Math.floor(slot / ATLAS_COLS) * (H / ATLAS_ROWS));
    ctx.scale(W / DESIGN_W, H / DESIGN_H);
    ctx.beginPath();
    ctx.rect(x0, y0, sw, sh);
    ctx.clip();
    ctx.fillStyle = PARCHMENT;
    ctx.fillRect(x0, y0, sw, sh);

    // Thin inner border in velvet, like a printed paddle.
    ctx.strokeStyle = "rgba(43,10,29,0.55)";
    ctx.lineWidth = 3;
    roundRect(ctx, x0 + 22, y0 + 16, sw - 44, sh - 32, 44);
    ctx.stroke();

    const label = showLabel(c) ? c.label : "";
    const hasBot = c.isBot;
    const numSize = hasBot && label ? 116 : hasBot || label ? 132 : 158;
    const numY = y0 + (hasBot && label ? 84 : hasBot || label ? 100 : 126);

    ctx.fillStyle = VELVET;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `900 ${numSize}px ${NUMBER_FONT}`;
    const num = String(c.paddle);
    fitText(ctx, num, sw - 80);
    ctx.fillText(num, cx, numY);

    let y = numY + numSize * 0.52;
    if (label) {
      ctx.font = `700 28px ${NUMBER_FONT}`;
      fitText(ctx, label, sw - 90);
      ctx.fillText(label, cx, y + 14); // plain text only
      y += 36;
    }
    if (hasBot) {
      ctx.font = `800 36px ${NUMBER_FONT}`;
      const tw = ctx.measureText("BOT").width + 30;
      ctx.fillStyle = VELVET;
      roundRect(ctx, cx - tw / 2, y, tw, 44, 10);
      ctx.fill();
      ctx.fillStyle = PARCHMENT;
      ctx.fillText("BOT", cx, y + 23);
    }
    ctx.restore();
  }

  dispose(): void {
    this.disposed = true;
    this.texture.dispose();
    this.canvas.width = this.canvas.height = 1;
  }
}

function showLabel(c: FaceContent): boolean {
  if (!c.label) return false;
  return c.label.toLowerCase().replace(/\s+/g, "") !== `paddle${c.paddle}`;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): void {
  const w = ctx.measureText(text).width;
  if (w <= maxW) return;
  const m = /(\d+)px/.exec(ctx.font);
  if (!m || !m[1]) return;
  const size = Math.max(10, Math.floor((Number(m[1]) * maxW) / w));
  ctx.font = ctx.font.replace(/\d+px/, `${size}px`);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
