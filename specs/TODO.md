# TODO — work queue (the loop's spine)

> State lives here, not in any conversation: one queue item = one loop tick = one commit.
> Item format: lines starting `- [ ]` under **Queue** are queued; a finished item is flipped
> to `- [x]` and moved under **Done**; a stuck item gets a line starting `BLOCKED:` under
> **Blocked** (that exact line-start is the halt sentinel — never start a prose line with
> it). Every queued item carries `Accept:` criteria and a `Gate:` line.
> `node scripts/factory/queue.mjs <status|next|lint>` is the one parser of this file.

## Loop contract

```
TRIGGER : manual — `/factory [ticks]` in a Claude Code session (maker/checker form), or
          `pwsh ./Invoke-RalphLoop.ps1` in a worktree (headless single-agent form), or a
          `/loop` maintenance tick (.claude/loop.md). No schedule is registered today.
SCOPE   : this repo only, on a dedicated branch — never `main` (it auto-deploys);
          src/**, pipeline/**, scripts/**, docs/**, specs/**, .github/**, index.html;
          public/data/** changes only via re-running the pipeline
MAKER   : factory-implementer (Opus) takes the FIRST unchecked item, implements exactly
          that item with tests, and leaves the work uncommitted
GATE    : `npm run gate`, run by the orchestrator — never taken on the maker's word.
          Path-scoped: always queue lint + `npm run verify` (eslint · unit tests · tsc ·
          build); anything the browser loads → `qa:render --quick` (console errors ·
          120 k cap · blank canvas · context loss); pipeline/** or public/data/** →
          `verify:data` (Σ ≈ 8.03 B · H3 roll-up · sizes); every changed file < 100 MB;
          deploys additionally gated by CI and the `verify-live` job
CHECKER : factory-reviewer (Opus, fresh context, read-only) gets the item and the diff —
          not the maker's report — and returns PASS/FAIL per Accept criterion
COMMIT  : gate green AND checker PASS → one conventional commit = the change + the item
          moved to Done as `[x]` with its evidence; push the branch
RETRY   : gate red or checker FAIL → back to the same maker once; second failure →
          stash the work, BLOCKED line, stop
BUDGET  : ≤ 12 ticks/run · 1 item/tick · ≤ 3 sub-agents/tick · strictly serial (items
          share files, and the render gate's timings are CPU-sensitive)
STOP    : queue empty | blocked sentinel present | budget spent
REPORT  : evidence in the Done note + commit body; sprint summary → PROJECT_STATE.md
```

## Queue

Ordered correctness first, then performance, then features. Only items that do not
depend on the open LOD-banding decision (see **Backlog**, first entry) are queued; the
cull-window, tile-selection, popping and cross-fade work waits there for it.

- [ ] Tile-stream loose ends: two small defects the tick-1 checkers found in
      `src/data/tileStream.ts`. (1) A partial burst never expires — only a success clears a
      tile's failure count, so one prefetch failure ten minutes ago leaves `{count: 1}`, and
      when the tile later becomes visible and fails it resumes at count 2 with no warning
      and a shortened budget; a record older than the cool-down should start a new burst.
      (2) An abandoned run's in-flight load still evicts under its *old* `protect` set, so
      with more than 64 resident tiles it can evict a tile the current view just loaded —
      and that tile has no failure record, so no timer re-requests it and the hole lasts
      until the next view-key change (this predates tick 1). Evict against the current
      view's protect set, or re-check the visible set after an eviction.
      Accept: unit tests prove (a) a failure record older than the cool-down is treated as
      a fresh burst — full budget, one warning; (b) with the cache at its cap, a stale
      run's late-arriving tile never evicts a tile of the current visible set, and the
      current view's merged tier is complete; (c) the existing 15 tile-stream tests pass
      unchanged.
      Gate: verify, qa:render.
