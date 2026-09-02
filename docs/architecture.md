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
| `overview` | r4 | 22 km | 71,283 | 1.2 MB | global hero, always loaded (zoom < 2.2) |
| `mid` | r6 | 3 km | 2,016,971 | 31 MB | lazy whole-load, viewport-culled (2.2–4.5) |
| `r8` | r8 | 400 m | 32,957,699 | 502 MB · 12,761 tiles | **tiled**, streamed per-viewport (≥ 4.5) |

**Integrity check:** every tier sums to **≈ 8.03 B** (2023 world population) — r4/r6 to
8,031,924,025 and the 33 M-cell r8 pyramid to 8,031,924,024. The densest r4 cells resolve to
Cairo/Jakarta/Manila/Karachi/Mumbai; the Tokyo r3 tile holds 13,586 × 400 m cells (23.4 M pop).

## 3b. r8 tile pyramid & streaming (`pipeline/build_tiles.py`)

The 400 m tier (33 M cells) is too large to load whole, so it is **partitioned by a coarse
H3 parent** and streamed per-viewport. Fetch granularity (coarse tiles, few files) is
deliberately decoupled from render granularity (fine viewport cull).

```
Kontur r8 *.gpkg  ──DuckDB(spatial+h3)──▶  COPY … PARTITION_BY(parent) ──▶  public/data/tiles/r8/parent=<h3>/…parquet
   (EPSG:3857)        │                                                      + index.json (parent → file, cellCount)
                      ├─ parent = h3_h3_to_string(h3_cell_to_parent(h3_string_to_h3(h3), 3))
                      └─ h3, population, lng, lat (centroid 3857→4326)
```

- **Tiling at H3 r3** (~3.4° cells): 12,761 tiles, mean ~32 KB, max 0.27 MB — small enough to
  stream, few enough to commit. (r2 was rejected: single tiles reach tens of MB; r4 → 71 k files.)
- **Client streaming** (`src/data/useTileStreaming.ts`): on a coarse view-key change, compute the
  visible parents (`src/lib/tiles.ts` → h3-js `latLngToCell` + `gridDisk`, k scaled by zoom),
  fetch the missing tiles (`readColumns`), **LRU-cache** (64 tiles, in-flight-deduped), and merge
  the visible tiles' typed arrays into one `LodData` published to the store.
- **Render** reuses the same `H3HexagonLayer` path; the merged set is viewport-culled like `mid`.
- **LOD selection** (`selectActive` in `lib/lod.ts`): r8 wins once zoom ≥ 4.5 and tiles are merged;
  otherwise the finest loaded whole tier (`pickLod`). Shared by `useGlobeLayers` and `Controls`.
- Shared download/decompress/schema/CRS helpers live in `pipeline/kontur_common.py`.

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
    decode.worker.ts    # off-thread fetch + Parquet decode → transferable typed arrays
    decodeClient.ts     # 2-worker pool, request routing, inline fallback
    h3Column.ts         # packed BigUint64 H3 indices + lazy string materialization
    parquet.ts          # hyparquet column reader (subpath import; inline-fallback path)
    useGlobeData.ts     # eager overview + lazy mid by zoom band
    useTileStreaming.ts # r8 viewport tile fetch + LRU cache + merge + idle ring prefetch
  lib/
    density.ts          # cell area per H3 res, people/km², shared cross-tier domain
    lod.ts              # pickLod() + selectActive() + hysteresis + cullForView() + quickselect cap
    tiles.ts            # visibleParents() + prefetchParents() (h3-js gridDisk) + coarse view key
    scales.ts           # zoom-continuous column height + earth constants
    colorRamp.ts        # Inferno ramp (RGB + CSS)
    format.ts           # population / lat-lng formatting
  store/useGlobeStore   # Zustand: manifest, data, viewState, hover, autoRotate, status
