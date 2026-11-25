# knowledge/INBOX — flags waiting to be curated

Append-only during a tick. The orchestrator copies each `KNOWLEDGE:` entry from the
maker's report and the checker's verdict here verbatim, and the owner's rulings in their
own words (`.claude/commands/factory.md`, step 7 and "The owner's rulings"). Nothing here
is a rule yet: an entry becomes one only when a curation pass moves it into a note, with
its evidence re-checked ([README.md](README.md)). A curated entry is deleted from this
file in the commit that adds it to the note.

```
### <YYYY-MM-DD> · tick <n> · <item title>
- [missing|wrong|stale] (maker|checker) <topic> — <what misled the agent, or what it had
  to find out> — evidence: <command, file and heading, commit or URL>
  suggest: <the correction, if the agent had one>
- [owner] <YYYY-MM-DD> "<the ruling, in the owner's words>" — context: <what it was about>
```

## Waiting

### 2026-11-24 · seeded from the records of ticks 1–14 (not raised by an agent at the time)

Lessons the first fourteen ticks paid for that no note holds yet. Each was read out of a
Done note or a commit; none is new.

- [missing] (checker) the checker cannot see the orchestrator's headless runs — in tick 8
  the only reason for a FAIL was that three headless checks the item required had been run
  by the orchestrator, and the reviewer is handed the item text only —
  evidence: `specs/TODO.md`, Done note "Re-band on on-screen cell size" ("returned FAIL for
  one reason only"); `.claude/commands/factory.md`, "One tick" step 4
  suggest: hand the checker the gate's summary block and the output of any headless script
  the item names, as evidence only — not the maker's report. This changes the loop contract,
  so it is an owner decision, not a curation edit.
- [missing] (checker) anything computed under a cull key must be a function of the key, not
  of the view that happened to trigger the cull — a radius, a window, a tile set or a
  selection taken from the triggering view is wrong for every other view on the same key.
  Paid for in tick 4 (a gap of up to ~6 % of the half-span under zoom drift), seen again in
  tick 9 (another view on the same key could miss 3–7 % of its on-screen cells), designed
  for in tick 10, and paid for again in tick 12 (the triggering view itself lost 1–4 % of
  its edge cells) — evidence: `specs/TODO.md`, Done notes "Pole-aware viewport cull" ("Sent
  back once") and "Tier selection that follows latitude and canvas size" ("How it got
  there"); commits `55c113c3` ("Known, and recorded for the selection item") and `1856cbe5`
  suggest: an entry in a geometry note, with "test same-key neighbours" added to the
  checker's list of inputs to try. No topic-indexed record states the rule.
- [missing] (checker) sampling a cell's boundary at a few points is not an overlap test —
  on a small ground footprint (narrow canvas, zoom 9.5–10, high latitude) an on-screen tile
  was skipped: 149 misses in 20,000 random views — evidence: commit `1856cbe5`;
  `specs/TODO.md`, Done note "Tile streaming for any tiled tier"
  suggest: an entry in a geometry note: test overlap exactly (edge arcs against the
  window's planes), and prove it against a brute force.
- [wrong] (maker) the pole-cull item's premise was half right — it said a fixed lng/lat
  window over-scans near the poles and asked for the longitude span to be scaled by
  1/cos(lat); the visible ground also shrinks toward the poles, and on a wide canvas the
  screen reaches far past the window. The item was written before anyone had measured
  GlobeView's projection — evidence: `specs/TODO.md`, Done note "Pole-aware viewport cull"
  ("The item's premise was only half right")
  suggest: nothing further for the code (ticks 4 and 9 fixed it); it is here as the case
  for "Writing a queue item" in `.claude/commands/factory.md`.

### 2026-11-24 · curation pass · `knowledge/verification-limits.md` · first review

- [wrong] (checker) `CLAUDE.md`'s Commands table calls `qa:render` a "stall + console-error
  gate", but stalls never fail it by default: `--max-stall-ms` defaults to off, long frames
  go to `findings.warnings`, and the gate passes no `--baseline` — evidence:
  `scripts/qa/render_qa.mjs` `parseArgs` defaults and the freezes → `findings.warnings`
  push; `scripts/factory/gate.mjs` `plan()`
  suggest: "frame timing (advisory) + console-error / cell-cap / blank-canvas gate". The
  table is in `CLAUDE.md`, so this is an owner edit, not a curation edit.

### 2026-11-24 · curation pass · `knowledge/verification-limits.md` · second review

- [wrong] (checker) render gate / failed requests — Chromium's own "Failed to load
  resource: net::ERR_FAILED" (and HTTP 4xx/5xx) reaches Playwright's `page.on('console')`
  as type `error` for main-thread fetches, not for Worker fetches, so `render_qa.mjs` fails
  on any failed main-thread request. The previous curation pass treated the opposite as
  established — evidence: scratch probe with the repo's playwright-core and
  `findChromium()`; `render_qa.mjs` `page.on('console')`; `useTileStreaming.ts` `streamFor`
  `console.error`
  suggest: "A failed request from a Worker (tile and tier decode) is only a warning; a
  failed main-thread request (manifest, tile index, a lazy chunk, an inline-fallback
  decode) fails the gate through Chromium's own console error."
  *(Orchestrator's note: the first review said the reverse, from reading the
  `requestfailed` handler alone. The entry was withdrawn from the note. It should return
  only with a committed probe as its `check:` — one that aborts a main-thread request and
  a Worker request in a gate run and asserts which turns it red.)*
- [stale] (checker) `render_qa.mjs` `report.limitations` SwiftShader line — it still says
  stall detection transfers to any hardware ("a ${FREEZE_MS} ms+ frame is a freeze on any
  hardware"), against the Sprint 7 measurement that the stalls are SwiftShader's vertex
  pipeline — evidence: `PROJECT_STATE.md`, "What the render harness could NOT show — and
  why"
  suggest: change the line in `render_qa.mjs` (a code edit, not a curation edit).
- [stale] (checker) `docs/data.md` §4 — it says `verify_data.mjs` only bounds-checks
  lng/lat, but it now also asserts that r5 and r7 `lng/lat == H3 cell center`. Those tiers
  do not go through the reprojection, so the conclusion stands — evidence:
  `scripts/verify_data.mjs`, the checks named "lng/lat == H3 cell center (EPSG:4326, lng
  first)"
  suggest: add one sentence to §4.
- [missing] (checker) the complete list of what fails the render gate — a draft entry
  listing it was withdrawn because it left out `--max-stall-ms` (which fails a run when the
  flag is passed) and its heading was a title, not a claim — evidence: the
  `findings.failures.push(…)` calls in `scripts/qa/render_qa.mjs` `main()`
  suggest: do not enumerate; point to the calls, or generate the list from them.
- [missing] (orchestrator) what a scheduled run's "succeeded" status means — recollection
  of this session, not a record: the factory schedule fired on 2026-09-02, the runs that
  finished were recorded as succeeded, and none left a branch or a pull request. A draft
  entry was withdrawn because nothing in the repository recorded it before this change, and
  details of the recollection do not match what the repository does record (commit
  `eb353753` documents the schedule as running since 2026-08-30) — evidence:
  `PROJECT_STATE.md`, Sprint 8 "What the review found" (the outcome only: nothing landed
  after 2026-09-02)
  suggest: when a schedule is next registered, fire it once by hand, record the run's
  status next to `git ls-remote --heads origin <branch>`, and write the entry from that.

### 2026-11-25 · tick 15 · Wire the render gate into CI

Entries as the maker (two rounds) and the two checkers reported them; where more than one
agent flagged the same thing it is listed once with all of them named.

- [wrong] (maker, checker 1, checker 2) `scripts/qa/browser.mjs` pool lookup —
  `findChromium()` searches `PLAYWRIGHT_BROWSERS_PATH`/`/opt/pw-browsers` for
  `chromium-*/chrome-linux/chrome`, but the pool here, and playwright-core 1.62's Chrome for
  Testing builds, use `chrome-linux64/`. The pool branch never matches; local runs only
  work because the container sets `CHROME_PATH=/usr/bin/google-chrome`, and CI only works
  because the workflow sets `QA_CHROMIUM_PATH` — evidence: `ls /opt/pw-browsers/chromium-1243`
  → `chrome-linux64`; `node -e "import('./scripts/qa/browser.mjs').then(m=>console.log(m.findChromium()))"`
  → `/usr/bin/google-chrome`; `npx playwright-core install --dry-run --no-shell chromium`
  suggest: add `chrome-linux64/chrome` to the candidate list (a code item), and record that
  the binary in use is the one `report.browser.executable` names.
- [stale] (maker) `CLAUDE.md` CI line — "CI: `.github/workflows/ci.yml` (`verify` +
  `verify:data` + queue lint)" is wrong once this lands: there is also a `render` job
  running `qa:render --quick` — evidence: `CLAUDE.md`, "Commands", the "CI:" line;
  `.github/workflows/ci.yml` job `render`
  suggest: "CI: `ci.yml` — `build` (`verify` + `verify:data` + queue lint) and `render`
  (`qa:render --quick`, report + screenshots as artifact `render-qa`)". An owner edit.
- [stale] (maker, checker 1, checker 2) `knowledge/verification-limits.md`, "`verify:live`
  accepts a deployed manifest that has lost a tier" — this change fixes that — evidence:
  `scripts/verify_live.mjs` `tierSetProblems`; a manifest without r8 now exits 1 with
  `missing tier "r8"`, and HEAD's version passed it
  suggest: rewrite the entry: `verify:live` asserts the deployed tier set (lod, order,
  h3Res, tiled, cellCount) equals the checkout's `public/data/manifest.json`, so running it
  from a checkout whose manifest differs from the deployment fails by design; check:
  `scripts/verify_live.test.mjs`.
- [missing] (maker) the gate's path scoping does not cover `.github/workflows/**` or
  `scripts/verify_live.mjs` — a change to how CI runs the render gate never triggers the
  render gate locally, so an item like this needs its own headless run — evidence:
  `npm run gate -- --skip-render --dry-run` → only `queue lint` and `verify`;
  `scripts/factory/gate.mjs` `RENDER_PATHS`
  suggest: say so in the note on what each check can see.
- [missing] (maker) the proxy refuses the live Pages host, so `verify:live` cannot be run
  from this container at all — evidence:
  `curl -sS https://zeevmala.github.io/world-population-globe/data/manifest.json` →
  `CONNECT tunnel failed, response 403`
  suggest: an entry under "No local check sees what the CDN does": from an agent box here,
  only the deploy workflow's `verify-live` job can run it.
- [missing] (maker, checker 1, checker 2) the QA dev server's bind address —
  `ensureDevServer` started Vite with no `--host` while probing a literal 127.0.0.1. Vite
  binds whatever Node's lookup of `localhost` returns first, so on a host where that is not
  127.0.0.1 every headless harness dies at boot after 90 s. This sandbox maps `localhost`
  to 127.0.0.1 only and has no IPv6, so no local run could show it. That an Ubuntu runner
  resolves `localhost` to `::1` first is unmeasured — evidence:
  `node_modules/vite/dist/node/chunks/node.js` `resolveHostname`, `tryBindServer`;
  `cat /etc/hosts`; `node -e "require('net').createServer().listen(0,'::1')"` →
  `EAFNOSUPPORT`; a preload making `localhost` resolve to 127.0.0.2 (90,375 ms failure
  before the fix, ready in 868 ms after)
  suggest: an entry in verification-limits.md: "a green headless run here proves nothing
  about name resolution or IPv6; the harness binds and drives `DEV_HOST`, a literal", with
  `check: scripts/qa/server.test.mjs`; once an Actions run exists, record what its "dev
  server ready on" line shows.
- [missing] (maker) stopping a background server from a shell —
  `(cd dir && python3 -m http.server … &); echo $!` records the wrapper's pid, not the
  server's; a probe server outlived its `kill` and kept serving a deleted directory, which
  made a later control fail with a 404 HTML page — evidence: `pgrep -af http.server` showed
  the pid still alive after `kill $(cat srv.pid)`
  suggest: start it as `python3 -m http.server PORT --directory DIR &` in the same shell
  and check `pgrep` after the kill.

### Owner rulings recorded before this file existed (not verbatim unless marked)

- [owner] 2026-08, verbatim from the session: "this site needs to be the best in the world,
  a cartographic benchmark … aim for a smooth rendering experience in all zoom levels …
  SOTA UX\UI … solid updated data" — context: the request that started the continuous
  factory; `PROJECT_STATE.md`, Sprint 7, paraphrases it as the "User brief". It is the
  standing answer to "is this good enough to ship".
- [owner] 2026-11-18 Option A — band the LOD tiers by on-screen cell size (a tier starts
  where its hexagon is ~3 px across), not Option B (keep the bands, patch the symptoms) —
  context: `specs/TODO.md` Backlog, "DECIDED 2026-11-18"; commit `cd75a71a`.
- [owner] 2026-11-23 permitted downloading the NASA Black Marble texture for the
  night-lights basemap — context: commit `36ca4bd5`.
- [owner] open — the 120 k cell cap against large canvases. Not ruled on: it needs frame
  times at 120 k, 200 k and 300 k extruded cells on a real GPU first — context:
  `specs/TODO.md` Backlog, "OWNER DECISION".
- [owner] by 2026-08-30 — a scheduled factory run never pushes to `main`; it works on a
  branch and merging stays with the owner — context: commit `eb353753`; `PROJECT_STATE.md`,
  "Iteration loop".
