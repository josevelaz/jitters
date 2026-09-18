/**
 * browser.ts — thin adapter that drives Chrome ONLY through the
 * `agent-browser` CLI (`--json`), never Playwright / Browser Use.
 *
 * Every command runs as:
 *   agent-browser --session <studio-…> --json <command…>
 *
 * Rules:
 * - The session id is always `studio-…` (unique per launch). The adapter
 *   never operates on the default/unnamed session, never passes `--headed`
 *   (headless), and never passes `close --all`.
 * - A cursor-buffer page init script is registered BEFORE the first
 *   navigation (`open` with no URL carries `--init-script`, then we
 *   navigate). The init script re-installs itself on every document, so
 *   mousemove/mousedown/mouseup keep being recorded across navigations.
 * - `mouse move --human` is used for human-like moves (probed on
 *   agent-browser 0.37.1: the flag is accepted). The CLI dispatches one
 *   page-visible mousemove per call, so human moves are stepped through
 *   interpolated waypoints to record a dense path instead of a teleport.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface SnapRef {
  /** Ref with `@` prefix, e.g. `@e3` (accepted by every CLI command). */
  ref: string;
  role: string;
  name: string;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CursorPoint {
  /** ms since markRecordStart (Date.now() based, synced to record start). */
  tMs: number;
  x: number;
  y: number;
  button?: number;
}

export interface LaunchOptions {
  /** Starting URL. When omitted the session stays on about:blank. */
  url?: string;
  viewportWidth?: number;
  viewportHeight?: number;
}

/**
 * Page init script (embedded; written to a temp file at launch because the
 * CLI takes `--init-script <path>`). Buffers mousemove positions as
 * { tMs, x, y } plus mousedown/mouseup presses as { tMs, x, y, button }
 * using client coordinates (moves carry no button field so ripple detection
 * sees a rising edge on press; e.buttons makes a left press read 1, not 0).
 * tMs is Date.now() minus a record-start offset the adapter resets when
 * recording starts, so points line up with the captured video.
 */
