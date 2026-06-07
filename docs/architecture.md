# Architecture — `world-population-globe`

## 1. Vision & scope

An interactive 3D globe ("Google Earth" feel) that renders **world population** as
extruded H3 hexagon columns — height and color encode population per cell. Built as a
static, CDN-served MVP designed to scale toward fine-grained (400 m) global detail.

## 2. System decisions (locked)

| Layer | Choice | Why |
|---|---|---|
| Render | **deck.gl `_GlobeView` + `H3HexagonLayer`** (extruded) | WebGL2, instanced columns, true radial 3D on a globe. GlobeView's only unsupported layers are Heatmap/Contour/Terrain/Mask. |
| Data | **Kontur Population** (H3, CC-BY 4.0, 2023-11-01) | SOTA H3-native global population; ships pre-aggregated resolutions that double as LOD tiers. |
| Format | **SNAPPY Parquet** read by `hyparquet` | Columnar, compact, decoded natively in-browser (no extra codec, no wasm). |
| Infra | **Static → GitHub Pages + CDN** | Zero backend; cheapest path to scale; best valuation/cost ratio. |
| State | **Zustand** | Minimal ephemeral UI/view state without Redux overhead. |

## 3. Data pipeline (`pipeline/build_lods.py`)

```
Kontur *.gpkg.gz  ──download──▶  gunzip  ──DuckDB(spatial)──▶  public/data/*.parquet + manifest.json
   (EPSG:3857)                                │
                                              ├─ select h3, population
                                              ├─ centroid = ST_Transform(ST_Centroid(geom), 3857→4326, always_xy)
                                              └─ COPY … (FORMAT PARQUET, COMPRESSION SNAPPY)
```

- **Vectorized only** — the whole transform is one DuckDB statement; no Python row loops.
- **CRS** — Kontur geometry is **EPSG:3857**; centroids are reprojected to **EPSG:4326**
  (lng/lat) for the client's viewport cull. The H3 index itself is CRS-independent and
  drives hexagon geometry client-side.
- **Column auto-detection** survives minor upstream schema drift (`h3`, `population`, geometry).
- **Output schema** per tier: `h3:VARCHAR, population:FLOAT, lng:FLOAT, lat:FLOAT`.

### LOD tiers (Kontur pre-aggregated resolutions)

| LOD | H3 res | ≈ cell | cells | Parquet | role |
|---|---|---|---|---|---|
| `overview` | r4 | 22 km | 71,283 | 1.2 MB | global hero, always loaded |
| `mid` | r6 | 3 km | 2,016,971 | 31 MB | lazy on zoom-in, viewport-culled |
| _(r8 400 m, 6.6 GB)_ | r8 | 400 m | — | — | Sprint 2: tiled deep zoom |

**Integrity check:** every tier sums to **8,031,924,025 ≈ 8.03 B** (2023 world population);
the densest r4 cells resolve to Cairo, Jakarta, Manila, Karachi, Mumbai.

## 4. Frontend

```
src/
  App.tsx               # full-screen shell + HUD overlays
  components/
    Globe.tsx           # DeckGL + _GlobeView, controlled viewState, idle auto-rotate, lighting
    Header / Controls / Legend / InfoPanel / Attribution / Loader
  layers/useGlobeLayers # sphere (SimpleMeshLayer) + land (GeoJsonLayer) + population (H3HexagonLayer)
  data/
    load.ts             # manifest + LOD loaders → columnar typed arrays
    parquet.ts          # hyparquet column reader (subpath import)
    useGlobeData.ts     # eager overview + lazy finer tiers by zoom band
  lib/
    lod.ts              # pickLod() + cullForView() viewport cull + cap
    scales.ts           # log1p normalization, elevation/earth constants
    colorRamp.ts        # Inferno ramp (RGB + CSS)
    format.ts           # population / lat-lng formatting
  store/useGlobeStore   # Zustand: manifest, data, viewState, hover, autoRotate, status
```

### Rendering & cartographic rules

- **Encoding** — population is right-skewed, so **both** column height and Inferno color use
  `log1p` normalization. Linear would collapse all but megacities into one bucket.
- **Color** — Inferno (perceptually uniform). Rainbow/jet is banned (fabricates breaks).
- **Performance budget**
  - overview (71 k): rendered whole.
  - mid (2 M): **viewport-culled** to a zoom-scaled lng/lat window, capped at 120 k
    highest-population cells/frame; cull memoized on a coarse view key (no per-tick recompute).
  - Data is **columnar typed arrays** + deck.gl non-iterable `{length}` accessors → no per-cell objects.
- **Globe** — dark ocean sphere (`SimpleMeshLayer`, CARTESIAN) + Natural Earth 110 m land
  outline; ambient + directional lighting so columns read as 3D while keeping ramp colors true.

## 5. Deploy

- Vite `base` = `/world-population-globe/` (prod) / `/` (dev); data fetched via `import.meta.env.BASE_URL`.
- GitHub Actions: **CI** (tsc + ESLint + build) and **Pages deploy** (`actions/deploy-pages`).
- No secrets — the basemap is self-rendered; all data is open + static.

## 6. Scale roadmap (post-MVP)

1. **400 m deep zoom** — tile r8 into an H3/quadkey pyramid; stream per-viewport (PMTiles or range-read Parquet shards).
2. **Proper frustum culling** replacing the lng/lat-box approximation.
3. Time-series / animation; search + fly-to; bilingual RTL (he/en) UI; share-state URL; PWA offline.
4. Bundle code-splitting (deck.gl is ~1 MB) via dynamic import.
