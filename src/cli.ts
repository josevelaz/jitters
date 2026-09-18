#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { captureDemo, resolveSlug } from "./capture.js";
import { renderProject } from "./studio.js";

const HELP = `studio-demo — prompt-in / MP4-out demo video studio

Usage:
  studio-demo [options] <prompt>      Capture a guided browser demo from a prompt
  studio-demo render <project> [options]  Re-render an existing project without re-capturing

Positional:
  prompt                              Natural-language description of the demo to capture

Options:
  --url <url>                         Starting URL for the browser run
  --out <path>                        Output MP4 file or directory (default: <slug>.mp4 next to <slug>.studio/ in cwd)
  --project <name>                    Project name (default: derived from prompt)
  --style <path>                      Path to style.json replacing the project style for this export
  --max-steps <n>                     Max agent steps (default: 20, max: 40)
  --format <WxH>                      Export size override, e.g. 1920x1080 (default: style.json canvas)
  --bg <color>                        Background color override for one export (default: style.json background)
  -h, --help                          Show this help

Examples:
  studio-demo "type 'hello@example.com' into the email field" --url https://example.com
  studio-demo "show the signup flow" --url https://example.com --out ./out
  studio-demo render ./demo.studio
  studio-demo render ./demo.studio --style ./custom.json --format 1280x720 --bg "#111111" --out ./demo-v2.mp4

Capture writes <slug>.mp4 plus <slug>.studio/{capture.mp4,cursor.json,timeline.json,style.json},
then composites a Studio-framed MP4. Stdout is JSON: { status, out, project, durationMs, steps }.
Render reruns only the compositor (needs ffmpeg, no Chrome).
`;

interface CaptureOptions {
  prompt: string;
  url?: string;
  out?: string;
  project?: string;
  style?: string;
  maxSteps: number;
  format?: string;
  bg?: string;
}

interface RenderArgs {
  projectDir: string;
  out?: string;
  style?: string;
  format?: string;
  bg?: string;
}

function onPath(bin: string): boolean {
  const r = spawnSync("command", ["-v", bin], {
    shell: true,
    stdio: "ignore",
  });
  return r.status === 0;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function checkFfmpeg(): void {
  if (!onPath("ffmpeg")) {
    fail(
      "Missing dependency: ffmpeg is not on PATH. Install ffmpeg (https://ffmpeg.org) and retry.",
    );
  }
}

function checkCaptureDeps(): void {
  if (!process.env.TYPESAFE_API_KEY) {
    fail(
      "Missing dependency: TYPESAFE_API_KEY is not set. Export TYPESAFE_API_KEY and retry.",
    );
  }
  if (!onPath("agent-browser")) {
    fail(
      "Missing dependency: agent-browser is not on PATH. Install agent-browser and retry.",
    );
  }
  checkFfmpeg();
}

function parseMaxSteps(raw: string | undefined): number {
  const DEFAULT = 20;
  const CAP = 40;
  if (raw === undefined) return DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    fail(`Invalid --max-steps ${JSON.stringify(raw)}: expected an integer >= 1.`);
  }
  return Math.min(n, CAP);
}

function parseCaptureArgs(args: string[]): CaptureOptions {
  let prompt: string | undefined;
  let url: string | undefined;
  let out: string | undefined;
  let project: string | undefined;
  let style: string | undefined;
  let maxStepsRaw: string | undefined;
  let format: string | undefined;
  let bg: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--url") url = args[++i];
    else if (a === "--out") {
      const v = args[++i];
      if (v !== undefined) out = v;
    } else if (a === "--project") project = args[++i];
    else if (a === "--style") style = args[++i];
    else if (a === "--max-steps") maxStepsRaw = args[++i];
    else if (a === "--format") {
      const v = args[++i];
      if (v !== undefined) format = v;
    } else if (a === "--bg") {
      const v = args[++i];
      if (v !== undefined) bg = v;
    } else if (a.startsWith("-")) fail(`Unknown flag ${a}. Run studio-demo --help.`);
    else if (prompt === undefined) prompt = a;
    else fail(`Unexpected argument ${JSON.stringify(a)}. Run studio-demo --help.`);
  }

  if (prompt === undefined) {
    console.error(HELP);
    fail("Missing <prompt>. Run studio-demo --help.");
  }

  return {
    prompt,
    url,
    out,
    project,
    style,
    maxSteps: parseMaxSteps(maxStepsRaw),
    format,
    bg,
  };
}

