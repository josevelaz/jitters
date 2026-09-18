/**
 * studio.ts — CleanShot-style frame compositor.
 *
 * Reads page-only `capture.mp4` + sampled `cursor.json` + semantic
 * `timeline.json` + `style.json` out of a project directory and writes an
 * MP4. No browser, no ffmpeg zoom filters, no baked pointer: the cursor is drawn per
 * frame from the Bézier path fitted through the sampled cursor track
 * (see cursor.ts), and zoom envelopes come from timeline boxes.
 *
 * Task 6 wires `studio-demo render <projectDir> [--style] [--out]
 * [--format] [--bg]` on top of `renderProject`.
 */

import { createCanvas, ImageData } from "@napi-rs/canvas";
import type { SKRSContext2D } from "@napi-rs/canvas";
import { promises as fs } from "node:fs";
import { closeSync, openSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  downAt,
  drawCursor,
  drawRipple,
  extractRipples,
  normalizeTrack,
  positionAt,
  type ClickRipple,
  type CursorSample,
} from "./cursor.js";
import {
  createEncoder,
  decodeToRawFile,
  type VideoInfo,
} from "./ffmpeg.js";

/* ------------------------------------------------------------------ */
/* Style                                                               */
/* ------------------------------------------------------------------ */

export interface StyleJson {
  canvas?: { width?: number; height?: number };
  width?: number;
  height?: number;
  aspectRatio?: string;
  padding?: number | { x?: number; y?: number };
  radius?: number;
  cornerRadius?: number;
  borderRadius?: number;
  shadow?: { x?: number; y?: number; blur?: number; color?: string } | string | false | null;
  background?: string | { type?: string; from?: string; to?: string; colors?: string[]; angle?: number };
  bg?: string;
  zoom?: number | {
    scale?: number; to?: number; maxScale?: number;
    inMs?: number; in?: number;
    holdMs?: number; hold?: number;
    outMs?: number; out?: number;
    skipAbove?: number; skipThreshold?: number;
  };
  cursor?: number | { size?: number; tension?: number };
  cursorSize?: number;
  tension?: number;
  smoothing?: { tension?: number };
  ripples?: { enabled?: boolean; durationMs?: number; duration?: number; color?: string; maxRadius?: number; radius?: number };
  ripple?: StyleJson["ripples"];
  motionBlur?: boolean | number | {
    enabled?: boolean; samples?: number; shutter?: number;
    camera?: boolean; cursor?: boolean;
  };
  motionblur?: StyleJson["motionBlur"];
  fps?: number;
}

/** The default `style.json` shape (default tokens per spec). */
export function defaultStyle(): StyleJson {
  return {
    canvas: { width: 1920, height: 1080 },
    padding: 96,
    radius: 16,
    shadow: { x: 0, y: 24, blur: 80, color: "rgba(0,0,0,0.35)" },
    background: {
      type: "linear-gradient",
      from: "#0b1020",
      to: "#1d4ed8",
      angle: 135,
    },
    zoom: { scale: 1.6, inMs: 700, holdMs: 800, outMs: 700, skipAbove: 0.4 },
    cursor: { size: 28, tension: 0.5 },
    ripples: {
      enabled: true,
      durationMs: 600,
      color: "rgba(96,165,250,1)",
      maxRadius: 44,
    },
    motionBlur: { enabled: true, samples: 8, shutter: 0.5, camera: true, cursor: true },
  };
}