- [ ] Wire the render gate into CI: run `npm run qa:render` in `.github/workflows/ci.yml`
      against the dev server, uploading the report + screenshots as artifacts, and fail on
      console errors, a blank canvas or a broken cell cap (the exact checks — the
      SwiftShader stall comparison stays advisory; see `scripts/qa/render_qa.mjs`).
      Accept: CI job green on a clean PR and red on a deliberately-broken render; runtime
      < 10 min.
      Gate: verify.
- [ ] Cache H3 cell boundaries across re-culls: measured on the real mid tier, a re-cull
      at z2.5 costs ~284 ms of main-thread JS and **239 ms of that is `cellToBoundary` for
      the 120 k rendered cells** (720 k vertices) — repaid in full on every re-cull during a
      pan, even though most cells are unchanged between adjacent cull windows. Memoize the
      boundary per H3 index (bounded LRU keyed on the packed `BigUint64` index, sized to a
      few times the 120 k cap), or precompute boundaries in the decode worker alongside the
      packed column. Keep the per-cell true-geometry path: the instanced-column shortcut
      was tried and reverted for the radial "star" shading it produced
      (`docs/architecture.md`).
      Accept: a Node benchmark on the committed mid tier (kept under `scripts/bench/`)
      shows boundary cost on a repeat cull over an overlapping window down ≥ 5×, with the
      before/after numbers in the Done note; a unit test proves identical geometry (same
      cells, same vertices, same order) with the cache cold and warm; memory stays bounded
      under a sustained pan (the cache has a hard cap and a test for it).
      Gate: verify, qa:render.
- [ ] Night-lights basemap toggle: swap the dark-ocean sphere texture for NASA Black Marble
      (public domain) behind a `Controls.tsx` toggle; columns must stay legible
      (data > basemap).
      Accept: toggle works both ways at overview and r8 zoom; attribution line updated;
      the texture is < 2 MB and lazy-loaded (not in the first-paint path); 0 console errors.
      Gate: verify, qa:render.

## Backlog (needs breakdown before queueing)

- **DECISION NEEDED — the LOD bands switch ~3 zoom levels before their cells are visible.**
  Measured 2026-11-17 against deck.gl 9.3's real `GlobeViewport` (1280×800, CSS px):
  an r6 hexagon is **0.38–0.47 px** across when the mid tier switches on at zoom 2.2 and
  does not reach 3 px until zoom ≈ 4.9–5.2; an r8 hexagon is **0.27–0.33 px** across when
  r8 switches on at 4.5, is still only **1.5–1.9 px** at the maximum zoom of 7, and would
  need zoom ≈ 7.7–8.0 to reach 3 px. Everything downstream is a symptom of drawing
  sub-pixel prisms: far more cells fall on screen than the 120 k cap allows, so —
  (1) **r8 covers a patch, not the screen.** At zoom 4.6 over Tokyo the 37 streamed tiles
  reach ~3.3° from the center while a 900×560 canvas spans ±10°; the rest of Japan and
  Korea render with no columns at all (`scripts/qa/out/tokyo-z4.60.png` after any gate
  run). `lib/tiles.ts` also sizes its disk from a `parentEdgeDeg` table that is ~6× too
  large (r3 listed as 3.4°; the real average edge is 59.8 km ≈ 0.54°). Covering that
  screen with r8 would take ~100+ tiles and > 500 k cells — it cannot be done under the cap.
  (2) **mid draws a truncated disc.** The cull window is 1.5 × `min(60, 180/2^zoom)`; the
  real screen edge at lat 0 is 75° from center at zoom 2.3, 69° at zoom 3 and 36.6° at
  zoom 4 (58° to a corner), against windows of 54.8°, 33.8° and 16.9°. Inside the window
  top-k keeps the densest 120 k, so rural cells vanish. Toward the poles the window
  over-selects instead (the projection scales by 1/cos(lat)): at (0°, 80° N, zoom 3) the
  cap is spent south of the screen and 5 of 383 visible cells are drawn.
  (3) the top-k set swaps on every re-cull (popping), each crossing replaces the whole
  mesh with one 49× finer (the seam the cross-fade item papers over), and ~240 ms per
  re-cull goes on boundaries for hexagons smaller than a pixel.
  **Option A (recommended): band by on-screen cell size.** Pick the finest tier whose
  hexagon is ≥ ~3 px: r4 from zoom ≈ 2.1–2.4, r5 ≈ 3.5–3.8, r6 ≈ 4.9–5.2, r7 ≈ 6.3–6.6,
  r8 ≈ 7.7–8.0, and raise `maxZoom` to ~10 so a 400 m cell is ~12–15 px — legible and
  pickable, which VISION promises and zoom 7 does not deliver. r5 and r7 are H3-parent
  aggregations of the committed r6 / r8 (sum of population, parent centroid) — no
  upstream download, Σ ≈ 8.03 B preserved by construction; r7 is tiled like r8. A
  1280×800 screen then holds ≤ ~130 k cells, so the cap becomes a safety net instead of
  a truncation, r8 streams 1–7 tiles per view, each tier step is 7× not 49×, and the
  popping and cross-fade items mostly dissolve. Cost: two more tiers of data in the repo
  and a different look — distinct hexagons instead of a sub-pixel texture.
  **Option B: keep the bands, patch the symptoms.** Fit the cull window and the tile disk
  to the real footprint, and composite r8 over mid (mid cells wherever no r8 tile is
  loaded) so the screen is never blank. Keeps the current look, the sub-pixel geometry,
  the truncation and the re-cull cost.
  Either way the first building block is the same: a tested model of what GlobeView
  shows (px per km and the visible region from zoom, latitude and canvas size), driving
  the cull window, the tile disk and — under A — tier selection.
