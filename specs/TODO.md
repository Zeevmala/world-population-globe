# TODO — work queue (the loop's spine)

> State lives here, not in any conversation: one queue item = one loop tick = one commit.
> Item format: lines starting `- [ ]` are queued, `- [x]` done; a stuck item gets a line
> starting `BLOCKED:` under **Blocked** below (that exact line-start is the runner's halt
> sentinel — never start a prose line with it).

## Loop contract

```
TRIGGER : Routine "globe factory tick" (every 3 h, fresh session) | manual
          `pwsh ./Invoke-RalphLoop.ps1` (ralph) | `/loop` tick (.claude/loop.md) | /goal
SCOPE   : this repo only, branch loop/auto in a dedicated worktree — never the main checkout;
          src/**, pipeline/**, scripts/**, docs/**, specs/**, index.html;
          public/data/** changes only via re-running the pipeline
ACTION  : take the FIRST unchecked item below → implement exactly that item → verify
VERIFY  : `npm run verify` exit 0 (eslint + tsc -b + vite build); render-path change →
          `npm run qa:render` (frame/stall/console gate); pipeline or data touched →
          `npm run verify:data` (Σ ≈ 8.03 B, per-file < 100 MB, H3 roll-up);
          deploys additionally gated by the CI `verify-live` job
BUDGET  : ≤ 12 iterations/run · 1 item/tick · ≤ 3 sub-agents/tick
STOP    : queue empty | blocked sentinel present | no-progress ×3 (HEAD + dirty-tree hash)
REPORT  : conventional commits + `[x]` flips here; sprint-level summary → PROJECT_STATE.md
```

## Queue

- [ ] LOD cross-fade: with encoding now continuous across tiers (density domain +
      zoom-continuous height), the remaining seam at zoom 2.2/4.5 is purely geometric —
      22 km hexes are replaced by 3 km hexes in one frame. Render both tiers for ~250 ms
      at the crossing and cross-fade opacity (`layers/useGlobeLayers.ts`, driven off the
      `activeLod` transition in `store/useGlobeStore.ts`). Accept: no visible pop at either
      threshold in `npm run qa:render` screenshots; ≤ 120 k cells/frame still holds across
      the fade (cap the *sum* of both layers); no frame > 100 ms attributable to the fade;
      `npm run verify` green.
- [ ] Cull-boundary popping: `cullForView` swaps its 120 k top-k set on each re-cull, so
      cells blink in/out at the window edge during a pan. Fade newly-added cells in over
      ~150 ms, or widen the scan window and stabilize the selection between adjacent cull
      keys (`lib/lod.ts`). Accept: pan at z 3–5 shows no blinking cells in a qa:render
      frame diff; cap and highest-density semantics preserved; `npm run verify` green.
- [ ] Wire the render gate into CI: run `npm run qa:render` in `.github/workflows/ci.yml`
      against a built preview, uploading the report + screenshots as artifacts, and fail on
      console errors or a stall regression vs `scripts/qa/baseline-main.json`. Accept: CI
      job green on a clean PR and red on a deliberately-broken render; runtime < 6 min;
      `npm run verify` green.
- [ ] Night-lights basemap toggle: swap the dark-ocean sphere texture for NASA Black Marble
      (public domain) behind a `Controls.tsx` toggle; columns must stay legible
      (data > basemap). Accept: toggle works both ways at overview and r8 zoom; attribution
      line updated; `npm run verify` green; 0 console errors.
- [ ] Pole-aware viewport cull: `cullForView` uses a fixed lng/lat window, so near the poles
      a longitude window covers far less ground than at the equator — the cull over-scans
      there and can under-cover at high latitude. Scale the longitude half-span by
      `1/cos(lat)` (clamped). Accept: cell counts at lat 70° comparable to lat 0° for the
      same zoom; no empty edges; `npm run verify` green.

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
