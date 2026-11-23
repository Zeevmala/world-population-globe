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
RETRY   : one send-back per oracle — a red gate goes back to the same maker once, and a
          checker FAIL goes back once (then a fresh checker); a second red gate, or a
          second FAIL, → stash the work, BLOCKED line, stop
BUDGET  : ≤ 12 ticks/run · 1 item/tick · ≤ 3 sub-agents/tick · strictly serial (items
          share files, and the render gate's timings are CPU-sensitive)
STOP    : queue empty | blocked sentinel present | budget spent
REPORT  : evidence in the Done note + commit body; sprint summary → PROJECT_STATE.md
```

## Queue

Option A (decided 2026-11-18, see **Backlog**) is done — its five items and the
follow-up that tightened the cap rule (tick 13) are under **Done**. First here is the
night-lights basemap, unblocked 2026-11-23 when the owner permitted the texture download;
the item after it still waits on a pull request.

- [ ] Night-lights basemap toggle: offer NASA's Black Marble as a second basemap behind a
      `Controls.tsx` toggle, the current dark ocean + land fill staying the default.
      Columns must stay legible (VISION: data > labels > basemap) — and night lights are
      bright yellow exactly where the densest columns are, the top of the Inferno ramp, so
      the lights have to be held down, not shown at full strength.
      Source (owner permitted the download 2026-11-23): NASA GIBS, layer
      `VIIRS_Black_Marble` ("Black Marble (VIIRS, Suomi NPP)", the 2016 composite), WMS
      `https://gibs.earthdata.nasa.gov/wms/epsg4326/all/wms.cgi` GetMap, EPSG:4326, BBOX
      -90,-180,90,180, 4096×2048 PNG, fetched 2026-11-23, sha256 `fb9ff079…28f1078` (the
      `best` endpoint and some `all` backends answer with a MapServer error page — retry).
      Equirectangular, north up, −180° at the left edge; the two edge columns match (mean
      abs difference 0.96 of 255), so it wraps. NASA imagery is public domain; GIBS asks to
      be acknowledged. The 5 MB PNG is not committed — the committed texture is a JPEG
      encoded from it by a script kept in the repo.
      Accept: (a) the toggle is a real control — a button with a pressed state, reachable
      by keyboard, listed in the shortcuts dialog if it gets a key — and a headless check
      turns it on and off at overview zoom and at an r8 zoom: on changes the canvas, off
      restores the dark basemap pixel for pixel (same view, columns settled);
      (b) georeferencing is proven, not eyeballed: the same check reads the rendered canvas
      at the view centre for at least four places with no population columns, chosen so an
      east–west mirror, a north–south flip and a longitude offset would each fail it (the
      Greenland ice cap against the same latitude mirrored in longitude, Antarctica
      against the Arctic Ocean, the Sahara against the mid-Pacific), and each agrees with
      the texture's own pixel at that longitude and latitude;
      (c) data > basemap as a stated, pinned number: with night lights on, no basemap
      pixel is brighter than the Inferno colour at the ramp's midpoint (relative
      luminance) — say how the lights are held down (a tone curve baked into the texture,
      or a tint / desaturation at draw time) and what it does to the land tones, with
      before/after screenshots over Europe–India at overview zoom and over a city at r8;
      (d) the texture is < 2 MB, is requested only when the toggle is first turned on (a
      network assertion: a cold load with the toggle off never requests it; turning it on
      twice requests it once) and adds nothing to the entry chunk beyond the toggle
      (report the entry chunk before / after); it must also work where
      `MAX_TEXTURE_SIZE` is 2048, WebGL 2's minimum — say how;
      (e) a failed texture request (blocked in the headless check) leaves the dark basemap
      on screen, the toggle not pressed, a message the user can read, and no unhandled
      rejection; (f) the credit line names NASA Black Marble / GIBS while night lights are
      on, and the Kontur CC-BY credit is unchanged in both modes; (g) 0 console errors in
      the render gate, and the default first paint (toggle off) is pixel-identical to
      before the change on the gate's hero view.
      Gate: verify, qa:render.
- [ ] Wire the render gate into CI: run `npm run qa:render` in `.github/workflows/ci.yml`
      against the dev server, uploading the report + screenshots as artifacts, and fail on
      console errors, a blank canvas or a broken cell cap (the exact checks — the
      SwiftShader stall comparison stays advisory; see `scripts/qa/render_qa.mjs`).
      Also for this item: `scripts/verify_live.mjs` now walks whatever tiers the deployed
      manifest lists, and so no longer fails if one is missing altogether — have it assert
      the tier set it expects (or at least a count) so a manifest that lost r8 cannot pass.
      Waiting on the user (2026-11-17): the Accept needs a real GitHub Actions run, and
      `ci.yml` only triggers on a pull request or a push to `main` — a PR has not been
      asked for. The same PR would be the first Actions run of the `verify` +
      `verify:data` steps added to CI and to the deploy workflow in Sprint 8.
      Accept: CI job green on a clean PR and red on a deliberately-broken render; runtime
      < 10 min.
      Gate: verify.

## Backlog (needs breakdown before queueing)

- **OWNER DECISION — the 120 k cell cap against large canvases.** With tiers banded by
  on-screen size and the cull window guaranteed to fit the cap (ticks 8–12), the cap is
  now what limits detail on a big screen: 1920×1080 cannot show cells finer than ~4.5 px
  across even with a perfect fit and no margin, and with the margins the guarantee needs,
  cells are 8–10 px at a tier's entry. Tick 13 recovered what the bound could give back
  without a longitude key (r5 0.22–0.25 zoom earlier on desktop, mid 0.11–0.13, r7/r8
  under 0.1; 1920×1080 at the equator now enters r5 at 5.20 with 8.0 px cells and r8 at
  9.44); beyond that, finer cells on desktop mean a higher cap. The cap was set when tiers
  drew sub-pixel prisms, and nothing since has been measured on a real GPU — a decision
  needs frame times at 120 k, 200 k and 300 k extruded cells on real hardware.
