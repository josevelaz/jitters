/**
 * ffmpeg.ts — probe/decode/encode helpers around the external ffmpeg binary.
 *
 * Decoding: capture.mp4 → raw RGBA (a temp `.raw` file the compositor reads
 * back windowed, so long captures never sit fully in memory).
 * Encoding: raw RGBA frames piped on stdin → H.264 MP4.
 *
 * Hygiene: ffmpeg runs with `-loglevel error -hide_banner -nostats` so
 * nothing chatty reaches stdout, and this module never logs the environment
 * (no secrets) or any recorder state. Nothing but pixels is encoded —
 * no text overlays are added here.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

export interface VideoInfo {
  width: number;
  height: number;
  /** Frames per second (from avg_frame_rate, fallen back to r_frame_rate). */
  fps: number;
  durationSec: number;
  nbFrames: number;
}

interface ProbeStream {
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  nb_frames?: string;
}

function parseRate(raw: string | undefined): number {
  if (!raw) return NaN;
  if (raw.includes("/")) {
    const [num, den] = raw.split("/").map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
      return num / den;
    }
    return NaN;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

function runBin(
  bin: string,
  args: string[],
  input?: Buffer,
): Promise<{ stdout: Buffer; stderr: string; status: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(Buffer.from(d)));
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ stdout: Buffer.concat(chunks), stderr, status: status ?? 1 });
    });
    if (input && input.length > 0) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

/** Probe the first video stream with ffprobe (JSON, quiet). */
export async function probeVideo(inputPath: string): Promise<VideoInfo> {
  const { stdout, stderr, status } = await runBin("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,avg_frame_rate,r_frame_rate,duration,nb_frames",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    inputPath,
  ]);
  if (status !== 0) {
    throw new Error(`ffprobe failed for ${inputPath}: ${stderr.trim()}`);
  }
  let parsed: { streams?: ProbeStream[]; format?: { duration?: string } };
  try {
    parsed = JSON.parse(stdout.toString("utf8")) as typeof parsed;
  } catch {
    throw new Error(`ffprobe returned invalid JSON for ${inputPath}`);
  }
  const stream = parsed.streams?.[0];
  if (!stream || !stream.width || !stream.height) {
    throw new Error(`ffprobe found no video stream in ${inputPath}`);
  }
  let fps = parseRate(stream.avg_frame_rate);
  if (!Number.isFinite(fps) || fps <= 0) fps = parseRate(stream.r_frame_rate);
  if (!Number.isFinite(fps) || fps <= 0) fps = 30;
  fps = Math.min(60, Math.max(1, fps));

  let durationSec =
    Number(stream.duration) || Number(parsed.format?.duration) || NaN;
  let nbFrames = Number(stream.nb_frames);
  if (!Number.isFinite(nbFrames) || nbFrames <= 0) {
    nbFrames =
      Number.isFinite(durationSec) && durationSec > 0
        ? Math.max(1, Math.round(durationSec * fps))
        : 0;
  }
  if ((!Number.isFinite(durationSec) || durationSec <= 0) && nbFrames > 0) {
    durationSec = nbFrames / fps;
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`ffprobe could not determine duration for ${inputPath}`);
  }
  if (nbFrames <= 0) nbFrames = Math.max(1, Math.round(durationSec * fps));
  return {
    width: stream.width,
    height: stream.height,
    fps,
    durationSec,
    nbFrames,
  };
}

/**
 * Decode `inputPath` to a raw RGBA file at native dimensions. Returns probe
 * info; the caller derives `frameBytes = width * height * 4` and reads frame
 * `i` at offset `i * frameBytes`.
 */
export async function decodeToRawFile(
  inputPath: string,
  rawPath: string,
): Promise<VideoInfo> {
  const info = await probeVideo(inputPath);
  await fs.mkdir(dirname(rawPath), { recursive: true });
  const { stderr, status } = await runBin("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostats",
    "-y",
    "-i",
    inputPath,
    "-an",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    rawPath,
  ]);
  if (status !== 0) {
    throw new Error(`ffmpeg decode failed for ${inputPath}: ${stderr.trim()}`);
  }
  const stat = await fs.stat(rawPath);
  const frameBytes = info.width * info.height * 4;
  const frames = Math.floor(stat.size / frameBytes);
  if (frames <= 0) {
    throw new Error(`ffmpeg decoded zero frames from ${inputPath}`);
  }
  return { ...info, nbFrames: frames };
}

export interface EncoderOptions {
  width: number;
  height: number;
  fps: number;
  outPath: string;
  crf?: number;
}

export interface FrameEncoder {
  writeFrame(frame: Buffer): Promise<void>;
  finish(): Promise<void>;
}

/**
 * Open an H.264 MP4 encoder fed with raw RGBA frames (W*H*4 bytes each).
 * Backpressure is honored: writeFrame resolves once the frame is flushed.
 */
export function createEncoder(options: EncoderOptions): FrameEncoder {
  const { width, height, fps, outPath } = options;
  const crf = options.crf ?? 18;
  let ready: Promise<void> | null = null;
  let failed: Error | null = null;

  const child = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostats",
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      `${width}x${height}`,
      "-framerate",
      String(fps),
      "-i",
      "-",
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      String(crf),
      "-preset",
      "veryfast",
      "-movflags",
      "+faststart",
      outPath,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
  });
  child.on("error", (err) => {
    failed = err as Error;
  });

  const closed = new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
  });

  async function ensureDir(): Promise<void> {
    if (!ready) {
      ready = fs.mkdir(dirname(outPath), { recursive: true }).then(() => {});
    }
    await ready;
  }

  return {
    async writeFrame(frame: Buffer): Promise<void> {
      if (failed) throw failed;
      await ensureDir();
      const expected = width * height * 4;
      if (frame.length !== expected) {
        throw new Error(
          `frame size ${frame.length} != ${expected} (${width}x${height} RGBA)`,
        );
      }
      await new Promise<void>((resolve, reject) => {
        const ok = child.stdin.write(frame, (err) => {
          if (err) reject(err);
          else resolve();
        });
        if (!ok) {
          child.stdin.once("drain", () => resolve());
        }
      });
      if (failed) throw failed;
    },
    async finish(): Promise<void> {
      await ensureDir();
      if (failed) throw failed;
      child.stdin.end();
      const code = await closed;
      if (failed) throw failed;
      if (code !== 0) {
        throw new Error(`ffmpeg encode failed: ${stderr.trim()}`);
      }
      const stat = await fs.stat(outPath);
      if (stat.size <= 0) {
        throw new Error(`ffmpeg wrote an empty file to ${outPath}`);
      }
    },
  };
}
