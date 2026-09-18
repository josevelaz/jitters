# studio-demo skill

Prompt-in / MP4-out demo video studio.

## When to use

Use `studio-demo` when the user wants a narrated-style product demo video (MP4)
driven by a natural-language prompt.

## Key facts

- **Prompt in, MP4 out.** Input is a `prompt` positional; output is a
  Studio-framed MP4. Stdout is JSON-only (`{ status, out, project,
  durationMs, steps }`); logs go to stderr.
- **Quoting type-in text:** always single/double-quote literal text the agent
  must type. Jev cannot generate text — it can only judge pixels — so never
  ask it to invent copy; pass exact strings: `"type 'hello@example.com' ..."`.
- **`--url`:** sets the starting URL for the browser run.
- **Capture once, then restyle:** one capture writes `<slug>.mp4` plus
  `<slug>.studio/{capture.mp4,cursor.json,timeline.json,style.json}`. Then
  edit `<slug>.studio/style.json` (`zoom`, `cursor`, `motionBlur`,
  `background`, `padding`, `radius`, `ripples`) and re-render without Chrome.
  `stuck` / `max_steps` still export whatever was captured.
- **Restyle via `style.json` + `render`:** edit `<slug>.studio/style.json`,
  then run `studio-demo render <projectDir>` to recomposite without
  re-capturing. `--style` replaces the style file for that export; `--format`
  (e.g. `1920x1080`) and `--bg` override one export. Render only needs
  `ffmpeg`.

## Commands

Capture once from a user prompt (returns JSON pointing at the framed MP4):

```sh
studio-demo "type 'hello@example.com' into the email field and submit" --url https://example.com
studio-demo "demo the checkout" --url https://example.com --out ./out
```

Tweak `style.json`, then restyle without re-capturing:

```sh
studio-demo render ./demo.studio
studio-demo render ./demo.studio --style ./custom.json --format 1280x720 --bg "#111111" --out ./demo-v2.mp4
```

## Deps

Capture needs `TYPESAFE_API_KEY`, `agent-browser` on PATH, `ffmpeg` on PATH.
Render needs `ffmpeg` on PATH. `--help` needs none of these.
Missing deps exit nonzero naming the missing one. Never print API keys or
agent-browser state; keep them out of video, stdout, and the repo.
