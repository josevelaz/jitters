#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const HELP = `studio-demo — prompt-in / MP4-out demo video studio

Usage:
  studio-demo [options] <prompt>      Capture a guided browser demo from a prompt
  studio-demo render <project>        Re-render an existing project with style.json

Positional:
  prompt                              Natural-language description of the demo to capture

Options:
  --url <url>                         Starting URL for the browser run
  --out <dir>                         Output directory (default: ./out)
  --project <name>                    Project name (default: derived from prompt)
  --style <path>                      Path to style.json for the compositor
  --max-steps <n>                     Max agent steps (default: 20, max: 40)
  --format <format>                   Frame format (default: png)
  --bg <color>                        Background color for letterboxing (default: black)
  -h, --help                          Show this help

Examples:
  studio-demo "show the signup flow" --url https://example.com --out ./out
  studio-demo render my-project --out ./out
`;

interface CaptureOptions {
  prompt: string;
  url?: string;
  out: string;
  project?: string;
  style?: string;
  maxSteps: number;
  format: string;
  bg: string;
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
  let out = "./out";
  let project: string | undefined;
  let style: string | undefined;
  let maxStepsRaw: string | undefined;
  let format = "png";
  let bg = "black";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--url") url = args[++i];
    else if (a === "--out") out = args[++i] ?? out;
    else if (a === "--project") project = args[++i];
    else if (a === "--style") style = args[++i];
    else if (a === "--max-steps") maxStepsRaw = args[++i];
    else if (a === "--format") format = args[++i] ?? format;
    else if (a === "--bg") bg = args[++i] ?? bg;
    else if (a.startsWith("-")) fail(`Unknown flag ${a}. Run studio-demo --help.`);
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

function main(): void {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  const [first, ...rest] = argv;

  if (first === "render") {
    const project = rest.find((a) => !a.startsWith("-"));
    if (!project) {
      console.error(HELP);
      fail("Usage: studio-demo render <project>. Run studio-demo --help.");
    }
    // Render is a local recomposite: only ffmpeg is required.
    checkFfmpeg();
    fail(
      `render for project ${JSON.stringify(project)} is not implemented yet (stub).`,
    );
    return;
  }

  if (first === undefined || first.startsWith("-") === false || argv.length > 0) {
    // Capture path: studio-demo <prompt> [options]
    const opts = parseCaptureArgs(argv);
    checkCaptureDeps();
    void opts;
    fail("capture is not implemented yet (stub). Deps OK.");
    return;
  }

  console.error(HELP);
  process.exit(1);
}

main();
