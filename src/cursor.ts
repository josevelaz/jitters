/**
 * cursor.ts — synthetic cursor path + cursor/ripple drawing.
 *
 * The capture video contains page pixels only (no pointer). The cursor you
 * see in the export is drawn by the compositor from `cursor.json`, which
 * holds every sampled mouse position (`{ tMs, x, y, button? }` in
 * capture/viewport space).
 *
 * Path model: the compositor evaluates the cursor with a cubic Bézier fitted
 * through the *sampled* track (Catmull-Rom → Bézier, one segment per sample
 * pair). The path is never collapsed to click-to-click segments, so spins,
 * loops, overshoots, and `--human` curves in the samples survive into the
 * export. The `tension` knob only scales tangent magnitude — it never drops
 * samples, so it cannot erase loops.
 */

export interface CursorSample {
  tMs: number;
  x: number;
  y: number;
  button?: number | string | boolean;
  type?: string;
  pressed?: boolean;
}

export interface CursorPoint {
  x: number;
  y: number;
}

export interface BezierSegment {
  p0: CursorPoint;
  p1: CursorPoint;
  p2: CursorPoint;
  p3: CursorPoint;
  /** Segment time range (ms, relative to record start). */
  t0: number;
  t1: number;
}

export interface ClickRipple {
  tMs: number;
  x: number;
  y: number;
}

export const DEFAULT_TENSION = 0.5;

/** Keep raw cursor input usable: drop garbage, coerce numbers, sort by time. */
export function normalizeTrack(raw: unknown): CursorSample[] {
  if (!Array.isArray(raw)) return [];
  const out: CursorSample[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const tMs = Number(rec.tMs ?? rec.time ?? rec.timeMs ?? rec.t);
    const x = Number(rec.x ?? rec.clientX ?? rec.left);
    const y = Number(rec.y ?? rec.clientY ?? rec.top);
    if (!Number.isFinite(tMs) || !Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    const sample: CursorSample = { tMs, x, y };
    if (rec.button !== undefined) {
      sample.button = rec.button as CursorSample["button"];
    }
    if (typeof rec.type === "string") sample.type = rec.type;
    if (typeof rec.pressed === "boolean") sample.pressed = rec.pressed;
    out.push(sample);
  }
  out.sort((a, b) => a.tMs - b.tMs);
  return out;
}

/** True when a sample represents a pressed primary button. */
export function isDown(sample: CursorSample): boolean {
  if (sample.pressed === true) return true;
  const type = (sample.type ?? "").toLowerCase();
  if (
    type.includes("mousedown") ||
    type.includes("pointerdown") ||
    type === "down" ||
    type === "press" ||
    type === "pressed"
  ) {
    return true;
  }
  if (
    type.includes("mouseup") ||
    type.includes("pointerup") ||
    type === "up" ||
    type === "release" ||
    type === "released"
  ) {
    return false;
  }
  const button = sample.button;
  if (typeof button === "number") return button > 0;
  if (typeof button === "boolean") return button;
  if (typeof button === "string") {
    const b = button.toLowerCase();
    return b === "down" || b === "pressed" || b === "1" || b === "true";
  }
  return false;
}

/**
 * Click ripples come from `mousedown` samples in cursor.json — not from the
 * timeline alone. A held button emits one ripple on its rising edge; explicit
 * `mousedown`-typed samples each emit a ripple.
 */
export function extractRipples(track: CursorSample[]): ClickRipple[] {
  const ripples: ClickRipple[] = [];
  let wasDown = false;
  for (const sample of track) {
    const type = (sample.type ?? "").toLowerCase();
    const explicitDown =
      type.includes("mousedown") || type.includes("pointerdown");
    // Only samples carrying button info update the latch: plain move samples
    // (no button field) between a down and its release must not re-arm the
    // rising edge, or a held button would emit one ripple per sample.
    const carriesButtonInfo =
      sample.button !== undefined ||
      sample.pressed !== undefined ||
      sample.type !== undefined;
    const down = isDown(sample);
    if (explicitDown || (carriesButtonInfo && down && !wasDown)) {
      const last = ripples[ripples.length - 1];
      // Coalesce duplicate reports of the same press.
      if (!last || sample.tMs - last.tMs > 40) {
        ripples.push({ tMs: sample.tMs, x: sample.x, y: sample.y });
      }
    }
    if (carriesButtonInfo) wasDown = down;
    if (explicitDown) wasDown = true;
  }
  return ripples;
}

/**
 * Fit one cubic Bézier per sample pair using the Catmull-Rom → Bézier
 * conversion. Endpoints are clamped (duplicated) so the curve passes through
 * the first and last samples. `tension` scales tangent length only
 * (default 0.5 → the classic 1/6 factor); every sample stays on the curve.
 */
export function catmullRomToBezier(
  track: CursorSample[],
  tension = DEFAULT_TENSION,
): BezierSegment[] {
  const k = (Number.isFinite(tension) ? tension : DEFAULT_TENSION) / 3;
  const segments: BezierSegment[] = [];
  for (let i = 0; i + 1 < track.length; i++) {
    const p0 = track[Math.max(0, i - 1)]!;
    const p1 = track[i]!;
    const p2 = track[i + 1]!;
    const p3 = track[Math.min(track.length - 1, i + 2)]!;
    segments.push({
      p0: { x: p1.x, y: p1.y },
      p1: {
        x: p1.x + (p2.x - p0.x) * k,
        y: p1.y + (p2.y - p0.y) * k,
      },
      p2: {
        x: p2.x - (p3.x - p1.x) * k,
        y: p2.y - (p3.y - p1.y) * k,
      },
      p3: { x: p2.x, y: p2.y },
      t0: p1.tMs,
      t1: p2.tMs,
    });
  }
  return segments;
}

function evalCubic(
  p0: CursorPoint,
  p1: CursorPoint,
  p2: CursorPoint,
  p3: CursorPoint,
  u: number,
): CursorPoint {
  const v = 1 - u;
  const a = v * v * v;
  const b = 3 * v * v * u;
  const c = 3 * v * u * u;
  const d = u * u * u;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/**
 * Cursor position at time `tMs` by walking the Bézier segments fitted through
 * the sampled track. Times outside the track clamp to the first/last sample.
 */
export function positionAt(
  track: CursorSample[],
  tMs: number,
  tension = DEFAULT_TENSION,
): CursorPoint {
  if (track.length === 0) return { x: 0, y: 0 };
  if (track.length === 1 || tMs <= track[0]!.tMs) {
    return { x: track[0]!.x, y: track[0]!.y };
  }
  const last = track[track.length - 1]!;
  if (tMs >= last.tMs) return { x: last.x, y: last.y };

  const segments = catmullRomToBezier(track, tension);
  // Binary search on segment end times.
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tMs > segments[mid]!.t1) lo = mid + 1;
    else hi = mid;
  }
  const seg = segments[lo]!;
  const span = seg.t1 - seg.t0;
  const u = span <= 0 ? 0 : Math.min(1, Math.max(0, (tMs - seg.t0) / span));
  return evalCubic(seg.p0, seg.p1, seg.p2, seg.p3, u);
}

