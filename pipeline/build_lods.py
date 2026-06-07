#!/usr/bin/env python3
"""Build whole-tier LOD Parquet for `world-population-globe`.

Kontur Population coarse H3 tiers (r4 = 22 km, r6 = 3 km) -> extract
``(h3, population, lng, lat)`` -> compact SNAPPY Parquet + a typed
``manifest.json`` entry. Each tier loads whole in the client (the dense r8 tier
is streamed instead; see ``build_tiles.py``).

All transforms run vectorized inside DuckDB (no Python row loops). Shared
download / decompress / schema / CRS helpers live in ``kontur_common``.

Usage::

    python pipeline/build_lods.py                 # build all tiers
    python pipeline/build_lods.py --only overview # build a single tier
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import duckdb

from kontur_common import (
    ATTRIBUTION,
    CACHE,
    DATA_DATE,
    LICENSE,
    OUT,
    ROOT,
    S3,
    centroid_4326,
    decompress,
    detect_columns,
    download,
    log,
)

TAG = "build_lods"


@dataclass(frozen=True)
class Tier:
    """One whole-loaded LOD tier mapped to a Kontur H3 resolution."""

    lod: str
    h3_res: int
    approx_km: float
    min_zoom: float
    max_zoom: float

    @property
    def url(self) -> str:
        return f"{S3}/kontur_population_20231101_r{self.h3_res}.gpkg.gz"

    @property
    def gz_path(self) -> Path:
        return CACHE / f"kontur_r{self.h3_res}.gpkg.gz"

    @property
    def gpkg_path(self) -> Path:
        return CACHE / f"kontur_r{self.h3_res}.gpkg"

    @property
    def out_path(self) -> Path:
        return OUT / f"{self.lod}.parquet"


TIERS: list[Tier] = [
    Tier("overview", 4, 22.0, min_zoom=-2.0, max_zoom=2.2),
    Tier("mid", 6, 3.0, min_zoom=2.2, max_zoom=4.5),
]


def build_tier(con: duckdb.DuckDBPyConnection, tier: Tier) -> dict:
    h3_col, pop_col, geom_col = detect_columns(con, tier.gpkg_path)
    src = tier.gpkg_path.as_posix()
    OUT.mkdir(parents=True, exist_ok=True)

    select = f"""
        SELECT CAST("{h3_col}" AS VARCHAR)                  AS h3,
               CAST("{pop_col}" AS FLOAT)                    AS population,
               CAST(ST_X({centroid_4326(geom_col)}) AS FLOAT) AS lng,
               CAST(ST_Y({centroid_4326(geom_col)}) AS FLOAT) AS lat
        FROM ST_Read('{src}')
        WHERE "{pop_col}" IS NOT NULL AND "{pop_col}" > 0
    """
    con.execute(
        f"COPY ({select}) TO '{tier.out_path.as_posix()}' (FORMAT PARQUET, COMPRESSION SNAPPY)"
    )

    cell_count, max_pop, sum_pop = con.execute(
        f"SELECT count(*), max(population), sum(population) FROM ({select})"
    ).fetchone()
    size = tier.out_path.stat().st_size
    log(
        TAG,
        f"{tier.lod}: {cell_count:,} cells, maxPop={max_pop:,.0f}, "
        f"sumPop={sum_pop:,.0f} -> {tier.out_path.name} ({size:,} B)",
    )
    return {
        "lod": tier.lod,
        "file": f"data/{tier.out_path.name}",
        "h3Res": tier.h3_res,
        "approxKm": tier.approx_km,
        "minZoom": tier.min_zoom,
        "maxZoom": tier.max_zoom,
        "cellCount": cell_count,
        "maxPopulation": round(max_pop, 2),
        "sumPopulation": round(sum_pop, 2),
        "bytes": size,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Build population LOD Parquet tiles.")
    ap.add_argument("--only", choices=[t.lod for t in TIERS], help="build a single tier")
    args = ap.parse_args()

    tiers = [t for t in TIERS if not args.only or t.lod == args.only]
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")

    entries = []
    for tier in tiers:
        t0 = time.time()
        download(tier.url, tier.gz_path, TAG)
        decompress(tier.gz_path, tier.gpkg_path, TAG)
        entries.append(build_tier(con, tier))
        log(TAG, f"{tier.lod} done in {time.time() - t0:.1f}s")

    # Merge into existing manifest so a single-tier build doesn't drop the others.
    manifest_path = OUT / "manifest.json"
    existing: dict[str, dict] = {}
    if manifest_path.exists():
        prev = json.loads(manifest_path.read_text(encoding="utf-8"))
        existing = {e["lod"]: e for e in prev.get("lods", [])}
    for e in entries:
        existing[e["lod"]] = e
    ordered = [existing[t.lod] for t in TIERS if t.lod in existing]
    # Preserve any extra (e.g. tiled r8) entries appended by build_tiles.py.
    ordered += [e for lod, e in existing.items() if lod not in {t.lod for t in TIERS}]

    manifest = {
        "source": "Kontur Population",
        "dataDate": DATA_DATE,
        "license": LICENSE,
        "attribution": ATTRIBUTION,
        "crs": "EPSG:4326",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "lods": ordered,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    log(TAG, f"wrote {manifest_path.relative_to(ROOT)} with {len(ordered)} LOD(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
