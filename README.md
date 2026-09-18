# studio-demo

Prompt-in / MP4-out demo video studio (TypeSafe + agent-browser + ffmpeg).

## What it does

- **Prompt in:** you describe the demo (`studio-demo "show the signup flow"`).
- **MP4 out:** the tool drives a browser, captures frames, and composites an MP4.

> **Quoting type-in text:** quote any text the agent should type. Jev cannot
> generate text — it only judges what it sees. So pass literal strings with
> shell quotes, e.g. `studio-demo "type 'hello@example.com' into the email field"`.

## Requirements (external binaries, not npm deps)

- `TYPESAFE_API_KEY` exported in your environment.
- `agent-browser` on `PATH` (external binary).
- `ffmpeg` on `PATH` (external binary).

`--help` works without any of these. Capture and render check deps first and
exit nonzero naming the missing one.

## Usage

```sh
studio-demo "show the signup flow" --url https://example.com --out ./out
studio-demo --help
```

Options:

- positional `prompt` — what to demo
- `--url <url>` — starting URL
- `--out <dir>` — output directory (default `./out`)
- `--project <name>` — project name (default: derived from prompt)
- `--style <path>` — path to `style.json` for the compositor
- `--max-steps <n>` — max agent steps (default 20, max 40)
- `--format <format>` — frame format (default `png`)
- `--bg <color>` — background color for letterboxing (default `black`)

## Restyle via style.json + render

1. Edit `<out>/<project>/style.json` (fonts, colors, captions).
2. Re-render without re-capturing:

```sh
studio-demo render <project> --out ./out
```

Render only needs `ffmpeg` on `PATH`.