export const CURSOR_INIT_JS = `(() => {
  const w = window;
  if (w.__studioCursorInit) return;
  w.__studioCursorInit = true;
  const SS_KEY = "__studioCursorPersist.v1";
  const NAME_PREFIX = "__studioCursor::";
  const readOne = (raw) => {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o.start === "number" && Array.isArray(o.buf)) return o;
    } catch (_) {}
    return null;
  };
  const readPersisted = () => {
    let a = null;
    let b = null;
    try {
      const raw = w.sessionStorage.getItem(SS_KEY);
      if (raw) a = readOne(raw);
    } catch (_) {}
    try {
      const nm = w.name;
      if (typeof nm === "string" && nm.indexOf(NAME_PREFIX) === 0) {
        b = readOne(nm.slice(NAME_PREFIX.length));
      }
    } catch (_) {}
    if (a && b) {
      // sessionStorage is per-origin (stale after a cross-origin hop) while
      // window.name travels with the tab (fresh). Neither alone is newest,
      // so take their union: both are append-only histories on the same
      // record-start clock, and the union is the complete track.
      if (a.start !== b.start) return b.buf.length >= a.buf.length ? b : a;
      const seen = new Set();
      const buf = [];
      const all = a.buf.concat(b.buf);
      for (let i = 0; i < all.length; i++) {
        const p = all[i];
        const k = p.tMs + "|" + p.x + "|" + p.y + "|" + p.button;
        if (seen.has(k)) continue;
        seen.add(k);
        buf.push(p);
      }
      buf.sort((m, n) => m.tMs - n.tMs);
      return { start: a.start, buf };
    }
    return b || a;
  };
  const writePersistedWith = (start, buf) => {
    let payload = "";
    try {
      payload = JSON.stringify({ start, buf });
    } catch (_) {
      return;
    }
    try {
      w.sessionStorage.setItem(SS_KEY, payload);
    } catch (_) {
      try {
        w.sessionStorage.setItem(SS_KEY, JSON.stringify({ start, buf: buf.slice(-5000) }));
      } catch (_) {}
    }
    try {
      w.name = NAME_PREFIX + payload;
    } catch (_) {
      try {
        w.name = NAME_PREFIX + JSON.stringify({ start, buf: buf.slice(-5000) });
      } catch (_) {}
    }
  };
  const writePersisted = () => {
    writePersistedWith(w.__studioRecordStart, w.__studioCursorBuf);
  };
  const restored = readPersisted();
  if (restored) {
    w.__studioCursorBuf = restored.buf;
    w.__studioRecordStart = restored.start;
  } else {
    if (!Array.isArray(w.__studioCursorBuf)) w.__studioCursorBuf = [];
    if (typeof w.__studioRecordStart !== "number") w.__studioRecordStart = Date.now();
    try {
      writePersisted();
    } catch (_) {}
  }
  let lastFlush = 0;
  let flushTimer = null;
  const schedulePersist = () => {
    try {
      const now = Date.now();
      if (now - lastFlush > 300) {
        lastFlush = now;
        writePersisted();
      } else if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          lastFlush = Date.now();
          try {
            writePersisted();
          } catch (_) {}
        }, 350);
      }
    } catch (_) {}
  };
  const push = (e, btn) => {
    try {
      const sample = {
        tMs: Date.now() - w.__studioRecordStart,
        x: e.clientX,
        y: e.clientY,
      };
      // Moves carry no button field (plain moves); only presses carry
      // button state, so a mousedown is a rising edge. e.button is 0 for a
      // left press (indistinguishable from a move), so presses store
      // e.buttons (left press reads 1).
      if (btn !== undefined) sample.button = btn;
      w.__studioCursorBuf.push(sample);
      schedulePersist();
    } catch (_) {}
  };
  const flush = () => {
    try {
      lastFlush = Date.now();
      writePersisted();
    } catch (_) {}
  };
  w.addEventListener("mousemove", (e) => push(e), true);
  w.addEventListener("mousedown", (e) => push(e, (typeof e.buttons === "number" && e.buttons > 0) ? e.buttons : ((typeof e.button === "number" ? e.button : 0) + 1)), true);
  w.addEventListener("mouseup", (e) => push(e, (typeof e.buttons === "number" ? e.buttons : 0)), true);
  w.addEventListener("pagehide", flush, true);
  w.addEventListener("beforeunload", flush, true);
  try {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  } catch (_) {}
  w.__studioMarkRecordStart = () => {
    w.__studioCursorBuf = [];
    w.__studioRecordStart = Date.now();
    lastFlush = Date.now();
    try {
      writePersistedWith(w.__studioRecordStart, w.__studioCursorBuf);
    } catch (_) {}
    return w.__studioRecordStart;
  };
})();
`;

const MAX_REFS = 60;
const VIEWPORT_W = 1440;
const VIEWPORT_H = 900;

export class StudioBrowserError extends Error {
  readonly command: string[];
  constructor(message: string, command: string[]) {
    super(message);
    this.name = "StudioBrowserError";
    this.command = command;
  }
}

interface CliEnvelope {
  success: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error: unknown;
}

/** Run one CLI command and return the `data` payload (throws on failure). */
function runCli(
  sessionId: string,
  args: string[],
  opts?: { stdin?: string },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const argv = ["--session", sessionId, "--json", ...args];
  const res = spawnSync("agent-browser", argv, {
    encoding: "utf8",
    input: opts?.stdin,
    timeout: 120_000,
  });
  if (res.error) {
    throw new StudioBrowserError(
      `agent-browser spawn failed: ${(res.error as Error).message}`,
      argv,
    );
  }
  const out = (res.stdout ?? "").trim();
  let envelope: CliEnvelope;
  try {
    envelope = JSON.parse(out) as CliEnvelope;
  } catch {
    throw new StudioBrowserError(
      `agent-browser returned non-JSON output (exit ${res.status}): ${out.slice(0, 300)}${res.stderr ? ` stderr: ${String(res.stderr).slice(0, 300)}` : ""}`,
      argv,
    );
  }
  if (!envelope || envelope.success !== true) {
    const detail =
      typeof envelope?.error === "string"
        ? envelope.error
        : JSON.stringify(envelope?.error ?? envelope ?? null);
    throw new StudioBrowserError(`agent-browser failed: ${detail}`, argv);
  }
  return envelope.data;
}