- (candidate, from tick 13's review — needs an owner go-ahead and a breakdown) Thresholds
  that know the longitude too. Tick 13 keeps a tier's threshold a function of canvas and
  latitude band by taking the worst longitude in the band, so every place pays for the
  icosahedron vertex nearest its latitude. Measured on 1280×800, weighing the window at
  the actual place instead would start r7 and r8 0.13–0.35 zoom earlier at typical cities
  (Tokyo 0.21 / 0.23, Delhi 0.27 / 0.28, New York 0.31 / 0.33, São Paulo 0.33 / 0.35,
  Lagos 0.13 / 0.13, Dalian — next to a vertex — 0), mid 0.06–0.29, r5 under 0.07 (its
  window is tens of degrees wide and averages the vertices out). Cost: a cache keyed
  latitude × longitude (86 × 72 cells at 5°, ~13 ms each cold, far more cold cells per
  pan than today), a second flap edge in longitude needing its own step-below-hysteresis
  proof, and placement handling for windows that straddle cells. The checker's view:
  worth it for r7/r8 only with coarse (~10°) cells warmed in idle time; not for r5.
- (small, from tick 13's review) `selectionCanvas.ts` `covers`: its docstring says a
  covering canvas's thresholds are never earlier; that holds only to within the search
  tolerance (one fuzzed pair, 1471×257 over 1126×263 at lat 70.86, is earlier by 0.00789
  zoom against a 1/128 tolerance — real cells there peak at 90.4 % of the cap, so the
  guarantee is not touched; the wording and the zero-tolerance test are). Say that
  `prefixRows` in `tierFit.ts` is bounded by construction (360 rows × 11.5 kB). Trim the
  unit suite: `npm test` went ~12 s → ~22 s; the monotonicity sweep can step 0.1 instead
  of 0.05 and the area-model test needs ~5 k cells per resolution, not 850 k in all.
- (to look at on a real machine) While a window is being resized, selection reads a canvas
  up to 1.25× larger than the real one, so a view just past a threshold can drop to the
  coarser tier during the drag and return ~250 ms after it stops. Cheap to change if it
  reads as a flicker: shorten `SETTLE_MS`, lower `GROW`, or hold the tier during a drag.
- **DECIDED 2026-11-18 — Option A: band the LOD tiers by on-screen cell size.** Measured
  against deck.gl 9.3's real `GlobeViewport` (1280×800, CSS px), each tier switched on ~3
  zoom levels before its cells were visible: an r6 hexagon was 0.38–0.47 px across at the
  mid tier's zoom 2.2 and an r8 hexagon 0.27–0.33 px at 4.5 (1.5–1.9 px at the old maximum
  zoom of 7). Drawing sub-pixel prisms put far more cells on screen than the 120 k cap
  allows — the root of the r8 "patch" at zoom 4.6 (`tokyo-z4.60.png` in any gate run before
  the change), the mid tier's truncated disc, the top-k popping and the seam at each
  crossing. The rule now: a tier starts where its hexagon is ~3 px across; r5 and r7 are
  H3-parent aggregations of the committed r6 / r8; the maximum zoom goes to 10 so a 400 m
  cell is ~12 px. The five queue items above carry it out in order. Not chosen — Option B:
  keep the bands and patch the symptoms.
- (re-assess once Option A has landed — likely moot without top-k truncation) Cull-boundary popping: `cullForView` swaps its 120 k top-k set on each re-cull, so
  cells blink in/out at the window edge during a pan. Fade newly-added cells in over
  ~150 ms, or widen the scan window and stabilize the selection between adjacent cull
  keys (`lib/lod.ts`).
  Accept: a unit test over a scripted pan at z 3–5 on a dense synthetic tier shows the
  rendered set changing by no more than the cells entering/leaving the window between
  adjacent cull keys (no interior churn), with the cap and highest-density semantics
  preserved; a qa:render frame diff of a z 3–5 pan shows no blinking cells.
  Gate: verify, qa:render.
- (re-assess once Option A has landed — each tier step becomes 7× in area, not 49×) LOD cross-fade: with encoding now continuous across tiers (density domain +
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
- [x] Tile-stream loose ends: two small defects the tick-1 checkers found in
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
      *(Done 2026-11-17, factory tick 5: (1) a failure continues a burst only if the
      previous one is inside the cool-down and under the bound, otherwise it starts a
      fresh burst — the same boundary `tileEligible` uses; (2) `TileStream` remembers the
      visible set of the latest `loadVisible` and every eviction protects it, read when
      the tile arrives rather than when its run started. The hook did not need to change.
      Evidence: 10 new tests (9 fail on the old module); the 15 existing cases are
      byte-for-byte unchanged; the checker's own interleavings pass, including a 150-step
      pan with late arrivals from every earlier view (cache stays bounded, ends ≤ 64) and
      A → B → A with A's first run still in flight. Gate green: 135 tests, qa:render PASS,
      0 console errors. Headless re-runs by the orchestrator: `tile_fail.mjs` PASS
      (52,306 r8 cells with the Tokyo tile aborted) and `--fail-times 1` PASS (the tile
      recovers, 65,892 cells) — the recovery case is now first-hand. Checker PASS first
      time. Known, bounded: a stale prefetch can hold the cache above its cap by its old
      protect set until the next eviction; an attempt that starts just inside the
      cool-down and fails after it continues the old burst.)*
- [x] Cache H3 cell boundaries across re-culls: measured on the real mid tier, a re-cull
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
      *(Done 2026-11-17, factory tick 6: the population layer (`src/layers/populationLayer.ts`)
      now renders, without the wrapper, the `PolygonLayer` that `H3HexagonLayer` rendered on
      the GlobeView — per-cell true geometry, no instanced columns — with `getPolygon`
      served from `BoundaryCache` (`src/lib/h3Boundary.ts`): a bounded LRU keyed on the
      packed 64-bit H3 index, flat typed storage, hard cap 2^18 cells ≈ 32 MB. The old path
      ran `cellToBoundary` three times per cell per rebuild, plus a `getResolution` /
      `isPentagon` pass that is also gone. Sent back once: dropping the wrapper lowered the
      fill sublayer's index in deck.gl's layer tree by one, which changed its default depth
      bias — the orchestrator's pixel diff found 31–45 of 504,000 pixels changed at the r8
      shots (thin column slivers losing to the land fill) and the checker traced it;
      `getPolygonOffset` now compensates, pinned by a test on deck.gl's own index resolver.
      Evidence — Node bench on the committed mid tier (`node scripts/bench/boundary_bench.mjs`,
      adjacent cull windows sharing 97–98 % of their cells; it times two of the old path's
      three calls, so it understates the gain): repeat-cull boundary cost India z2.5
      534 → 45 ms (11.8×), Tokyo z3.5 463 → 26 ms (17.7×); whole tessellation 707 → 145 ms
      and 621 → 106 ms; cold cache 2.2× (checker's run; the maker and the first checker got
      11.9–18.7×). Geometry bit-identical to deck.gl's `h3ToPolygon` + `flattenPolygon` on
      9,594 real and hard cells (antimeridian, poles, pentagons, > 6-vertex cells), cold,
      warm and after eviction; real `PolygonTesselator` output byte-identical; the LRU
      fuzzed against a Map model at capacities 1 … 4×pool with 0 failures; 360° pans peak at
      exactly the cap. **Render pixel-identical to the old path at both r8 shots (0 of
      504,000 pixels differ).** Gate green: 146 tests, qa:render PASS, 0 console errors.
      Two independent checkers PASSed. Not verified: browser main-thread timing (Node/V8
      only) and a real GPU. Known: the cache holds ~32 MB for the session once the first
      population layer is built; `useGlobeLayers` still rebuilds the layer on every zoom
      frame and drag start/stop (a new `data` object each build) — the rebuilds are now
      cache hits, but a stable data object would remove them and is worth an item.)*
- [x] Stop re-tessellating the columns on every zoom frame: `useGlobeLayers` rebuilds the
      population layer inside a `useMemo` that depends on `elevationScale` (a new value on
      every zoom frame) and `isDragging`, and `buildPopulationLayer`
      (`src/layers/populationLayer.ts`) hands deck.gl a fresh `data: { length }` object on
      each build. deck.gl diffs `data` by reference, so every zoom frame and every drag
      start / stop is a full data change: all 120 k polygons are fetched and tessellated
      again (≈ 110–150 ms of main-thread JS per frame even with the boundary cache warm,
      ≈ 620–710 ms before it — `scripts/bench/boundary_bench.mjs`), although only a uniform
      (`elevationScale`) or a flag (`pickable`) changed. The comment in the layer already
      claims "a zoom change costs one uniform write"; make it true: keep the `data` object
      (and anything else deck.gl compares by identity) stable for as long as the cull is
      unchanged, so a zoom frame updates `elevationScale` only. Found by the tick-6 maker.
      Accept: unit tests on real deck.gl layer instances prove (a) two builds that differ
      only in `elevationScale`, or only in `pickable`, share the same `data` object and
      report no data change and no `getPolygon` / `getElevation` / `getFillColor` trigger
      change when diffed the way deck.gl diffs props (use deck.gl's own prop diff, not a
      re-implementation); (b) a build after the cull key or the tier changed does report a
      data change; (c) hover still maps `info.index` through the current cull indices after
      a zoom-only update (no stale closure over an old cull); and (d) a count of
      `getPolygon` calls across a scripted zoom of 30 frames inside one cull key is 0 after
      the first build (it is 30 × 3 × cells today) — reported before and after.
      Gate: verify, qa:render.
      *(Done 2026-11-17, factory tick 7: `buildPopulationLayer` now hands deck.gl one
      `{length}` container per (tier object, cull indices), held weakly, instead of a fresh
      one per build; the hook did not need to change. A zoom frame therefore diffs as
      `elevationScale` only and a drag start / stop as `pickable` only, while a re-cull, an
      r8 tile merge, a tier switch or a density-domain change still forces the full update.
      Evidence: 4 tests on real deck.gl layer instances through deck.gl's own `diffProps`
      and update path — a 30-frame zoom inside one cull key costs 0 `getPolygon` calls, was
      13,500 for 150 cells (30 × 3 × cells; re-measured by the checker: 13,500 → 0 and
      16,920 → 0 on a whole tier). In the real page (`node scripts/qa/zoom_rebuild.mjs`,
      run by the orchestrator on the 120 k-cell mid tier): 10 zoom-only frames → 0
      re-tessellations, same data object, `elevationScale` 245,459 → 260,445; an 18° pan →
      exactly 1, new data object; 0 console errors. Gate green: 150 tests, qa:render PASS,
      the r8 screenshots still pixel-identical. Checker PASS first time. Not measured: the
      frame-time saving in ms on real hardware — the item's 110–150 ms figure is the Node
      cost of one rebuild, which each zoom frame no longer pays.)*
- [x] Re-band on on-screen cell size — r5 tier, new bands, zoom to 10: step 1 of Option A.
      (a) Pipeline: add an r5 tier as the H3-parent aggregation of the committed r6 tier —
      a new `pipeline/build_parents.py`, vectorized (DuckDB SQL for the aggregation; the
      parent by H3 bit arithmetic or an H3 extension; lng/lat = the parent's H3 cell
      center from a vectorized H3 library — no Python row loops), the same Parquet schema
      as every other tier (`h3, population, lng, lat`), written to `public/data/r5.parquet`
      with a manifest entry and wired into `npm run data`. Checked feasible 2026-11-18 with
      PyPI packages only (`duckdb`, `h3`, `h3ronpy`, `pyarrow`; the DuckDB community-
      extension host is not reachable from the cloud session): 393,791 r5 cells,
      Σ = 8,031,924,024 exactly, and the parent computed by bit arithmetic in plain DuckDB
      SQL equals `h3.cell_to_parent` on 20,000 sampled cells. Record the Python
      requirements where `docs/data.md` describes a refresh.
      (b) Bands: the pipeline's tier table is the one place band constants live
      (`build_lods.py` `TIERS`, `build_tiles.py` `MIN_ZOOM`); move it to the rule "a tier
      starts where its hexagon is 3 CSS px across flats at the equator". On deck.gl's
      GlobeView px per km = 512·2^zoom / (2π·6371·cos lat), which puts the thresholds near
      zoom 3.78 (r5), 5.18 (r6) and 7.99 (r8); r4 runs below, and until the r7 item lands
      r6 runs to 7.99. Derive the numbers from that model and verify the model against
      `GlobeViewport` in a unit test — do not type them in. Client selection is already
      driven by the manifest, so it follows.
      (c) `MAX_ZOOM` 7 → 10 (`src/lib/camera.ts`), so an r8 cell is ~12 px at full zoom.
      Then walk everything that assumed 7 or the old 2.2 / 4.5 bands and move it: the zoom
      ladder in `Controls.tsx`; the search fly-to default zoom (5 "so r8 streams in");
      `maxColumnHeightM` over zoom 7–10 (report the tallest column in metres and in px at
      zoom 5, 7, 8.5 and 10, and retune the profile if columns vanish — it must stay
      continuous in zoom); any UI copy that names a zoom or a tier; the unit-test fixture
      manifest; the headless scripts that navigate by zoom (`scripts/qa/tile_fail.mjs`
      needs an r8 view, `scripts/qa/zoom_rebuild.mjs` a culled tier); and the plans in
      `scripts/qa/render_qa.mjs` — samples and crossings must follow the new bands and
      cover every tier that can render, with `--quick` kept under ~9 min.
      (d) `scripts/verify_data.mjs` covers r5: Σ, cell count, file size, CRS bounds, every
      r5 cell is the H3 parent of at least one r6 cell, every r6 cell's parent is present,
      and each r5 population equals the sum of its r6 children.
      (e) Docs that name the tiers, bands, sums or zoom range say the new truth:
      `docs/architecture.md`, `docs/data.md`, `VISION.md`, `README.md`, and the tier sums
      in `CLAUDE.md`'s invariants (this item may edit that paragraph).
      Accept: (1) `npm run verify:data` ALL PASS with r5, and it fails when r5 is tampered
      with (a dropped row; one changed population) — show both; (2) a unit test computes
      the bands from the projection model and they equal the manifest's within 0.02 zoom,
      and the model's px/km is within 1 % of `GlobeViewport`'s at lat 0 / 45 / 70 and zoom
      2–10; (3) unit tests on the real band table: zoom 3 → r4, 4.5 → r5, 6 → r6, 9 → r8,
      hysteresis intact at each threshold; the density domain is unchanged (the r8 peak,
      55,163 people/km²) with the r5 maximum normalizing below 1; column height continuous
      across every threshold up to zoom 10; (4) render gate green on the new plan: every
      tier in the plan is reached, ≤ 120 k cells, 0 console errors, and the r8 sample is
      at a zoom where r8 is the wanted tier; (5) the headless checks pass at their new
      zooms (`tile_fail.mjs` in both modes, `zoom_rebuild.mjs`).
      Gate: verify, qa:render, verify:data.
      *(Done 2026-11-18, factory tick 8, Option A step 1. Bands now come from one rule in
      one place — `pipeline/tiers.py`, "a tier starts where its hexagon is 3 CSS px across
      flats at the equator", computed from the H3 mean areas — and reach the client through
      the manifest: overview (r4) below 3.78, r5 3.78–5.18, mid (r6) 5.18–7.99, r8 from
      7.99; `MAX_ZOOM` is 10. `pipeline/build_parents.py` builds r5 from the committed r6
      (parent by H3 bit arithmetic in plain DuckDB SQL, centers from `h3ronpy`, no row
      loops; 0.3 s, byte-identical across runs) and re-bands the manifest;
      `pipeline/requirements.txt` lists what it needs. Whole tiers now load only once their
      band is reached, the search fly-to lands at the r8 band + 0.5 (8.49), and the column
      height has a 1 km floor above zoom ≈ 8.07 so r8 columns do not flatten to 2 px at
      zoom 10 (still continuous; nothing changes at zoom ≤ 8).
      Evidence: r5 = 393,791 cells, 6.43 MB, Σ = 8,031,924,024 exactly, every population an
      integer below 2^24; the checker rebuilt r5 independently with the H3 library (same
      cells, 0 population mismatches, centers within 7.6e-6°), re-ran the pipeline in a
      scratch copy (byte-identical `r5.parquet`, manifest identical but for `generatedAt`
      — not hand-edited) and re-derived the bands from `GlobeViewport` (3.779 / 5.182 /
      7.990; model error 7e-5). `verify:data` ALL PASS in ~22 s and fails under five
      tamperings (dropped row, changed population with Σ kept, non-integer population,
      wrong parent, non-contiguous band). 173 unit tests. Render gate green in 188 s (was
      ~400 s): overview 71,283 cells, r5 and mid reached at their crossings, r8 38,298
      cells at zoom 9, 0 console errors, worst stall 17.8 s (was ~40 s). Headless checks
      re-run by the orchestrator at the new zooms, all PASS: `tile_fail.mjs` (r8 at 8.99,
      24,712 cells with the Tokyo tile aborted), `--fail-worker`, `zoom_rebuild.mjs` (r5,
      0 re-tessellations over ten zoom frames). Entry chunk 219.78 → 220.16 kB.
      The checker returned FAIL for one reason only — it could not see those three headless
      runs — and no code finding above minor; the runs above close it.
      Not verified: `build_lods.py` / `build_tiles.py` end to end (the Kontur source and
      the DuckDB extension hosts are unreachable here; import-checked and read only), and
      how the 1 km floor looks on a real GPU.
      Known, and why it is not finished yet — measured by the checker on 1280×800: the
      old cull radius still covers only 39–57 % of the canvas at the r5 and r6 entry zooms
      and the r8 tile disk 76–80 % at zoom 8 (100 % from zoom 9); those are the next two
      items. r5's lng/lat is the H3 cell center, the Kontur tiers' the reprojected polygon
      centroid — used for the cull only. The ladder labels r5 "9 km" (8.5 rounded).)*
- [x] Cull window from the real footprint: `cullForView` sizes its window from
      `halfSpanDeg = min(60, 180/2^zoom)`, which matches neither the canvas nor latitude.
      Measured against `GlobeViewport` on 1280×800: at zoom 5.5 the screen edge is 10.5°
      from the center at the equator (12.7° to a corner) against a window of 6°, so a
      culled tier draws a disc about half as wide as the screen; at 70° N the same screen
      reaches only 3.5° and the window over-selects. Add `src/lib/footprint.ts`: a tested
      model of what GlobeView shows for a view and a canvas size — use deck.gl's
      `GlobeViewport` itself (unproject the canvas border; the limb bounds it when the
      globe is smaller than the canvas) or a closed form verified against it. Put the
      canvas size in the store (a resize updates it). The cull then keeps what falls
      inside the canvas rectangle grown by the re-cull margin — not a circle drawn around
      it: a cap around a 16:10 canvas is ~3× its area and would spend the 120 k cap off
      screen. Keep tick 4's rule: a cull's window is a function of its key and covers
      every view on that key (position and zoom drift), with canvas size now part of the
      key.
      Accept: (a) unit tests against `GlobeViewport` for 1280×800, 1920×1080 and 375×812
      at lat 0 / 45 / 70 / 85 over zoom 3.8–9: on an equal-area synthetic tier, every
      front-facing cell that projects inside the canvas is selected, for the triggering
      view and for sampled views sharing its key, whenever the selection is under the cap;
      (b) tightness: the selection is ≤ 2.5× the on-screen count; (c) a Node script under
      `scripts/bench/` on the committed r5 and r6 tiers reports, at each tier's entry zoom
      over India, Tokyo, Lagos and São Paulo on 1280×800 and 1920×1080, on-screen cells vs
      selected vs the cap — coverage is 100 % wherever on-screen ≤ 120 k, and every view
      where on-screen exceeds 120 k is listed (it feeds the latitude/canvas item below);
      (d) a canvas resize changes the cull key; (e) cull cost on the 2 M-cell r6 tier
      within 2× of before, both numbers reported; (f) the gate's r5 and r6 screenshots
      show columns out to the screen edges; (g) the stale-coverage test in `lod.test.ts`
      sweeps the zooms culled tiers actually run at now (3.6–10), not 2.05–4.65.
      While in the render harness, since (f) is read off its screenshots: dismiss the
      first-run cue before capturing (it covers the middle of every shot), read the
      maximum zoom from the app instead of retyping `MAX_ZOOM = 10`, fix the header's
      count of sampled states, and make a budget-truncated run fail the "every planned
      tier was reached" check instead of skipping it.
      Gate: verify, qa:render.
      *(Done 2026-11-18, factory tick 9, Option A step 2. `src/lib/footprint.ts` is a pure
      closed-form model of deck.gl's GlobeViewport (perspective camera, the 85.05° latitude
      clamp, the limb) — no deck.gl or h3-js import, so the entry chunk is unaffected
      (220.16 → 220.31 kB). The cull keeps the canvas rectangle as projected, grown by the
      drift margin of its re-cull bucket and cut at the horizon, tested per cell with three
      dot products on cached float32 unit vectors. The key is `lod:WxH:iy:ix:zq` — view
      center in Web Mercator steps of 1/6 of the canvas's shorter side (GlobeView scales
      like Mercator, so a step is the same share of the screen at every latitude), zoom in
      steps of 1/8. The canvas size reaches the cull from DeckGL's `onResize` via the store.
      Evidence: the model agrees with GlobeViewport to < 0.01 px over 5,000+ points with 0
      on/off-screen mismatches over ~24 k; the checker's own oracle (deck.gl's `project`
      plus a front-facing test) over 900 triggering views — 5 canvases incl. 2560×600,
      lat 0/±45/±70/±84/89.9, lng ±180, zoom 3.63–10 — and their same-key neighbours found
      0 on-screen cells missing under the cap; tightness 1.8–2.5× at zoom ≥ 3.78. The old
      cull missed 54–86 % of on-screen cells at the same views. On the committed tiers
      (`node scripts/bench/cull_coverage.mjs --hysteresis`): 100 % coverage wherever
      on-screen ≤ 120 k, three rows re-derived by the checker. Cull cost on r6: mean of
      medians 3.80 ms, was 4.63 (0.52–1.38× per view); first cull of a tier 63 ms (r6) /
      40 ms (r5) to build the vectors. Render gate green (196 tests, 220 s, 0 console
      errors). Seen by the orchestrator at 1280×800 over India: r5 at zoom 4.2 (63,661
      cells) and r6 at zoom 5.6 (67,155 cells) fill the screen edge to edge; headless
      `zoom_rebuild.mjs` and `tile_fail.mjs` pass. Harness: the first-run cue is dismissed
      before capture, the max zoom is read from the app, a budget-truncated run fails the
      tier-coverage check. Checker PASS first time.
      What the bench found, and it sets up the last item — views with more than 120 k
      cells ON SCREEN at a tier's entry zoom: r5 at 3.78 on 1920×1080 over India 172,098
      and Lagos 132,792; r6 at 5.18 on 1920×1080 over Lagos 155,672 and São Paulo 123,189;
      and inside the hysteresis band, r5 at 3.63 on 1280×800 over India 132,937 (on
      1920×1080: 195,751).
      Known: (1) while the window holds more than the cap, which cells are kept depends on
      the view that triggered the cull, so another view on the same key can miss 3–7 % of
      its on-screen cells at its leading edge (r5 Lagos z3.78 1280×800: 7,701 of 113,789)
      — the selection item must budget for the window, not just the screen; (2) tightness
      reaches 2.51–2.59× inside the r5 hysteresis band (z3.63); (3) the unit vectors hold
      ~29 MB for the session once r5 and r6 have been culled, built on the main thread;
      (4) every resize frame re-culls (no debounce); zoom re-culls twice as often as
      before (1/8 steps), pans about half as often at the equator; (5) r5 re-culls cost up
      to 12.6 ms at its entry views (was 1.4) because it now selects 120 k cells where the
      old window took 25 k; (6) the first-run cue is no longer mounted during render QA.
      Not verified: frame cost of the extra cells on a real GPU.)*
