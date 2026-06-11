# PROJECT_STATE — `world-population-globe`

> PM tracker. Source of truth for sprint status and iteration loop.
> Last updated: 2026-06-10.

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

## Iteration loop

Human / sprint cadence (this file is the PM log):
1. Pull a backlog item into a sprint task.
2. Architecture note (if non-trivial) → `docs/architecture.md`.
3. Implement (typed, vectorized, modular).
4. **Verify (all layers below)** → 5. Update this file + commit → 6. Deploy via CI → 7. **Post-deploy gate**.

Autonomous cadence (loop-engineering scaffolding, added 2026-06-11):
- **Queue + loop contract:** [`specs/TODO.md`](specs/TODO.md) — the loop's spine; one item = one tick = one commit.
- **Anchors read every tick:** [`CLAUDE.md`](CLAUDE.md) operating rules + invariants; [`VISION.md`](VISION.md) north star.
- **Per-tick prompt:** [`PROMPT.md`](PROMPT.md); **runner:** [`Invoke-RalphLoop.ps1`](Invoke-RalphLoop.ps1)
  (max-iter cap, no-progress ×3 halt, line-anchored `BLOCKED:` sentinel, per-iteration logs; worktree-only).
- **`/loop` maintenance default:** [`.claude/loop.md`](.claude/loop.md) (uncommitted work → CI/deploy health → `verify:live` → queue).
- **Verifier:** `npm run verify` (eslint + tsc + vite build, one exit code) locally; CI + `verify-live` post-deploy.

## QA & verification loop

Defense in depth — each layer catches what the previous cannot:

| Layer | Mechanism | Catches |
|---|---|---|
| Data integrity | pipeline asserts (Σ pop ≈ 8.03 B, per-file < 100 MB, city spot-checks) | bad/incomplete data, CRS errors |
| Static analysis | `tsc -b` + `eslint .` (CI) | type/lint regressions |
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
- ↳ queued in **specs/TODO.md**: responsive mobile framing; r8 tile prefetch on pan; night-lights basemap toggle.
- PWA offline; time-series animation (needs breakdown — see specs/TODO.md backlog).
- (Bilingual RTL he/en UI — dropped per scope decision.)

## Data provenance
Kontur Population 2023-11-01, **CC-BY 4.0**. Attribution wired into the UI footer.
Pipeline regenerates assets via `npm run data`.
