# Data — provenance, integrity & refresh runbook

Everything under `public/data/**` is pipeline output. Never hand-edit it: change
`pipeline/`, re-run, re-assert with `npm run verify:data`.

## 1. What ships today

Kontur Population **2023-11-01**, baked into three LOD tiers. Figures below are not
copied from the manifest — they are what `npm run verify:data` decoded from the
committed Parquet on 2026-08-28 (FULL mode, 19.0 s, `ALL PASS`).

| tier | H3 res | ≈ cell | cells | Σ population | max cell | storage |
|---|---|---|---|---|---|---|
| `overview` | r4 | 22 km | 71,283 | 8,031,924,025 | 22,732,636 | `overview.parquet`, 1,189,500 B |
| `mid` | r6 | 3 km | 2,016,971 | 8,031,924,024 | 1,949,226 | `mid.parquet`, 31,277,924 B |
| `r8` | r8 | 400 m | 32,957,699 | 8,031,924,024 | 40,673 | 12,761 tiles, 502,427,581 B |

`public/data/**` total: **12,766 files, 536.47 MB**. Largest file `mid.parquet`
(31.28 MB); largest tile 267,712 B; tile mean 39,372 B, median 13,022 B, p99 213,780 B.
Plus `tiles/r8/index.json` (1,431,491 B) and `land.geojson` (138,160 B, Natural Earth
110 m basemap outline — not population data).

Per-tier schema: `h3:VARCHAR, population:FLOAT, lng:FLOAT, lat:FLOAT`.

### Why r4 sums to …025 and r6/r8 to …024

Not a data discrepancy. Upstream `kontur_population_20231101_r4.gpkg` holds
`population REAL` (float64) and sums to **8,031,924,024.0** with max
**22,732,635.0** (read directly from the GeoPackage, 2026-08-28). The pipeline
`CAST(... AS FLOAT)`s to float32 for compactness; float32 rounding lifts that max to
22,732,636 and the r4 total to 8,031,924,025. The r6/r8 tiers round the other way and
land on 8,031,924,024. CLAUDE.md's shorthand "r4/r6: 8,031,924,025" is the r4 value —
the exact per-tier totals are the ones in the table above, and they are what
`verify_data.mjs` asserts.

## 2. Source & license

| | |
|---|---|
| Dataset | Kontur Population: Global Population Density for H3 Hexagons |
| Release | `2023-11-01` (upstream objects Last-Modified **2023-10-31**) |
| Landing page | https://www.kontur.io/datasets/population-dataset/ |
| Mirror / catalogue | https://data.humdata.org/dataset/kontur-population-dataset (400 m), `-3km`, `-22km` |
| Distribution used by the pipeline | `https://geodata-eu-central-1-kontur-public.s3.eu-central-1.amazonaws.com/kontur_datasets/` |
| License | **CC-BY 4.0** |
| Upstream inputs | GHSL, Meta/Facebook HRSL, Microsoft Buildings (ODbL), Copernicus GLS land cover, LINZ (CC-BY 4.0), OpenStreetMap (ODbL) |

**Attribution is an obligation, not a courtesy.** CC-BY 4.0 requires appropriate credit
plus an indication that changes were made (this project reprojects centroids and
re-encodes to Parquet). The string lives in `pipeline/kontur_common.py:ATTRIBUTION`, is
copied into `manifest.json`, and is rendered by `src/components/Attribution.tsx` in the
UI footer. It must stay visible in the app; removing it makes the deploy non-compliant.
`verify_data.mjs` fails if `manifest.license !== "CC-BY 4.0"`.

Upstream artefacts (HTTP HEAD, measured 2026-08-28):

| tier | object | gz bytes | Last-Modified |
|---|---|---|---|
| r4 / 22 km | `kontur_population_20231101_r4.gpkg.gz` | 6,659,105 | Tue, 31 Oct 2023 17:22:20 GMT |
| r6 / 3 km | `kontur_population_20231101_r6.gpkg.gz` | 185,340,844 | Tue, 31 Oct 2023 17:22:21 GMT |
| r8 / 400 m | `kontur_population_20231101.gpkg.gz` | 2,436,991,241 | Tue, 31 Oct 2023 17:21:47 GMT |

Only r4, r6 and the full r8 file exist under that prefix; `_r2/_r3/_r5/_r7/_r8/_r11`
all return AccessDenied (the bucket denies `ListBucket`, so a missing key answers 403,
not 404). Do not add a tier that assumes another pre-aggregated resolution exists.

## 3. Upstream schema (verified, not assumed)

`kontur_population_20231101_r4.gpkg` decompresses to 18,182,144 B (2.73×) and contains:

```
gpkg_contents:          population | features | srs_id 3857
gpkg_geometry_columns:  population.geom | GEOMETRY | srs_id 3857
table "population":     fid INTEGER, geom GEOMETRY, h3 TEXT, population REAL
rows: 71,283            (all population > 0 — the pipeline's `> 0` filter drops nothing at r4)
```

