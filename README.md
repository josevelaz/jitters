# studio-demo

Prompt-in / MP4-out demo video studio (TypeSafe + agent-browser + ffmpeg).

## What it does

- **Prompt in:** you describe the demo (`studio-demo "show the signup flow"`).
- **MP4 out:** the tool drives a browser, captures frames, and composites a
  Studio-framed MP4. Stdout is JSON-only so agents can parse it; logs go to
  stderr.

> **Quoting type-in text:** quote any text the agent should type. Jev cannot
> generate text — it only judges what it sees. So pass literal strings with
> shell quotes, e.g. `studio-demo "type 'hello@example.com' into the email field"`.

## Requirements (external binaries, not npm deps)

- `TYPESAFE_API_KEY` exported in your environment.
- `agent-browser` on `PATH` (external binary).
- `ffmpeg` on `PATH` (external binary).

`--help` works without any of these. Capture checks all three first and exits
nonzero naming the missing one. Render only needs `ffmpeg`.

## Usage

Capture once — writes `<slug>.mp4` plus
`<slug>.studio/{capture.mp4,cursor.json,timeline.json,style.json}`:

```sh
studio-demo "type 'hello@example.com' into the email field and submit" --url https://example.com
studio-demo "show the signup flow" --url https://example.com --out ./out
node dist/cli.js --help
```

Stdout is parseable JSON:

```json
{ "status": "done", "out": "/abs/demo.mp4", "project": "/abs/demo.studio", "durationMs": 12345, "steps": [] }
```

`status` is `done`, `stuck`, `max_steps`, or `error`. `stuck` and `max_steps`
still export whatever was captured (exit 0). `error` exits nonzero.

Options:

- positional `prompt` — what to demo
- `--url <url>` — starting URL
- `--out <path>` — output MP4 file or directory (default `<slug>.mp4` next to
  `<slug>.studio/` in cwd; `--out ./out` puts both under `./out`)
- `--project <name>` — project name (default: derived from prompt)
- `--style <path>` — path to `style.json` replacing the project style for this export
- `--max-steps <n>` — max agent steps (default 20, max 40)
- `--format <WxH>` — export size override, e.g. `1920x1080` (default: style.json canvas)
- `--bg <color>` — background color override for one export (default: style.json background)

## Restyle via style.json + render

Capture once, then tweak `style.json` and re-render without Chrome:

1. Edit `<slug>.studio/style.json` — `zoom` (scale/timings), `cursor` (size),
   `motionBlur`, `background`, `padding`, `radius`, `ripples`.
2. Re-render without re-capturing:

```sh
studio-demo render ./demo.studio
studio-demo render ./demo.studio --style ./custom.json --format 1280x720 --bg "#111111" --out ./demo-v2.mp4
```

`--style` replaces the style file for that export; `--format` and `--bg`
override one export. Render only needs `ffmpeg` on `PATH`.
