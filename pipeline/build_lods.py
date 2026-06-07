#!/usr/bin/env python3
"""Build LOD population tiles for `world-population-globe`.

Pipeline: Kontur Population H3 tiers (`*.gpkg.gz`) -> extract ``(h3, population)``
-> compact ZSTD Parquet + a typed ``manifest.json`` the web client consumes.

Design notes
------------
* All transforms run **vectorized inside DuckDB** (no Python row loops) -- the
  GeoPackage is read with the spatial extension's ``ST_Read`` (GDAL), filtered,
  cast, and streamed straight to Parquet via ``COPY``.
* Kontur already publishes pre-aggregated H3 resolutions (r4 = 22 km, r6 = 3 km,
  r8 = 400 m), so each tier *is* an LOD level -- no client-side rollup needed.
* Column names are auto-detected (case-insensitive) so the script survives minor
  upstream schema drift; Kontur's canonical schema is ``h3`` + ``population``.

Usage
-----
    python pipeline/build_lods.py                 # build all tiers
    python pipeline/build_lods.py --only overview # build a single tier
"""
from __future__ import annotations

import argparse
import gzip
import json
import shutil
import sys
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(__file__).resolve().parent / ".cache"
OUT = ROOT / "public" / "data"

# Kontur Population 2023-11-01 release. CC-BY 4.0 (c) Kontur + upstream sources
# (GHSL, Meta, Microsoft Buildings, Copernicus GLS, LINZ, OpenStreetMap).
DATA_DATE = "2023-11-01"
LICENSE = "CC-BY 4.0"
ATTRIBUTION = "© Kontur (kontur.io), CC-BY 4.0 — GHSL, Meta, Microsoft, Copernicus, OSM"
S3 = "https://geodata-eu-central-1-kontur-public.s3.eu-central-1.amazonaws.com/kontur_datasets"


@dataclass(frozen=True)
class Tier:
    """One level-of-detail tier mapped to a Kontur H3 resolution."""

    lod: str          # logical LOD name used by the client
    h3_res: int       # H3 resolution of the source tier
    approx_km: float  # nominal hexagon edge length (km)
    min_zoom: float   # GlobeView zoom at/above which this LOD becomes preferred
    max_zoom: float   # ...and below which it stays preferred

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
    Tier("mid", 6, 3.0, min_zoom=2.2, max_zoom=8.0),
]


def log(msg: str) -> None:
    print(f"[build_lods] {msg}", flush=True)


def download(tier: Tier) -> None:
    if tier.gz_path.exists() and tier.gz_path.stat().st_size > 0:
        log(f"cache hit: {tier.gz_path.name} ({tier.gz_path.stat().st_size:,} B)")
        return
    CACHE.mkdir(parents=True, exist_ok=True)
    log(f"downloading {tier.url}")
    req = urllib.request.Request(tier.url, headers={"User-Agent": "world-population-globe/1.0"})
    with urllib.request.urlopen(req) as resp, open(tier.gz_path, "wb") as fh:
        shutil.copyfileobj(resp, fh)
    log(f"downloaded {tier.gz_path.name} ({tier.gz_path.stat().st_size:,} B)")


def decompress(tier: Tier) -> None:
    if tier.gpkg_path.exists() and tier.gpkg_path.stat().st_size > 0:
        log(f"already decompressed: {tier.gpkg_path.name}")
        return
    log(f"decompressing {tier.gz_path.name}")
    with gzip.open(tier.gz_path, "rb") as src, open(tier.gpkg_path, "wb") as dst:
        shutil.copyfileobj(src, dst, length=1 << 22)
    log(f"decompressed -> {tier.gpkg_path.name} ({tier.gpkg_path.stat().st_size:,} B)")


def detect_columns(con: duckdb.DuckDBPyConnection, gpkg: Path) -> tuple[str, str, str]:
    """Return (h3_col, pop_col, geom_col), case-insensitively matched."""
    desc = con.execute(
        f"DESCRIBE SELECT * FROM ST_Read('{gpkg.as_posix()}')"
    ).fetchall()
    names = [c[0] for c in desc]
    types = {c[0]: c[1] for c in desc}
    lower = {n.lower(): n for n in names}
    h3_col = lower.get("h3") or next((lower[k] for k in lower if "h3" in k), None)
    pop_col = (
        lower.get("population")
        or next((lower[k] for k in lower if "pop" in k), None)
    )
    geom_col = next((n for n in names if str(types[n]).startswith("GEOMETRY")), None)
    if not h3_col or not pop_col or not geom_col:
        raise SystemExit(f"could not locate h3/population/geometry columns in {types}")
    return h3_col, pop_col, geom_col


def build_tier(con: duckdb.DuckDBPyConnection, tier: Tier) -> dict:
    h3_col, pop_col, geom_col = detect_columns(con, tier.gpkg_path)
    src = tier.gpkg_path.as_posix()
    OUT.mkdir(parents=True, exist_ok=True)

    # Single vectorized statement: read GeoPackage -> project (h3, population) +
    # centroid reprojected EPSG:3857 -> EPSG:4326 (Kontur stores geometry in Web
    # Mercator; centroids feed the client's lng/lat viewport cull). always_xy
    # keeps output as (lng, lat). Drop empty cells -> stream to SNAPPY Parquet
    # (hyparquet decodes snappy natively; ZSTD needs an extra browser codec).
    # The H3 index drives hexagon geometry client-side; centroids drive the cull.
    centroid = f"ST_Transform(ST_Centroid(\"{geom_col}\"), 'EPSG:3857', 'EPSG:4326', always_xy := true)"
    select = f"""
        SELECT CAST("{h3_col}" AS VARCHAR)        AS h3,
               CAST("{pop_col}" AS FLOAT)          AS population,
               CAST(ST_X({centroid}) AS FLOAT)     AS lng,
               CAST(ST_Y({centroid}) AS FLOAT)     AS lat
        FROM ST_Read('{src}')
        WHERE "{pop_col}" IS NOT NULL AND "{pop_col}" > 0
    """
    con.execute(
        f"COPY ({select}) TO '{tier.out_path.as_posix()}' "
        f"(FORMAT PARQUET, COMPRESSION SNAPPY)"
    )

    stats = con.execute(
        f"SELECT count(*), max(population), sum(population) FROM ({select})"
    ).fetchone()
    cell_count, max_pop, sum_pop = stats
    size = tier.out_path.stat().st_size
    log(
        f"{tier.lod}: {cell_count:,} cells, maxPop={max_pop:,.0f}, "
        f"sumPop={sum_pop:,.0f} -> {tier.out_path.name} ({size:,} B)"
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
        download(tier)
        decompress(tier)
        entries.append(build_tier(con, tier))
        log(f"{tier.lod} done in {time.time() - t0:.1f}s")

    # Merge into existing manifest so a single-tier build doesn't drop the others.
    manifest_path = OUT / "manifest.json"
    existing = {}
    if manifest_path.exists():
        prev = json.loads(manifest_path.read_text(encoding="utf-8"))
        existing = {e["lod"]: e for e in prev.get("lods", [])}
    for e in entries:
        existing[e["lod"]] = e
    ordered = [existing[t.lod] for t in TIERS if t.lod in existing]

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
    log(f"wrote {manifest_path.relative_to(ROOT)} with {len(ordered)} LOD(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
