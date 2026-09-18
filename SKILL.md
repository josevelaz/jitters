# studio-demo skill

Prompt-in / MP4-out demo video studio.

## When to use

Use `studio-demo` when the user wants a narrated-style product demo video (MP4)
driven by a natural-language prompt.

## Key facts

- **Prompt in, MP4 out.** Input is a `prompt` positional; output is an MP4.
- **Quoting type-in text:** always single/double-quote literal text the agent
  must type. Jev cannot generate text — it can only judge pixels — so never
  ask it to invent copy; pass exact strings: `"type 'hello@example.com' ..."`.
- **`--url`:** sets the starting URL for the browser run.
- **Restyle via `style.json` + `render`:** edit `<out>/<project>/style.json`,
  then run `studio-demo render <project>` to recomposite without re-capturing.
  Render only needs `ffmpeg`.

## Commands

```sh
studio-demo "demo the checkout" --url https://example.com --out ./out
studio-demo render <project> --out ./out
```

## Deps

Capture needs `TYPESAFE_API_KEY`, `agent-browser` on PATH, `ffmpeg` on PATH.
Render needs `ffmpeg` on PATH. `--help` needs none of these.