- (held for the LOD decision) Cull-boundary popping: `cullForView` swaps its 120 k top-k set on each re-cull, so
  cells blink in/out at the window edge during a pan. Fade newly-added cells in over
  ~150 ms, or widen the scan window and stabilize the selection between adjacent cull
  keys (`lib/lod.ts`).
  Accept: a unit test over a scripted pan at z 3–5 on a dense synthetic tier shows the
  rendered set changing by no more than the cells entering/leaving the window between
  adjacent cull keys (no interior churn), with the cap and highest-density semantics
  preserved; a qa:render frame diff of a z 3–5 pan shows no blinking cells.
  Gate: verify, qa:render.
- (held for the LOD decision) LOD cross-fade: with encoding now continuous across tiers (density domain +
  zoom-continuous height), the remaining seam at zoom 2.2/4.5 is purely geometric —
  22 km hexes are replaced by 3 km hexes in one frame. Render both tiers for ~250 ms
  at the crossing and cross-fade opacity (`layers/useGlobeLayers.ts`, driven off the
  `activeLod` transition in `store/useGlobeStore.ts`).
  Accept: no visible pop at either threshold in `npm run qa:render` screenshots;
  ≤ 120 k cells/frame still holds across the fade (cap the *sum* of both layers — with
  a unit test on the split); no frame > 100 ms of main-thread JS attributable to the
  fade (Node timing, not a SwiftShader frame time); reduced-motion skips the fade.
  Gate: verify, qa:render.
- PWA offline — app-shell SW is easy; the 502 MB tile pyramid is not. Needs a caching-scope
  decision (shell + overview only vs. visited-tile cache with eviction).
- Time-series / population animation — needs a data-source decision. Kontur publishes a
  single snapshot (see `docs/data.md`); a time series means a second source entirely.
- Sub-tile frustum culling (beyond the current lng/lat window cull) + smarter pan prefetch.
- Tile migration to a CDN/release asset if the in-repo pyramid outgrows GitHub Pages limits.
- Exact per-cell H3 areas for the density encoding (currently the resolution's nominal
  average — <1% of ramp position, but exact would need the area precomputed in the pipeline
  as a fourth column, not computed client-side at 3.6 µs/cell).

## Blocked

(none)

## Done

(queue established 2026-06-11)

