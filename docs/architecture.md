# Architecture — `world-population-globe`

## 1. Vision & scope

An interactive 3D globe ("Google Earth" feel) that renders **world population** as
extruded H3 hexagon columns — height and color encode population per cell. Built as a
static, CDN-served MVP designed to scale toward fine-grained (400 m) global detail.

## 2. System decisions (locked)

| Layer | Choice | Why |
|---|---|---|
| Render | **deck.gl `_GlobeView` + extruded H3 cells** (the `PolygonLayer` that `H3HexagonLayer` renders on a globe, fed from a boundary cache — see *Boundary cache* below) | WebGL2, per-cell true geometry, true radial 3D on a globe. GlobeView's only unsupported layers are Heatmap/Contour/Terrain/Mask. |
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
| `overview` | r4 | 22 km | 71,283 | 1.2 MB | global hero, always loaded (zoom < 3.78) |
| `r5` | r5 | 9 km | 393,791 | 6.4 MB | lazy whole-load, viewport-culled (3.78–5.18) — **H3-parent roll-up of `mid`** |
| `mid` | r6 | 3 km | 2,016,971 | 31 MB | lazy whole-load, viewport-culled (5.18–7.99) |
| `r8` | r8 | 400 m | 32,957,699 | 502 MB · 12,761 tiles | **tiled**, streamed per-viewport (7.99 to the zoom-10 maximum) |

**Bands are cut by on-screen cell size** (decided 2026-11-18, Option A in `specs/TODO.md`):
a tier starts where its hexagon is **3 CSS px across flats at the equator**. On deck.gl's
GlobeView px/km at the view center = 512·2^zoom / (2π·6371·cos lat) (held to the real
`GlobeViewport` within 1 % by `src/lib/bands.test.ts`), and an H3 hexagon of mean area A is
√(2A/√3) across, which puts r5 at 3.78, r6 at 5.18 and r8 at 7.99. The old bands (2.2 / 4.5,
maximum zoom 7) switched each tier on ~3 zoom levels before its cells were visible — r6 cells
0.4 px across at 2.2, r8 cells 0.3 px at 4.5 — so the 120 k cap truncated sub-pixel prisms.
The tier table and the rule live in **one** place, `pipeline/tiers.py`; every pipeline script
reads it and `build_parents.py` re-applies it to the whole manifest, which the client reads —
nothing in `src/` types a band. `scripts/bands.test.mjs` pins the committed manifest to the rule.
r5 is not a Kontur file (Kontur publishes r4, r6, r8): `pipeline/build_parents.py` rolls the
committed r6 up to its H3 parents in DuckDB SQL (bit arithmetic, no extension) and places each
r5 cell at its H3 center (h3ronpy) — populations are integers, so the roll-up is exact.