interface ResolvedStyle {
  width: number;
  height: number;
  padding: number;
  radius: number;
  shadow: { x: number; y: number; blur: number; color: string } | null;
  background: { kind: "solid"; color: string } | { kind: "gradient"; from: string; to: string; angle: number };
  zoom: { scale: number; inMs: number; holdMs: number; outMs: number; skipAbove: number };
  cursor: { size: number; tension: number };
  ripples: { enabled: boolean; durationMs: number; color: string; maxRadius: number };
  motionBlur: { enabled: boolean; samples: number; shutter: number; camera: boolean; cursor: boolean };
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function parseFormatDims(format: string | undefined): { width: number; height: number } | null {
  if (!format) return null;
  const f = format.trim().toLowerCase();
  const wh = f.match(/(\d{3,5})\s*[x×:]\s*(\d{3,5})/);
  if (wh) {
    const w = Number(wh[1]);
    const h = Number(wh[2]);
    if (w >= 64 && h >= 64 && w <= 8192 && h <= 8192) return { width: w, height: h };
    return null;
  }
  if (f === "1080p" || f === "1080") return { width: 1920, height: 1080 };
  if (f === "720p" || f === "720") return { width: 1280, height: 720 };
  if (f === "4k" || f === "2160p" || f === "2160") return { width: 3840, height: 2160 };
  if (f === "16:9" || f === "landscape") return { width: 1920, height: 1080 };
  if (f === "9:16" || f === "portrait") return { width: 1080, height: 1920 };
  if (f === "1:1" || f === "square") return { width: 1080, height: 1080 };
  if (f === "4:3") return { width: 1440, height: 1080 };
  return null;
}

function resolveStyle(
  base: StyleJson,
  formatOverride?: string,
  bgOverride?: string,
): ResolvedStyle {
  const d = defaultStyle();
  const canvas = (base.canvas ?? {}) as { width?: number; height?: number };
  let width = num(canvas.width ?? base.width, 1920);
  let height = num(canvas.height ?? base.height, 1080);
  if (typeof base.aspectRatio === "string") {
    const dims = parseFormatDims(base.aspectRatio);
    if (dims) {
      width = dims.width;
      height = dims.height;
    }
  }
  if (formatOverride) {
    const dims = parseFormatDims(formatOverride);
    if (dims) {
      width = dims.width;
      height = dims.height;
    }
  }
  width = Math.round(Math.min(8192, Math.max(64, width)));
  height = Math.round(Math.min(8192, Math.max(64, height)));

  const padRaw = base.padding ?? (d.padding as number);
  const padding =
    typeof padRaw === "number"
      ? padRaw
      : num((padRaw as { x?: number }).x ?? (padRaw as { y?: number }).y, 96);
  const radius = num(
    base.radius ?? base.cornerRadius ?? base.borderRadius,
    16,
  );

  let shadow: ResolvedStyle["shadow"] = { x: 0, y: 24, blur: 80, color: "rgba(0,0,0,0.35)" };
  const dShadow = d.shadow as { x: number; y: number; blur: number; color: string };
  if (base.shadow === false || base.shadow === null) {
    shadow = null;
  } else if (typeof base.shadow === "string") {
    shadow = { ...dShadow, color: base.shadow };
  } else if (base.shadow && typeof base.shadow === "object") {
    const s = base.shadow;
    shadow = {
      x: num(s.x, dShadow.x),
      y: num(s.y, dShadow.y),
      blur: num(s.blur, dShadow.blur),
      color: typeof s.color === "string" ? s.color : dShadow.color,
    };
  }

  let background: ResolvedStyle["background"] = {
    kind: "gradient",
    from: "#0b1020",
    to: "#1d4ed8",
    angle: 135,
  };
  const bgRaw = base.background ?? base.bg ?? d.background;
  if (typeof bgRaw === "string") {
    background = { kind: "solid", color: bgRaw };
  } else if (bgRaw && typeof bgRaw === "object") {
    const g = bgRaw as { type?: string; from?: string; to?: string; colors?: string[]; angle?: number };
    const type = (g.type ?? "").toLowerCase();
    if (type.includes("solid") || (!g.from && !g.to && !g.colors)) {
      background = {
        kind: "solid",
        color: (g.from ?? g.colors?.[0] ?? "#0b1020") as string,
      };
    } else {
      const colors = Array.isArray(g.colors) && g.colors.length >= 2
        ? g.colors
        : [g.from ?? "#0b1020", g.to ?? "#1d4ed8"];
      background = {
        kind: "gradient",
        from: colors[0]!,
        to: colors[1]!,
        angle: num(g.angle, 135),
      };
    }
  }
  if (bgOverride && bgOverride.trim().length > 0) {
    background = { kind: "solid", color: bgOverride };
  }

  const dZoom = d.zoom as { scale: number; inMs: number; holdMs: number; outMs: number; skipAbove: number };
  const zoomRaw = base.zoom;
  const zoomObj = (typeof zoomRaw === "number" ? { scale: zoomRaw } : (zoomRaw ?? {})) as NonNullable<Exclude<StyleJson["zoom"], number>>;
  const zoom = {
    scale: num(zoomObj.scale ?? zoomObj.to ?? zoomObj.maxScale, dZoom.scale),
    inMs: num(zoomObj.inMs ?? zoomObj.in, dZoom.inMs),
    holdMs: num(zoomObj.holdMs ?? zoomObj.hold, dZoom.holdMs),
    outMs: num(zoomObj.outMs ?? zoomObj.out, dZoom.outMs),
    skipAbove: num(zoomObj.skipAbove ?? zoomObj.skipThreshold, dZoom.skipAbove),
  };
  zoom.scale = Math.min(4, Math.max(1, zoom.scale));
  zoom.inMs = Math.min(10000, Math.max(0, zoom.inMs));
  zoom.holdMs = Math.min(30000, Math.max(0, zoom.holdMs));
  zoom.outMs = Math.min(10000, Math.max(0, zoom.outMs));
  zoom.skipAbove = Math.min(1, Math.max(0, zoom.skipAbove));

  const dCursor = d.cursor as { size: number; tension: number };
  const cursorRaw = base.cursor;
  const cursorObj = (typeof cursorRaw === "number" ? { size: cursorRaw } : (cursorRaw ?? {})) as { size?: number; tension?: number };
  const smoothing = (base.smoothing ?? {}) as { tension?: number };
  const cursor = {
    size: num(cursorObj.size ?? base.cursorSize, dCursor.size),
    tension: num(cursorObj.tension ?? base.tension ?? smoothing.tension, dCursor.tension),
  };
  cursor.size = Math.min(128, Math.max(4, cursor.size));
  if (!Number.isFinite(cursor.tension)) cursor.tension = dCursor.tension;
  cursor.tension = Math.min(1.5, Math.max(0, cursor.tension));

  const dRip = d.ripples as { enabled: boolean; durationMs: number; color: string; maxRadius: number };
  const ripRaw = ((base.ripples ?? base.ripple ?? {}) as NonNullable<StyleJson["ripples"]>);
  const ripples = {
    enabled: (ripRaw.enabled ?? dRip.enabled) !== false,
    durationMs: num(ripRaw.durationMs ?? ripRaw.duration, dRip.durationMs),
    color: typeof ripRaw.color === "string" ? ripRaw.color : dRip.color,
    maxRadius: num(ripRaw.maxRadius ?? ripRaw.radius, dRip.maxRadius),
  };

  const dMb = d.motionBlur as { enabled: boolean; samples: number; shutter: number; camera: boolean; cursor: boolean };
  const mbRaw = base.motionBlur ?? base.motionblur;
  let motionBlur = {
    enabled: dMb.enabled,
    samples: dMb.samples,
    shutter: dMb.shutter,
    camera: dMb.camera,
    cursor: dMb.cursor,
  };
  if (typeof mbRaw === "boolean") {
    motionBlur = { ...motionBlur, enabled: mbRaw };
  } else if (typeof mbRaw === "number") {
    motionBlur = { ...motionBlur, enabled: mbRaw > 1, samples: mbRaw };
  } else if (mbRaw && typeof mbRaw === "object") {
    const m = mbRaw;
    motionBlur = {
      enabled: (m.enabled ?? dMb.enabled) !== false,
      samples: num(m.samples, dMb.samples),
      shutter: num(m.shutter, dMb.shutter),
      camera: (m.camera ?? dMb.camera) !== false,
      cursor: (m.cursor ?? dMb.cursor) !== false,
    };
  }
  motionBlur.samples = Math.round(Math.min(32, Math.max(1, motionBlur.samples)));
  motionBlur.shutter = Math.min(2, Math.max(0, motionBlur.shutter));
  if (motionBlur.samples <= 1) motionBlur.enabled = false;

  return { width, height, padding, radius, shadow, background, zoom, cursor, ripples, motionBlur };
}

/* ------------------------------------------------------------------ */
/* Timeline                                                            */
/* ------------------------------------------------------------------ */

export interface TimelineBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TimelineEvent {
  tMs: number;
  kind: string;
  box?: TimelineBox;
}

function toBox(raw: unknown, capW: number, capH: number): TimelineBox | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  let rec: Record<string, unknown>;
  if (Array.isArray(raw)) {
    const [x, y, w, h] = raw as unknown[];
    rec = { x, y, w, h };
  } else {
    rec = raw as Record<string, unknown>;
  }
  let x = Number(rec.x ?? rec.left ?? rec.l);
  let y = Number(rec.y ?? rec.top ?? rec.t);
  let w = Number(rec.w ?? rec.width ?? rec.widthPx);
  let h = Number(rec.h ?? rec.height ?? rec.heightPx);
  if (![x, y, w, h].every(Number.isFinite)) return undefined;
  if (w <= 0 || h <= 0) return undefined;
  // Normalized 0..1 boxes → capture pixels.
  if (x >= 0 && y >= 0 && Math.max(x, y, w, h) <= 1 && capW > 10 && capH > 10) {
    x *= capW;
    y *= capH;
    w *= capW;
    h *= capH;
  }
  return { x, y, w, h };
}