```

### Rendering & cartographic rules

- **Encoding — density, not per-cell population.** Both column height and Inferno color are
  `log1p` of **people/km²**, normalized against **one domain shared by every tier**
  (`lib/density.ts` → the densest cell any tier publishes, derived from the manifest).
  This replaced per-tier `log1p(population)/log1p(maxPopulation_of_that_tier)`, which was
  wrong twice over: an r4 cell covers 1,770 km² and an r8 cell 0.74 km² — 2,400× — so the
  same place rendered a different color on each side of a zoom threshold, and the legend's
  "density" label described a quantity the map wasn't drawing. Density is the only quantity
  comparable across resolutions, so it is the one that gets encoded, and the legend now
  prints real people/km² tick values at their true log positions.
  - Cell area is the **nominal average for the resolution**, not per-cell. Real H3 cells
    vary ~±25% around it, which moves a cell <1% along the log ramp; an exact `cellArea()`
    per cell costs ~3.6 µs (≈7 s for the 2 M-cell mid tier), which no budget absorbs. The
    UI says "≈" wherever it surfaces a number derived from it.
- **Column height is continuous in zoom, not stepped per tier.** `maxColumnHeightM(zoom)`
  (`lib/scales.ts`) = `min(800 km, 2.9e6 m · 2^(-1.425·zoom))`, calibrated on the two views
  that ship: the zoom-1.3 hero (800 km columns) and city zoom ≈5.5 (13 km). Height used to
  be `approxKm × 32,000` — a per-tier constant — so crossing a threshold collapsed every
  column ~7× in one frame, the most visible seam in the render. Now both tiers agree on the
  height at the crossing, and the switch changes only mesh resolution. It rides deck.gl's
  `elevationScale` uniform (with `getElevation` returning normalized 0–1 density), so a zoom
  change costs one uniform write — no attribute re-upload, no re-cull.
- **Tier hysteresis** — a tier keeps a 0.15-zoom band once on screen (`lib/lod.ts`), so a
  camera resting on 2.2 or 4.5 can't oscillate and rebuild the layer every frame. The
  rendered tier is published to the store as `activeLod` and fed back in.
- **Color** — Inferno (perceptually uniform). Rainbow/jet is banned (fabricates breaks).
- **Performance budget**
  - overview (71 k): rendered whole.
  - mid (2 M): **viewport-culled** to a zoom-scaled lng/lat window, capped at 120 k
    highest-population cells/frame; cull memoized on a coarse view key (no per-tick recompute).
  - r8 (33 M total): only the visible r3 tiles are fetched, merged, then viewport-culled + capped
    at 120 k/frame — so render cost is bounded regardless of global cell count.
  - Data is **columnar typed arrays** + deck.gl non-iterable `{length}` accessors → no per-cell objects.
  - **Decoding runs in a worker** (`data/decode.worker.ts`, 2-worker pool). Measured on the
    committed data, the mid tier costs **2.44 s** of pure decode (metadata 4 ms · population
    296 ms · lng 163 ms · lat 164 ms · **h3 1,817 ms**) — and it used to run on the main
    thread the instant the camera crossed zoom 2.2, freezing the app mid-gesture. The worker
    fetches and decodes, then **transfers** the buffers, so the main thread pays a postMessage.
  - **H3 indices travel packed.** An H3 index is a 64-bit integer whose canonical string is
    its lowercase hex — always 15 digits (mode-1 sets bit 59). So the column is a
    `BigUint64Array` (transferable, 16 MB for the mid tier vs ~80 MB of JS strings) and the
    string is built only for cells that reach `getHexagon`, bounded by the 120 k render cap
    and memoized per cell. Verified: 2,090,083 real indices across r4/r6/r8 round-trip
    `BigInt('0x'+s).toString(16) === s` with **0 mismatches**, all exactly 15 hex chars.
    The r8 tile merge is now a typed-array `set()` instead of a per-cell string copy.
- **Globe** — dark ocean sphere (`SimpleMeshLayer`, CARTESIAN) + Natural Earth 110 m land
  outline; ambient + directional lighting so columns read as 3D while keeping ramp colors true.
- **Interaction performance** (panning was the user-felt cost — most of it was paid *per
  pointer event* during a drag, invisible to a synthetic `setViewState` benchmark):
  - **Picking off while dragging** — a `pickable` layer re-renders the picking buffer on every
    `pointermove`; an `isDragging` store flag (set from `onInteractionStateChange`) drops
    `pickable` during a drag, so a pan no longer double-draws the whole scene. Hover resumes on release.
  - **Render-buffer cap** — `useDevicePixels ≤ 1.5`; on HiDPI the dark scene is fill-rate bound
    while panning and the cap is visually lossless here.
  - **Instancing — tried and reverted.** `highPrecision: false` (instanced `ColumnLayer`) was
    cheaper in verts but gave every hexagon prism the same face orientation; under the fixed
    directional sun on the `_GlobeView` that produced an N-fold radial "star" of shading across the
    sphere. It was also perf-neutral at overview, so `H3HexagonLayer` stays on `highPrecision: 'auto'`
    (per-cell geometry, varied faces, no star). The pan wins above (picking-skip, DPR cap) carry it.
  - **Re-cull cadence** — `cullKeyFor` quantizes the camera to a zoom-relative step (`halfSpan/4`)
    so the dense-tier cull re-runs ~5–10× less often than the old fixed 1°; `cullForView` scans a
    `1.5×halfSpan` window (wider than the quantum, so edges don't pop) and fills the 120 k cap via
    an O(n) quickselect (`topKByPopulation`) instead of an O(n log n) sort of ~1 M indices.
  - **Idle tile prefetch** — after the visible r8 tiles merge, a `requestIdleCallback` warms the
    `gridDisk` k+1 ring into the LRU cache (no `setR8Data`, so no rebuild), with visible-protecting
    eviction — so panning reveals ready tiles instead of empty gaps.

## 5. Deploy

- Vite `base` = `/world-population-globe/` (prod) / `/` (dev); data fetched via `import.meta.env.BASE_URL`.
- GitHub Actions: **CI** (tsc + ESLint + build) and **Pages deploy** (`actions/deploy-pages`).
- No secrets — the basemap is self-rendered; all data is open + static.

## 6. Scale roadmap

1. ✅ **400 m deep zoom** (Sprint 2) — r8 tiled into an H3-parent pyramid, streamed per-viewport.
2. Sub-tile frustum culling + tile prefetch on pan; optional migration of tiles to a CDN/release
   asset if the in-repo set outgrows GitHub Pages (currently 502 MB, within limits).
3. Time-series / animation; search + fly-to; bilingual RTL (he/en) UI; share-state URL; PWA offline.
4. Bundle code-splitting (deck.gl is ~1 MB) via dynamic import.
