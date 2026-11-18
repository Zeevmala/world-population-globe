#!/usr/bin/env python3
"""Build the r5 tier as the H3-parent roll-up of the committed r6 (``mid``) tier.

Kontur publishes r4, r6 and r8 but no r5, and r5 is what fills the band between the
22 km overview and the 3 km mid tier (see ``tiers.py``). Population is additive, so
an r5 cell's population is exactly the sum of its r6 children — no source download,
no re-projection: this reads ``public/data/mid.parquet`` and writes
``public/data/r5.parquet`` with the same ``(h3, population, lng, lat)`` schema.

Vectorized end to end (no Python row loops):

* the parent is H3 bit arithmetic in plain DuckDB SQL — set the 4-bit resolution
  field (bits 52-55) to 5 and fill the digit slots of resolutions 6-15 with 7
  (``0b111``, "unused"), which is exactly ``cellToParent`` — so no DuckDB extension
  is needed (the community-extension host is not always reachable);
* the aggregation is a DuckDB ``GROUP BY`` (summed as DOUBLE: every r6 population is
  an integer and every r5 sum is < 2^24, so the FLOAT cast is exact);
* lng/lat is the r5 cell's H3 center, from ``h3ronpy`` over the whole Arrow column.

It then (re)writes the r5 manifest entry and re-applies the band table to EVERY
manifest entry, so this script is also how a band change reaches the manifest
without rebuilding the Kontur-sourced tiers.

Usage::

    python pipeline/build_parents.py
"""
from __future__ import annotations

import json
import sys
import time

import duckdb
import h3ronpy
import pyarrow as pa
from h3ronpy.vector import cells_to_coordinates

from kontur_common import OUT, ROOT, log
from tiers import TIER_BY_LOD, apply_bands, bands

TAG = "build_parents"
CHILD = TIER_BY_LOD["mid"]
PARENT = TIER_BY_LOD["r5"]
CHILD_PATH = OUT / "mid.parquet"
OUT_PATH = OUT / f"{PARENT.lod}.parquet"


def parent_sql(col: str, res: int) -> str:
    """SQL: the H3 string of ``col``'s parent at ``res`` (lower-case, 15 hex chars)."""
    cell = f"('0x' || {col})::UBIGINT"
    res_field = "(~(15::UBIGINT << 52))"  # clear bits 52-55 (resolution)
    unused = f"((1::UBIGINT << (3 * (15 - {res}))) - 1)"  # digits res+1..15 := 7
    return f"lower(to_hex((({cell} & {res_field}) | ({res}::UBIGINT << 52)) | {unused}))"


def main() -> int:
    t0 = time.time()
    if not CHILD_PATH.exists():
        raise SystemExit(f"{CHILD_PATH} missing — run build_lods.py first")
    con = duckdb.connect()

    rolled = con.sql(
        f"""
        SELECT {parent_sql('h3', PARENT.h3_res)} AS h3,
               sum(population::DOUBLE)            AS population
        FROM read_parquet('{CHILD_PATH.as_posix()}')
        GROUP BY 1
        ORDER BY 1
        """
    ).to_arrow_table()

    # Cell centers for the whole column at once (h3ronpy is Rust over Arrow arrays).
    cells = h3ronpy.cells_parse(rolled.column("h3").combine_chunks())
    coords = cells_to_coordinates(cells)
    table = pa.table(
        {
            "h3": rolled.column("h3"),
            "population": rolled.column("population"),
            "lng": pa.array(coords["lng"]),
            "lat": pa.array(coords["lat"]),
        }
    )
    con.register("r5", table)
    select = """
        SELECT h3,
               CAST(population AS FLOAT) AS population,
               CAST(lng AS FLOAT)        AS lng,
               CAST(lat AS FLOAT)        AS lat
        FROM r5
    """
    OUT.mkdir(parents=True, exist_ok=True)
    con.execute(f"COPY ({select}) TO '{OUT_PATH.as_posix()}' (FORMAT PARQUET, COMPRESSION SNAPPY)")

    cell_count, max_pop, sum_pop, non_exact = con.execute(
        f"""
        SELECT count(*), max(population), sum(population::DOUBLE),
               count(*) FILTER (WHERE population::DOUBLE <> round(population::DOUBLE))
        FROM read_parquet('{OUT_PATH.as_posix()}')
        """
    ).fetchone()
    child_sum = con.execute(
        f"SELECT sum(population::DOUBLE) FROM read_parquet('{CHILD_PATH.as_posix()}')"
    ).fetchone()[0]
    if non_exact or sum_pop != child_sum:
        raise SystemExit(
            f"r5 roll-up is not exact: Σr5={sum_pop:,.0f} Σr6={child_sum:,.0f}, "
            f"{non_exact} non-integer populations"
        )
    size = OUT_PATH.stat().st_size
    log(
        TAG,
        f"{PARENT.lod}: {cell_count:,} cells, maxPop={max_pop:,.0f}, sumPop={sum_pop:,.0f} "
        f"(== Σ{CHILD.lod}) -> {OUT_PATH.name} ({size:,} B)",
    )

    lo, hi = bands()[PARENT.lod]
    entry = {
        "lod": PARENT.lod,
        "file": f"data/{OUT_PATH.name}",
        "h3Res": PARENT.h3_res,
        "approxKm": PARENT.approx_km,
        "minZoom": lo,
        "maxZoom": hi,
        "cellCount": cell_count,
        "maxPopulation": round(float(max_pop), 2),
        "sumPopulation": round(float(sum_pop), 2),
        "bytes": size,
    }

    manifest_path = OUT / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit("manifest.json missing — run build_lods.py first")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    lods = [e for e in manifest.get("lods", []) if e.get("lod") != PARENT.lod] + [entry]
    manifest["lods"] = apply_bands(lods)
    manifest["generatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    table_txt = ", ".join(f"{e['lod']} {e['minZoom']}–{e['maxZoom']}" for e in manifest["lods"])
    log(TAG, f"wrote {manifest_path.relative_to(ROOT)}: {table_txt}")
    log(TAG, f"done in {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
