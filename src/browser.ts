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
 * CLI takes `--init-script <path>`). Buffers every mousemove / mousedown /
 * mouseup as { tMs, x, y, button } using client coordinates. tMs is
 * Date.now() minus a record-start offset the adapter resets when recording
 * starts, so points line up with the captured video.
 */
export const CURSOR_INIT_JS = `(() => {
  const w = window;
  if (w.__studioCursorInit) return;
  w.__studioCursorInit = true;
  if (!Array.isArray(w.__studioCursorBuf)) w.__studioCursorBuf = [];
  if (typeof w.__studioRecordStart !== "number") w.__studioRecordStart = Date.now();
  const push = (e) => {
    try {
      w.__studioCursorBuf.push({
        tMs: Date.now() - w.__studioRecordStart,
        x: e.clientX,
        y: e.clientY,
        button: typeof e.button === "number" ? e.button : 0,
      });
    } catch (_) {}
  };
  w.addEventListener("mousemove", push, true);
  w.addEventListener("mousedown", push, true);
  w.addEventListener("mouseup", push, true);
  w.__studioMarkRecordStart = () => {
    w.__studioCursorBuf = [];
    w.__studioRecordStart = Date.now();
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
   * Start video recording (NO `--cursor`: the cursor is overlaid later from
   * the cursor buffer). Resets the cursor clock so tMs lines up with the
   * capture, and returns the record-start epoch ms.
   */
  async recordStart(path: string, fps = 60): Promise<number> {
    runCli(this.sessionId, ["record", "start", path, "--fps", String(fps)]);
    return this.markRecordStart();
  }

  async recordStop(): Promise<void> {
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
      "JSON.stringify(typeof window.__studioMarkRecordStart === 'function' ? window.__studioMarkRecordStart() : ((window.__studioCursorBuf = [], window.__studioRecordStart = Date.now())))",
    );
    const n = Number(JSON.parse(raw));
    return Number.isFinite(n) ? n : Date.now();
  }

  /** Dump the cursor buffer via `eval --stdin`. */
  async cursorBuffer(): Promise<CursorPoint[]> {
    const raw = await this.evalJs(
      "JSON.stringify(window.__studioCursorBuf || [])",
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
      points.push({
        tMs: p.tMs,
        x: p.x,
        y: p.y,
        button: typeof p.button === "number" ? p.button : 0,
      });
    }
    return points;
  }

  async clearCursorBuffer(): Promise<void> {
    await this.evalJs("JSON.stringify((window.__studioCursorBuf = [], true))");
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
