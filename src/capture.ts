/**
 * capture.ts — page-only take recorder with a dense cursor track.
 *
 * `captureDemo` runs the TypeSafe step loop (`runAgent`) against a real
 * `StudioBrowser` while recording page pixels only (no baked pointer) and
 * sampling the synthetic cursor path separately:
 *
 * - `<slug>.studio/capture.mp4` — page pixels only (`record start --fps 60`,
 *   never `--cursor`; the compositor overlays the cursor later).
 * - `<slug>.studio/cursor.json` — every sampled mouse position/button
 *   `{ tMs, x, y, button? }` from the cursor buffer. Human moves step
 *   through interpolated waypoints, so curves/spins survive as many points.
 *   tMs is rescaled into the measured capture.mp4 duration at close when the
 *   wall-clock run overshoots it (sparse screencast frames pack short).
 * - `<slug>.studio/timeline.json` — semantic click/type/scroll events with
 *   boxes for zooms/ripples. This is NOT the cursor path.
 * - `<slug>.studio/style.json` — default tokens when missing (for render).
 *
 * `runAgent` always closes the browser in `finally`, so recording
 * start/stop and artifact writes live inside a launch wrapper: record
 * starts after launch (viewport + init script already done), actions are
 * intercepted for timeline events with boxes, and the wrapper `close()`
 * does `record stop` (with retries for the intermittent ffmpeg
 * "Output file does not contain any stream" flake), dumps the cursor
 * buffer, writes files, then delegates to the real close.
 */

import { promises as fs } from "node:fs";
import { resolve, join } from "node:path";
import { StudioBrowser, type Box, type CursorPoint } from "./browser.js";
import { probeVideo } from "./ffmpeg.js";
import {
  runAgent,
  type AgentBrowserLike,
  type RunAgentResult,
  type SystemOneLike,
} from "./agent.js";
import { defaultStyle } from "./studio.js";

export interface CaptureDemoOptions {
  prompt: string;
  url?: string;
  /** Base directory holding `<slug>.studio/` (default: cwd). */
  outDir?: string;
  /** Project name; falls back to a slug derived from the prompt. */
  project?: string;
  maxSteps?: number;
  /** Injected TypeSafe client (tests / fakes); defaults to real client. */
  client?: SystemOneLike;
  /** Injected launcher; defaults to `StudioBrowser.launch`. */
  launch?: (opts: { url?: string }) => Promise<AgentBrowserLike>;
  /** Capture frame rate (default 60). */
  fps?: number;
}

export interface TimelineRecord {
  tMs: number;
  kind: string;
  box?: Box;
  ref?: string;
  value?: string;
  url?: string;
}

export interface CaptureDemoResult extends RunAgentResult {
  slug: string;
  projectDir: string;
  capturePath: string;
  cursorPath: string;
  timelinePath: string;
  stylePath: string;
}

