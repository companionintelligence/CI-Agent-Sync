# CI Agent Sync — product video

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

A 16:9 and a 9:16 cut of the CI Agent Sync setup wizard, built from [`storyboard.json`](storyboard.json)
with `@companionintelligence/video-kit` (0.35.0 when authored). Videos are build output: never committed,
rendered to `out/` (gitignored). The shots in `assets/shots/` and the narration in `assets/audio/` are committed.

```bash
./video/make.sh --no-render      # stage the wizard, capture, build, check
./video/make.sh                  # ... and render both cuts
```

The stage (`stage.sh`) runs `./bin/agent-atlas` on loopback with an **empty throwaway HOME**, so the
backup step cannot expose a real home directory. The store itself is not faked: harnesses, profiles and
counts come from this repo's YAML. The browser chrome label reads `127.0.0.1:8787` because that is the
product's real, loopback-only address.

Notes for editors:

- The wizard shows the active step with the `hidden` attribute, not an `active` class on later steps; shots wait on `:not([hidden])`.
- No shot opens "Preview backup": it prints a timestamped absolute path.
- The agent names render as the app capitalises them (`Openclaw`, `Chatgpt`); that is product text, filed rather than masked.
- `npm install` in `video/` needs a GitHub Packages token for the private kit; capture only needs Playwright (pinned `1.62.1`), which the kit resolves from here.
