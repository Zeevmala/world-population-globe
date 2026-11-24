#!/usr/bin/env python3
"""Build the r5 and r7 tiers as H3-parent roll-ups of committed Kontur tiers.

Kontur publishes r4, r6 and r8 but no r5 or r7, and those are what fill the bands
between them (see ``tiers.py``: without r7 an r6 cell grows from 3 px to 21 px before
the 49× jump to r8). Population is additive, so a parent cell's population is exactly
the sum of its children — no source download, no re-projection:

* **r5** reads ``public/data/mid.parquet`` (r6) and writes ``public/data/r5.parquet``;
* **r7** reads every r8 tile listed in ``public/data/tiles/r8/index.json`` and writes a
  tile pyramid partitioned by **r2** parent, ``public/data/tiles/r7/parent=<r2>/
  data_0.parquet``, plus an ``index.json`` in the r8 index's format. r2 keeps a
  1280×800 screen at the band's entry zoom within ~20 tiles (r3 would need over 60),
  and an r2 tile of r7 cells is at most a few hundred kB.

Both keep the ``(h3, population, lng, lat)`` schema. Vectorized end to end (no Python
row loops):

* the parent is H3 bit arithmetic in plain DuckDB SQL — set the 4-bit resolution
  field (bits 52-55) to the parent's resolution and fill the digit slots below it
  with 7 (``0b111``, "unused"), which is exactly ``cellToParent`` (pentagons too: it is
  digit truncation either way) — so no DuckDB extension is needed (the
  community-extension host is not always reachable);
* the aggregation is a DuckDB ``GROUP BY`` summed as DOUBLE. Every r6 and r8
  population is a whole number and every parent sum is < 2^24, so the FLOAT cast is
  exact; the script fails if either Σ changes or a population is not whole;
* lng/lat is the parent cell's H3 center, from ``h3ronpy`` over the whole Arrow column.

Output is deterministic: rows are written sorted by ``h3`` (tiles: by parent, then
``h3``) from a single-threaded COPY, so a re-run is byte-identical.

It then (re)writes the r5 and r7 manifest entries and re-applies the band table to
EVERY manifest entry, so this script is also how a band change reaches the manifest
without rebuilding the Kontur-sourced tiers. It needs the r8 pyramid
(``build_tiles.py``) on disk: after a ``npm run data:tiles`` re-run it must run again.

Usage::

    python pipeline/build_parents.py
"""
from __future__ import annotations

import json
import shutil
import sys
import time

import duckdb
import h3ronpy
import pyarrow as pa
from h3ronpy.vector import cells_to_coordinates

from kontur_common import OUT, ROOT, log
from tiers import TIER_BY_LOD, apply_bands, bands

TAG = "build_parents"

R5 = TIER_BY_LOD["r5"]
R5_CHILD = TIER_BY_LOD["mid"]
R5_CHILD_PATH = OUT / f"{R5_CHILD.lod}.parquet"
R5_PATH = OUT / f"{R5.lod}.parquet"

R7 = TIER_BY_LOD["r7"]
R7_CHILD = TIER_BY_LOD["r8"]
#: H3 resolution of the r7 tiles' parents (one file per populated r2 cell).
R7_TILE_PARENT_RES = 2
R7_CHILD_INDEX = OUT / "tiles" / R7_CHILD.lod / "index.json"
R7_DIR = OUT / "tiles" / R7.lod
#: Same guard as build_tiles.py: stay under GitHub's 100 MB hard limit.
MAX_FILE_BYTES = 95 * 1024 * 1024
#: Largest integer a FLOAT holds exactly — every parent population must stay below it.
FLOAT_EXACT = 2**24


def parent_sql(col: str, res: int) -> str:
    """SQL: the H3 string of ``col``'s parent at ``res`` (lower-case, 15 hex chars)."""
    cell = f"('0x' || {col})::UBIGINT"
    res_field = "(~(15::UBIGINT << 52))"  # clear bits 52-55 (resolution)
    unused = f"((1::UBIGINT << (3 * (15 - {res}))) - 1)"  # digits res+1..15 := 7
    return f"lower(to_hex((({cell} & {res_field}) | ({res}::UBIGINT << 52)) | {unused}))"