function newStudioSessionId(): string {
  return `studio-${randomUUID().slice(0, 8)}`;
}

export class StudioBrowser {
  readonly sessionId: string;
  private initScriptDir: string | null;
  private lastMouse: { x: number; y: number } | null = null;

  private constructor(sessionId: string, initScriptDir: string | null) {
    if (!sessionId.startsWith("studio-")) {
      throw new StudioBrowserError(
        `refusing to operate on non-isolated session ${JSON.stringify(sessionId)}`,
        [],
      );
    }
    this.sessionId = sessionId;
    this.initScriptDir = initScriptDir;
  }

  /**
   * Launch an isolated `studio-…` session: register the cursor-buffer init
   * script BEFORE the first navigation (blank `open` carries
   * `--init-script`), set the viewport, then navigate when `url` is given.
   * Always headless (no `--headed`).
   */
  static async launch(opts: LaunchOptions = {}): Promise<StudioBrowser> {
    const sessionId = newStudioSessionId();
    const dir = mkdtempSync(join(tmpdir(), "studio-cursor-"));
    const initScriptPath = join(dir, "cursor-init.js");
    writeFileSync(initScriptPath, CURSOR_INIT_JS, "utf8");
    const browser = new StudioBrowser(sessionId, dir);
    // Blank open registers the init script before any real navigation.
    runCli(sessionId, ["open", "--init-script", initScriptPath]);
    await browser.setViewport(
      opts.viewportWidth ?? VIEWPORT_W,
      opts.viewportHeight ?? VIEWPORT_H,
    );
    // Seed a known mouse baseline (pre-recording; the buffer is reset at
    // record start) so the first human move can interpolate waypoints.
    runCli(browser.sessionId, ["mouse", "move", "720", "450"]);
    browser.lastMouse = { x: 720, y: 450 };
    if (opts.url) await browser.goto(opts.url);
    return browser;
  }

  /** Low-level escape hatch: run any CLI args on THIS session as `--json`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(args: string[]): any {
    return runCli(this.sessionId, args);
  }

  async setViewport(w: number, h: number): Promise<void> {
    runCli(this.sessionId, ["set", "viewport", String(w), String(h)]);
  }

  async goto(url: string): Promise<void> {
    runCli(this.sessionId, ["open", url]);
    await this.waitForLoad();
  }

  /** Parse `snapshot -i --json` refs into { ref, role, name }[] (cap ~60). */
  async snapshot(): Promise<SnapRef[]> {
    const data = runCli(this.sessionId, ["snapshot", "-i"]);
    const refs = (data as { refs?: Record<string, { role?: unknown; name?: unknown }> })
      .refs;
    if (!refs || typeof refs !== "object") return [];
    return Object.entries(refs)
      .slice(0, MAX_REFS)
      .map(([key, value]) => ({
        ref: key.startsWith("@") ? key : `@${key}`,
        role: typeof value?.role === "string" ? value.role : "",
        name: typeof value?.name === "string" ? value.name : "",
      }));
  }

  /** Parse `get box --json` ({x,y,width,height}) into { x, y, w, h }. */
  async box(ref: string): Promise<Box> {
    const data = runCli(this.sessionId, ["get", "box", ref]) as {
      x?: unknown;
      y?: unknown;
      width?: unknown;
      height?: unknown;
    };
    if (
      typeof data?.x !== "number" ||
      typeof data?.y !== "number" ||
      typeof data?.width !== "number" ||
      typeof data?.height !== "number"
    ) {
      throw new StudioBrowserError(
        `get box returned unexpected payload: ${JSON.stringify(data)}`,
        ["get", "box", ref],
      );
    }
    return { x: data.x, y: data.y, w: data.width, h: data.height };
  }

  async boxCenter(ref: string): Promise<{ x: number; y: number }> {
    const b = await this.box(ref);
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }

  async getUrl(): Promise<string> {
    const data = runCli(this.sessionId, ["get", "url"]) as { url?: unknown };
    if (typeof data?.url !== "string") {
      throw new StudioBrowserError(
        `get url returned unexpected payload: ${JSON.stringify(data)}`,
        ["get", "url"],
      );
    }
    return data.url;
  }