- [x] Responsive mobile framing: on tall portrait (375×812) the globe sits small and high
      with dead space below (Sprint 4 QA note). Add a responsive default zoom and/or vertical
      re-centering (`store/useGlobeStore.ts`, `components/Globe.tsx`). Accept: globe visually
      centered and filling the width on a 375×812 preview; desktop zoom-1.3 hero unchanged;
      URL deep-link override still wins; `npm run verify` green; 0 console errors.
      *(Done 2026-06-11: viewport-aware `defaultZoom()` in `useGlobeStore.ts` — portrait
      h > w×1.4 → 1.9, else 1.3; both < mid band 2.2. Verified: `npm run verify` exit 0;
      preview oracles 1280×800 → 1.3, 375×812 → 1.9, hash `#139.7/35.68/5` wins on portrait;
      0 console errors. Preview screenshot capture timed out on the WebGL canvas — visual
      check by zoom-ratio proxy (2^0.6 ≈ 1.52× diameter ≈ full 375 px width).)*
- [x] Pan perf — baseline frame cost: globe pans slowly (user report, even at overview).
      Cap the render buffer (`useDevicePixels` ≤ 1.5), render columns instanced
      (`highPrecision: false`), and disable hover picking while dragging so the picking
      buffer doesn't re-render on every `pointermove`
      (`components/Globe.tsx`, `layers/useGlobeLayers.ts`, `store/useGlobeStore.ts`).
      Accept: visuals unchanged at overview/r8 (Inferno ramp + column shapes); `pickable`
      flips off while dragging, on at rest; `npm run verify` green; 0 console errors.
      *(Done 2026-06-13: `MAX_PIXEL_RATIO` 1.5 cap + `isDragging` store flag gating
      `pickable`; H3 layer `highPrecision: false`. Verified live via `window.__globe`/`__deck`
      oracles — effPx 1.5, instanced sublayer active, pickable true→false→true across
      idle/drag/release, r8 Tokyo + overview render artifact-free. Synthetic `setViewState`
      ramps can't measure the picking win (they fire no pointer events) and cross-time FPS on
      this box is load-noisy, so the picking-skip is asserted structurally, not by a frame delta.)*
- [x] Pan perf — cull cadence: dense-tier viewport cull (`lib/lod.ts`) re-runs every ~1° of
      drag (`cullKeyFor` quantizes center to 1°) and full-sorts up to ~1M indices. Quantize the
      re-cull cadence to a zoom-relative step (~`halfSpan/4`), scan a `1.5×halfSpan` margin so
      edges don't pop, and replace the full sort with quickselect for the 120k-cell top-k.
      Accept: ~10× fewer rebuilds while dragging at mid/r8; same cells rendered (cap + highest-pop
      semantics preserved); `npm run verify` green.
      *(Done 2026-06-13: `cullKeyFor` quantizes center to `max(0.25, halfSpan/4)` + zoom to 0.25;
      `cullForView` scans `1.5×halfSpan` and uses in-place `topKByPopulation` quickselect.
      Verified live at mid (r6, 2.0M cells) over India z3.2: rendered exactly 120k, cells
      concentrate on dense regions (quickselect top-k correct), viewport fully covered, no holes;
      cull key steps in 4.9° quanta (78.35→83.25→88.14) vs the old 1° — ~5× fewer re-culls at z3.2,
      ~10× near z2.2. `npm run verify` exit 0.)*
- [x] Tile prefetch on pan: `src/data/useTileStreaming.ts` fetches visible r3 parents only;
      prefetch the gridDisk ring k+1 when the viewport is idle so panning at r8 doesn't flash
      empty tiles. Accept: pan at zoom ≥ 4.5 in preview shows no empty-tile flash; LRU cap
      (64) and in-flight dedupe respected; `npm run verify` green.
      *(Done 2026-06-13: `prefetchParents()` (gridDisk k+1 shell) in `tiles.ts`; shared
      `ensureTile()` + visible-protecting `evictLru()` in `useTileStreaming.ts`; idle ring
      prefetch via `requestIdleCallback` that warms the cache without `setR8Data`. Verified
      live at Shanghai z5.2: fetch log shows two bursts — 13 visible tiles at t≈0, then 10
      prefetch-ring tiles at t≈3.7s (idle) — and a +6° pan into the warmed ring fetched 0
      tiles (no flash). 0 console errors; `npm run verify` exit 0.)*
