# PROJECT_STATE — `world-population-globe`

> PM tracker. Source of truth for sprint status and iteration loop.
> Last updated: 2026-06-07.

## Product

3D population globe (deck.gl GlobeView + extruded H3 columns), Kontur Population data,
static deploy on GitHub Pages. See [`docs/architecture.md`](docs/architecture.md).

## Status: Sprint 1 — vertical slice ✅ (deploying)

| # | Task | State |
|---|---|---|
| 1 | Scaffold Vite + React + TS + Tailwind, deps | ✅ done |
| 2 | Data pipeline: Kontur r4/r6 → SNAPPY Parquet + manifest | ✅ done |
| 3 | Trackers: architecture.md, PROJECT_STATE.md, README | ✅ done |
| 4 | Globe frontend: sphere + land + extruded H3 columns, LOD, HUD | ✅ done |
| 5 | Verify: typecheck + lint + build + visual QA | ✅ done |
| 6 | Repo + CI/CD + GitHub Pages deploy | ⏳ in progress |

### Verification log (Sprint 1)
- `tsc -b`, `eslint .`, `vite build` — all clean.
- Data integrity: all tiers sum to 8.03 B; top r4 cells = Cairo/Jakarta/Manila/Karachi/Mumbai.
- Visual QA (Claude Preview): globe + Inferno towers render; auto-rotate works; 0 console errors;
  mobile + desktop layouts clean.

### Known gaps / smoke tests pending
- [ ] Live **zoom-in** test of the `mid` (2 M-cell) tier on the deployed site (lazy load + cull path).
- [ ] Confirm GitHub Pages serves Parquet (`asyncBufferFromUrl` range requests) under the repo subpath.

## Iteration loop
1. Pull a backlog item into a sprint task.
2. Architecture note (if non-trivial) → `docs/architecture.md`.
3. Implement (typed, vectorized, modular). 4. `tsc + eslint + build` + Preview QA.
5. Update this file + commit. 6. Deploy via CI.

## Backlog (Sprint 2+)
- **400 m (r8) deep zoom**: tile pyramid + per-viewport streaming (PMTiles / range-read shards).
- Replace lng/lat-box cull with true frustum culling.
- Tooltip/fly-to search (geocode), share-state URL.
- Bilingual RTL (he/en) UI; PWA offline; night-lights basemap toggle.
- Code-split deck.gl (dynamic import) to cut the ~1 MB bundle.
- OG/social meta + pre-publish QA (see `github-portfolio-deploy`).

## Data provenance
Kontur Population 2023-11-01, **CC-BY 4.0**. Attribution wired into the UI footer.
Pipeline regenerates assets via `npm run data`.