function parseRenderArgs(args: string[]): RenderArgs {
  let projectDir: string | undefined;
  let out: string | undefined;
  let style: string | undefined;
  let format: string | undefined;
  let bg: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--out") {
      const v = args[++i];
      if (v !== undefined) out = v;
    } else if (a === "--style") style = args[++i];
    else if (a === "--format") {
      const v = args[++i];
      if (v !== undefined) format = v;
    } else if (a === "--bg") {
      const v = args[++i];
      if (v !== undefined) bg = v;
    } else if (a.startsWith("-")) fail(`Unknown flag ${a}. Run studio-demo --help.`);
    else if (projectDir === undefined) projectDir = a;
    else fail(`Unexpected argument ${JSON.stringify(a)}. Run studio-demo --help.`);
  }

  if (projectDir === undefined) {
    console.error(HELP);
    fail("Usage: studio-demo render <project>. Run studio-demo --help.");
  }

  return { projectDir, out, style, format, bg };
}

function isVideoFilePath(p: string): boolean {
  return /\.(mp4|mov|mkv|webm|m4v)$/i.test(p);
}

function emitJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function runCapture(opts: CaptureOptions): Promise<void> {
  const start = Date.now();
  let outDir: string;
  let explicitOut: string | undefined;
  if (!opts.out) {
    outDir = ".";
  } else if (isVideoFilePath(opts.out)) {
    explicitOut = resolve(opts.out);
    outDir = dirname(explicitOut);
  } else {
    outDir = opts.out;
  }

  let projectDir = "";
  let steps: unknown[] = [];
  try {
    const cap = await captureDemo({
      prompt: opts.prompt,
      url: opts.url,
      outDir,
      project: opts.project,
      maxSteps: opts.maxSteps,
    });
    projectDir = cap.projectDir;
    steps = cap.steps;
    // Default export is <slug>.mp4 next to <slug>.studio/; an explicit
    // --out file overrides the name/location.
    const exportPath = explicitOut ?? join(dirname(cap.projectDir), `${cap.slug}.mp4`);
    console.error(`[studio-demo] captured ${cap.status} (${cap.steps.length} steps) -> ${cap.projectDir}`);
    const out = await renderProject(cap.projectDir, {
      out: exportPath,
      style: opts.style,
      format: opts.format,
      bg: opts.bg,
    });
    emitJson({
      status: cap.status,
      out,
      project: cap.projectDir,
      durationMs: Date.now() - start,
      steps: cap.steps,
    });
    // `stuck` and `max_steps` still export and report that status (exit 0).
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? "capture failed");
    console.error(`[studio-demo] error: ${message}`);
    // The agent run may have written artifacts before failing (e.g. a late
    // record-stop error): report the project dir when it exists on disk so
    // callers can inspect/re-render it, instead of an empty string.
    if (!projectDir) {
      const slug = resolveSlug({ prompt: opts.prompt, project: opts.project });
      const candidate = join(resolve(outDir), `${slug}.studio`);
      try {
        if (statSync(candidate).isDirectory()) projectDir = candidate;
      } catch {
        // leave projectDir empty when nothing was written
      }
    }
    let out = "";
    if (projectDir) {
      try {
        const capturePath = join(projectDir, "capture.mp4");
        if (statSync(capturePath).size > 0) {
          try {
            out = await renderProject(projectDir, {
              out: explicitOut,
              style: opts.style,
              format: opts.format,
              bg: opts.bg,
            });
          } catch {
            // Fall back to the raw capture when the export fails.
            out = capturePath;
          }
        }
      } catch {
        // No usable capture; out stays empty.
      }
    }
    emitJson({
      status: "error",
      out,
      project: projectDir,
      durationMs: Date.now() - start,
      steps,
      error: message,
    });
    process.exit(1);
  }
}

async function runRender(args: RenderArgs): Promise<void> {
  const start = Date.now();
  try {
    const dir = resolve(args.projectDir);
    const out = await renderProject(dir, {
      out: args.out,
      style: args.style,
      format: args.format,
      bg: args.bg,
    });
    emitJson({
      status: "done",
      out,
      project: dir,
      durationMs: Date.now() - start,
      steps: [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? "render failed");
    console.error(`[studio-demo] error: ${message}`);
    emitJson({
      status: "error",
      out: "",
      project: resolve(args.projectDir),
      durationMs: Date.now() - start,
      steps: [],
      error: message,
    });
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  const [first, ...rest] = argv;

  if (first === "render") {
    const args = parseRenderArgs(rest);
    // Render is a local recomposite: only ffmpeg is required (no Chrome).
    checkFfmpeg();
    await runRender(args);
    return;
  }

  // Capture path: studio-demo <prompt> [options]
  const opts = parseCaptureArgs(argv);
  checkCaptureDeps();
  await runCapture(opts);
}

void main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err ?? "failed");
  console.error(`[studio-demo] error: ${message}`);
  try {
    emitJson({
      status: "error",
      out: "",
      project: "",
      durationMs: 0,
      steps: [],
      error: message,
    });
  } catch {
    // stdout write failed; stderr already has the message
  }
  process.exit(1);
});
