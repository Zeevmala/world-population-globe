# 🌍 World Population Globe

An interactive 3D globe that renders **world population** as extruded H3 hexagon columns —
height and color both encode population density (people/km², log scale). Built with
**deck.gl** (`GlobeView` + an extruded `PolygonLayer` of H3 cells) over the **Kontur
Population** dataset (~8.03 billion people, 2023).

> **Live:** https://zeevmala.github.io/world-population-globe/

![World Population Globe](docs/preview.png)

## Stack

- **React 19 + TypeScript + Vite + Tailwind v4**
- **deck.gl 9** — `_GlobeView`, extruded `PolygonLayer` of H3 cell boundaries, `SimpleMeshLayer` sphere
- **Zustand** — view/UI state
- **hyparquet** — in-browser columnar Parquet reader (SNAPPY, no wasm)
- **Python + DuckDB** (spatial) — the data pipeline
- Static deploy on **GitHub Pages** (no backend, no API keys)

## Quick start

```bash
npm install
npm run data     # build LOD Parquet tiles from Kontur (Python + DuckDB; see below)
npm run dev      # http://localhost:5173
```

`npm run data` requires Python with `pip install -r pipeline/requirements.txt`. It downloads
the Kontur 22 km (6.6 MB) and 3 km (185 MB) tiers, reprojects centroids, derives the 9 km r5
tier as the H3-parent roll-up of the 3 km one, and writes `public/data/*.parquet` +
`manifest.json` (zoom bands from `pipeline/tiers.py`). Artifacts are committed, so `npm run dev`
works without re-running the pipeline.

## Scripts

| Script | Action |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run data` | Regenerate LOD Parquet tiles + manifest (`pipeline/build_lods.py` → `build_parents.py`) |
| `npm run typecheck` | `tsc -b` |
| `npm run lint` | ESLint |
| `npm run verify` | Lint + typecheck + production build — one exit code (the loop verifier) |
| `npm run build` | Typecheck + production build → `dist/` |
| `npm run preview` | Serve the production build |

## How it works

- **Data** — Kontur publishes population on the H3 grid at multiple resolutions; r4 ≈ 22 km,
  r6 ≈ 3 km and r8 ≈ 400 m double as LOD levels, and r5 ≈ 9 km is summed from r6 into its H3
  parents. The pipeline extracts `(h3, population)` + an EPSG:4326 centroid and writes compact
  SNAPPY Parquet (r8 as 12,761 r3-parent tiles).
- **Rendering** — each tier switches on where its hexagons are ~3 px across: `overview` (r4)
  below zoom 3.78, `r5` to 5.18, `mid` (r6) to 7.99, then the streamed r8 tiles to the zoom-10
  maximum. The coarse `overview` tier loads eagerly and renders whole; the finer whole tiers
  load lazily on zoom-in and are viewport-culled + capped for performance. Population is
  `log1p`-normalized into the Inferno ramp for both column height and color.
- **Architecture** — see [`docs/architecture.md`](docs/architecture.md). Roadmap & status in
  [`PROJECT_STATE.md`](PROJECT_STATE.md); work queue + autonomous-iteration loop contract in
  [`specs/TODO.md`](specs/TODO.md).

## Data & license

Population data © [Kontur](https://www.kontur.io/datasets/population-dataset/) (2023-11-01),
**CC-BY 4.0**, derived from GHSL, Meta, Microsoft Buildings, Copernicus, LINZ, and OpenStreetMap.
Land outline: Natural Earth (public domain). Application code: MIT.