def roll_up(con: duckdb.DuckDBPyConnection, child_view: str, res: int) -> pa.Table:
    """``child_view`` summed to its ``res`` parents, with H3 cell centers, sorted by h3."""
    rolled = con.sql(
        f"""
        SELECT {parent_sql('h3', res)} AS h3,
               sum(population::DOUBLE)  AS population
        FROM {child_view}
        GROUP BY 1
        ORDER BY 1
        """
    ).to_arrow_table()
    # Cell centers for the whole column at once (h3ronpy is Rust over Arrow arrays).
    cells = h3ronpy.cells_parse(rolled.column("h3").combine_chunks())
    coords = cells_to_coordinates(cells)
    return pa.table(
        {
            "h3": rolled.column("h3"),
            "population": rolled.column("population"),
            "lng": pa.array(coords["lng"]),
            "lat": pa.array(coords["lat"]),
        }
    )


#: The published schema: FLOAT population and FLOAT lng/lat, as every tier.
SELECT_FLOATS = """
    SELECT h3,
           CAST(population AS FLOAT) AS population,
           CAST(lng AS FLOAT)        AS lng,
           CAST(lat AS FLOAT)        AS lat
"""


def assert_exact(con: duckdb.DuckDBPyConnection, lod: str, out_glob: str, child_view: str, child_lod: str):
    """Fail unless the written tier sums exactly to its children, in whole numbers."""
    cell_count, max_pop, sum_pop, non_exact = con.execute(
        f"""
        SELECT count(*), max(population), sum(population::DOUBLE),
               count(*) FILTER (WHERE population::DOUBLE <> round(population::DOUBLE))
        FROM read_parquet('{out_glob}', hive_partitioning=false)
        """
    ).fetchall()[0]
    child_sum = con.execute(f"SELECT sum(population::DOUBLE) FROM {child_view}").fetchall()[0][0]
    if non_exact or sum_pop != child_sum or max_pop >= FLOAT_EXACT:
        raise SystemExit(
            f"{lod} roll-up is not exact: Σ{lod}={sum_pop:,.0f} Σ{child_lod}={child_sum:,.0f}, "
            f"{non_exact} non-integer populations, max={max_pop:,.0f}"
        )
    return cell_count, max_pop, sum_pop


def build_r5(con: duckdb.DuckDBPyConnection) -> dict:
    """r5 = r6 (mid) summed to its parents, one whole file."""
    if not R5_CHILD_PATH.exists():
        raise SystemExit(f"{R5_CHILD_PATH} missing — run build_lods.py first")
    con.execute(f"CREATE OR REPLACE VIEW r6_src AS SELECT * FROM read_parquet('{R5_CHILD_PATH.as_posix()}')")
    con.register("r5", roll_up(con, "r6_src", R5.h3_res))
    con.execute(f"COPY ({SELECT_FLOATS} FROM r5) TO '{R5_PATH.as_posix()}' (FORMAT PARQUET, COMPRESSION SNAPPY)")

    cell_count, max_pop, sum_pop = assert_exact(con, R5.lod, R5_PATH.as_posix(), "r6_src", R5_CHILD.lod)
    size = R5_PATH.stat().st_size
    log(
        TAG,
        f"{R5.lod}: {cell_count:,} cells, maxPop={max_pop:,.0f}, sumPop={sum_pop:,.0f} "
        f"(== Σ{R5_CHILD.lod}) -> {R5_PATH.name} ({size:,} B)",
    )
    lo, hi = bands()[R5.lod]
    return {
        "lod": R5.lod,
        "file": f"data/{R5_PATH.name}",
        "h3Res": R5.h3_res,
        "approxKm": R5.approx_km,
        "minZoom": lo,
        "maxZoom": hi,
        "cellCount": cell_count,
        "maxPopulation": round(float(max_pop), 2),
        "sumPopulation": round(float(sum_pop), 2),
        "bytes": size,
    }


