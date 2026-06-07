#!/usr/bin/env python3
"""Build the r8 (400 m) tile pyramid for `world-population-globe`.

The full Kontur r8 tier is tens of millions of H3 cells — too large to load
whole — so it is partitioned by a coarse H3 **parent** cell into many small
Parquet tiles that the client streams per-viewport.

Fetch granularity (coarse parent tiles, few files) is intentionally decoupled
from render granularity (the client culls to the viewport). All work is one
vectorized DuckDB pass (no Python row loops). Shared helpers: ``kontur_common``.

Usage::

    python pipeline/build_tiles.py --measure-only     # just count r8 cells
    python pipeline/build_tiles.py                     # build tiles (r2 parents)
    python pipeline/build_tiles.py --tile-parent-res 3
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

import duckdb

from kontur_common import (
    CACHE,
    OUT,
    ROOT,
    S3,
    centroid_4326,
    decompress,
    detect_columns,
    download,
    log,
)

TAG = "build_tiles"
H3_RES = 8
APPROX_KM = 0.4
MIN_ZOOM = 4.5
MAX_FILE_BYTES = 95 * 1024 * 1024  # stay under GitHub's 100 MB hard limit

R8_URL = f"{S3}/kontur_population_20231101.gpkg.gz"
GZ = CACHE / "kontur_r8.gpkg.gz"
GPKG = CACHE / "kontur_r8.gpkg"
TILES_DIR = OUT / "tiles" / "r8"


def main() -> int:
    ap = argparse.ArgumentParser(description="Build the r8 population tile pyramid.")
    ap.add_argument("--tile-parent-res", type=int, default=2, help="H3 parent res for tiling")
    ap.add_argument("--measure-only", action="store_true", help="count cells and exit")
    args = ap.parse_args()
    pres = args.tile_parent_res

    download(R8_URL, GZ, TAG)
    decompress(GZ, GPKG, TAG)

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("INSTALL h3 FROM community; LOAD h3;")

    h3_col, pop_col, geom_col = detect_columns(con, GPKG)
    src = GPKG.as_posix()

    if args.measure_only:
        total = con.execute(
            f"SELECT count(*) FROM ST_Read('{src}') WHERE \"{pop_col}\" > 0"
        ).fetchone()[0]
        log(TAG, f"r8 populated cells: {total:,}")
        return 0

    parent_expr = (
        f"h3_h3_to_string(h3_cell_to_parent("
        f"h3_string_to_h3(CAST(\"{h3_col}\" AS VARCHAR)), {pres}))"
    )
    base = f"""
        SELECT CAST("{h3_col}" AS VARCHAR)                  AS h3,
               CAST("{pop_col}" AS FLOAT)                    AS population,
               CAST(ST_X({centroid_4326(geom_col)}) AS FLOAT) AS lng,
               CAST(ST_Y({centroid_4326(geom_col)}) AS FLOAT) AS lat,
               {parent_expr}                                 AS parent
        FROM ST_Read('{src}')
        WHERE "{pop_col}" IS NOT NULL AND "{pop_col}" > 0
    """

    if TILES_DIR.exists():
        shutil.rmtree(TILES_DIR)
    TILES_DIR.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    con.execute(
        f"COPY ({base}) TO '{TILES_DIR.as_posix()}' "
        f"(FORMAT PARQUET, PARTITION_BY (parent), COMPRESSION SNAPPY, OVERWRITE_OR_IGNORE)"
    )
    log(TAG, f"partitioned write done in {time.time() - t0:.1f}s")

    # Per-parent counts + per-parent max population, in one metadata-light pass.
    glob = f"{TILES_DIR.as_posix()}/**/*.parquet"
    rows = con.execute(
        f"SELECT parent, count(*), max(population) "
        f"FROM read_parquet('{glob}', hive_partitioning=true) GROUP BY parent"
    ).fetchall()

    tiles: list[dict] = []
    total_cells = 0
    total_bytes = 0
    max_pop = 0.0
    biggest = 0
    for parent, count, pmax in rows:
        pdir = TILES_DIR / f"parent={parent}"
        files = sorted(pdir.glob("*.parquet"))
        if len(files) != 1:
            raise SystemExit(f"expected exactly 1 parquet in {pdir}, found {len(files)}")
        size = files[0].stat().st_size
        rel = files[0].relative_to(OUT).as_posix()
        tiles.append({"parent": parent, "file": f"data/{rel}", "cellCount": count})
        total_cells += count
        total_bytes += size
        max_pop = max(max_pop, float(pmax))
        biggest = max(biggest, size)

    if biggest > MAX_FILE_BYTES:
        raise SystemExit(
            f"a tile is {biggest:,} B (> {MAX_FILE_BYTES:,}). "
            f"Re-run with a finer --tile-parent-res (e.g. {pres + 1})."
        )

    sum_pop = con.execute(
        f"SELECT sum(population) FROM read_parquet('{glob}', hive_partitioning=true)"
    ).fetchone()[0]

    index = {
        "parentRes": pres,
        "h3Res": H3_RES,
        "approxKm": APPROX_KM,
        "tileCount": len(tiles),
        "cellCount": total_cells,
        "maxPopulation": round(max_pop, 2),
        "sumPopulation": round(float(sum_pop), 2),
        "tiles": sorted(tiles, key=lambda t: t["parent"]),
    }
    index_path = TILES_DIR / "index.json"
    index_path.write_text(json.dumps(index), encoding="utf-8")

    log(
        TAG,
        f"r8: {total_cells:,} cells in {len(tiles):,} tiles "
        f"(parent r{pres}); total {total_bytes / 1e6:.1f} MB, "
        f"biggest tile {biggest / 1e6:.2f} MB; sumPop={sum_pop:,.0f}",
    )

    _update_manifest(pres, total_cells, round(max_pop, 2), round(float(sum_pop), 2))
    return 0


def _update_manifest(pres: int, cell_count: int, max_pop: float, sum_pop: float) -> None:
    """Add/replace the tiled r8 entry in manifest.json (keeps overview/mid)."""
    manifest_path = OUT / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit("manifest.json missing — run build_lods.py first")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entry = {
        "lod": "r8",
        "tiled": True,
        "tileParentRes": pres,
        "indexFile": "data/tiles/r8/index.json",
        "h3Res": H3_RES,
        "approxKm": APPROX_KM,
        "minZoom": MIN_ZOOM,
        "maxZoom": 24,
        "cellCount": cell_count,
        "maxPopulation": max_pop,
        "sumPopulation": sum_pop,
    }
    lods = [e for e in manifest.get("lods", []) if e.get("lod") != "r8"]
    lods.append(entry)
    manifest["lods"] = lods
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    log(TAG, f"updated {manifest_path.relative_to(ROOT)} with tiled r8 entry")


if __name__ == "__main__":
    sys.exit(main())