- [x] Tile streaming for any tiled tier, tiles chosen from the footprint:
      `useTileStreaming` and `selectActive` hard-code `'r8'`, the store has a single
      `r8Data`, and `lib/tiles.ts` picks tiles with a `gridDisk` whose radius is
      `halfSpanDeg / parentEdgeDeg` — and that table is ~6× too large (r3 listed as 3.4°;
      the real mean edge is 59.8 km ≈ 0.54°), so the disk is too small on a wide canvas (at
      zoom 8 a 1920×1080 screen spans about ±2.6° × ±1.5° at the equator; k = 1 reaches
      ~1.4°). Generalize: one `TileStream` per tiled manifest entry with its own cache and
      retry state, merged data per tier in the store, and a selection that walks from the
      wanted tier down to the finest tier that has data, so the tier already on screen
      keeps drawing while the next one's tiles load. Tiles = the parent cells (at the
      entry's `tileParentRes`) that intersect the footprint, plus the prefetch ring.
      While in the render harness: it now seeds the first-run cue as already seen, so
      `FirstRunCue` is never mounted under the gate and an error in it would go unnoticed —
      mount it once and dismiss it through its own button before the first capture.
      Accept: unit tests prove (a) for 1280×800, 1920×1080 and 375×812 at zoom 8–10 and
      lat 0 / 45 / 70, every r3 parent whose cell overlaps the canvas footprint is
      selected, and the visible set plus the prefetch ring fits the 64-tile cache; (b) the
      same code selects r2 parents for an entry declaring `tileParentRes: 2`; (c) with the
      wanted tiled tier still loading, the previously drawn tier is the one selected, and
      a cold deep-link falls back to the finest tier that is loaded; (d) the existing
      tile-stream tests pass; (e) headless `tile_fail.mjs` passes in both modes, and at a
      1920×1080 r8 view the gate screenshot shows columns to the screen edges.
      Gate: verify, qa:render.
      *(Done 2026-11-18, factory tick 10, Option A step 3. Tiles are now the parents whose
      cells overlap the cull's own window for the cull's own re-selection key
      (`selectParents` in `src/lib/tiles.ts`: a flood fill over neighbours, each cell's
      edge arcs tested exactly against the window's planes), so "visible" means one thing
      across the render path and every view sharing a key has its tiles. Each tiled
      manifest entry gets its own stream, cache and timers (`useTileStreaming`); the store
      holds `tiles: Record<lod, TileSet>` instead of a single `r8Data`; `selectActive`
      walks from the wanted tier down to the finest tier that has data for THIS view, so
      the tier on screen keeps drawing while the next one's tiles load and a pan never
      shows another view's tiles as this one's. Nothing in `src/` names a tier any more.
      Two send-backs, one per oracle (the contract was amended to allow exactly that —
      `c442c5a5`): the gate went red on the new first-run-cue step in the render harness (a
      wall-clock wait that the software rasterizer outlasted; it now waits on the app
      state that makes the cue due), and the first checker FAILed Accept (a) with
      counterexamples — the overlap test sampled each cell boundary at a few points, so on
      a small ground footprint (narrow canvas, zoom 9.5–10, high latitude; Svalbard on a
      phone) an on-screen tile could be skipped: 149 misses in 20,000 random views.
      Evidence after the fix: a fresh checker's own deck.gl oracle found 0 missed parents
      in 63,140 structured r3 views (5 canvases incl. 320×568 and 2560×1080, 25 latitudes
      to the 85.05° clamp, antimeridian, pentagons, same-key neighbours), 24,000 random r3
      views, 30,570 structured and 6,000 random r2 views, and the earlier checker's own
      20,000-view sweep; the overlap test matched a brute force on 30,704 (cell, window)
      pairs with 0 false negatives and 0 false positives. The old disk loaded 7 of the 20
      r3 parents on screen at zoom 8 on 1920×1080. Visible / kept tiles at zoom 8: 12 / 29
      (375×812), 29 / 51 (1280×800), 51 / 64 (1920×1080, prefetch ring cut to fit). 223
      unit tests; the 25 original tile-stream tests unmodified. Render gate green: r8 at
      zoom 9 draws 50,972 cells on 900×560 (38,298 before), 0 console errors, the cue
      mounted and dismissed through its own button. Seen by the orchestrator at 1920×1080
      over Delhi, zoom 8.05: r8 hexagons to every screen edge, 28 parents, 371,827 merged
      cells. Headless `tile_fail.mjs` re-run by the orchestrator on the final tree: PASS in
      default mode (22,564 cells with the Tokyo tile aborted), `--fail-times 1` (36,150
      after recovery) and `--fail-worker`.
      Known: at that Delhi view 120,000 of the on-screen cells are drawn — the cap binds
      on a 1920×1080 canvas at r8's entry zoom, visibly, as speckle where low-density
      cells are dropped (the selection item); on 2560×1080 the visible set alone exceeds
      the 64-tile cache at r8's and r2's entry zooms (62–77 tiles; protected from
      eviction, nothing drawn wrong); off its own key the "tiles cover this view" check
      samples the canvas border every 16 px; a 1280 px pan at zoom 8 over a dense area
      costs 7–9 merges and ~50–60 MB of allocation. Not verified: the r7 + r8 two-stream
      path in a browser (no r7 data yet — unit-tested on a synthetic manifest), and
      pan smoothness on a real GPU.)*
- [x] r7 tier, tiled by r2 parents: between r6 and r8 a cell otherwise grows from 3 px to
      21 px before the 49× jump to r8. Pipeline (`pipeline/build_parents.py`): aggregate the
      committed r8 tiles to their r7 parents (same vectorized method and schema as r5),
      partition by r2 parent into `public/data/tiles/r7/` with an `index.json` like r8's
      (r2 keeps a 1280×800 screen at the band's entry zoom within ~20 tiles; r3 would need
      over 60), manifest entry with the band from the 3-px rule (≈ 6.59–7.99; r6 then ends
      at 6.59). `verify:data` covers it: Σ, counts, every file < 100 MB, tile ↔ parent
      roll-up, r7 ↔ r8 children sums. `scripts/verify_live.mjs` (the post-deploy gate)
      checks every tier the manifest lists instead of a fixed overview / mid / r8 — it has
      ignored r5 since that tier shipped. Client: nothing but the tier table should need
      to change after the previous item — if more does, say what and why.
      Accept: (1) `npm run verify:data` ALL PASS with five tiers and fails under tampering
      (a deleted tile; a mislabelled parent); Σ r7 = Σ r8; (2) total added data and the
      largest tile reported, every file < 100 MB, and the published site still under
      GitHub Pages' 1 GB limit with the figure stated; (3) unit tests: zoom 7.2 → r7 on the
      real band table, r6 → r7 → r8 crossings keep hysteresis, column height continuous;
      (4) render gate green with an r7 sample and both crossings; ≤ 120 k cells; 0 console
      errors.
      Gate: verify, qa:render, verify:data.
      *(Done 2026-11-18, factory tick 11, Option A step 4. `pipeline/build_parents.py` now
      builds r7 as well as r5: it reads exactly the r8 tiles the r8 index lists, sums them
      into their H3 parents (bit arithmetic in plain DuckDB SQL, centers from `h3ronpy`, no
      row loops), and writes `public/data/tiles/r7/parent=<r2>/data_0.parquet` with an
      index in the r8 format; `pipeline/tiers.py` gained one table row and the band fell
      out of the 3-px rule. Bands: overview −2–3.78, r5 3.78–5.18, mid 5.18–6.59, r7
      6.59–7.99, r8 from 7.99. `verify_data.mjs` checks every tiled tier the same way and
      proves r7 against r8 one r2 tile group at a time (which also checks every r8 cell's
      r3 placement, not a 600-tile sample); `verify_live.mjs` walks whatever tiers the
      manifest lists. The client needed only the tier table plus the zoom ladder growing
      from 128 to 160 px so five labels stay ≥ 20 px apart.
      Evidence: r7 = 9,012,014 cells in 2,409 tiles, Σ = 8,031,924,024 = Σ r8, max 281,504,
      every population a whole number below 2^24. The checker rebuilt it independently from
      all 32,957,699 r8 rows with an H3 library (same cells, every population equal, every
      cell in the tile of its true r2 parent; five populated r2 tiles are pentagons and are
      selected correctly), re-ran the pipeline twice in a scratch copy (all 2,410 files
      byte-identical to the tree and to each other; manifest identical but for
      `generatedAt`), re-derived the bands (6.5861, 7.9898), and tampered seven ways —
      deleted r7 tile, relabelled tile with and without a fixed-up index, a cell moved to
      a neighbouring tile, ±100 on two populations with Σ preserved, index and manifest
      sums raised together, a deleted r8 tile — every one caught. `verify:data` ALL PASS in
      ~51–58 s (was ~22 s), peak ~0.85 GB. 226 unit tests. Render gate green in 373 s with
      all five tiers reached: r7 21,223 cells at zoom 7.29, r8 50,972 at zoom 9, both
      crossings, 0 console errors. Headless (maker's runs): `tile_fail.mjs --tier r7
      --zoom 7.2` PASS (r7 active, 16,647 cells with a tile aborted) and the r8 default.
      Checker PASS first time.
      Sizes: +141.2 MB (140.9 MB of tiles, largest 281 kB, plus a 271 kB index) — more than
      the ~90 MB guessed, because r8 averages only 3.66 populated cells per r7 parent.
      `public/` is now 684 MB and `dist/` 686 MB, 68.6 % of GitHub Pages' 1 GB limit; a data
      refresh adds ~643 MB of tile blobs to git history.
      Not verified: `verify_live.mjs` against a deployment (checked against a local static
      server of `dist/`, which does not gzip); both tiled streams publishing at the same
      moment in a browser beyond the render gate's r7 → r8 crossing.
      Known: `verify_live.mjs` no longer asserts that any particular tier exists, so a
      deployed manifest that had lost r8 would pass (noted on the CI item); the 512-person
      Σ tolerance, which pre-dates this, also applies to r7 although its sum is exact.)*
- [x] Tier selection that follows latitude and canvas size: the bands are zoom thresholds
      at the equator on a nominal canvas, but GlobeView scales by 1/cos(lat) — at 60° N a
      cell is twice as wide on screen as the band assumes — and a larger canvas holds more
      cells: at the 3-px threshold a fully populated 1920×1080 view is ~266 k cells, over
      twice the cap, so top-k truncation returns on exactly the big desktop screens this
      portfolio piece is judged on. Select by on-screen cell size at the view center
      instead: the finest tier whose hexagon is at least max(3 px, √(canvas px ÷ (0.866 ×
      a cell budget))) across, from the footprint model, with hysteresis kept. The budget
      is not the cap: the cull keeps a margin around the screen (window ÷ on-screen was
      1.2–1.9× on the committed tiers, up to 2.5× on a synthetic one), and while the window
      exceeds 120 k the cells kept depend on the view that triggered the cull — another
      view on the same key then misses 3–7 % of its on-screen cells. So budget the WINDOW
      under the cap (or shrink the margin and say what that costs in re-culls), and make
      what is kept past the cap a function of the key alone. The bench's current offenders
      are listed in the cull item's Done note. Since selection now depends on the canvas,
      a window drag must not re-select and re-cull on every resize frame (today each one
      re-culls and re-tessellates): quantize or debounce the canvas size. A very wide
      canvas (2560×1080) also puts more tiles on screen than the 64-tile cache holds at a
      tiled tier's entry zoom (62–77); canvas-aware bands should bring that back under.
      The manifest's zoom bands stay as the nominal (equator, 3 px) values and a test pins
      them to the model. Also load a whole tier only when it is wanted or about to be —
      today every whole tier below the zoom is fetched, so a deep-link to zoom 9 would
      download r5 and the 31 MB r6 for nothing — and start that load shortly before the
      band so the crossing does not wait on it. (Tick 8 already narrowed the loader to
      the finest whole tier whose band is reached; what is left: a search fly-to from the
      hero still fetches and decodes every tier it merely passes through — r5's 6 MB
      competes with the 31 MB r6 and the r8 tile burst mid-flight — and a cold deep-link
      into the r6 band shows 22 km cells until the 31 MB file decodes, where the 6 MB r5
      would arrive far sooner as an intermediate.)
      Accept: unit tests prove (a) at one zoom the selected tier steps finer as latitude
      rises, at the latitude the model predicts, and coarser as the canvas grows; (b) at
      the equator on a canvas small enough that the budget does not bind (the render
      harness's 900×560) selection equals the manifest's nominal bands, and on 1280×800
      and 1920×1080 each threshold moves later by exactly what the budget formula gives —
      the shift stated in zoom and in px, and pinned by the test (a 1280×800 canvas over
      India already holds 105 k cells on screen and a 160 k window at r5's nominal entry,
      so it cannot keep the nominal bands and fit the cap);
      (c) no flapping: a view parked on a threshold in zoom, latitude or canvas size does
      not alternate tiers; (d) a cold deep-link to zoom 9 requests no whole tier other than
      the overview, and approaching a whole tier's band from below requests it before the
      threshold; (e) the bench from the cull item, re-run: no listed view exceeds the cap
      on 1280×800 or 1920×1080; (f) a fly-to from the hero to a city requests only the
      tiers it will stop in or fall back on, not every tier it crosses; (g) on the
      committed tiers, for every bench view and sampled views sharing its key, 0 on-screen
      cells are missing — the window fits the cap; (h) dragging the canvas from 1280×800
      to 1300×820 in 1 px steps re-culls at most a handful of times, not once per step.
      Gate: verify, qa:render.
      *(Done 2026-11-19, factory tick 12, Option A step 5 — with the specification amended
      during review, so read this note over the criteria above where they differ.
      What shipped: `src/lib/tierBands.ts` selects, per view, the finest tier whose
      threshold is passed, where a tier's threshold is the LATER of the 3-px rule moved by
      log2(cos lat) and "the cull window fits the cap" (`src/lib/tierFit.ts`): the ground
      area of the window the cull would use — the canvas grown by the re-cull drift, cut
      at the horizon — × 1.03 ÷ (0.6 × the mean H3 cell area), judged 0.15 zoom below the
      threshold so a tier held by hysteresis fits too, at the worst bucket alignment.
      Thresholds are cached per 16-px canvas key and 1° latitude band and warmed in idle
      time. The loader plans for where the camera is going (`flyTarget` while flying):
      each whole tier 0.5 zoom before its band, a 6 MB r5 interim under the 31 MB r6, no
      whole tier under a tiled one, nothing for bands a flight only crosses. Past the cap
      the kept cells are a function of the cull key alone (a safety net the committed data
      no longer reaches). The cull key rounds the canvas up to 16 px, with a window proven
      to cover every canvas on the key. The zoom ladder, DataStatus, tile streaming, the
      search arrival zoom, the render harness and the bench all read the same selection.
      How it got there: the first cut used a flat 65 k on-screen budget and met every
      criterion as written; the checker's scan (5 canvases × 3,408 view centres × 4 tiers
      × threshold / held) then found 2,518 of 102,240 cases with the window over the cap —
      r5 across Kazakhstan, Central Asia, the Russian plain, Iran and Punjab, worst
      178,800 — and, because past-the-cap selection had been made key-only as this item
      asked, the triggering view itself missing 1–4 % of its edge cells there. A lower
      budget did not close it (the limb is inside r5's window; a flat estimate cannot see
      that), so criteria (b), (e) and (g) were replaced: the window must fit by
      construction, the nominal bands hold only where nothing moves them, and the scan
      replaces the hand-picked bench views.
      Evidence: `node scripts/bench/cull_coverage.mjs --scan` — 136,320 views, 0 windows
      over the cap (largest 78,283), 36,091 views checked against deck.gl with 0 on-screen
      cells missing, 0 over the 64-tile cache. The second checker, independently: the
      bound peaks at 0.999 of the cap over every latitude to the clamp and every bucket
      alignment; REAL H3 cells counted in 1,160 worst-case windows peak at 93 % of the cap
      (111,683, next to a pentagon); its own data scan found 0 over the cap and 0 missing
      in 133,519 checked views; 253,440 jitter runs on thresholds, band edges and
      canvas-key edges with 0 flaps; loader sequences re-driven on 5 canvases. 314 unit
      tests; render gate green with all five tiers reached and 0 console errors. Seen by
      the orchestrator on the first cut at 1920×1080 over Delhi: r8 with nothing truncated
      where zoom 8.05 used to draw 120,000 of 371,827 cells as speckle.
      Thresholds now (zoom; cell px at entry) — 900×560 at the equator: r5 4.42 (4.7), mid
      5.69 (4.3), r7 7.06 (4.2), r8 8.45 (4.1); 1280×800: 4.91 (6.6), 6.19 (6.0), 7.56
      (5.9), 8.95 (5.8); 1920×1080: 5.44 (9.5), 6.71 (8.6), 8.06 (8.3), 9.45 (8.3);
      375×812: 3.98 (3.4), 5.30 (3.3), 6.68 (3.2), 8.07 (3.2). Nominal bands hold only at
      the equator on canvases up to about 360×640.
      The cost, stated plainly: the guarantee is conservative. On 1920×1080 every tier
      starts about 1.5 zoom later than the 3-px rule — r4 cells reach ~23 px before r5
      takes over — and about 1 zoom later on 1280×800. Of that, the uniform 0.6 cell-area
      floor costs 0.28–0.37 zoom, the hysteresis allowance 0.15, the drift margin and key
      rounding ~0.35, and ~0.57 on 1920×1080 is unavoidable under a 120 k cap. The fullest
      window in the committed data is 65 % of the cap. Recovering detail is the next
      queue item; the cap itself is an owner decision (Backlog).
      Also known: a cold latitude band costs ~12 ms on the frame that first needs it; a
      window drag crosses a new canvas key every 16 px and each computes cold thresholds
      (~40 hitches of 12–25 ms from 1280 to 1920 px wide); the threshold cache is
      unbounded (~100 B per entry); the entry chunk grew 220.42 → 226.49 kB (footprint and
      fit model; no deck.gl or h3-js). Not verified: any of this on a real GPU, and the
      idle warming in a browser.)*
- [x] Win back the detail the cap rule gives away: tick 12 starts each tier where its cull
      window cannot hold more than the cap even if every cell in it were populated and as
      small as the smallest H3 hexagon anywhere (0.6 × the mean area). That is safe — the
      fullest real window is 93 % of the cap and the committed data peaks at 65 % — but
      coarse on a desktop: on 1920×1080 at the equator r5 starts at zoom 5.44 with cells
      9.5 px across, and r4 cells reach ~23 px before it does (r8 only from 9.45); on
      1280×800 tiers start about one zoom later than the 3-px rule. Measured costs: the
      uniform 0.6 area floor 0.28–0.37 zoom; judging the fit 0.15 below the threshold
      0.15; the drift margin, zoom bucket and canvas-key rounding ~0.35; ~0.57 on 1920×1080
      is unavoidable under a 120 k cap. Recover what can be recovered without giving up
      the guarantee: (1) a floor that knows where the window is — H3's area distortion is
      a smooth function of the angular distance to the nearest icosahedron face center, so
      the smallest cell a given window can contain is computable without h3-js — or at
      least a per-resolution floor measured over window-sized regions (the checker's
      estimate: +0.32 zoom at r5, 0.15 at mid, 0.08 at r7, 0.05 at r8); (2) a tighter drift
      margin where re-culls are cheap — say what halving the pan step costs in re-culls
      per pan and wins in zoom. Also from the review: a window drag crosses a new 16-px
      canvas key every 16 px and each computes cold thresholds synchronously (~12–25 ms a
      step, ~40 hitches from 1280 to 1920 px wide) while the idle warmer restarts for every
      transient size — debounce the canvas that SELECTION uses, and bound the threshold
      cache.
      Accept: (a) `node scripts/bench/cull_coverage.mjs --scan` still reports 0 windows
      over the cap and 0 on-screen cells missing, and a Node check kept under
      `scripts/bench/` that counts REAL H3 cells in worst-case windows (every tier, the
      five canvases, next to each icosahedron vertex) stays ≤ the cap; (b) the threshold
      table for 900×560, 1280×800, 1920×1080, 375×812 and 2560×1080 at lat 0 / 35.68 / 60
      is reported before and after, each tier starting earlier by at least 0.2 zoom at r5
      and 0.1 at mid on 1280×800 and 1920×1080 — or a stated reason the geometry does not
      allow it; (c) the existing jitter tests still find no flapping, including at any new
      cache-cell edge; (d) a 1 px-step drag from 1280 to 1920 px wide computes thresholds
      for at most a handful of canvas sizes; (e) the entry chunk's size before and after.
      Gate: verify, qa:render.
      *(Done 2026-11-19, factory tick 13. What shipped: the cell-count bound in
      `src/lib/tierFit.ts` no longer divides every window by the smallest hexagon anywhere.
      H3 lays a uniform grid on each icosahedron face's gnomonic plane, so a hexagon's area
      is 1.2066 · cos³θ × the resolution's mean, θ the angle to the nearest of the 20 face
      centres (inlined; no h3-js in the entry chunk) — 0.605 at a vertex, 1.21 at a face
      centre. A window is weighed by the most cells per area it can meet at any longitude
      (720 half-degree turns, exact arc-by-arc on a 0.5° raster) and at every position its
      re-cull row can take along the latitude band, so thresholds still depend on canvas
      and latitude band alone. Lever (2), the drift margin, was measured and left: halving
      the pan step wins 0.07–0.14 zoom for twice the re-culls and tile re-selections per
      pan (9.6 → 19.2 per 1280 px on 1280×800); halving the zoom step wins 0.03. Tier
      selection now reads a debounced canvas (`src/lib/selectionCanvas.ts`, store field
      `selectionCanvas`): during a resize, the canvas it already had while that covers the
      real one, else one 1.25× larger; the real canvas again 250 ms after the last resize.
      The cull and tile selection still follow the real canvas. The threshold cache keeps
      the four most recently used canvases.
      Thresholds (zoom; cell px at entry), before → after, at the equator — 900×560: r5
      4.42 → 4.17 (3.9), mid 5.69 → 5.58 (4.0), r7 7.06 → 7.02 (4.1), r8 8.45 → 8.44
      (4.1); 1280×800: 4.91 → 4.66 (5.5), 6.19 → 6.08 (5.6), 7.56 → 7.52 (5.7), 8.95 →
      8.94 (5.8); 1920×1080: 5.44 → 5.20 (8.0), 6.71 → 6.58 (7.9), 8.06 → 8.02 (8.1),
      9.45 → 9.44 (8.2); 375×812: 3.98 → 3.78 (3.0), 5.30 → 5.18 (3.0), 6.68 → 6.64
      (3.1), 8.07 → 8.05 (3.1); 2560×1080: 5.73 → 5.56 (10.3), 6.92 → 6.80 (9.2), 8.27 →
      8.22 (9.3), 9.65 → 9.64 (9.4). At lat 35.68 and 60 the gains are r5 0.22–0.25
      (0.15–0.17 on 2560×1080), mid 0.12–0.14, r7 0.07–0.08, r8 0.05–0.07. Criterion (b)
      is met on 1280×800 and 1920×1080 (r5 ≥ 0.22, mid ≥ 0.11). r7 and r8 gain little by
      geometry, not by omission: their windows are a few degrees across and can sit right
      next to a vertex, where the floor really is 0.605, and every latitude band is within
      reach of one at its worst longitude (see the Backlog candidate on longitude).
      Evidence — gate green on the final tree (verify 50 s, 333 unit tests; render 396 s,
      all five tiers reached, 0 console errors). The checker, by its own measurement, with
      no access to the maker's report: (a) `cull_coverage.mjs --scan` 136,320 views, 0
      windows over the cap (largest 91,872, was 78,283), 0 on-screen cells missing;
      `scripts/bench/h3_window_count.mjs` 4,800 windows of REAL H3 cells, largest 112,154
      (93.5 % of the cap); its own adversarial search — hill-climbs from every vertex,
      random and polar views, 14 canvases incl. 3840×2160, 320×568, 1001×777 and 812×375,
      then a sweep of every 1° band on six canvases — peaks at 112,604 (93.8 %), none
      over. The area model holds on 2.62 M hexagons at r5–r8 (smallest ratio 1.20656 ≥
      the 1.206 used; exact to ~1e-5 in both grid classes); the weight never comes out
      under a brute-force integral (min ratio 1.022 over 240 windows incl. poles and the
      antimeridian). (b) its own before/after table matches the one above; nothing starts
      later anywhere (17 canvases × every 0.37° of latitude: +0.0005 zoom at most, inside
      the 1/128 search tolerance); order never violated. (c) largest step between
      adjacent bands 0.099 (r5; 0.094 before) against the 0.15 hysteresis; 6,830 parked
      runs on every band edge, 0 flaps; a selection-canvas switch cannot loop and every
      consumer re-selects on it. (d) the 1 px drag 1280 → 1920 computes thresholds for 3
      canvases (was 40); no stuck covering canvas; the LRU cannot thrash. (e) entry chunk
      226.49 → 230.80 kB (74.0 gzip), no h3-js or deck.gl in it.
      Cost and known limits: a cold band is ~13 ms (was ~11.5) and the first one of a
      session adds a one-off raster fill (first call 87 ms in Node under load, was 43);
      `npm test` ~12 s → ~22 s; the band-step test limit was relaxed from < 0.011 to
      < 0.032 (the weight legitimately changes per band; the checker measured 0.0298 at
      most). Minor findings carried to the Backlog: `covers` holds only to within the
      search tolerance, and the possible coarse flip during a resize. Not verified: any
      of it on a real GPU or in a real browser drag; the store's settle timer has no unit
      test (the pure `resizingCanvas` has).)*
