# What each check can and cannot see

Read this before writing an Accept criterion, claiming something is verified, or adding a
step to a headless script. Every entry was paid for at least once. Format and rules:
[README.md](README.md).

## The render gate (`npm run qa:render`, `scripts/qa/render_qa.mjs`)

### Its frame times and stalls say nothing about a real GPU, in either direction
- kind: measured
- evidence: `PROJECT_STATE.md`, "What the render harness could NOT show — and why" (an idle
  box at 360×280 still blocked ~29 s at a tier crossing while the JavaScript accounted for
  ~0.3 s of it)
- check: none
- verified: 2026-11-24

Headless Chromium here rasterizes on the CPU (SwiftShader). Its cost is dominated by the
software vertex pipeline, so shrinking the viewport does not help and a slow frame is not
a regression. For a performance claim, time the JavaScript in Node against the committed
data (`scripts/bench/`) before and after, and say the GPU side is unmeasured. Stalls never
fail the gate: `--max-stall-ms` is off by default and long frames are reported as
warnings; and `npm run gate` passes no `--baseline`, so the gate compares against nothing.

### A failure the app logs with `console.warn` is invisible to it; only `console.error` and uncaught page errors turn it red
- kind: measured
- evidence: `scripts/qa/render_qa.mjs` — the `page.on('console', …)` handler sorts messages
  into `consoleErrors` and `consoleWarnings`, and only the errors and `pageErrors` are
  pushed to `findings.failures`; `src/data/decodePool.ts` header comment ("the render gate
  fails on console errors, not warnings"); `specs/TODO.md`, Done note "Decode-worker
  failure must fall back, not hang" ("Sent back once")
- check: none
- verified: 2026-11-24

A fault the user would see must be reported as `console.error`, once, or a broken build
passes the gate. Tick 2's first cut logged a dead decode worker as a warning.

### A headless step waits on app state, never on a fixed time
- kind: measured
- evidence: commit `1856cbe5` and `specs/TODO.md`, Done note "Tile streaming for any tiled
  tier" ("a wall-clock wait that the software rasterizer outlasted"); the `CUE_WAIT_MS` /
  `CUE_WAIT_POLLS` comment in `scripts/qa/render_qa.mjs`
- check: none
- verified: 2026-11-24

The software rasterizer blocks the main thread for seconds per frame, so any fixed
timeout is eventually outlasted and the gate goes red on a change that is fine. Wait on
the state that makes the thing due, and bound the wait by polls the page answered as well
as by wall clock.

### Nothing may edit the working tree while it runs, and two must never run at once
- kind: measured
- evidence: commit `e2bc4e5f`, body (a run that died with "execution context destroyed"
  because `package.json` was edited mid-run and Vite reloaded the page); the header comment
  of `scripts/factory/gate.mjs` (the frame timings are CPU-sensitive). The rule itself is in
  `CLAUDE.md`, "Conventions"; this entry is only the why
- check: none
- verified: 2026-11-24

Two questions about this gate are **not** answered here, because two independent reviews
of this note disagreed with each other and with its drafts: exactly which failed network
requests turn it red, and the complete list of what fails it. Both are open entries in
[INBOX.md](INBOX.md). Until they are settled by a measurement, do not rely on the gate for
a loading failure either way — prove it with `scripts/qa/tile_fail.mjs`.

## The checker (`.claude/agents/factory-reviewer.md`)

### It is handed the item text only, so it cannot see the orchestrator's gate or headless runs unless it is given their output
- kind: measured
- evidence: `.claude/commands/factory.md`, "One tick" step 4 ("with the item text only");
  `.claude/agents/factory-reviewer.md`, "Rules" (it may not run `npm run gate` or
  `npm run qa:render` itself); `specs/TODO.md`, Done note "Re-band on on-screen cell size"
  (a FAIL "for one reason only — it could not see those three headless runs")
- check: none
- verified: 2026-11-24

The checker may re-run a measurement the item calls for, and other headless scripts are
not forbidden to it — but only one headless run can be in progress at a time. When an
item's Accept criteria include a headless run the orchestrator has already made, give the
checker that run's output, or expect a FAIL with no code finding. Whether the contract
should say so is an open flag in [INBOX.md](INBOX.md).

## The data gates

### `verify:data`'s bounds check does not catch a swapped lng/lat axis inside ±90° longitude
- kind: sourced
- evidence: `docs/data.md`, "CRS handling"
- check: none
- verified: 2026-11-24

`always_xy := true` in `pipeline/kontur_common.py` is the real guard. A change to the
reprojection needs its own check against a known place, not a green `verify:data`.

### A `--sample` run of `verify:data` is never a release gate
- kind: sourced
- evidence: `docs/data.md`, "Verify" (a sampled run skips the all-tile Σ-population
  assertions and the r7 ↔ r8 roll-up, and prints its mode on line 2)
- check: none
- verified: 2026-11-24

### `verify:live` accepts a deployed manifest that has lost a tier
- kind: measured
- evidence: `scripts/verify_live.mjs` — it checks whatever tiers `manifest.lods` lists, and
  only that the list is non-empty and its bands contiguous; `specs/TODO.md`, the open Queue
  item "Wire the render gate into CI" asks for the expected tier set to be asserted
- check: none (the queue item is the fix)
- verified: 2026-11-24

### No local check sees what the CDN does to the files; only a check against the deployment does
- kind: measured
- evidence: `PROJECT_STATE.md`, "Postmortem — 2026-06-08" (the CDN gzips `.parquet`; local
  dev and `curl` both masked it) and "QA & verification loop" ("Open gap → closed");
  `docs/data.md`, "Verify", last paragraph (`verify:data` and `verify:live` are both
  needed); the dev-server line in `report.limitations` (`scripts/qa/render_qa.mjs`)
- check: none
- verified: 2026-11-24

`verify:data` proves the committed files and the render gate drives the uncompressed dev
server; neither goes through the CDN. A change to how files are fetched is not verified
until `verify:live` (the `verify-live` job in `.github/workflows/deploy.yml`) has passed
against a deployment and the live page has been looked at.

## Only a real machine can settle these

None of the following has been measured on a GPU or in a real browser session. They are
the owner's to look at; an agent here cannot close them, and should not word a Done note
as if it had.

| Open question | Where it is recorded |
|---|---|
| Frame times at 120 k, 200 k and 300 k extruded cells — the input to the cell-cap decision | `specs/TODO.md` Backlog, "OWNER DECISION — the 120 k cell cap" |
| Whether decoding off the main thread is felt at a tier crossing | `PROJECT_STATE.md`, "What the render harness could NOT show — and why" |
| Retry timing for a failed tile, and the second burst after a cool-down, in a real browser | `specs/TODO.md`, Done note "Tolerate a failed r8 tile" |
| The frame-time saving of the boundary cache and of not re-tessellating on zoom, in ms | Done notes "Cache H3 cell boundaries across re-culls", "Stop re-tessellating the columns on every zoom frame" |
| How the 1 km floor looks; frame cost of the extra on-screen cells; pan smoothness across tiled tiers | Done notes "Re-band on on-screen cell size", "Cull window from the real footprint", "Tile streaming for any tiled tier" |
| Per-view tier selection and the window-resize hold in a real browser drag | Done notes "Tier selection that follows latitude and canvas size", "Win back the detail the cap rule gives away"; Backlog "(to look at on a real machine) While a window is being resized" |
| Night lights at r8 zoom (the magnified texture reads as grey blur over water), and the hitch when the toggle re-uploads its texture | Backlog "(to look at on a real machine) Night lights at r8 zoom"; Backlog, tick 14's review, item (3) |
