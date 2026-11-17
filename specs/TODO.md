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

Ordered correctness first, then performance, then features. The three items at the top
came out of the 2026-11-17 code review; the rest are the standing queue, re-ordered so the
boundary cache lands before the two items that rebuild cells on the path it changes.

- [ ] Tolerate a failed r8 tile: `src/data/useTileStreaming.ts` awaits the visible tiles
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
- [ ] Decode-worker failure must fall back, not hang: in `src/data/decodeClient.ts`,
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
- [ ] Deep-link parsing accepts garbage: `parseHash('#//')` returns `{0, 0, 0}`
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
- [ ] Pole-aware viewport cull: `cullForView` (`src/lib/lod.ts`) keeps cells inside a
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
- [ ] Cull-boundary popping: `cullForView` swaps its 120 k top-k set on each re-cull, so
      cells blink in/out at the window edge during a pan. Fade newly-added cells in over
      ~150 ms, or widen the scan window and stabilize the selection between adjacent cull
      keys (`lib/lod.ts`).
      Accept: a unit test over a scripted pan at z 3–5 on a dense synthetic tier shows the
      rendered set changing by no more than the cells entering/leaving the window between
      adjacent cull keys (no interior churn), with the cap and highest-density semantics
      preserved; a qa:render frame diff of a z 3–5 pan shows no blinking cells.
      Gate: verify, qa:render.
- [ ] LOD cross-fade: with encoding now continuous across tiers (density domain +
      zoom-continuous height), the remaining seam at zoom 2.2/4.5 is purely geometric —
      22 km hexes are replaced by 3 km hexes in one frame. Render both tiers for ~250 ms
      at the crossing and cross-fade opacity (`layers/useGlobeLayers.ts`, driven off the
      `activeLod` transition in `store/useGlobeStore.ts`).
      Accept: no visible pop at either threshold in `npm run qa:render` screenshots;
      ≤ 120 k cells/frame still holds across the fade (cap the *sum* of both layers — with
      a unit test on the split); no frame > 100 ms of main-thread JS attributable to the
      fade (Node timing, not a SwiftShader frame time); reduced-motion skips the fade.
      Gate: verify, qa:render.
- [ ] Wire the render gate into CI: run `npm run qa:render` in `.github/workflows/ci.yml`
      against the dev server, uploading the report + screenshots as artifacts, and fail on
      console errors, a blank canvas or a broken cell cap (the exact checks — the
      SwiftShader stall comparison stays advisory; see `scripts/qa/render_qa.mjs`).
      Accept: CI job green on a clean PR and red on a deliberately-broken render; runtime
      < 10 min.
      Gate: verify.
- [ ] Night-lights basemap toggle: swap the dark-ocean sphere texture for NASA Black Marble
      (public domain) behind a `Controls.tsx` toggle; columns must stay legible
      (data > basemap).
      Accept: toggle works both ways at overview and r8 zoom; attribution line updated;
      the texture is < 2 MB and lazy-loaded (not in the first-paint path); 0 console errors.
      Gate: verify, qa:render.

## Backlog (needs breakdown before queueing)

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
