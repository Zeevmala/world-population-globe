# PROJECT_STATE — `world-population-globe`

> PM tracker. Source of truth for sprint status and iteration loop.
> Last updated: 2026-08-30.

## Product

3D population globe (deck.gl GlobeView + extruded H3 columns), Kontur Population data,
static deploy on GitHub Pages. See [`docs/architecture.md`](docs/architecture.md).

## Status: Sprint 1 — vertical slice ✅ SHIPPED

**Live:** https://zeevmala.github.io/world-population-globe/
**Repo:** https://github.com/Zeevmala/world-population-globe

| # | Task | State |
|---|---|---|
| 1 | Scaffold Vite + React + TS + Tailwind, deps | ✅ done |
| 2 | Data pipeline: Kontur r4/r6 → SNAPPY Parquet + manifest | ✅ done |
| 3 | Trackers: architecture.md, PROJECT_STATE.md, README | ✅ done |
| 4 | Globe frontend: sphere + land + extruded H3 columns, LOD, HUD | ✅ done |
| 5 | Verify: typecheck + lint + build + visual QA | ✅ done |
| 6 | Repo + CI/CD + GitHub Pages deploy | ✅ done |

### Verification log (Sprint 1)
- `tsc -b`, `eslint .`, `vite build` — all clean.
- Data integrity: all tiers sum to 8.03 B; top r4 cells = Cairo/Jakarta/Manila/Karachi/Mumbai.
- Visual QA (Claude Preview): globe + Inferno towers render; auto-rotate works; 0 console errors;
  mobile + desktop layouts clean.

### Deploy validation (Sprint 1)
- [x] CI green (tsc + eslint + build); Pages deploy green.
- [x] Live page + all data assets return 200; `Accept-Ranges: bytes` present
      (overview 1.2 MB, mid 31 MB) → in-browser Parquet column reads work under the subpath.
- [x] `index.html` references correct `/world-population-globe/` base; hashed JS/CSS resolve.
- [x] Manual live **zoom-in** smoke test of the `mid` (2 M-cell) tier (lazy load + cull path).
      **Live interactive QA (2026-06-08):** zoomed into Cairo on the deployed site — HUD flipped to
      `3 km cells · 2,016,971 loaded` (full r6 tier lazy-loaded + parsed over the CDN), live hover at
      r6 res (`863e63cd7ffffff`), **0 console errors**.

## Status: Sprint 2 — 400 m (r8) deep-zoom tile streaming ✅ SHIPPED

| # | Task | State |
|---|---|---|
| 7 | r8 tile pyramid: 32.96 M cells → 12,761 r3-parent Parquet tiles + index | ✅ done |
| 8 | Client tile streaming (`useTileStreaming`) + visible-parent enumeration | ✅ done |
| 9 | Wire r8 LOD band + rendering (`selectActive`, store r8 slice) | ✅ done |
| 10 | Docs (architecture tiling section, this board) | ✅ done |
| 11 | Verify (integrity, zoom QA, build) | ✅ done |
| 12 | Deploy (commit, push, smoke test) | ✅ done |

Approach: r8 cells partitioned by H3 r3 parent → 12,761 small Parquet tiles (~32 KB mean,
0.27 MB max) + `index.json`; client computes visible parents (h3-js `gridDisk`),
fetches/LRU-caches/merges tiles per viewport, renders via the existing `H3HexagonLayer`
path, viewport-culled. LOD bands: overview r4 (<2.2) → mid r6 (2.2–4.5) → r8 (≥4.5).

### Verification log (Sprint 2)
- Pipeline integrity: r8 = 32,957,699 cells, Σ pop = 8,031,924,024 ≈ 8.03 B (matches r4/r6);
  Tokyo r3 tile = 13,586 cells / 23.4 M; densest 400 m cells in dense urban cores.
- `tsc -b`, `eslint .`, `vite build` — clean (hyparquet `src/read.js` subpath resolves in build).
- Preview QA: global hero intact; flew to Tokyo z5.6 → 16 r8 tiles streamed (206 range reads),
  merged 65,892 cells, Kanto/Tokyo Bay rendered correctly at 400 m.
- Fixed in QA: (a) `useGlobeData` was whole-loading the tiled r8 entry (`/undefined` fetch +
  parquet error) → now skips tiled tiers + `loadLod` guard; (b) columns were giant spikes at
  deep zoom → height now scales with cell footprint (`ELEVATION_PER_KM_M`).
- Repo +502 MB (12,761 tiles, each ≪ 100 MB) — within GitHub Pages limits; in-repo (no CDN needed).

### Deploy validation (Sprint 2)
- [x] CI green (tsc + eslint + build); Pages deploy green (commit 69cb528).
- [x] Live homepage + `manifest.json` (r8 entry) + `tiles/r8/index.json` + a tile return 200.
- [x] Tile serves `Accept-Ranges: bytes` → in-browser per-viewport range streaming works in prod.
- [x] Manual live deep-zoom interactive pass.
      **Live interactive QA (2026-06-08):** continued into central Cairo — HUD flipped to
      `0.4 km cells · 46,744 loaded` (r8 r3-parent tiles streamed + merged for the viewport), live
      hover on a real r8 cell (`883e662e31fffff`, ≈5,634 /km²), 400 m columns rendered across the
      Cairo metro + Nile Delta, **0 console errors**.
- **QA method note:** the deployed globe was driven by a real mouse (operator-assisted) and observed
  via Chrome MCP (HUD / hover / console oracles). Automated synthetic-wheel zoom proved unreliable on
  `GlobeView` — deck warns `around not supported in GlobeView` (scroll-zoom is cursor-anchored, but
  GlobeView only zooms around center), so synthetic wheel input accumulated zoom glacially. The
  **share-state deep-link** (Sprint 3 backlog) would make this pass fully scriptable, and a fly-to /
  zoom-control affordance would improve real-user deep navigation.

## Status: Sprint 3 — Navigation & sharing ✅ SHIPPED