This is exactly what `pipeline/kontur_common.py:detect_columns()` looks for (`h3`,
`population`, first GEOMETRY column, case-insensitive). The detector tolerates minor
renames; it does **not** tolerate a resolution suffix change or a switch away from
GeoPackage. Re-run this check before trusting any new release.

## 4. CRS handling

- Kontur geometry is stored in **EPSG:3857** (confirmed above: `srs_id 3857` in both
  `gpkg_contents` and `gpkg_geometry_columns`).
- `kontur_common.centroid_4326()` emits
  `ST_Transform(ST_Centroid(geom), 'EPSG:3857', 'EPSG:4326', always_xy := true)`.
  `always_xy` is load-bearing: without it PROJ returns EPSG:4326 in its authority order
  (lat, lng) and every `lng`/`lat` column silently swaps.
- The published `lng`/`lat` columns exist only for the client's viewport cull
  (`src/lib/lod.ts`). Hexagon geometry comes from the **H3 index**, which is
  CRS-free — so a CRS mistake shows up as mis-culled cells, not as displaced hexagons.
  `verify_data.mjs` bounds-checks lng ∈ [-180,180] / lat ∈ [-90,90], which catches an
  axis swap only outside ±90 lng; the `always_xy` flag is the real guard.
- `manifest.crs` is `EPSG:4326` and describes the emitted centroids, not the source.

## 5. Integrity invariants (P0 — must hold after any refresh)

1. Each tier's Σ population is the exact value in §1 and stays ≈ 8.03 B.
2. Parquet row count == the tier's `cellCount`; per-tile rows == the tile's `cellCount`.
3. Σ of the 12,761 per-tile `cellCount`s == the r8 `cellCount` (32,957,699), and every
   tile listed in `index.json` exists on disk with no unlisted `parent=` dir beside it.
4. Every r8 cell rolls up to the H3 r3 parent named by its directory
   (`cellToParent(cell, 3) === parent`). A mis-partitioned pyramid renders holes and
   duplicate cells, and nothing else catches it.
5. Every H3 index carries its tier's resolution (nibble 1 of the 15-char index).
6. Populations finite and non-negative; lng/lat in range.
7. **Every committed file < 100 MB** — GitHub's hard blob limit. `build_tiles.py`
   already aborts above 95 MB and tells you to use a finer `--tile-parent-res`.
8. `manifest.license == "CC-BY 4.0"`, `manifest.crs == "EPSG:4326"`, and every
   `LodEntry` carries the fields `src/types.ts` declares.

## 6. Verify

```bash
npm run verify:data            # FULL: reads all 12,761 r8 tiles — ~19 s, no network
npm run verify:data -- --sample=500      # 500 strided tiles; existence + Σ cellCount still cover all
node scripts/verify_data.mjs --concurrency=16
```

Offline and read-only: it opens the committed `public/data/**` from disk with the same
hyparquet path the browser uses. Prints `PASS`/`FAIL` per assertion, a per-tier summary
table, and `ALL PASS` or `N FAILURE(S)`; exit code is non-zero on any failure. FULL is
the default and the mode is printed on line 2 — a `SAMPLE` run explicitly `SKIP`s the
all-tile Σ-population assertion, so never accept a sampled run as a release gate.

This is the offline twin of `npm run verify:live`, which proves the *deployed* files
parse over HTTP. Both are needed: `verify:data` catches a bad bake before it is
committed; `verify:live` catches CDN/transport failures (e.g. the Pages gzip + range
incompatibility, postmortem 2026-06-08).

## 7. Refresh procedure

Prerequisites: Python with `pip install duckdb` (the DuckDB `spatial` and community
`h3` extensions are installed by the scripts), Node deps installed, and **≥ 12 GB free
disk** — ~2.63 GB of `.gz` plus ~7.1 GB of decompressed GeoPackage land in
`pipeline/.cache/` (gitignored, never deleted automatically), on top of the 536 MB of
output.

```bash
# 1. Point the pipeline at the new release.
#    pipeline/kontur_common.py : DATA_DATE, ATTRIBUTION (and S3 if the prefix moves)
#    pipeline/build_lods.py    : Tier.url  -> kontur_population_<DATE>_r{res}.gpkg.gz
#    pipeline/build_tiles.py   : R8_URL    -> kontur_population_<DATE>.gpkg.gz

# 2. Coarse tiers (downloads 6.7 MB + 185 MB gz).
npm run data                       # -> overview.parquet, mid.parquet, manifest.json

# 3. r8 pyramid (downloads 2.44 GB gz, decompresses to ~6.6 GB).
python pipeline/build_tiles.py --measure-only     # count populated cells (downloads+decompresses first)
npm run data:tiles                                # r3 parents (the shipped pyramid) — see below

# 4. Gate.
npm run verify:data
npm run verify                     # lint + typecheck + build
```

Notes that will bite you:

- **Keep `--tile-parent-res` at 3.** That is the shipped pyramid (12,761 tiles, 0.27 MB
  max) and, since 2026-08-28, the script default — it used to default to `2`, the
  resolution `docs/architecture.md` §3b explicitly rejects, so a bare `npm run data:tiles`
  silently rebuilt tens-of-MB tiles that still passed the 95 MB guard.
  `useTileStreaming` sizes its `gridDisk` from `index.json`'s `parentRes`, so a coarser
  pyramid does not error — the client just streams far more bytes per viewport.
- `build_tiles.py` **`rmtree`s `public/data/tiles/r8` first.** A failed run leaves you
  with no tiles; nothing is incremental.
- Order matters: `build_lods.py` writes `manifest.json`, `build_tiles.py` only patches
  the `r8` entry into an existing one and exits if it is missing.
- Both `pipeline/.cache/*.gpkg.gz` and `*.gpkg` are cache-hit-skipped by name. Changing
  `DATA_DATE` without changing the cache filenames (`kontur_r4.gpkg.gz` etc.) will
  re-use the **old** download. Clear `pipeline/.cache/` on a version bump.
- Runtime is download-bound (2.6 GB over the wire) plus one vectorized DuckDB
  `COPY … PARTITION_BY (parent)` over 33 M rows. Not re-measured in this audit — do not
  quote a figure you have not observed.
- Every refresh rewrites all 12,761 tile blobs. Git cannot delta compressed Parquet, so
  the ~502 MB of tiles is added to history again; `.git` is already 329 MB. Budget for
  that, or move the pyramid to a release asset / CDN (already flagged in
  `docs/architecture.md` §6).

## 8. Freshness audit — 2026-08-28

**Finding: no newer Kontur Population release could be confirmed. `2023-11-01` is still
current.**

Evidence:

1. **Direct probe of the distribution bucket the pipeline downloads from.** HEAD on
   `…/kontur_datasets/kontur_population_<YYYYMMDD>_r4.gpkg.gz` for **every date from
   2024-01-01 through 2026-09-30** (1,004 dates) → zero 200s. The same sweep over
   **2022-01-01 … 2023-12-31** (730 dates) returned exactly one hit, `20231101` — a
   positive control proving the probe works and that the bucket keeps only the current
   release under this prefix. The undated/`_latest`/`_v2` name variants all 403.
2. **HDX / kontur.io could not be fetched from this session** — `data.humdata.org`,
   `www.kontur.io` and `geo.btaa.org` are all blocked by this environment's egress
   policy (report, do not route around). Web-search summaries of those pages
   consistently give last-modified **2023-10-31**, temporal coverage **2020-03-11 →
   2023-11-01**, update frequency "as needed", and resource sizes 6.6 GB / 169 MB /
   6 MB for 400 m / 3 km / 22 km. The 6.6 GB figure matches the *decompressed* 400 m
   GeoPackage implied by the measured 2.44 GB `.gz` and the 2.73× r4 ratio.
3. GitHub code search for `kontur_population_2024|2025|2026` → 0 results.

Caveat: (1) and (3) are direct observations; (2) is second-hand because the pages are
unreachable here. Re-check by opening
https://data.humdata.org/dataset/kontur-population-dataset from an unrestricted network
before concluding the dataset is stale rather than merely unchanged.

### Upgrade path, when a newer release does land

The schema is stable across Kontur releases (`h3 TEXT`, `population REAL`, EPSG:3857
geometry) and `detect_columns()` is written for drift, so the expected change is a date
string in three places (§7 step 1) — no pipeline rewrite.

Cost of a full refresh at today's magnitudes:

| item | cost |
|---|---|
| download | 2.63 GB (`.gz`: 2.44 GB r8 + 185 MB r6 + 6.7 MB r4) |
| peak disk | ~9.8 GB in `pipeline/.cache/` + 536 MB of output |
| runtime | download-bound; one DuckDB pass over ~33 M rows (not measured here) |
| repo delta | ~502 MB of new tile blobs added to git history per refresh |

Guard rails to re-check after the bake, all covered by `npm run verify:data`:

- Largest tile stays ≪ 100 MB (today 0.27 MB at r3; `build_tiles.py` aborts at 95 MB).
- Published site size stays under the **1 GB GitHub Pages** limit — today ~537 MB of
  data plus the bundle, so roughly half the budget. A release that grows cell count
  materially, or a shift to r4 parents (≈ 71 k files), needs the CDN/release-asset move
  in `docs/architecture.md` §6 rather than a bigger commit.
- Σ population will change with the release; update the constants in
  `scripts/verify_data.mjs` (`EXPECTED_SUM`, `EXPECTED_R8_CELLS`, `EXPECTED_R8_TILES`)
  and `docs/architecture.md` §3 in the same commit, and record the old and new totals
  in `PROJECT_STATE.md`. Changing those constants to make a red run go green without
  explaining the delta is how bad data ships.