def build_r7(con: duckdb.DuckDBPyConnection) -> dict:
    """r7 = every r8 tile summed to its parents, re-tiled by r2 parent."""
    if not R7_CHILD_INDEX.exists():
        raise SystemExit(f"{R7_CHILD_INDEX} missing — run build_tiles.py first")
    child_index = json.loads(R7_CHILD_INDEX.read_text(encoding="utf-8"))
    files = [(OUT.parent / t["file"]).as_posix() for t in child_index["tiles"]]
    # The index is the list of record: read exactly the tiles it names (no hive column —
    # the r3 directory name is the r8 partition key, not data).
    con.read_parquet(files, hive_partitioning=False).create_view("r8_src", replace=True)
    rows = con.execute("SELECT count(*) FROM r8_src").fetchall()[0][0]
    if rows != child_index["cellCount"]:
        raise SystemExit(f"r8 tiles hold {rows:,} rows, index says {child_index['cellCount']:,}")

    con.register("r7", roll_up(con, "r8_src", R7.h3_res))
    if R7_DIR.exists():
        shutil.rmtree(R7_DIR)
    R7_DIR.mkdir(parents=True)
    # One thread: one file per partition, rows in the ORDER BY order, byte-identical runs.
    con.execute("SET threads = 1")
    con.execute(
        f"""
        COPY ({SELECT_FLOATS}, {parent_sql('h3', R7_TILE_PARENT_RES)} AS parent
              FROM r7 ORDER BY parent, h3)
        TO '{R7_DIR.as_posix()}'
        (FORMAT PARQUET, PARTITION_BY (parent), COMPRESSION SNAPPY, FILENAME_PATTERN 'data_{{i}}')
        """
    )
    con.execute("RESET threads")

    glob = f"{R7_DIR.as_posix()}/*/*.parquet"
    cell_count, max_pop, sum_pop = assert_exact(con, R7.lod, glob, "r8_src", R7_CHILD.lod)
    per_tile = con.execute(
        f"""
        SELECT parent, count(*)
        FROM read_parquet('{glob}', hive_partitioning=true)
        GROUP BY parent ORDER BY parent
        """
    ).fetchall()

    tiles: list[dict] = []
    total_bytes = 0
    biggest = (0, "")
    for parent, count in per_tile:  # one entry per tile file, not per cell
        pdir = R7_DIR / f"parent={parent}"
        found = sorted(pdir.glob("*.parquet"))
        if [f.name for f in found] != ["data_0.parquet"]:
            raise SystemExit(f"expected exactly data_0.parquet in {pdir}, found {[f.name for f in found]}")
        size = found[0].stat().st_size
        total_bytes += size
        biggest = max(biggest, (size, parent))
        tiles.append({"parent": parent, "file": f"data/{found[0].relative_to(OUT).as_posix()}", "cellCount": count})
    if biggest[0] > MAX_FILE_BYTES:
        raise SystemExit(f"r7 tile {biggest[1]} is {biggest[0]:,} B (> {MAX_FILE_BYTES:,})")
    if sum(t["cellCount"] for t in tiles) != cell_count:
        raise SystemExit("r7 per-tile counts do not add up to the tier's cell count")

    index = {
        "parentRes": R7_TILE_PARENT_RES,
        "h3Res": R7.h3_res,
        "approxKm": R7.approx_km,
        "tileCount": len(tiles),
        "cellCount": cell_count,
        "maxPopulation": round(float(max_pop), 2),
        "sumPopulation": round(float(sum_pop), 2),
        "tiles": tiles,
    }
    index_path = R7_DIR / "index.json"
    index_path.write_text(json.dumps(index), encoding="utf-8")
    log(
        TAG,
        f"{R7.lod}: {cell_count:,} cells in {len(tiles):,} tiles (parent r{R7_TILE_PARENT_RES}), "
        f"maxPop={max_pop:,.0f}, sumPop={sum_pop:,.0f} (== Σ{R7_CHILD.lod}); "
        f"{total_bytes:,} B, biggest tile {biggest[1]} ({biggest[0]:,} B)",
    )
    lo, hi = bands()[R7.lod]
    return {
        "lod": R7.lod,
        "tiled": True,
        "tileParentRes": R7_TILE_PARENT_RES,
        "indexFile": f"data/{index_path.relative_to(OUT).as_posix()}",
        "h3Res": R7.h3_res,
        "approxKm": R7.approx_km,
        "minZoom": lo,
        "maxZoom": hi,
        "cellCount": cell_count,
        "maxPopulation": index["maxPopulation"],
        "sumPopulation": index["sumPopulation"],
    }


def main() -> int:
    t0 = time.time()
    manifest_path = OUT / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit("manifest.json missing — run build_lods.py first")
    con = duckdb.connect()
    entries = [build_r5(con), build_r7(con)]

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    ours = {e["lod"] for e in entries}
    lods = [e for e in manifest.get("lods", []) if e.get("lod") not in ours] + entries
    manifest["lods"] = apply_bands(lods)
    manifest["generatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    table_txt = ", ".join(f"{e['lod']} {e['minZoom']}–{e['maxZoom']}" for e in manifest["lods"])
    log(TAG, f"wrote {manifest_path.relative_to(ROOT)}: {table_txt}")
    log(TAG, f"done in {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
