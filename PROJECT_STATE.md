# PROJECT_STATE — `world-population-globe`

> PM tracker. Source of truth for sprint status and iteration loop.
> Last updated: 2026-06-07.

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
- [ ] Manual live **zoom-in** smoke test of the `mid` (2 M-cell) tier (lazy load + cull path) — assets confirmed served; interactive pass pending.

## Status: Sprint 2 — 400 m (r8) deep-zoom tile streaming ⏳

| # | Task | State |
|---|---|---|
| 7 | r8 tile pyramid: download + DuckDB partition by H3 parent + index | ⏳ in progress |
| 8 | Client tile streaming (`useTileStreaming`) + visible-parent enumeration | ✅ done |
| 9 | Wire r8 LOD band + rendering (`selectActive`, store r8 slice) | ✅ done |
| 10 | Docs (architecture tiling section, this board) | ⏳ in progress |
| 11 | Verify (integrity, zoom QA, build) | ☐ |
| 12 | Deploy (commit, push, smoke test) | ☐ |

Approach: r8 cells partitioned by a coarse H3 parent → many small Parquet tiles +
`index.json`; client computes visible parents (h3-js `gridDisk`), fetches/LRU-caches/merges
tiles per viewport, renders via the existing `H3HexagonLayer` path, viewport-culled.
LOD bands: overview r4 (<2.2) → mid r6 (2.2–4.5) → r8 (≥4.5).

## Iteration loop
1. Pull a backlog item into a sprint task.
2. Architecture note (if non-trivial) → `docs/architecture.md`.
3. Implement (typed, vectorized, modular). 4. `tsc + eslint + build` + Preview QA.
5. Update this file + commit. 6. Deploy via CI.

## Backlog (Sprint 3+)
- Tooltip/fly-to search (geocode), share-state URL.
- Bilingual RTL (he/en) UI; PWA offline; night-lights basemap toggle.
- Code-split deck.gl (dynamic import) to cut the ~1 MB bundle.
- OG/social meta + pre-publish QA (see `github-portfolio-deploy`).

## Data provenance
Kontur Population 2023-11-01, **CC-BY 4.0**. Attribution wired into the UI footer.
Pipeline regenerates assets via `npm run data`.