- [x] Tolerate a failed r8 tile: `src/data/useTileStreaming.ts` awaits the visible tiles
      with `Promise.all`, so ONE failed fetch rejects the lot — the merge below it, which
      already filters to `cache.has(p)` and was plainly meant to publish partial sets,
      never runs; the rejection is unhandled; and because `processedRef` was set before
      the await, that view is never retried. One flaky tile = no r8 there until the camera
      moves a degree. The idle prefetch has the same unhandled `Promise.all`. While in
      there: `idx.tiles.find()` is a linear scan of 12,761 tiles per tile and
      `new Set(idx.tiles.map(…))` is rebuilt on every view-key change — build one
      `Map<parent, file>` when the index loads. Fix with `Promise.allSettled`, publish what
      loaded, retry a failed tile a bounded number of times (not forever, not never),
      `console.warn` once per failed tile. Pull tile selection / merge / eviction / retry
      bookkeeping out of the hook into pure functions so Node can test them.
      Accept: unit tests prove (a) with 1 of N tile loads rejecting, the merged tier holds
      exactly the other N−1 tiles' cells, columns aligned; (b) a failed tile is retried and
      appears once it succeeds, and a permanently failing tile stops being retried after
      the bound; (c) the LRU cap (64), visible-tile protection and in-flight dedupe still
      hold; and (d) one headless confirmation, recorded in the Done note with before/after:
      dev server at `#139.7/35.68/5.5` with one tile request aborted (Playwright
      `route.abort`) → `activeLod === 'r8'` with cells > 0 and no unhandled rejection
      (keep the script under `scripts/qa/` so it can be re-run).
      Gate: verify, qa:render.
      *(Done 2026-11-17, factory tick 1: the bookkeeping moved to `src/data/tileStream.ts`
      (`TileStream`, injected loader + clock); the visible load and the prefetch use
      `allSettled` and publish what loaded; parent→file is one `Map`. Retry runs in bursts
      of ≤ 3 attempts (2 s / 4 s backoff) followed by a 30 s cool-down — the maker's first
      cut gave a tile up for the whole session, and was sent back because a ten-second
      outage would then have left permanent r8 holes. Evidence: 15 unit tests in
      `tileStream.test.ts` cover (a)–(c) plus the burst / cool-down edges; headless
      `node scripts/qa/tile_fail.mjs` with the Tokyo tile `832f5afffffffff` aborted —
      BEFORE (maker's run on the old code): `activeLod=mid r8Cells=0`, 1 unhandled
      rejection; AFTER (re-run by the orchestrator): `activeLod=r8 r8Cells=52306
      aligned=true`, 0 unhandled rejections, 3 aborted requests then quiet, 1 warning; with
      `--fail-times 1` the tile recovers and the tier grows to 65,892 cells (maker's run).
      Gate green: 75 tests, qa:render PASS, 0 console errors. Two independent checkers
      PASSed; their minor findings are queued as "Tile-stream loose ends". Not verified: the
      second burst after a cool-down in a real browser (Node tests with an injected clock
      only), and retry timing on real hardware — SwiftShader blocks the main thread ~25 s
      per r8 frame, so the timers fired late.)*
- [x] Decode-worker failure must fall back, not hang: in `src/data/decodeClient.ts`,
      `worker.onerror` only zeroes `slot.inFlight` — requests already posted to that worker
      are never settled, so `loadLod()` never resolves and the app sits on the loader
      forever with no error. The inline fallback exists but only behind the `try/catch`
      around `new Worker`, and a module worker that fails to load or throws does so
      asynchronously, through `error`, so the fallback is unreachable for the failure it
      was written for. Track which slot owns each pending request; on `error` /
      `messageerror` re-run that slot's requests through `decodeInline`, terminate the
      dead worker, and route later calls inline once no healthy worker is left. Make the
      pool a unit that takes its worker factory and inline decoder as arguments so Node
      can drive it with a fake worker.
      Accept: unit tests prove (a) a worker that errors after `postMessage` → the pending
      promise resolves with the inline decoder's result; (b) with every worker dead, later
      calls go inline without touching the pool; (c) one dead worker does not take the
      healthy one's requests down; (d) a healthy worker's result still resolves and a
      failure message from it still rejects; and (e) one headless confirmation, recorded
      in the Done note with before/after: dev server with the worker script request
      aborted → `status === 'ready'` and cells on screen (extend the script from the item
      above).
      Gate: verify, qa:render.
      *(Done 2026-11-17, factory tick 2: the pool is now `src/data/decodePool.ts`
      (`DecodePool(createWorker, decodeInline, size, reportDeath)`, no DOM imports); each
      slot owns its pending requests, a dead slot is terminated, dropped and its requests
      re-run inline, and with no healthy worker left calls go inline directly.
      `decodeClient.ts` is the thin wiring. Sent back once: the first cut reported a death
      with `console.warn` behind `preventDefault()`, which would have hidden a genuinely
      broken worker from the render gate — it now logs one `console.error` per dead worker
      (reason + workers left), so a worker dying in a normal run turns `qa:render` red.
      Evidence: 20 unit tests in `decodePool.test.ts` cover (a)–(d), the reporting rule and
      the edges (several requests in flight, late message from a dead worker, inline
      decoder rejecting or throwing, `postMessage` throwing, factory throwing); headless
      `node scripts/qa/tile_fail.mjs --fail-worker` with the worker script aborted —
      BEFORE (maker's run on the old code): still `status=loading`, no error, after 150 s;
      AFTER (re-run by the orchestrator): `status=ready`, 71,283 cells at +16.6 s, 2 death
      errors logged, 0 unhandled rejections. The default tile mode of the script still
      passes. Gate green: 95 tests, qa:render PASS with 0 console errors on the healthy
      path. Two independent checkers PASSed. Not verified in a browser: `messageerror`
      and a runtime crash mid-decode (fake worker only). Known limits: an inline fallback
      re-fetches the file and decodes on the main thread (~2.4 s for the mid tier); if the
      worker *constructor* throws the pool only warns, so that path is invisible to the
      gate; nothing in the UI says the app is running degraded.)*
- [x] Deep-link parsing accepts garbage: `parseHash('#//')` returns `{0, 0, 0}`
      (`Number('')` is 0, so empty components pass the finite check), `#0/0/999` seeds a
      zoom far outside the view's `[minZoom, maxZoom]` (a blank screen from a shared URL),
      and longitude is unbounded. In `src/lib/urlState.ts`: reject empty or whitespace
      components, wrap longitude into [−180, 180), clamp zoom to the camera's real bounds —
      which today are literals in `store/useGlobeStore.ts`; export them from one place
      instead of repeating them.
      Accept: unit tests cover `#//`, `#1/2/`, `#0/0/999`, `#0/0/-50`, `#540/10/3`
      (→ 180 wraps to −180) and whitespace; every hash `formatHash` can emit still
      round-trips; the store seeds its initial view from the validated values.
      Gate: verify, qa:render.
      *(Done 2026-11-17, factory tick 3: `parseHash` now requires each component to be a
      plain decimal (rejects empty, whitespace, hex, exponent, `Infinity`, trailing junk,
      `%20`), wraps longitude into [−180, 180), clamps zoom, still rejects a latitude off
      the sphere, and folds −0 to 0. The zoom bounds live once in a DOM-free
      `src/lib/camera.ts` (`MIN_ZOOM`, `MAX_ZOOM`, `clampZoom`, `wrapLng`) shared by the
      parser, the store and the zoom ladder; `zoomBy`'s fallback bounds were −2/8 and
      disagreed with the view's −1/7. Evidence: 16 tests in `urlState.test.ts`, 8 of which
      fail against the old parser; a > 10 k-view sweep of the store's whole range
      round-trips, and the checker's independent 200 k random-view probe (seam, −0, tiny
      values) found 0 rejects and 0 mismatches. Gate green: 106 tests, qa:render PASS, 0
      console errors. Checker PASS first time. Not verified in a browser: the seeding of
      the initial view from a hash (read, not run — the store touches `window` at load, so
      Node cannot import it). Left as is: two inline `wrapLng` copies in `Globe.tsx` and
      `KeyboardShortcuts.tsx`; `scripts/qa/page-probe.mjs` no longer forces the bounds in
      `setCamera`, it inherits the store's.)*
- [x] Pole-aware viewport cull: `cullForView` (`src/lib/lod.ts`) keeps cells inside a
      fixed lng/lat *degree* box, but a degree of longitude covers cos(lat) as much ground
      as at the equator — at 70° N the window is a third as wide on the ground as the
      viewport it is meant to cover (empty east/west edges), and a view near a pole misses
      everything on the far side of it. Replace the box with a spherical-cap test (angular
      distance from the view center ≤ the window), using the latitude band as the cheap
      prefilter; that is exact at the poles and across the antimeridian by construction.
      `cullKeyFor` should scale its longitude quantum the same way, so the re-cull cadence
      stays constant in ground distance instead of thrashing as the camera nears a pole.
      Accept: unit tests on an equal-area synthetic tier (uniform in lng and sin(lat)) show
      (a) every selected cell lies within the window's angular radius of the view center,
      and under the cap no cell inside it is dropped; (b) the selected count at lat 70° and
      at lat 85° is within 15 % of lat 0° at the same zoom (today ≈ cos(lat)×); (c) a view
      centered on a pole selects cells at every longitude; (d) the existing antimeridian,
      top-k and cap tests still pass; and (e) a Node timing on the committed mid tier
      (`public/data/mid.parquet`, 2 M cells) shows the cull within 1.5× of its cost before
      the change — report both numbers.
      Gate: verify, qa:render.
      *(Done 2026-11-17, factory tick 4: `cullForView` keeps a great-circle cap — a
      latitude band, a bounding-box reject and a per-cull table of the cap's longitude
      half-width, so only rim cells pay trig; `cullKeyFor` steps longitude by ground
      distance and drops it next to a pole. Sent back once: the key quantizes zoom, so a
      radius taken from the triggering view left a gap of up to ~6 % of the half-span when
      the camera zoomed out inside a bucket and moved diagonally; the radius
      (`cullRadiusDeg`) is now a function of the key, so every view on a key is covered.
      Evidence: 19 new tests on an equal-area synthetic tier (all fail on the old cull, the
      17 old tests are untouched); count at lat 70° / 85° vs the equator is 0.99–1.05, was
      0.10–0.44; the checker's own sampler found 0 uncovered among 882,504 same-key view
      pairs and 0 cells dropped inside the cap over 13 + 22 brute-forced views (both
      poles, antimeridian, widest window); Node timing on the 2 M-cell mid tier
      (`node scripts/bench/cull_bench.mjs`): mean of medians 14.6–15.3 ms before, 15.0–15.2
      ms after, worst single view 1.23×. Gate green: 125 tests, qa:render PASS, 0 console
      errors. Two independent checkers PASSed. **The item's premise was only half right**,
      and the first checker measured why: deck.gl's GlobeViewport scales with 1/cos(lat),
      so the *visible* ground also shrinks toward the poles, and on a wide canvas the
      screen reaches far past `halfSpanDeg` (1280×800, lat 0: screen edge 69° from center
      at z3 and 36.6° at z4, against cull radii of 33.8° and 16.9°). Against real on-screen
      coverage this tick is still a large net win (Iceland z4 52 % → 100 % of visible cells,
      St Petersburg z4.5 59 % → 99 %, Alaska z3 26 % → 72 %) with one regression: at
      (0°, 80° N, z3) the cap now spends the 120 k budget on cells south of the screen and
      top-k keeps 5 of 383 visible cells, was 23. Both are the next queue item. Not
      verified in a browser: timing on the main thread (Node/V8 only).)*