/** Lenient timeline parse: array or `{ events | timeline | clips | items }`. */
export function parseTimeline(raw: unknown, capW: number, capH: number): TimelineEvent[] {
  let items: unknown[] = [];
  if (Array.isArray(raw)) items = raw;
  else if (raw && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    const nested = rec.events ?? rec.timeline ?? rec.clips ?? rec.items;
    if (Array.isArray(nested)) items = nested;
  }
  const events: TimelineEvent[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const tMs = Number(
      rec.tMs ?? rec.timeMs ?? rec.time ?? rec.t ?? rec.start ?? rec.startMs ?? rec.at ?? rec.timestamp,
    );
    if (!Number.isFinite(tMs) || tMs < 0) continue;
    const kind = String(rec.type ?? rec.kind ?? rec.name ?? rec.action ?? "click").toLowerCase();
    const box = toBox(
      rec.box ?? rec.rect ?? rec.target ?? rec.region ?? rec.bounds ?? rec.frame,
      capW,
      capH,
    );
    events.push(box ? { tMs, kind, box } : { tMs, kind });
  }
  events.sort((a, b) => a.tMs - b.tMs);
  return events;
}

/* ------------------------------------------------------------------ */
/* Camera (zoom envelopes from timeline boxes)                         */
/* ------------------------------------------------------------------ */