/** Filesystem-safe slug from `--project` or the prompt. */
export function slugify(raw: string): string {
  const slug = (raw ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  return slug || "demo";
}

export function resolveSlug(opts: { prompt: string; project?: string }): string {
  const fromProject = (opts.project ?? "").trim();
  if (fromProject) return slugify(fromProject);
  return slugify(opts.prompt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRecordStopFlake(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  // Narrow: only the known ffmpeg zero-frame failure. In particular this
  // must NOT match "No recording in progress" (that is the terminal state
  // after any stop attempt, never a retryable flake).
  return /does not contain any stream|no frames/i.test(msg);
}

type RealBrowser = AgentBrowserLike & {
  box?: (ref: string) => Promise<Box>;
  recordStart?: (path: string, fps?: number) => Promise<number>;
  recordStop?: () => Promise<void>;
  markRecordStart?: () => Promise<number>;
  cursorBuffer?: () => Promise<CursorPoint[]>;
};

/**
 * Run one demo capture: page-only video + dense cursor track + timeline.
 * Never passes `--cursor` to the recorder (page pixels only).
 */
export async function captureDemo(
  options: CaptureDemoOptions,
): Promise<CaptureDemoResult> {
  const { prompt } = options;
  if (!prompt || prompt.trim().length === 0) {
    throw new Error("captureDemo requires a non-empty prompt");
  }
  const fps = options.fps ?? 60;
  const slug = resolveSlug({ prompt, project: options.project });
  const baseDir = resolve(options.outDir ?? ".");
  const projectDir = join(baseDir, `${slug}.studio`);
  const capturePath = join(projectDir, "capture.mp4");
  const cursorPath = join(projectDir, "cursor.json");
  const timelinePath = join(projectDir, "timeline.json");
  const stylePath = join(projectDir, "style.json");

  await fs.mkdir(projectDir, { recursive: true });

  const timeline: TimelineRecord[] = [];
  // Stash pre-navigation buffers so a navigation that resets the page
  // buffer does not silently drop the early track. Merged at close.
  const stashed: CursorPoint[] = [];
  let startEpoch = 0;
  let recording = false;
  let recordStartedAt = 0;

  const nowMs = (): number =>
    startEpoch > 0 ? Math.max(0, Date.now() - startEpoch) : 0;

  const stashBuffer = async (real: RealBrowser): Promise<void> => {
    try {
      if (typeof real.cursorBuffer === "function" && startEpoch > 0) {
        const pts = await real.cursorBuffer();
        if (Array.isArray(pts) && pts.length > 0) stashed.push(...pts);
      }
    } catch {
      // best effort; the final dump at close is authoritative
    }
  };

  const readBox = async (
    real: RealBrowser,
    ref: string,
  ): Promise<Box | undefined> => {
    try {
      if (typeof real.box === "function") return await real.box(ref);
    } catch {
      // element may be gone; record the event without a box
    }
    return undefined;
  };

  const realLaunch =
    options.launch ??
    ((opts: { url?: string }) =>
      StudioBrowser.launch(opts) as unknown as Promise<AgentBrowserLike>);

  const wrappedLaunch = async (opts: {
    url?: string;
  }): Promise<AgentBrowserLike> => {
    const real = (await realLaunch(opts)) as RealBrowser;

    // Start recording AFTER launch (viewport + init script already done).
    // Page pixels only: never pass `--cursor` (recordStart takes path+fps).
    if (typeof real.recordStart === "function") {
      startEpoch = await real.recordStart(capturePath, fps);
      recording = true;
      recordStartedAt = Date.now();
    } else {
      // Fake browsers in unit contexts may lack recording; fall back to a
      // local clock so timeline events still carry monotonic times.
      startEpoch = Date.now();
      recording = false;
      recordStartedAt = startEpoch;
    }

    const wrapped: AgentBrowserLike = {
      snapshot: (...a) => real.snapshot(...a),
      getUrl: (...a) => real.getUrl(...a),
      getTitle: (...a) => real.getTitle(...a),
      evalJs: real.evalJs ? (...a) => real.evalJs!(...a) : undefined,

      async clickRef(ref: string): Promise<unknown> {
        const box = await readBox(real, ref);
        // Defense in depth: stash the pre-click track BEFORE the click can
        // navigate away and destroy the page buffer. The init script now
        // persists across navigations, so the post-click dump already
        // contains the pre-track; dedup at close absorbs the overlap.
        await stashBuffer(real);
        const out = await real.clickRef(ref);
        try {
          timeline.push(
            box
              ? { tMs: nowMs(), kind: "click", box, ref }
              : { tMs: nowMs(), kind: "click", ref },
          );
        } catch {
          // never break the run on timeline bookkeeping
        }
        return out;
      },

      async typeRef(ref: string, text: string): Promise<unknown> {
        const box = await readBox(real, ref);
        const out = await real.typeRef(ref, text);
        try {
          timeline.push(
            box
              ? { tMs: nowMs(), kind: "type", box, ref, value: text }
              : { tMs: nowMs(), kind: "type", ref, value: text },
          );
        } catch {
          // never break the run on timeline bookkeeping
        }
        return out;
      },

      async pressKey(key?: string): Promise<unknown> {
        const out = await real.pressKey(key);
        try {
          timeline.push({ tMs: nowMs(), kind: "press" });
        } catch {
          // ignore
        }
        return out;
      },

      async goto(url: string): Promise<unknown> {
        await stashBuffer(real);
        const out = await real.goto(url);
        try {
          timeline.push({ tMs: nowMs(), kind: "navigate", url });
        } catch {
          // ignore
        }
        return out;
      },

      async scroll(dir?: string, px?: number): Promise<unknown> {
        const out = await real.scroll(dir, px);
        try {
          const d = (dir ?? "down").toLowerCase();
          timeline.push({
            tMs: nowMs(),
            kind: d === "up" ? "scroll_up" : "scroll_down",
          });
        } catch {
          // ignore
        }
        return out;
      },

      async goBack(): Promise<unknown> {
        await stashBuffer(real);
        const out = await real.goBack();
        try {
          timeline.push({ tMs: nowMs(), kind: "go_back" });
        } catch {
          // ignore
        }
        return out;
      },

      async close(): Promise<void> {
        let stopError: unknown = null;
        if (recording && typeof real.recordStop === "function") {
          // Guard against zero-frame takes: ensure at least ~1s of footage
          // so ffmpeg has a stream to mux.
          const elapsed = Date.now() - recordStartedAt;
          if (elapsed < 1000) await sleep(1000 - elapsed);
          // `record stop` is terminal: even a failed stop ends the take, so
          // retrying always fails with "No recording in progress" and masks
          // the real error. Attempt exactly once; recordStart/recordStop
          // force warmup frames so the zero-frame flake should not happen.
          try {
            await real.recordStop();
          } catch (err) {
            stopError = err;
          }
          if (stopError !== null && isRecordStopFlake(stopError)) {
            console.error(
              `[studio-demo] record stop failed: ${(stopError as Error)?.message ?? String(stopError)}`,
            );
          }
        }

        // Dump the cursor buffer: every sampled { tMs, x, y, button? }.
        // Never collapse to waypoints — the compositor fits curves through
        // all samples, so spins and --human arcs survive.
        let points: CursorPoint[] = [];
        try {
          if (typeof real.cursorBuffer === "function") {
            points = (await real.cursorBuffer()) ?? [];
          }
        } catch (err) {
          console.error(
            `[studio-demo] cursor buffer dump failed: ${(err as Error)?.message ?? String(err)}`,
          );
          points = [];
        }
        const merged = [...stashed, ...(Array.isArray(points) ? points : [])];
        merged.sort((a, b) => (a.tMs ?? 0) - (b.tMs ?? 0));
        // Stash-before-click/navigate overlaps the persisted post-navigation
        // dump by design; dedup exact (tMs,x,y,button) repeats so the track
        // stays dense without doubled samples.
        const seen = new Set<string>();
        const deduped: CursorPoint[] = [];
        for (const p of merged) {
          const key = `${p.tMs ?? 0}|${p.x ?? 0}|${p.y ?? 0}|${p.button ?? 0}`;
          if (seen.has(key)) continue;
          seen.add(key);
          deduped.push(p);
        }

        // The recorder packs sparsely-delivered screencast frames at the
        // nominal fps, so capture.mp4's duration can be shorter than the
        // wall-clock run (long API waits produce no frames). Cursor and
        // timeline tMs are wall-clock since record start, but the compositor
        // reads them in video time — overshooting samples would clamp to a
        // frozen cursor and lost ripples. Rescale both tracks linearly into
        // the measured video duration when they overshoot it; frames cluster
        // at actions, so actions stay aligned with their visuals.
        try {
          const info = await probeVideo(capturePath);
          const videoMs = info.durationSec * 1000;
          let maxT = 0;
          for (const p of deduped) maxT = Math.max(maxT, p.tMs ?? 0);
          for (const e of timeline) maxT = Math.max(maxT, e.tMs ?? 0);
          if (videoMs > 0 && maxT > videoMs) {
            const s = videoMs / maxT;
            for (const p of deduped) {
              p.tMs = Math.max(0, Math.round((p.tMs ?? 0) * s));
            }
            for (const e of timeline) {
              e.tMs = Math.max(0, Math.round((e.tMs ?? 0) * s));
            }
            deduped.sort((a, b) => (a.tMs ?? 0) - (b.tMs ?? 0));
          }
        } catch {
          // Best effort: leave wall-clock times when the capture is missing
          // (the stop-error handling below still reports the failure).
        }

        try {
          await fs.mkdir(projectDir, { recursive: true });
          await fs.writeFile(cursorPath, `${JSON.stringify(deduped)}\n`, "utf8");
          await fs.writeFile(
            timelinePath,
            `${JSON.stringify(timeline)}\n`,
            "utf8",
          );
          try {
            await fs.access(stylePath);
          } catch {
            await fs.writeFile(
              stylePath,
              `${JSON.stringify(defaultStyle(), null, 2)}\n`,
              "utf8",
            );
          }
        } catch (err) {
          console.error(
            `[studio-demo] artifact write failed: ${(err as Error)?.message ?? String(err)}`,
          );
        } finally {
          await real.close();
        }

        // Surface a persistent record-stop failure after the browser is
        // closed and artifacts are on disk. Flakes already logged above
        // do not fail the capture when footage exists.
        if (stopError !== null && !isRecordStopFlake(stopError)) {
          throw stopError;
        }
        if (stopError !== null && isRecordStopFlake(stopError)) {
          try {
            const stat = await fs.stat(capturePath);
            if (stat.size <= 0) throw stopError;
          } catch {
            throw stopError;
          }
        }
      },
    };
    return wrapped;
  };

  const result = await runAgent({
    prompt,
    url: options.url,
    maxSteps: options.maxSteps,
    client: options.client,
    launch: wrappedLaunch,
  });

  return {
    ...result,
    slug,
    projectDir,
    capturePath,
    cursorPath,
    timelinePath,
    stylePath,
  };
}

export default captureDemo;