**Integrity check:** every tier sums to **≈ 8.03 B** (2023 world population) — r4 to
8,031,924,025, r5/r6 and the 33 M-cell r8 pyramid to 8,031,924,024. The densest r4 cells resolve to
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
- **Client streaming** (`src/data/useTileStreaming.ts`): **one `TileStream` per tiled manifest
  entry** (its own cache, retry state and timers; nothing in `src/` names a tiled tier), each
  publishing a `TileSet` to the store's `tiles[lod]`. A stream runs while its band is reached or its
  tier is on screen (`streamWanted`). On a change of the **tile key — the cull's bucket key**
  (canvas W×H, zoom in 1/8 steps, center in Mercator steps of 1/6 of the shorter side) it selects
  the parents (at the entry's `tileParentRes`) whose cells **overlap the key's cull window**
  (`src/lib/tiles.ts` `selectParents`: a flood fill over `gridDisk` neighbours, each cell's edge arcs
  tested exactly against the window's bounding planes — no sampling, no lng/lat seam; h3-js `polygonToCells` reads edges as lng/lat
  lines and takes any > 180° span as antimeridian-crossing), so every view sharing the key has
  its tiles. It fetches the missing ones, **LRU-caches** them (64 tiles, in-flight-deduped) and
  merges the typed arrays into one `LodData` — only when the drawn merge lacks a loaded tile or
  holds over twice as many (`needsMerge`), since every merge is a new tier object the cull pays
  12 B/cell of unit vectors for. Visible + the prefetch ring fit the 64-tile cache (the ring is cut
  nearest-first when they would not: only at 1920×1080, zoom 8, over the smallest r3 cells —
  ~50 visible + 32 ring). The bookkeeping lives in `src/data/tileStream.ts` (pure, Node-tested). Visible tiles are awaited with `allSettled`: a
  failed tile never blanks the view — the tiles that loaded are published, the failed one is
  retried on a 2 s / 4 s backoff (and by any later view that wants it), at most 3 attempts per
  burst; a spent tile rests 30 s after its last failure, then gets a fresh burst (the view's retry
  timer wakes for it), so an outage heals instead of leaving permanent holes. One `console.warn`
  per tile per burst; the clock is injectable so Node tests cover all of it.
- **Render** reuses the same population layer (`layers/populationLayer.ts`); the merged set is viewport-culled like `mid`.
- **LOD selection** (`selectActive` in `lib/lod.ts`): walk from the finest tier whose band is
  reached (with hysteresis) down to the first with data **for this view** — a whole tier once
  loaded, a tiled tier once its published parents cover the screen (`tileSetCovers`: exact on
  the set's own key; off it, the canvas border is walked every 16 px against the settled
  parents). So the tier on screen keeps drawing while the next tier's tiles load, a pan into
  unloaded tiles falls back to the tier below rather than drawing a previous view's tiles, and a
  cold deep link draws the finest tier loaded. The result is published as `activeLod`, which
  `Controls` reads. **Loading** (`wholeTierFor`, `lib/tierPlan.ts`): only the finest whole tier whose
  band is reached is fetched, so a cold deep link to street zoom pulls overview + mid (the
  fallback under the r8 tiles) and skips r5; zooming through a band still loads its tier.
- Shared download/decompress/schema/CRS helpers live in `pipeline/kontur_common.py`.

## 4. Frontend

```
src/
  App.tsx               # full-screen shell + HUD overlays
  components/
    Globe.tsx           # DeckGL + _GlobeView, controlled viewState, idle auto-rotate, lighting
    Header / Controls / Legend / InfoPanel / Attribution / Loader
  layers/useGlobeLayers # sphere (SimpleMeshLayer) + land (GeoJsonLayer) + population (layers/populationLayer: H3 cells as a PolygonLayer, cached boundaries)
  data/
    load.ts             # manifest + LOD loaders → columnar typed arrays
    decode.worker.ts    # off-thread fetch + Parquet decode → transferable typed arrays
    decodeClient.ts     # 2-worker pool, request routing, inline fallback
    h3Column.ts         # packed BigUint64 H3 indices + lazy string materialization
    parquet.ts          # hyparquet column reader (subpath import; inline-fallback path)
    useGlobeData.ts     # eager overview + lazy r5 / mid by zoom band (wholeTierFor)
    tileStream.ts       # one tiled tier's tile cache: LRU eviction, dedupe, merge, bounded retry
    useTileStreaming.ts # every tiled tier: tile key → selectParents → tileStream, retry timer, idle ring prefetch
  lib/
    density.ts          # cell area per H3 res, people/km², shared cross-tier domain
    lod.ts              # pickLod() + selectActive() + hysteresis + cullForView() + quickselect cap
    footprint.ts        # what GlobeView shows for a view + canvas; the cull's key and window
    tierPlan.ts         # wholeTierFor() (which whole tier to fetch) + arrivalZoom() (search fly-to zoom)
    screenScale.ts      # GlobeView px/km + hexagon width — the model the bands are cut from
    zoomLadder.ts       # the zoom ladder's tier bands + cell-size labels, from the manifest
    tiles.ts            # selectParents() (parents overlapping the cull window + ring), tileSetCovers(), tileKey()
    scales.ts           # zoom-continuous column height + earth constants
    colorRamp.ts        # Inferno ramp (RGB + CSS)
    format.ts           # population / lat-lng formatting
  store/useGlobeStore   # Zustand: manifest, data, viewState, canvas size, hover, autoRotate, status
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
  (`lib/scales.ts`) = `min(800 km, max(1 km, 2.9e6 m · 2^(-1.425·zoom)))`, calibrated on the
  zoom-1.3 hero (800 km columns) and zoom ≈5.5 (13 km). The 1 km floor (since the zoom-10
  re-band) takes over at zoom ≈ 8.07, just past r8's entry: the decay alone left a 149 m
  (≈ 2 px) column over a 12 px cell at zoom 10; with the floor a full-domain r8 column stays
  about as tall as its 0.92 km cell is wide, and zooming in magnifies a fixed scene. Tallest
  column at the equator: zoom 5 → 20.8 km / 8.5 px, 7 → 2.88 km / 4.7 px, 8.5 → 1 km / 4.6 px,
  10 → 1 km / 13.1 px. Height used to
  be `approxKm × 32,000` — a per-tier constant — so crossing a threshold collapsed every
  column ~7× in one frame, the most visible seam in the render. Now both tiers agree on the
  height at the crossing, and the switch changes only mesh resolution. It rides deck.gl's
  `elevationScale` uniform (with `getElevation` returning normalized 0–1 density), so a zoom
  change costs one uniform write — no attribute re-upload, no re-cull.
- **Tier hysteresis** — a tier keeps a 0.15-zoom band once on screen (`lib/lod.ts`), so a
  camera resting on a threshold (3.78 / 5.18 / 7.99) can't oscillate and rebuild the layer every frame. The
  rendered tier is published to the store as `activeLod` and fed back in.
- **Color** — Inferno (perceptually uniform). Rainbow/jet is banned (fabricates breaks).
- **Performance budget**
  - overview (71 k): rendered whole.
  - r5 (394 k) and mid (2 M): **viewport-culled** to what the canvas actually shows
    (`lib/footprint.ts`), capped at 120 k cells/frame — on-screen cells first, then by
    population; cull memoized on a coarse view key that includes the canvas size (no per-tick
    recompute).
  - r8 (33 M total): only the visible r3 tiles are fetched, merged, then viewport-culled + capped
    at 120 k/frame — so render cost is bounded regardless of global cell count.
  - Data is **columnar typed arrays** + deck.gl non-iterable `{length}` accessors → no per-cell objects.
  - **Decoding runs in a worker** (`data/decode.worker.ts`, 2-worker pool). Measured on the
    committed data, the mid tier costs **2.44 s** of pure decode (metadata 4 ms · population
    296 ms · lng 163 ms · lat 164 ms · **h3 1,817 ms**) — and it used to run on the main
    thread the instant the camera crossed into its band (then zoom 2.2), freezing the app mid-gesture. The worker
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
    sphere. It was also perf-neutral at overview, so the population layer stays on the per-cell
    polygon path (`highPrecision: 'auto'`, which on a `_GlobeView` always resolves to it — varied
    faces, no star). The pan wins above (picking-skip, DPR cap) carry it.
  - **Boundary cache** — that per-cell path paid `cellToBoundary` three times per cell
    (`PolygonLayer._getPaths`, then the polygon tesselator's sizing + fill passes) on every
    re-cull, though adjacent cull windows share ~97 % of their cells. `layers/populationLayer.ts`
    now renders the `PolygonLayer` that `H3HexagonLayer` rendered, without the wrapper: same
    class, bit-identical geometry, same forwarded props (all asserted in
    `populationLayer.test.ts`). One thing had to be compensated: deck.gl's default depth bias
    (`getPolygonOffset` = `-layerIndex × 100`) counts every layer in the tree, composites
    included, so dropping the wrapper level lowered the fill's `layerIndex` by 1 and a few
    near-coplanar column slivers lost the depth test to the land fill. The layer's
    `getPolygonOffset` uses `layerIndex + 1`, restoring the old offset exactly (pinned by a test
    against deck's own `layerIndexResolver` on both trees; revisit if the tree shape changes).
    Its `getPolygon` is served from a bounded LRU (`lib/h3Boundary.ts`): keyed on the packed 64-bit index
    as two uint32 words (survives r8 tile merges, shared across tiers), flat typed storage, hard cap
    2^18 cells ≈ 32 MB, fresh plain-array output (a small `Float64Array` costs ~0.8 µs to allocate in
    V8). Geometry is held bit-identical to deck.gl's `h3ToPolygon` + `flattenPolygon`, cold and warm.
    Repeat-cull boundary cost on the mid tier dropped 11–15× (`scripts/bench/boundary_bench.mjs`).
  - **Cull window = the real footprint** (replaced the zoom-only cap, whose `min(60, 180/2^zoom)`
    radius matched neither the canvas nor the latitude: at zoom 5.5 on 1280×800 it drew a disc
    about half as wide as the screen at the equator and over-selected ~3× at 70° N).
    `lib/footprint.ts` is a closed form of deck.gl's `GlobeViewport` (eye on the radius through
    the view center at `1 + 1.5·π·H·cos lat / (256·2^zoom)` globe radii, focal length 1.5·H px,
    latitude clamped to ±85.0511°; held to the viewport's own project/unproject within 0.01 px
    in `footprint.test.ts`). On screen = in front of the horizon (`u·c ≥ 1/k`) and projected
    inside the canvas. **Key**: tier, canvas W×H, zoom in steps of 1/8, view center in Web
    Mercator steps of 1/6 of the canvas's shorter side — Mercator because GlobeView scales
    the view center exactly like it, so one step is the same share of the screen at every
    latitude. **Window** (a function of the key alone): the union of the footprints of every
    view on the key — sampled bucket centers at the bucket's lowest zoom (a footprint only
    shrinks as zoom rises), their boundaries mapped into one perspective chart at the bucket
    center and bounded there (the canvas rectangle grown by the measured drift), cut by a cap
    of (center distance + footprint reach), +1 % slack. The rectangle, not a circle: a cap
    around a 16:10 canvas is ~3× its area. Test: under the cap, every cell deck.gl draws for
    any view sharing the key is kept (lat 0–85, zoom 3.6–10, three canvases, poles,
    antimeridian), and the selection is ≤ 2.5× the on-screen count. The zoom step went from
    0.25 to 1/8 for that bound: at the r5 entry over mid-latitudes the footprint's area grows
    1.8× across a 0.25 zoom step (its corners sit near the limb). When the window holds more
    than the cap (each part capped by an O(n) quickselect on population, `topKByPopulation`),
    the triggering view's on-screen cells come first, so the view that triggered the cull
    is drawn complete whenever it has ≤ 120 k cells on screen
    (`scripts/bench/cull_coverage.mjs`). That is not yet true of every other view on the
    same key: while the window exceeds the cap, the cells left out are the least populated
    ones in the margin, and a view that has drifted toward that margin can be missing 3–7 %
    of its on-screen cells until the next re-cull (measured on r5 and r6 at their entry
    zooms). The window only fits the cap everywhere once tier selection budgets for the
    margin — see the selection item in `specs/TODO.md`. Per cell the test
    is three dot products on cached float32 unit vectors (12 B/cell: 24 MB for mid, 4.7 MB for
    r5, built once per tier object on its first cull, ~50 ms for mid) — no per-cell trig;
    a re-cull of mid costs about what the old cap did (`scripts/bench/cull_bench.mjs`).
  - **Idle tile prefetch** — after the visible tiles merge, a `requestIdleCallback` warms the ring
    of parents around them into the LRU cache (no publish, so no rebuild), with visible-protecting
    eviction — so panning reveals ready tiles instead of falling back.

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