interface CameraState {
  scale: number;
  cx: number;
  cy: number;
}

function easeInOutCubic(u: number): number {
  const t = Math.min(1, Math.max(0, u));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOutCubic(u: number): number {
  const t = Math.min(1, Math.max(0, u));
  return 1 - Math.pow(1 - t, 3);
}

function boxCoversViewport(box: TimelineBox, capW: number, capH: number, skipAbove: number): boolean {
  return (box.w * box.h) / (capW * capH) > skipAbove;
}

function cameraAt(
  events: TimelineEvent[],
  tMs: number,
  capW: number,
  capH: number,
  zoom: ResolvedStyle["zoom"],
): CameraState {
  const vx = capW / 2;
  const vy = capH / 2;
  if (zoom.scale <= 1.001) return { scale: 1, cx: vx, cy: vy };
  const total = zoom.inMs + zoom.holdMs + zoom.outMs;
  let active: TimelineEvent | undefined;
  for (const ev of events) {
    if (!ev.box) continue;
    if (ev.tMs > tMs) break;
    if (tMs > ev.tMs + total) continue;
    if (boxCoversViewport(ev.box, capW, capH, zoom.skipAbove)) continue;
    active = ev; // latest started wins on overlap
  }
  if (!active || !active.box) return { scale: 1, cx: vx, cy: vy };
  const box = active.box;
  const bx = Math.min(Math.max(box.x + box.w / 2, 0), capW);
  const by = Math.min(Math.max(box.y + box.h / 2, 0), capH);
  const dt = tMs - active.tMs;
  const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
  if (dt < zoom.inMs && zoom.inMs > 0) {
    const u = easeInOutCubic(dt / zoom.inMs);
    return { scale: 1 + (zoom.scale - 1) * u, cx: lerp(vx, bx, u), cy: lerp(vy, by, u) };
  }
  if (dt < zoom.inMs + zoom.holdMs) {
    return { scale: zoom.scale, cx: bx, cy: by };
  }
  if (dt < total && zoom.outMs > 0) {
    const u = easeOutCubic((dt - zoom.inMs - zoom.holdMs) / zoom.outMs);
    return {
      scale: zoom.scale - (zoom.scale - 1) * u,
      cx: lerp(bx, vx, u),
      cy: lerp(by, vy, u),
    };
  }
  return { scale: 1, cx: vx, cy: vy };
}

/* ------------------------------------------------------------------ */
/* Frame rendering                                                     */
/* ------------------------------------------------------------------ */

export interface RenderOptions {
  out?: string;
  style?: string | StyleJson;
  format?: string;
  bg?: string;
}

interface FrameGeom {
  crop: { x: number; y: number; w: number; h: number };
  dest: { x: number; y: number; w: number; h: number };
}

function frameGeom(
  cam: CameraState,
  capW: number,
  capH: number,
  outW: number,
  outH: number,
  pad: number,
): FrameGeom {
  const scale = Math.max(1, cam.scale);
  const cropW = capW / scale;
  const cropH = capH / scale;
  const clamp = (v: number, lo: number, hi: number): number =>
    Math.min(Math.max(v, lo), Math.max(lo, hi));
  const cropX = clamp(cam.cx - cropW / 2, 0, capW - cropW);
  const cropY = clamp(cam.cy - cropH / 2, 0, capH - cropH);
  const boxW = Math.max(1, outW - pad * 2);
  const boxH = Math.max(1, outH - pad * 2);
  const fit = Math.min(boxW / capW, boxH / capH);
  const destW = capW * fit;
  const destH = capH * fit;
  return {
    crop: { x: cropX, y: cropY, w: cropW, h: cropH },
    dest: { x: (outW - destW) / 2, y: (outH - destH) / 2, w: destW, h: destH },
  };
}

function roundedRectPath(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

function paintBackground(ctx: SKRSContext2D, style: ResolvedStyle): void {
  const { width, height } = style;
  if (style.background.kind === "solid") {
    ctx.fillStyle = style.background.color;
    ctx.fillRect(0, 0, width, height);
    return;
  }
  const angle = ((style.background.angle - 90) * Math.PI) / 180;
  const cx = width / 2;
  const cy = height / 2;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const len = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
  const grad = ctx.createLinearGradient(cx - dx * len, cy - dy * len, cx + dx * len, cy + dy * len);
  grad.addColorStop(0, style.background.from);
  grad.addColorStop(1, style.background.to);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
}

interface SceneSources {
  track: CursorSample[];
  ripples: ClickRipple[];
  events: TimelineEvent[];
  capCanvas: import("@napi-rs/canvas").Canvas;
  capCtx: SKRSContext2D;
  capFd: number;
  capFrameBytes: number;
  capFrames: number;
  capW: number;
  capH: number;
  fps: number;
  style: ResolvedStyle;
  lastCapIndex: { value: number };
}

function captureIndexAt(tMs: number, fps: number, frames: number): number {
  return Math.min(frames - 1, Math.max(0, Math.round((tMs / 1000) * fps)));
}

function loadCaptureFrame(sources: SceneSources, index: number): void {
  if (sources.lastCapIndex.value === index) return;
  const buf = Buffer.allocUnsafe(sources.capFrameBytes);
  readSync(sources.capFd, buf, 0, sources.capFrameBytes, index * sources.capFrameBytes);
  const image = new ImageData(
    new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength),
    sources.capW,
    sources.capH,
  );
  sources.capCtx.putImageData(image, 0, 0);
  sources.lastCapIndex.value = index;
}

/** Render one shutter sub-sample of the scene at time `tsMs`. */
function renderSample(
  ctx: SKRSContext2D,
  sources: SceneSources,
  tsMs: number,
  camOverride?: CameraState,
  cursorOverride?: { x: number; y: number; pressed: boolean },
): void {
  const { style, capW, capH } = sources;
  const cam = camOverride ?? cameraAt(sources.events, tsMs, capW, capH, style.zoom);
  const geom = frameGeom(cam, capW, capH, style.width, style.height, style.padding);

  paintBackground(ctx, style);

  loadCaptureFrame(sources, captureIndexAt(tsMs, sources.fps, sources.capFrames));

  // Drop shadow + framed window.
  ctx.save();
  if (style.shadow) {
    ctx.shadowColor = style.shadow.color;
    ctx.shadowBlur = style.shadow.blur;
    ctx.shadowOffsetX = style.shadow.x;
    ctx.shadowOffsetY = style.shadow.y;
  }
  roundedRectPath(ctx, geom.dest.x, geom.dest.y, geom.dest.w, geom.dest.h, style.radius);
  ctx.fillStyle = "#000000";
  ctx.fill();
  ctx.restore();

  // Capture crop clipped to the rounded window.
  ctx.save();
  roundedRectPath(ctx, geom.dest.x, geom.dest.y, geom.dest.w, geom.dest.h, style.radius);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    sources.capCanvas,
    geom.crop.x, geom.crop.y, geom.crop.w, geom.crop.h,
    geom.dest.x, geom.dest.y, geom.dest.w, geom.dest.h,
  );
  // Click ripples stick to the content: map through this sample's camera.
  if (style.ripples.enabled) {
    for (const ripple of sources.ripples) {
      const age = tsMs - ripple.tMs;
      if (age < 0 || age > style.ripples.durationMs) continue;
      const px = geom.dest.x + ((ripple.x - geom.crop.x) / geom.crop.w) * geom.dest.w;
      const py = geom.dest.y + ((ripple.y - geom.crop.y) / geom.crop.h) * geom.dest.h;
      drawRipple(ctx, px, py, age / style.ripples.durationMs, {
        color: style.ripples.color,
        maxRadius: style.ripples.maxRadius,
      });
    }
  }
  ctx.restore();

  // Hairline window edge.
  ctx.save();
  roundedRectPath(ctx, geom.dest.x + 0.5, geom.dest.y + 0.5, geom.dest.w - 1, geom.dest.h - 1, style.radius);
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  // Synthetic cursor from the Bézier path through the sampled track.
  const cursor = cursorOverride ?? {
    ...positionAt(sources.track, tsMs, style.cursor.tension),
    pressed: downAt(sources.track, tsMs),
  };
  if (sources.track.length > 0) {
    const px = geom.dest.x + ((cursor.x - geom.crop.x) / geom.crop.w) * geom.dest.w;
    const py = geom.dest.y + ((cursor.y - geom.crop.y) / geom.crop.h) * geom.dest.h;
    // Cursor size is authored in output pixels but scales with the window so
    // it stays proportional when --format changes the canvas.
    const sizeScale = geom.dest.w / (sources.capW || geom.dest.w);
    drawCursor(ctx, px, py, {
      size: style.cursor.size * (Number.isFinite(sizeScale) && sizeScale > 0 ? Math.sqrt(sizeScale) : 1),
      pressed: cursor.pressed,
    });
  }
}

