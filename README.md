# 🌍 World Population Globe

An interactive 3D globe that renders **world population** as extruded H3 hexagon columns —
height and color encode population per cell. Built with **deck.gl** (`GlobeView` +
`H3HexagonLayer`) over the **Kontur Population** dataset (~8.03 billion people, 2023).

> **Live:** https://zeevmala.github.io/world-population-globe/

![World Population Globe](docs/preview.png)

## Stack

- **React 19 + TypeScript + Vite + Tailwind v4**
- **deck.gl 9** — `_GlobeView`, extruded `H3HexagonLayer`, `SimpleMeshLayer` sphere
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

`npm run data` requires Python with `pip install duckdb`. It downloads the Kontur
22 km (6.6 MB) and 3 km (185 MB) tiers, reprojects centroids, and writes
`public/data/*.parquet` + `manifest.json`. Artifacts are committed, so `npm run dev`
works without re-running the pipeline.

## Scripts

| Script | Action |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run data` | Regenerate LOD Parquet tiles + manifest (`pipeline/build_lods.py`) |
| `npm run typecheck` | `tsc -b` |
| `npm run lint` | ESLint |
| `npm run build` | Typecheck + production build → `dist/` |
| `npm run preview` | Serve the production build |

## How it works

- **Data** — Kontur publishes population on the H3 grid at multiple resolutions; the coarse
  tiers (r4 ≈ 22 km, r6 ≈ 3 km) double as LOD levels. The pipeline extracts `(h3, population)`
  + a reprojected EPSG:4326 centroid and writes compact SNAPPY Parquet.
- **Rendering** — the coarse `overview` tier loads eagerly and renders whole; the dense `mid`
  tier loads lazily on zoom-in and is viewport-culled + capped for performance. Population is
  `log1p`-normalized into the Inferno ramp for both column height and color.
- **Architecture** — see [`docs/architecture.md`](docs/architecture.md). Roadmap & status in
  [`PROJECT_STATE.md`](PROJECT_STATE.md).

## Data & license

Population data © [Kontur](https://www.kontur.io/datasets/population-dataset/) (2023-11-01),
**CC-BY 4.0**, derived from GHSL, Meta, Microsoft Buildings, Copernicus, LINZ, and OpenStreetMap.
Land outline: Natural Earth (public domain). Application code: MIT.