  async getTitle(): Promise<string> {
    const data = runCli(this.sessionId, ["get", "title"]) as { title?: unknown };
    if (typeof data?.title !== "string") {
      throw new StudioBrowserError(
        `get title returned unexpected payload: ${JSON.stringify(data)}`,
        ["get", "title"],
      );
    }
    return data.title;
  }

  /**
   * Move the mouse to (x, y). Human mode (default) steps through
   * interpolated waypoints with `mouse move --human` so the init script
   * records a dense path instead of a teleport; `human: false` teleports.
   */
  async moveMouse(
    x: number,
    y: number,
    opts: { human?: boolean; seed?: number } = {},
  ): Promise<void> {
    const human = opts.human ?? true;
    const tx = Math.round(x);
    const ty = Math.round(y);
    const seedArgs =
      opts.seed !== undefined ? ["--seed", String(opts.seed)] : [];
    if (!human || this.lastMouse === null) {
      const args =
        human && opts.seed !== undefined
          ? ["mouse", "move", String(tx), String(ty), "--human", ...seedArgs]
          : human
            ? ["mouse", "move", String(tx), String(ty), "--human"]
            : ["mouse", "move", String(tx), String(ty)];
      runCli(this.sessionId, args);
      this.lastMouse = { x: tx, y: ty };
      return;
    }
    const dx = tx - this.lastMouse.x;
    const dy = ty - this.lastMouse.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return;
    const steps = Math.min(16, Math.max(4, Math.ceil(dist / 60)));
    for (let i = 1; i <= steps; i++) {
      const wx = Math.round(this.lastMouse.x + (dx * i) / steps);
      const wy = Math.round(this.lastMouse.y + (dy * i) / steps);
      runCli(this.sessionId, [
        "mouse",
        "move",
        String(wx),
        String(wy),
        "--human",
        ...seedArgs,
      ]);
    }
    this.lastMouse = { x: tx, y: ty };
  }

  /**
   * Prep sequence required before every click/type: scroll into view, read
   * the box, human-move to the box center. Returns the box.
   */
  async focusRef(ref: string): Promise<Box> {
    runCli(this.sessionId, ["scrollintoview", ref]);
    const b = await this.box(ref);
    await this.moveMouse(b.x + b.w / 2, b.y + b.h / 2, { human: true });
    return b;
  }

  async waitForLoad(): Promise<void> {
    runCli(this.sessionId, ["wait", "--load", "load"]);
  }

  /** Click after scrollintoview + box + human move; re-snapshots. */
  async clickRef(ref: string): Promise<SnapRef[]> {
    await this.focusRef(ref);
    runCli(this.sessionId, ["click", ref]);
    await this.waitForLoad();
    return this.snapshot();
  }

  /** Type after scrollintoview + box + human move; re-snapshots. */
  async typeRef(ref: string, text: string): Promise<SnapRef[]> {
    await this.focusRef(ref);
    runCli(this.sessionId, ["type", ref, text]);
    await this.waitForLoad();
    return this.snapshot();
  }

  async pressKey(key = "Enter"): Promise<SnapRef[]> {
    runCli(this.sessionId, ["press", key]);
    await this.waitForLoad();
    return this.snapshot();
  }

  async scroll(dir = "down", px = 300): Promise<void> {
    runCli(this.sessionId, ["scroll", dir, String(px)]);
  }

  async goBack(): Promise<SnapRef[]> {
    runCli(this.sessionId, ["back"]);
    await this.waitForLoad();
    return this.snapshot();
  }

  /**
   * Force one captured frame via a throwaway screenshot. Headless screencast
   * emits nothing on a fully static page, and ffmpeg then fails the take
   * with "Output file does not contain any stream". Best effort: a missing
   * warmup frame only risks that flake.
   */
  private warmupFrame(): void {
    try {
      const dir = this.initScriptDir ?? tmpdir();
      runCli(this.sessionId, [
        "screenshot",
        join(dir, "record-warmup.png"),
      ]);
    } catch {
      // best effort (see above)
    }
  }