/** Button state at `tMs`: the most recent sample at or before `tMs`. */
export function downAt(track: CursorSample[], tMs: number): boolean {
  let down = false;
  let found = false;
  for (const sample of track) {
    if (sample.tMs > tMs) break;
    // Only samples that carry button info update the latch; plain moves
    // (no button field) leave the previous state alone.
    if (
      sample.button === undefined &&
      sample.pressed === undefined &&
      sample.type === undefined
    ) {
      continue;
    }
    down = isDown(sample);
    found = true;
  }
  return found ? down : false;
}

export interface CursorDrawOptions {
  /** Arrow height in px. */
  size?: number;
  pressed?: boolean;
}

type Ctx2D = import("@napi-rs/canvas").SKRSContext2D;

/**
 * Draw a synthetic arrow cursor with its hotspot at (x, y). White fill with
 * a dark outline reads over any page background; `size` is the arrow height.
 */
export function drawCursor(
  ctx: Ctx2D,
  x: number,
  y: number,
  options?: CursorDrawOptions,
): void {
  const size = options?.size ?? 28;
  const s = (size / 24) * (options?.pressed ? 0.9 : 1);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 17);
  ctx.lineTo(4.4, 12.9);
  ctx.lineTo(6.6, 17.8);
  ctx.lineTo(8.8, 16.7);
  ctx.lineTo(6.6, 11.9);
  ctx.lineTo(10.6, 11.9);
  ctx.closePath();
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();
}

export interface RippleDrawOptions {
  maxRadius?: number;
  color?: string;
  lineWidth?: number;
}

/** Draw one click ripple ring at 0 <= progress <= 1 (expanding + fading). */
export function drawRipple(
  ctx: Ctx2D,
  x: number,
  y: number,
  progress: number,
  options?: RippleDrawOptions,
): void {
  const p = Math.min(1, Math.max(0, progress));
  if (p <= 0 || p >= 1) return;
  const maxRadius = options?.maxRadius ?? 44;
  const eased = 1 - Math.pow(1 - p, 3);
  const radius = 6 + eased * maxRadius;
  const alpha = (1 - p) * 0.9;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = options?.color ?? "rgba(96,165,250,1)";
  ctx.lineWidth = options?.lineWidth ?? 3;
  ctx.stroke();
  ctx.globalAlpha = alpha * 0.18;
  ctx.fillStyle = options?.color ?? "rgba(96,165,250,1)";
  ctx.fill();
  ctx.restore();
}