Theme: make the globe *navigable and shareable* — land somewhere meaningful on load, jump to any
place by name, and share an exact view. Chosen from the Sprint 3 backlog (+ user-requested "start
more zoomed-in"); it also closes the live-QA gap above by making camera state scriptable via the URL.

| # | Task | Notes / files |
|---|---|---|
| 1 | ✅ Start zoomed-in + zoom controls | `INITIAL_VIEW.zoom` 0.2 → 2 (overview stays the load tier); `zoomBy()` (center-only, clamped −1…7) + on-screen **+ / −** buttons in `Controls.tsx`; removed the cell-count HUD chip. Center-zoom sidesteps `around not supported in GlobeView`. **Preview-verified:** +/− span 22 → 3 → 0.4 km (mid + r8 stream), reverses, clamps, 0 console errors, no `around` warning. |
| 2 | ✅ Geocode search | `lib/geocode.ts` (Nominatim/OSM, no key; browser `Referer` satisfies the usage policy) + `components/Search.tsx` (top-center; 350 ms debounce, `AbortController`, keyboard nav ↑/↓/Enter/Esc). **Preview-verified:** query "Tokyo" → Nominatim 200 → "Tokyo, Japan" result; select fires `flyTo`; 0 console errors. |
| 3 | ✅ Animated fly-to | Done with #2. `flyTo(lng,lat,zoom?)` store action sets a `flyTarget`; `Globe.tsx` eases the camera over 1.6 s via a **time-based rAF tween** (shortest-path longitude, ease-in-out-cubic), reusing the proven auto-rotate rAF pattern — **not** deck's `FlyToInterpolator`, which assumes Web Mercator and misbehaves on `GlobeView`. Auto-rotation stops on fly. |
| 4 | ✅ URL ↔ viewState deep-link | `lib/urlState.ts` (`parseHash`/`formatHash`/`viewUrl`, `#lng/lat/zoom`); store seeds `INITIAL_VIEW` from the hash + sets `autoRotate:!hash`; `Globe.tsx` debounced `replaceState` (only when `!autoRotate`); `Controls.tsx` "🔗 Share view" button. **Preview-verified (no render needed):** interact → `#139.7000/35.6800/5.00`; reload that URL → view seeded + rotation off; 0 console errors. Bonus: live QA is now scriptable via deep-link. |
| 5 | ✅ Wire UI + a11y | Search (top-center) + Share + zoom controls all wired in `App.tsx`/`Controls.tsx`; hover `InfoPanel` reused. Added full **combobox ARIA** to `Search.tsx` (`role=combobox/listbox/option`, `aria-expanded`/`-controls`/`-activedescendant`/`-selected`) on top of the existing `aria-label` + ↑/↓/Enter/Esc. |
| 6 | ✅ Verify | `tsc -b` + `eslint .` + `vite build` clean; **`npm run verify:live` ALL PASS** (overview/mid/r8 fetch+parse on the CDN, Σ≈8.03 B); Preview: search→fly-to→hash round-trip. |
| 7 | ✅ Deploy + post-deploy gate | Auto-deployed via Pages. **Live smoke (deep-link-driven):** bare load → zoom-2 hero + Search/Share/zoom UI, 0 console errors; search "Tokyo" → Nominatim "Tokyo, Japan"; deep-link `#139.70/35.68/5.00` → **r8 Kanto/Tokyo rendered at 400 m**, hash round-trips, rotation off, 0 errors. (#3 fly-to *animation* rAF-wedged in the test browser — Preview-verified.) |

Architecture note to add (`docs/architecture.md`) when implementing: geocoder choice (Nominatim vs
bundled gazetteer), fly-to interpolator, URL deep-link schema, and center-zoom controls for GlobeView.

**Open implementation fork (resolve at build):** Nominatim (full global coverage, live, 3rd-party
usage policy) vs a bundled gazetteer (offline, limited). Recommendation: **Nominatim** + debounce +
attribution; gazetteer as the documented fallback.

## Status: Sprint 4 — Portfolio polish & launch-ready ✅ SHIPPED

Theme: turn the shipped app into a fast, share-ready portfolio piece — smaller initial
download, a real social-preview card, and a looser default framing. (Hebrew/RTL dropped per
scope decision; PWA offline + night-lights basemap remain in the backlog.)

| # | Task | Notes / files |
|---|---|---|
| 1 | ✅ Default zoom-out | `store/useGlobeStore.ts` `INITIAL_VIEW.zoom` 2 → **1.3** (one `ZOOM_STEP` further out; still < the mid band 2.2, so `overview` stays the on-load tier). Deep-links override → unaffected. Preview-verified: loads at 1.3; +/− round-trips 1.3 → 2.0 → 1.3. |
| 2 | ✅ Code-split deck.gl | `App.tsx` lazy-loads `Globe` (`React.lazy` + `Suspense`/`Loader` fallback; named→default shim). deck.gl + luma + h3-js + hyparquet now load in a separate async `Globe-*.js` chunk. **Initial JS 1,136 KB → 203 KB entry** (gzip 64 KB) + 960 KB lazy chunk. Preview-verified: shell paints, globe streams in, `status: ready`, canvas renders, 0 console errors. |
| 3 | ✅ OG/social meta | `index.html` — Open Graph + Twitter `summary_large_image` cards + `theme-color` + canonical. `og:image` is the **absolute** prod URL (crawlers don't resolve relative/subpath). |
| 4 | ✅ Preview image | `public/og-image.png` (1200×630), generated by `scripts/make_og_image.py` (deterministic: deep-space globe + Inferno population over Asia + title/legend, reusing the app's exact ramp). |
| 5 | ✅ Verify | `tsc -b` + `eslint .` + `vite build` clean; build emits split chunks (small entry + lazy `Globe`); Preview QA (load → lazy globe → ready, looser zoom, +/− work, 0 errors); `verify:live` unaffected (no data change). |
| 6 | ✅ Deploy + post-deploy gate | Commit + push → Pages auto-deploy (`ci.yml` + `deploy.yml` `verify-live`). Live smoke + OG card validation. |

### Pre-publish QA notes (Sprint 4)
- **Desktop** (primary surface): hero globe at zoom 1.3 renders crisply; Inferno towers, search/share/zoom all functional; 0 console errors.
- **Mobile** (375×812): chrome is responsive — Search correctly hidden (`sm:block`), Header/Controls/Legend/Attribution positioned without overlap. *Observation:* on tall portrait the globe sits small & high with empty space below — a responsive default-zoom (or vertical re-centering) is a backlog candidate, **not** a Sprint-4 regression.

## Status: Sprint 5 — interaction performance ✅ SHIPPED

Theme: the globe rendered slowly when panned (user report, even at the overview tier). The
dominant cost turned out to be paid *per pointer event* during a drag — invisible to a synthetic
`setViewState` benchmark — so the fix is structural, verified by mechanism + visuals, not a frame
delta. Three commits (one per loop item).

| # | Task | Notes / files |
|---|---|---|
| 1 | ✅ Baseline render cost | `perf: cut globe pan cost` (93ff0eb9). `useDevicePixels ≤ 1.5` cap + instanced columns (`highPrecision: false`) + **picking disabled while dragging** (`isDragging` store flag → `pickable`, set from `onInteractionStateChange`). The picking-skip is the real "slow when panned" lever — a pickable layer re-rendered the picking buffer on every `pointermove`. Files: `Globe.tsx`, `useGlobeLayers.ts`, `useGlobeStore.ts` (+ dev-only `__deck` QA handle). |
| 2 | ✅ Cull cadence | `perf: re-cull less often…` (27209552). `cullKeyFor` quantizes the camera to `halfSpan/4` (re-cull ~5–10× less often vs the old 1°); `cullForView` scans a `1.5×halfSpan` margin (no edge-pop) and fills the 120 k cap via O(n) `topKByPopulation` quickselect instead of an O(n log n) sort of ~1 M indices. File: `lib/lod.ts`. |
| 3 | ✅ r8 tile prefetch | `feat: prefetch the next r8 tile ring…` (699483e8). `prefetchParents()` (gridDisk k+1 shell) + idle `requestIdleCallback` warms the next ring into the LRU cache (no `setR8Data`) with visible-protecting eviction. Files: `lib/tiles.ts`, `useTileStreaming.ts`. |

### Verification log (Sprint 5)
- `npm run verify` exit 0 after each commit (eslint + tsc + vite build).
- **Live oracles** (`window.__globe` / new `__deck`, real Chrome — synthetic-canvas screenshots OK
  via computer-use, not preview): effPx **1.5**, instanced sublayer active, `pickable` true→false→true
  across idle/drag/release; overview (Africa) + r8 (Tokyo) render artifact-free.
- **Cull (mid r6, 2.0 M cells, India z3.2):** rendered exactly **120 k**, cells concentrate on dense
  regions (quickselect top-k correct), viewport fully covered (no holes); cull key steps in **4.9°
  quanta** (78.35→83.25→88.14) vs the old 1°.
- **Prefetch (Shanghai z5.2):** fetch log shows **two bursts** — 13 visible tiles at t≈0, then 10
  prefetch-ring tiles at t≈3.7 s once idle; a +6° pan into the warmed ring fetched **0 tiles** (no
  empty flash). 0 console errors.
- **Measurement caveat:** the synthetic `setViewState` ramp fires no pointer events, so it cannot
  show the picking-skip win, and cross-time FPS on the dev box is load-noisy (a concurrent
  `vite build` made a 1m45s build take ~5min and stalled the renderer — serialize build vs.
  dev-server + WebGL tab; noted in agent memory). Wins asserted structurally + visually.

### Post-deploy fix — instancing reverted (star-shadow regression)
The `highPrecision: false` lever (Fix 1) was caught in production causing a radial **star-shaped
shadow** on the auto-rotating overview globe: the instanced `ColumnLayer` gives every hexagon prism
the same face orientation, so the fixed directional sun lit them in an N-fold pattern across the
sphere. Reverted to `highPrecision: 'auto'` (the pre-Sprint-5 per-cell path — visually proven, and
instancing was perf-neutral at overview anyway). DPR cap + drag picking-skip retained as the real
pan wins. Lesson: the QA gap was checking close-up r8 + a static overview, not the *lit, rotating*
full globe where the symmetry shows.

## Status: Sprint 6 — cartographic presentation (seat the globe in space) ✅ SHIPPED

Theme: a user-requested "make it world-class" pass. The data, encoding, and engineering
were already strong; the gap was *presentation* — the planet read as a flat disc in
featureless black (a static screen-space corner-vignette faked the atmosphere) — plus a
few finish holes. Deliberately **out of scope** (locked with the user): the Inferno ramp,
column `material`, `LightingEffect`, and the LOD/cull/120 k pipeline are untouched — colors
stay full-bright. Atmosphere + stars are screen-space **DOM**, so there is no WebGL-pipeline
change and no star-shadow-class regression risk (see Sprint 5 postmortem).

| # | Task | Notes / files |
|---|---|---|
| 1 | ✅ Atmospheric limb glow | new `components/Atmosphere.tsx` replaces the static corner-vignette in `App.tsx`. A `pointer-events-none` CSS radial-gradient anchored at the viewport center (where GlobeView keeps the disc); radius = `viewportHeight × radiusFrac(zoom)`, a zoom→fraction profile **sampled from the live deck projection** (perspective FOV → radius scales with height, non-linear in zoom). Hugs the limb within 1–3 px and collapses off-screen at city zoom (CSS clamps the non-increasing stops). Zero GPU cost. |
| 2 | ✅ Starfield | new `components/Starfield.tsx`; 420 seeded (mulberry32, deterministic) static stars in one SVG behind the **transparent** globe canvas (the opaque sphere occludes those behind it). A bright subset (~18) twinkles via CSS, gated behind `prefers-reduced-motion: no-preference`. No network asset. |
| 3 | ✅ Adaptive DPR sharpening | `Globe.tsx`: `useDevicePixels` is now reactive — `1.5×` while in motion (drag / spin / fly, preserving the Sprint-5 pan budget), up to `2×` at rest with a 200 ms settle debounce on the way up (avoids buffer-realloc thrash). Crisper resting image on HiDPI. |
| 4 | ✅ Accessibility | new `lib/useReducedMotion.ts`; `prefers-reduced-motion` → no auto-spin on load (store init) + instant fly-to instead of the 1.6 s tween + no twinkle. Global `:focus-visible` ring in `index.css` (canvas kept clear). Dimmest text bumped `white/40 → /60` (Attribution / InfoPanel H3 / Legend labels) → WCAG AA on `#05070d`. |

### Verification log (Sprint 6)
- `npm run verify` exit 0 (eslint + `tsc -b` + `vite build`). Entry chunk **65 KB gzip** —
  the new components are tiny and, by design, did **not** pull deck.gl into the entry bundle
  (Globe chunk stays lazy).
- **Live oracles** (`window.__globe` / `__deck`, preview): the atmosphere gradient's
  transparent-core stop matches the **true apparent disc radius within 1–3 px** across zoom
  0–2.5 (e.g. z1.3 → 150 px computed vs 149 px measured), validated by projecting points along
  a meridian and by sampling offscreen `GlobeViewport`s at many zooms without disturbing the
  live view. 420 stars present, 18 twinkling; `:focus-visible` rule + contrast classes applied;
  **0 console errors**.
- **Couldn't observe (correct-by-construction + type-checked):** the 2× DPR upgrade — the dev
  box is a 1.5-DPR display, so `min(dpr, 2) === min(dpr, 1.5)`, a no-op here — and the
  reduced-motion branches (an OS setting). `preview_screenshot` still hangs on the WebGL canvas,
  so all visual asserts went through eval oracles, not pixels.

## Status: Sprint 7 — one encoding across every tier, decode off the main thread ✅ SHIPPED

User brief: run the factory continuously and make this a cartographic benchmark, along
three axes — smooth rendering at all zoom levels, SOTA UX/UI, solid updated data. Four
tracks ran in parallel (encoding/render, data integrity + upstream freshness, UX shell,
headless render-QA harness).

| # | Task | State |
|---|---|---|
| 1 | Density encoding on one cross-tier domain (`lib/density.ts`) | ✅ done |
| 2 | Zoom-continuous column height (`lib/scales.ts` `maxColumnHeightM`) | ✅ done |
| 3 | Parquet fetch + decode in a worker pool; packed H3 column | ✅ done |
| 4 | LOD tier hysteresis + tweened zoom | ✅ done |
| 5 | Truthful legend (real people/km² log ticks) + hover readout | ✅ done |
| 6 | SOTA UX shell: responsive HUD, keyboard driver, shortcuts, first-run cue | ✅ done |
| 7 | `npm run verify:data` — local data gate over all 12,761 tiles | ✅ done |
| 8 | `npm run qa:render` — headless render/stall/console gate + baseline | ✅ done |
| 9 | Upstream data freshness audit (`docs/data.md`) | ✅ done |
| 10 | 24/7 cadence: PR-gated Routine every 6 h off `specs/TODO.md` | ✅ done |

### The defect that motivated the sprint
Each tier normalized population against its **own** maximum (r4 22.7 M, r6 1.95 M, r8
40.7 k) while cell area changes **2,400×** between r4 and r8. So the same place drew a
different color on each side of zoom 2.2 and 4.5, the legend's "density" label described
a quantity the map was not drawing, and column height — a per-tier constant
`approxKm × 32,000` — collapsed **7.3×** in one frame at a crossing.

### Verification log (Sprint 7)
- **Encoding continuity (computed from the shipped manifest):** shared domain
  **55,163 people/km²**; tier maxima now normalize to **0.866 / 0.998 / 1.000** instead of
  1.00 / 1.00 / 1.00. Height across the crossings: z2.19 **333,395 m** → z2.21
  **326,873 m** (2%, the smooth zoom decay), where it was 704 km → 96 km. At 4.5:
  34,382 m → 33,710 m.
- **Packed H3 column:** 2,090,083 real indices across r4/r6/r8 round-trip
  `BigInt('0x'+s).toString(16) === s` with **0 mismatches**; every index exactly 15 hex
  chars, as the mode-1 bit guarantees.
- **Decode cost (node, on the committed data):** mid tier **2,440 ms** — metadata 4 ms,
  population 296 ms, lng 163 ms, lat 164 ms, **h3 1,817 ms**. That is the work that used
  to land on the main thread the moment the camera crossed 2.2.
- **Live browser (dev, SwiftShader):** 2 decode workers spawned, `mid.parquet` fetched
  off-thread, 2,016,971 cells, **exactly 120,000 rendered** (cap holds), `elevationScale`
  245,459 m at z2.5 matching the profile, **0 console errors**.
- **`npm run verify:data`:** ALL PASS in 19 s — all 12,761 tiles read whole, 32,957,699
  cells, per-tier sums 8,031,924,025 / …024 / …024, H3 parent roll-up, CRS bounds, every
  file < 100 MB. Proved to fail under six deliberate tamperings (deleted tile, inflated
  cellCount, mislabelled parent, corrupted sums, orphan dir) → 15 failures, exit 1.
- **`npm run qa:render`:** VERDICT **PASS**, **0 console errors**, cap never exceeded, in
  both the baseline (`scripts/qa/baseline-main.json`, pre-change `main` at `f5fc6cdc`) and
  the HEAD run.
- **Entry chunk:** 219.78 kB / **70.21 kB gzip** (was 65 KB). The HUD work is the cost;
  `ShortcutsDialog` and `FirstRunCue` are lazy. `VISION.md` updated to the real figure
  rather than leaving the stated budget contradicted.

### Main-thread cost at a tier crossing, measured directly (2026-08-31, idle box)
The decode moved to a worker; what remains on the main thread per re-cull/rebuild at
z2.5 over Tokyo was timed against the real committed data, outside the browser:

| phase | ms | where |
|---|---|---|
| pack 2 M h3 → `BigUint64Array` | 175 | **worker** (off main thread) |
| `cullForView` scan + quickselect → 120 k | **34** | main |
| materialize 120 k h3 strings from packed | **11** | main |
| `cellToBoundary` × 120 k (720 k vertices) | **239** | main |
| **total main-thread JS** | **~284** | |

So ~84% of the remaining per-crossing JS cost is per-cell H3 boundary generation — the
`highPrecision: 'auto'` hi-fi path — and `cellToBoundary` alone is a *lower bound* on it
(deck.gl also tessellates and packs per-vertex attributes on top). That is the next real
optimization target on actual hardware; queued in `specs/TODO.md`.

### What the render harness could NOT show — and why
The headless harness runs on **SwiftShader**, a CPU rasterizer. Both runs recorded
**27 main-thread blocks over 500 ms** (baseline worst 41,415 ms; HEAD worst 50,448 ms),
and the freezes fall into exactly two per sample — one "steady-state pan", one "settle
after camera move" — at every zoom, including zooms that load no data at all. They are
software rasterization of 40–95 k extruded hexagons on a contended 4-CPU box, an order of
magnitude larger than the 2.44 s decode and unrelated to it. **The harness therefore
cannot resolve the worker win, and the run-to-run difference above must not be read as a
regression** (the harness's own noise measurement is up to 2.2× on a single sample, and
its regression gate is 3×). The decode win rests on the direct 2,440 ms measurement plus
the structural proof that the work now runs in a worker.
An earlier worker-vs-inline A/B was **discarded**: it ran while two agents' browsers
saturated the box (3 frames recorded, a 36 s "long task"), which is renderer starvation,
not a block.

Re-run on an **idle** box (load 0.41) at a deliberately tiny **360×280** viewport, the
crossing still blocked **28,982 ms** (p50 a smooth 17 ms, so one frame carries all of it).
That looked at first like a real regression — but the table above shows the JS accounts
for only ~284 ms of it. The rest is SwiftShader's software **vertex** pipeline: 120 k
extruded hexagon prisms is ~4.3 M vertices, and shrinking the viewport cuts *fill* cost,
not *vertex* cost — which is exactly why the smaller canvas did not help. There is no
analogue of this on a real GPU. Absolute browser stall numbers from this environment are
therefore not evidence about the deployed experience in either direction; the JS table
above is the number that transfers.
- **One genuine functional delta at the 4.5 crossing:** the baseline ended on `mid`
  (15,412 cells); HEAD reaches **r8** (94,864 cells).

### Data provenance check (Sprint 7)
No Kontur release newer than the shipped **2023-11-01** exists. All 1,004 candidate dates
2024-01-01 → 2026-09-30 were probed on the exact S3 path the pipeline downloads from —
zero hits — with a 2022–2023 sweep returning exactly `20231101` as a positive control. The
upstream r4 GeoPackage was downloaded and its schema confirmed against
`detect_columns()` (EPSG:3857, `population(fid, geom, h3, population)`, 71,283 rows).
Details and the refresh runbook: [`docs/data.md`](docs/data.md).

Also fixed: `pipeline/build_tiles.py` defaulted `--tile-parent-res` to **2** — the
resolution `docs/architecture.md` §3b explicitly rejects — so `npm run data:tiles` would
silently build tens-of-MB r2 tiles instead of regenerating the shipped r3 pyramid, passing
every guard while quietly regressing bandwidth. Default corrected to 3.

Corrected in `CLAUDE.md`: r6 sums to **8,031,924,024**, not …025. Only r4 differs, and
that is float32 rounding in the pipeline's `CAST(... AS FLOAT)` — not a data difference.

## Status: Sprint 8 — the factory gets an oracle, a gate and a checker ✅ SHIPPED (merged + deployed 2026-11-24)

User brief (2026-11-17): review and upgrade the project for better results, implement the
factory, execute it on Opus 5.5.

### What the review found
- **The factory was not running.** The "factory tick" Routine this file described was not
  among the account's scheduled tasks, and nothing had landed since 2026-09-02 — the six
  queued items sat untouched for eleven weeks.
- **The verifier could not see behaviour.** `npm run verify` was eslint + tsc + vite
  build, with not one unit test: a wrong cull, a broken top-k or a stepped height profile
  all type-check and build.
- **The contract and the prompt disagreed** (the contract required qa:render / verify:data
  by path; the prompt the runner pipes in only ever ran `npm run verify`), and **the maker
  certified itself**.
- Three defects in shipped code, all since fixed by the factory (below).

### What changed
| # | Change | State |
|---|---|---|
| 1 | Unit tests (vitest, Node, < 2 s) as the behavioural oracle; `verify` = eslint → tests → tsc → build. 60 tests at introduction, each of six injected bugs killed | ✅ |
| 2 | `npm run gate` — path-scoped verifier selection in code; `npm run queue` — the one parser of `specs/TODO.md` | ✅ |
| 3 | Maker / checker agents + `/factory` orchestration; the runner pins a model, refuses `main`, re-runs the gate itself | ✅ |
| 4 | CI and the deploy workflow run `verify` + `verify:data` before anything publishes | ✅ |
| 5 | Tick 1 — one failed r8 tile no longer blanks the r8 view (`869bd9bc`) | ✅ |
| 6 | Tick 2 — a dead decode worker falls back inline instead of hanging the loader (`dcfb18ab`) | ✅ |
| 7 | Tick 3 — deep-links: strict parsing, wrapped longitude, clamped zoom (`35f74ebc`) | ✅ |
| 8 | Tick 4 — spherical-cap cull sized from its memo key (`6e54a1d9`) | ✅ |
| 9 | Tick 5 — tile stream: stale partial bursts expire; eviction protects the current view (`ed5959a0`) | ✅ |
| 10 | Tick 6 — H3 boundary cache; the column layer rendered without the `H3HexagonLayer` wrapper (`1eff4574`) | ✅ |
| 11 | Tick 7 — a zoom frame no longer re-tessellates the columns (`1136b8d1`) | ✅ |

### What the loop is worth, measured on seven ticks
Every tick passed the gate on its first cut. The checker — fresh context, never shown the
maker's report — still sent four of seven back, each for a real defect a green gate could
not see: a tile abandoned for the whole session after a ten-second outage (tick 1); a dead
worker reported only as a warning, which would have hidden a broken worker from the render
gate (tick 2); a cull window sized from the triggering view rather than its memo key,
leaving a gap under zoom drift that the old code did not have (tick 4); and a depth bias
that shifted when a wrapper layer was removed, found by a pixel diff of the gate's
screenshots — 31–45 pixels of 504,000 — and traced by the checker to deck.gl's layer-index
resolver (tick 6). Two follow-up items came out of the ticks themselves (the tile-stream
loose ends from tick 1's checkers; the per-zoom-frame rebuild from tick 6's maker) and
both shipped. Tests went 60 → 150.

Measured gains, Node timings on the committed mid tier unless noted:
- Boundary work on a repeat cull: 534 → 45 ms (India z2.5), 463 → 26 ms (Tokyo z3.5);
  whole tessellation 707 → 145 ms and 621 → 106 ms (`scripts/bench/boundary_bench.mjs`).
- A zoom frame inside one cull key: a full re-tessellation of every culled cell → none
  (in the real page: 0 `updateGeometry` calls over ten zoom frames,
  `scripts/qa/zoom_rebuild.mjs`).
- The cull itself: unchanged cost (15 ms) for a window that is now correct at the poles
  and across the antimeridian (`scripts/bench/cull_bench.mjs`).

### The finding that outranks the queue: the LOD bands are ~3 zoom levels early
Tick 4's checker tested the cull against deck.gl's real `GlobeViewport` rather than the
`180/2^zoom` half-span the code assumes, and the model did not survive. Followed up with a
direct measurement (1280×800, CSS px): an r6 hexagon is **0.38–0.47 px** across when the
mid tier switches on at zoom 2.2; an r8 hexagon is **0.27–0.33 px** across when r8 switches
on at 4.5 and still only **1.5–1.9 px** at the maximum zoom of 7. Drawing sub-pixel prisms
puts far more cells on screen than the 120 k cap allows, which is the common root of the
top-k truncation, the cull-boundary popping, the per-re-cull boundary cost and the seam at
each crossing — and of two visible defects: at zoom 4.6 over Tokyo the r8 tier draws a
patch around the center and leaves the rest of Japan blank (`scripts/qa/out/tokyo-z4.60.png`),
and the mid tier draws a truncated disc covering about half the visible radius on a desktop.
The full numbers, and the two ways forward — **A:** band by on-screen cell size (add r5 and
r7 by H3-parent aggregation of the committed tiers, raise `maxZoom` to ~10), **B:** keep the
bands and patch the symptoms — are the first Backlog entry in `specs/TODO.md`. **It needs a
decision**; the items that depend on it are held there, and the queue carries only work
that is valid either way.

### Verification log (Sprint 8)
- Gate green on every commit, run by the orchestrator: queue lint, eslint, unit tests,
  `tsc -b`, `vite build`, `qa:render --quick` (PASS, 0 console errors, 120 k cap held).
- Headless confirmations re-run by the orchestrator: `tile_fail.mjs` (tile aborted →
  `activeLod=r8`, 52,306 cells, 0 unhandled rejections) and `--fail-worker` (worker script
  aborted → `status=ready`, 71,283 cells in 17 s).
- Not verified anywhere: behaviour on a real GPU. Every browser number here is SwiftShader;
  the Node timings (`scripts/bench/cull_bench.mjs`) are the ones that transfer.
- No schedule was registered: a recurring task spends tokens unattended, and whether the
  missing Routine was removed on purpose is not something the repo can answer.
- Left in the queue, each waiting on something outside the session: the night-lights
  basemap (its texture could not be downloaded from the cloud session — see the item) and the
  render gate in CI (its Accept needs a GitHub Actions run, which needs a pull request —
  the same PR would be the first Actions run of the `verify` + `verify:data` steps this
  sprint added to CI and to the deploy workflow, which are unverified there until then).

## Status: Sprint 9 — Option A: tiers banded by on-screen cell size ✅ SHIPPED (merged + deployed 2026-11-24)

Owner decision 2026-11-18: of the two ways forward recorded at the end of Sprint 8, **A** —
band the LOD tiers by on-screen cell size, add r5 and r7 by aggregating the committed data,
raise the maximum zoom to 10. Carried out as five factory ticks, in dependency order.

| # | Tick | Change | Commit |
|---|---|---|---|
| 1 | 8 | r5 tier (H3-parent roll-up of r6); bands from "a hexagon is 3 px across"; `MAX_ZOOM` 7 → 10 | `1e75ffc1` |
| 2 | 9 | Cull window from GlobeView's real footprint (`lib/footprint.ts`), canvas size in the cull key | `55c113c3` |
| 3 | 10 | Tile streaming for any tiled tier; tiles chosen from the cull's own window | `1856cbe5` |
| 4 | 11 | r7 tier (roll-up of r8), tiled by r2 parents; `verify:data` generic over tiled tiers | `9f3db146` |
| 5 | 12 | Per-view tier selection: each tier starts where its cull window fits the cap | `404ac720` |
| + | 13 | Follow-up: the cap bound knows where H3's cells are small; selection reads a debounced canvas | `e2394f59` |
| + | 14 | Opt-in NASA Black Marble night-lights basemap (owner permitted the GIBS download 2026-11-23) | `feat(basemap): opt-in NASA Black Marble…` |

### Before and after
- **Tiers:** r4 / r6 / r8 switching at zoom 2.2 and 4.5 → r4 / r5 / r6 / r7 / r8, each starting
  where its cells are legible and its window fits the 120 k cap for the view's latitude and
  canvas. A 400 m cell is ~12 px at zoom 10; it was under 2 px at the old maximum of 7.
- **What was on screen:** at zoom 4.6 over Tokyo the 400 m tier drew a patch and left the
  rest of Japan blank; the mid tier drew a disc covering about half the visible radius. Now a
  culled tier fills the canvas — seen at 1280×800 over India on r5 and r6, and at 1920×1080
  over Delhi on r8 — and the bench's scan of 136,320 views finds no window over the cap and
  no on-screen cell missing.
- **Data:** five tiers, each summing to 8.03 B (r5 393,791 cells, 6.4 MB; r7 9,012,014 cells
  in 2,409 tiles, 141 MB). `public/` is 684 MB — 68.6 % of GitHub Pages' 1 GB limit.
  `verify:data` proves both roll-ups cell by cell (~55 s, was ~22 s).
- **Render gate:** ~400 s → ~190 s on the software rasterizer after tick 8 (far fewer
  sub-pixel prisms), ~390–450 s now that it visits five tiers; worst stall ~40 s → ~18–23 s.
- **Basemap (tick 14):** a night-lights toggle (N) swaps the ocean sphere and land fill for
  NASA Black Marble (VIIRS 2016, via GIBS; 429 kB at 4096 px, 121 kB at 2048 px, fetched only
  when turned on). The lights sit exactly where the densest columns are and share the top of
  the Inferno ramp's colour, so the texture is tone-mapped before it is committed: no pixel is
  brighter than the ramp's midpoint (0.126 against 0.140 relative luminance; the source peaks
  at 1.0), while land and sea tones are left within a level. Georeferenced by a `BitmapLayer`'s
  bounds on a 1° mesh; the checker confirmed it against Natural Earth coasts and by
  unprojecting rendered frames. The default (dark) render is pixel-identical to before.
- **Tests:** 150 → 353.

### What the loop caught in this sprint
Five ticks, four review or gate send-backs, each for something a green gate could not see:
- **Tick 8:** the checker withheld its pass until three headless checks had been run at the
  new zooms (they passed) — no code finding.
- **Tick 10:** the gate went red on a harness step that waited a fixed 30 s for the first-run
  cue (the rasterizer was slower); then the checker failed the change with counterexamples —
  tile selection sampled each cell's boundary at a few points and could skip an on-screen
  tile on a small ground footprint (149 misses in 20,000 high-latitude views). The loop
  contract's "one retry per tick" would have blocked the item there; it was changed to one
  send-back per oracle (`c442c5a5`).
- **Tick 12:** the first cut met its criteria as written, and the checker's wider scan found
  the r5 window over the cap in 2,518 of 102,240 cases across Central Asia, Russia and Iran,
  with the triggering view itself losing edge cells — partly the specification's own fault
  (it had asked for key-only selection past the cap without first guaranteeing the window
  fits). The specification was amended to require the fit by construction, and a second
  checker verified the bound against real H3 cell counts.
Two specification errors were mine and were corrected in the queue: an acceptance criterion
that contradicted the bench's numbers, and the retry rule above.

### What it cost, and what is open
- **Coarser on desktop than the 3-px rule.** The cap guarantee is conservative. After tick 12,
  on 1920×1080 each tier started about 1.5 zoom later than the 3-px rule (r5 at 5.44, cells
  9.5 px across; r4 cells reach ~23 px first), about 1 zoom later on 1280×800. Tick 13 took
  back what a bound without a longitude key can: H3's hexagons are 1.2066 · cos³θ × the mean
  (θ to the nearest icosahedron face centre), so a window is weighed by where the small cells
  can actually be instead of by the smallest cell anywhere. r5 now starts 0.22–0.25 zoom
  earlier on desktop (1920×1080: 5.20, cells 8.0 px), mid 0.11–0.13, r7 and r8 under 0.1 —
  their windows are small enough to sit next to a vertex. The guarantee is unchanged: the
  checker's adversarial search over 14 canvases peaks at 93.8 % of the cap in real H3 cells,
  and the 136,320-view scan still finds no window over it and no cell missing. What is left
  is recorded in the Backlog: longitude-aware thresholds (0.13–0.35 zoom at typical cities
  for r7/r8, at the price of a second cache dimension), and the 120 k cap itself, an owner
  decision that needs frame times on a real GPU.
- **Not verified:** anything on a real GPU; the original pipeline scripts end to end (the
  Kontur source is unreachable from the cloud session — the new tiers are built from the
  committed data); `verify_live.mjs` against a deployment.
- **Still waiting on the owner:** a pull request (the CI render-gate item, and the first
  GitHub Actions run of the test and data-gate steps added in Sprint 8); the 120 k cap
  decision; and a look at night lights on a real screen — at r8 zoom the magnified texture is
  a grey blur over water (Backlog).

## Status: Sprint 10 — the factory keeps what it learns (phase 1) ✅ ON BRANCH (not merged)

Sprints 8 and 9 (PR #2) were merged on 2026-11-24 (`e6aa859b`). This sprint changes no
application code.

### Why
The loop learns something on most ticks and files it by date — a Done note, a commit
body, a sprint entry here. Reading the notes of ticks 1–14 for what each of the eight
send-backs was *for* (one reader's classification of the notes, not a measurement):

| | Count | Which |
|---|---|---|
| Over something already known or recorded | 3 of 8 | tick 2 (a failure logged as a warning, which the render gate does not fail on), tick 10's gate send-back (a fixed wait the software rasterizer outlasted), tick 12 (criteria that could not hold as written — "partly the specification's own fault", Sprint 9) |
| A first discovery — a note only prevents the repeat | 3 of 8 | tick 4 (cull radius from the triggering view, not the key), tick 6 (deck.gl sublayer index and depth bias), tick 10's review send-back (boundary sampling is not an overlap test) |
| Not a knowledge problem | 2 of 8 | tick 1 (a design judgment), tick 8 (the checker could not see the headless runs) |

Specification errors were the other cost: tick 4's premise ("only half right"), a
criterion that contradicted the bench's numbers (`61a892f8`), and tick 12's criteria. So a
note store might have helped with about three send-backs in eight and with the
specification step; the checker caught the rest and nothing replaces it. That sized the
work: small, in two phases, the second only if the first shows a need.

### What was added
- **A flag channel.** The maker's report and the checker's verdict end with a
  `KNOWLEDGE:` block — what they were told that was wrong, or had to work out because
  nothing recorded it, with evidence and an optional correction. The orchestrator appends
  it to `knowledge/INBOX.md` in the tick's commit, on the blocked path too. Agents doing an
  item flag; they never edit the notes.
- **The owner's rulings** go into the same inbox in their words when they are given.
- **Whoever writes a queue item reads the notes first** and says where its premise was
  measured (`.claude/commands/factory.md`, "Writing a queue item").
- **`knowledge/`**: an index, an entry format (claim · measured / sourced / decided ·
  evidence · check · date), and one note, `verification-limits.md` — what each check can
  and cannot see: 9 entries and a table of what only a real machine can settle.
- **`npm run check:freshness`** (`scripts/check_freshness.mjs`, 15 unit tests): the
  `docs/data.md` §8 audit as a command.

### What two reviews of the first note found
The note went through `factory-reviewer` before it was committed, twice, each time a fresh
context given the item text only. Both returned FAIL. That is the result of this sprint
worth keeping.

- **Review 1.** The draft held eleven entries written in good faith and one planted,
  undisclosed, believed false: "the render gate fails on any failed network request". The
  checker rejected it, citing `render_qa.mjs`'s `requestfailed` handler (it pushes a
  warning). It also failed three good-faith entries whose evidence did not say what the
  entry said, and one cited a record that did not exist in the repository.
- **Review 2**, of the corrected note. It ran a probe instead of reading the handler:
  Chromium reports a failed *main-thread* request as a console error, which the gate does
  fail on; a failed request from a Worker it does not. So the planted entry was half true,
  the first checker's correction was half wrong, and the orchestrator had adopted it. It
  also found a citation that contradicts the entry citing it, an enumeration with an
  omission, four inbox entries with misplaced or contradicted evidence, and errors of
  detail in this section's first draft.

What was done with that: the three entries review 2 failed, and the schedule entry it
could not ground, were **withdrawn to the inbox** rather than rewritten a third time. The
note as committed holds the eight entries review 2 marked met, plus one (the GPU entry)
with the contradicting citation removed; two had a label or a heading narrowed afterwards.
**No third review was run** — the loop contract allows one send-back per oracle, and the
honest state after two FAILs is a smaller note, not a third attempt at the same claims.
The inbox entries were corrected from review 2's findings and have not been re-reviewed.

The lesson is already an inbox entry: a claim about what a check *does* needs a check of
its own (a probe that fails when the claim stops being true), not a reading of the code —
two careful readers read the same handler and both got the behaviour wrong.

### The September schedule
Sprint 8 found that the scheduled factory run had produced nothing and no longer existed.
This session's recollection of it — a recollection, since nothing was recorded at the
time: the schedule was pointed at `main` while the six-item queue and the `verify:data`
and `qa:render` scripts it depended on were still on the branch of PR #1; it fired on
2026-09-02, the runs that finished were recorded as succeeded, and none left a branch or a
pull request; it was paused that day, shortly before PR #1 merged. Why no push landed was
not determined. It is an inbox entry, not a note entry, until a schedule is next
registered and a hand-fired run is recorded properly.

### Verification log (Sprint 10)
- PR #2's merge: the deploy, CI and `verify-live` runs for `e6aa859b` passed (read from the
  Actions API on 2026-11-24, not checkable from the repository).
- `npm run gate -- --base origin/main` green before the note was cut down: file size ·
  queue lint · verify (368 tests, build) · `qa:render --quick` PASS in 403 s. The changes
  after that run are Markdown only; queue lint re-run clean.
- `npm run check:freshness`, 2026-11-24: **Kontur `2023-11-01` is still the newest
  release** — control 200, 1,119 later dates all absent (`docs/data.md` §8). Five
  deliberate bugs in the script are each killed by its tests; against the real bucket a
  control date that does not exist exits 2.
- **Not verified:** the flag path inside `/factory`. No tick has run since it was added;
  the only real use so far is the two reviews above, which did fill the block. Whether any
  of this lowers the send-back rate is unknown until some ticks have run.

### Open
- **Phase 2, only if the inbox earns it:** a curator agent and `/curate`, a lint for the
  notes in the gate, a geometry note (two inbox entries are waiting for one), procedures as
  skills. Fifteen entries are in the inbox today: four seeded from ticks 1–14, six from this
  sprint's two reviews, five owner rulings.
- Inbox entries that need the owner or a code change: handing the checker the
  orchestrator's run output (a contract change); the wording of `qa:render` in `CLAUDE.md`;
  a stale line in `render_qa.mjs`'s report; one sentence in `docs/data.md` §4.
- Still no schedule: the factory runs when `/factory` is run.

## Iteration loop

Human / sprint cadence (this file is the PM log):
1. Pull a backlog item into a sprint task.
2. Architecture note (if non-trivial) → `docs/architecture.md`.
3. Implement (typed, vectorized, modular).
4. **Verify (all layers below)** → 5. Update this file + commit → 6. Deploy via CI → 7. **Post-deploy gate**.

Autonomous cadence (loop-engineering scaffolding, added 2026-06-11; continuous since 2026-08-30):
- **Trigger:** manual today — `/factory [ticks]` in a session, or `Invoke-RalphLoop.ps1`
  in a worktree. An earlier revision of this file said a Routine fired every 6 h (and
  `specs/TODO.md` said every 3 h); on 2026-11-17 no such scheduled task existed on the
  account and nothing had landed since 2026-09-02 — see Sprint 8. A schedule, when one is
  registered, should fire `/factory 1` on a branch and **never push to `main`**: `main`
  auto-deploys to the public site, so every autonomous change stays behind a human merge.
- **Maker / gate / checker:** `/factory` ([`.claude/commands/factory.md`](.claude/commands/factory.md))
  spawns `factory-implementer`, runs `npm run gate` itself, then spawns `factory-reviewer`
  with fresh context; it commits only on a green gate **and** a PASS.
- **Queue + loop contract:** [`specs/TODO.md`](specs/TODO.md) — the loop's spine; one item = one tick = one commit.
- **Anchors read every tick:** [`CLAUDE.md`](CLAUDE.md) operating rules + invariants; [`VISION.md`](VISION.md) north star.
- **Per-tick prompt:** [`PROMPT.md`](PROMPT.md); **runner:** [`Invoke-RalphLoop.ps1`](Invoke-RalphLoop.ps1)
  (max-iter cap, no-progress ×3 halt, line-anchored `BLOCKED:` sentinel, per-iteration logs; worktree-only).
- **`/loop` maintenance default:** [`.claude/loop.md`](.claude/loop.md) (uncommitted work → CI/deploy health → `verify:live` → queue).
- **Verifier:** `npm run verify` (eslint + unit tests + tsc + vite build, one exit code); `npm run gate`
  adds the path-scoped render and data gates; CI + `verify-live` post-deploy.

## QA & verification loop

Defense in depth — each layer catches what the previous cannot:

| Layer | Mechanism | Catches |
|---|---|---|
| Data integrity | pipeline asserts (Σ pop ≈ 8.03 B, per-file < 100 MB, city spot-checks) | bad/incomplete data, CRS errors |
| Static analysis | `tsc -b` + `eslint .` (CI) | type/lint regressions |
| Unit tests | `npm test` — vitest over the pure render logic (CI) | wrong cull / LOD / encoding math that still type-checks |
| Build | `vite build` (CI) | bundler/import resolution (e.g. subpath imports) |
| Local visual QA | Claude Preview: load, zoom-to-city, screenshot, console/network | render bugs, runtime errors, wrong fetches |
| **Post-deploy E2E** | `npm run verify:live` — fetches + parses the **deployed** manifest/tiers/tile the way the browser does (whole-file + gzip); wired as the `verify-live` CI job after Pages deploy | **deploy-only** failures (CDN gzip+range, propagation, 404s) |
| Live UI smoke | load the deployed URL in a real browser, confirm globe renders + 0 console errors | end-to-end prod rendering |

**Open gap → closed:** local Preview uses the dev server (no gzip), so it could not surface the
CDN gzip+range failure. `verify:live` + the live-UI smoke test now cover the deployed surface.

### Postmortem — 2026-06-08: "parquet footer != PAR1" on live (overview failed to load)
- **Symptom:** deployed globe showed only the dark sphere + an error overlay; data never loaded.
- **Root cause:** GitHub Pages/Fastly gzip `.parquet` (`Content-Encoding: gzip`); hyparquet's
  HTTP **range** reader computed offsets from the uncompressed size while the CDN applied ranges to
  the **compressed** stream → wrong bytes → footer check failed. Local dev (no gzip) and `curl`
  (no `Accept-Encoding: gzip`) both masked it; only the browser (always sends gzip) hit it.
- **Fix:** `src/data/parquet.ts` now fetches each Parquet **whole** (browser decompresses) and parses
  from memory — no range reads. Validated with `verify:live` against the live CDN (ALL PASS).
- **Prevention:** `verify:live` tool + `verify-live` CI gate; QA loop now mandates a live E2E pass.

## Backlog (Sprint 5+)

> The actionable queue now lives in [`specs/TODO.md`](specs/TODO.md) (loop-sized items with
> Accept criteria). This list is the sprint-level history.

- ↳ pulled into **Sprint 3**: geocode search + fly-to + share-state deep-link (+ default zoom-in, zoom controls).
- ↳ pulled into **Sprint 4**: code-split deck.gl; OG/social meta + preview image; default zoom-out.
- ↳ pulled into **Sprint 5**: interaction performance — DPR cap + instanced columns + drag-time
  picking skip; cull cadence + quickselect; r8 idle tile prefetch on pan.
- ↳ **Sprint 6** (user-requested): cartographic presentation — atmospheric limb glow + starfield
  + adaptive DPR sharpening + accessibility (reduced-motion, focus-visible, contrast). Encoding
  and lighting untouched.
- ↳ queued in **specs/TODO.md**: night-lights basemap toggle.
- PWA offline; time-series animation (needs breakdown — see specs/TODO.md backlog).
- (Bilingual RTL he/en UI — dropped per scope decision.)

## Data provenance
Kontur Population 2023-11-01, **CC-BY 4.0**. Attribution wired into the UI footer.
Pipeline regenerates assets via `npm run data`.