  /**
   * Start video recording (NO `--cursor`: the cursor is overlaid later from
   * the cursor buffer). Resets the cursor clock so tMs lines up with the
   * capture, forces one frame so a static page still yields a stream,
   * and returns the record-start epoch ms.
   */
  async recordStart(path: string, fps = 60): Promise<number> {
    runCli(this.sessionId, ["record", "start", path, "--fps", String(fps)]);
    const epoch = await this.markRecordStart();
    this.warmupFrame();
    return epoch;
  }

  async recordStop(): Promise<void> {
    this.warmupFrame();
    runCli(this.sessionId, ["record", "stop"]);
  }

  /** Run JS via `eval --stdin`; returns the raw `result` string. */
  async evalJs(script: string): Promise<string> {
    const data = runCli(this.sessionId, ["eval", "--stdin"], {
      stdin: script,
    }) as { result?: unknown };
    return typeof data?.result === "string"
      ? data.result
      : JSON.stringify(data?.result ?? null);
  }

  /** Reset the cursor buffer + record-start clock; returns start epoch ms. */
  async markRecordStart(): Promise<number> {
    const raw = await this.evalJs(
      "JSON.stringify(typeof window.__studioMarkRecordStart === 'function' ? window.__studioMarkRecordStart() : ((window.__studioCursorBuf = [], window.__studioRecordStart = Date.now(), (function(){ try { window.sessionStorage.removeItem('__studioCursorPersist.v1'); } catch(_){} try { if (typeof window.name === 'string' && window.name.indexOf('__studioCursor::') === 0) window.name = ''; } catch(_){} })(), window.__studioRecordStart)))",
    );
    const n = Number(JSON.parse(raw));
    return Number.isFinite(n) ? n : Date.now();
  }

  /** Dump the cursor buffer via `eval --stdin`. */
  async cursorBuffer(): Promise<CursorPoint[]> {
    const raw = await this.evalJs(
      "JSON.stringify((function(){ try { if (Array.isArray(window.__studioCursorBuf) && window.__studioCursorBuf.length > 0) return window.__studioCursorBuf; } catch(_){} try { var raw = window.sessionStorage.getItem('__studioCursorPersist.v1'); if (raw) { var o = JSON.parse(raw); if (o && Array.isArray(o.buf) && o.buf.length > 0) return o.buf; } } catch(_){} try { var nm = window.name; if (typeof nm === 'string' && nm.indexOf('__studioCursor::') === 0) { var p = JSON.parse(nm.slice('__studioCursor::'.length)); if (p && Array.isArray(p.buf)) return p.buf; } } catch(_){} try { if (Array.isArray(window.__studioCursorBuf)) return window.__studioCursorBuf; } catch(_){} return []; })())",
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StudioBrowserError(
        `cursor buffer eval returned non-JSON: ${raw.slice(0, 200)}`,
        ["eval", "--stdin"],
      );
    }
    if (!Array.isArray(parsed)) return [];
    const points: CursorPoint[] = [];
    for (const p of parsed as Array<Record<string, unknown>>) {
      if (typeof p?.tMs !== "number" || typeof p?.x !== "number" || typeof p?.y !== "number") {
        continue;
      }
      // Preserve a missing button as missing: plain moves carry no button
      // field, and the ripple latch relies on that (only samples with
      // button info update it). Defaulting moves to 0 would re-arm it.
      const pt: CursorPoint = { tMs: p.tMs, x: p.x, y: p.y };
      if (typeof p.button === "number") pt.button = p.button;
      points.push(pt);
    }
    return points;
  }

  async clearCursorBuffer(): Promise<void> {
    await this.evalJs(
      "JSON.stringify((window.__studioCursorBuf = [], (function(){ try { window.sessionStorage.removeItem('__studioCursorPersist.v1'); } catch(_){} try { if (typeof window.name === 'string' && window.name.indexOf('__studioCursor::') === 0) window.name = ''; } catch(_){} })(), true))",
    );
  }

  /** Close ONLY this session (never `--all`, never the default session). */
  async close(): Promise<void> {
    try {
      runCli(this.sessionId, ["close"]);
    } finally {
      if (this.initScriptDir) {
        try {
          rmSync(this.initScriptDir, { recursive: true, force: true });
        } catch {
          // best-effort temp cleanup
        }
        this.initScriptDir = null;
      }
    }
  }
}