function shutterTimes(tMs: number, dtMs: number, style: ResolvedStyle): number[] {
  const mb = style.motionBlur;
  if (!mb.enabled || mb.samples <= 1 || mb.shutter <= 0) return [tMs];
  const n = mb.samples;
  const win = mb.shutter * dtMs;
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? tMs : tMs - win + (win * i) / (n - 1);
    times.push(Math.max(0, t));
  }
  return times;
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path, "utf8")) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`invalid JSON in ${path}: ${(err as Error).message}`);
  }
}

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);

function resolveOutPath(projectDir: string, out?: string): string {
  if (!out) return resolve(projectDir, "export.mp4");
  if (VIDEO_EXTENSIONS.has(extname(out).toLowerCase())) return resolve(out);
  return resolve(out, `${basename(resolve(projectDir))}.mp4`);
}

/**
 * Recomposite a project directory to MP4 without recapturing.
 *
 * Reads `capture.mp4`, `cursor.json`, `timeline.json`, `style.json` from
 * `projectDir`. `options.style` (path or object) replaces the style file for
 * this export; `options.format` / `options.bg` override one export.
 * Resolves to the absolute output path. Never modifies `capture.mp4` and
 * never launches a browser.
 */
export async function renderProject(
  projectDir: string,
  options?: RenderOptions,
): Promise<string> {
  const dir = resolve(projectDir);
  const capturePath = join(dir, "capture.mp4");
  try {
    await fs.access(capturePath);
  } catch {
    throw new Error(`missing capture video: ${capturePath}`);
  }

  // Style: project file <- --style replacement/override <- --format/--bg.
  let fileStyle: StyleJson = {};
  const projectStylePath = join(dir, "style.json");
  if (typeof options?.style === "string") {
    try {
      fileStyle = JSON.parse(await fs.readFile(resolve(options.style), "utf8")) as StyleJson;
    } catch (err) {
      throw new Error(`cannot read style ${(options.style as string)}: ${(err as Error).message}`);
    }
  } else {
    const raw = await readJsonFile(projectStylePath);
    if (raw !== undefined) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`invalid style.json in ${dir}: expected an object`);
      }
      fileStyle = raw as StyleJson;
    } else {
      // No style.json yet: persist the defaults so restyles have a target.
      await fs.writeFile(projectStylePath, `${JSON.stringify(defaultStyle(), null, 2)}\n`, "utf8");
    }
  }
  const merged: StyleJson = { ...fileStyle };
  if (options?.style && typeof options.style === "object") {
    for (const [key, value] of Object.entries(options.style)) {
      const k = key as keyof StyleJson;
      if (
        value && typeof value === "object" && !Array.isArray(value) &&
        (merged[k] as unknown) && typeof merged[k] === "object"
      ) {
        (merged as Record<string, unknown>)[key] = { ...((merged[k] as unknown) as Record<string, unknown>), ...((value as unknown) as Record<string, unknown>) };
      } else {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }
  const style = resolveStyle(merged, options?.format, options?.bg);

  const cursorRaw = await readJsonFile(join(dir, "cursor.json"));
  const track = normalizeTrack(cursorRaw ?? []);
  const ripples = extractRipples(track);

  const timelineRaw = await readJsonFile(join(dir, "timeline.json"));

  const outPath = resolveOutPath(dir, options?.out);
  await fs.mkdir(dirname(outPath), { recursive: true });

  const rawPath = join(
    await fs.mkdtemp(join(tmpdir(), "studio-demo-")),
    "capture.rgba",
  );
  let info: VideoInfo;
  try {
    info = await decodeToRawFile(capturePath, rawPath);
  } catch (err) {
    await fs.rm(dirname(rawPath), { recursive: true, force: true });
    throw err;
  }
  const events = parseTimeline(timelineRaw ?? [], info.width, info.height);
  const fps = Math.min(60, Math.max(1, info.fps));
  const totalFrames = Math.max(1, info.nbFrames);
  const dtMs = 1000 / fps;

  const frameBytes = info.width * info.height * 4;
  const capFd = openSync(rawPath, "r");
  const capCanvas = createCanvas(info.width, info.height);
  const capCtx = capCanvas.getContext("2d");
  const scratch = createCanvas(style.width, style.height);
  const scratchCtx = scratch.getContext("2d");
  const outCanvas = createCanvas(style.width, style.height);
  const outCtx = outCanvas.getContext("2d");
  const acc = new Float32Array(style.width * style.height * 4);

  const sources: SceneSources = {
    track,
    ripples,
    events,
    capCanvas,
    capCtx,
    capFd,
    capFrameBytes: frameBytes,
    capFrames: totalFrames,
    capW: info.width,
    capH: info.height,
    fps,
    style,
    lastCapIndex: { value: -1 },
  };

  const encoder = createEncoder({ width: style.width, height: style.height, fps, outPath });
  const tmpDir = dirname(rawPath);
  try {
    for (let k = 0; k < totalFrames; k++) {
      const tMs = k * dtMs;
      const times = shutterTimes(tMs, dtMs, style);
      const fixedCam = style.motionBlur.camera
        ? undefined
        : cameraAt(events, tMs, info.width, info.height, style.zoom);
      const fixedCursor = style.motionBlur.cursor
        ? undefined
        : {
            ...positionAt(track, tMs, style.cursor.tension),
            pressed: downAt(track, tMs),
          };
      if (times.length === 1) {
        renderSample(scratchCtx, sources, times[0]!, fixedCam, fixedCursor);
        const single = scratchCtx.getImageData(0, 0, style.width, style.height);
        await encoder.writeFrame(Buffer.from(single.data));
      } else {
        acc.fill(0);
        for (const ts of times) {
          renderSample(scratchCtx, sources, ts, fixedCam, fixedCursor);
          const sample = scratchCtx.getImageData(0, 0, style.width, style.height);
          const data = sample.data;
          for (let i = 0; i < data.length; i++) acc[i]! += data[i]!;
        }
        const n = times.length;
        const bytes = new Uint8ClampedArray(acc.length);
        for (let i = 0; i < acc.length; i++) bytes[i] = Math.round(acc[i]! / n);
        outCtx.putImageData(new ImageData(bytes, style.width, style.height), 0, 0);
        const mergedFrame = outCtx.getImageData(0, 0, style.width, style.height);
        await encoder.writeFrame(Buffer.from(mergedFrame.data));
      }
      if (k === 0 || (k + 1) % 120 === 0 || k + 1 === totalFrames) {
        console.error(`[studio-demo] frame ${k + 1}/${totalFrames}`);
      }
    }
    await encoder.finish();
  } finally {
    closeSync(capFd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
  console.error(`[studio-demo] wrote ${outPath}`);
  return outPath;
}
