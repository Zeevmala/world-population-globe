"""Shared helpers for the Kontur Population pipeline.

Used by both `build_lods.py` (whole-tier LOD Parquet) and `build_tiles.py`
(r8 tile pyramid). Keeps download / decompress / schema detection / CRS handling
in one place.
"""
from __future__ import annotations

import gzip
import shutil
import urllib.request
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


def log(tag: str, msg: str) -> None:
    print(f"[{tag}] {msg}", flush=True)


def download(url: str, gz_path: Path, tag: str = "kontur") -> None:
    if gz_path.exists() and gz_path.stat().st_size > 0:
        log(tag, f"cache hit: {gz_path.name} ({gz_path.stat().st_size:,} B)")
        return
    gz_path.parent.mkdir(parents=True, exist_ok=True)
    log(tag, f"downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "world-population-globe/1.0"})
    with urllib.request.urlopen(req) as resp, open(gz_path, "wb") as fh:
        shutil.copyfileobj(resp, fh)
    log(tag, f"downloaded {gz_path.name} ({gz_path.stat().st_size:,} B)")


def decompress(gz_path: Path, gpkg_path: Path, tag: str = "kontur") -> None:
    if gpkg_path.exists() and gpkg_path.stat().st_size > 0:
        log(tag, f"already decompressed: {gpkg_path.name}")
        return
    log(tag, f"decompressing {gz_path.name}")
    with gzip.open(gz_path, "rb") as src, open(gpkg_path, "wb") as dst:
        shutil.copyfileobj(src, dst, length=1 << 22)
    log(tag, f"decompressed -> {gpkg_path.name} ({gpkg_path.stat().st_size:,} B)")


def detect_columns(con: duckdb.DuckDBPyConnection, gpkg: Path) -> tuple[str, str, str]:
    """Return (h3_col, pop_col, geom_col), case-insensitively matched."""
    desc = con.execute(f"DESCRIBE SELECT * FROM ST_Read('{gpkg.as_posix()}')").fetchall()
    names = [c[0] for c in desc]
    types = {c[0]: c[1] for c in desc}
    lower = {n.lower(): n for n in names}
    h3_col = lower.get("h3") or next((lower[k] for k in lower if "h3" in k), None)
    pop_col = lower.get("population") or next((lower[k] for k in lower if "pop" in k), None)
    geom_col = next((n for n in names if str(types[n]).startswith("GEOMETRY")), None)
    if not h3_col or not pop_col or not geom_col:
        raise SystemExit(f"could not locate h3/population/geometry columns in {types}")
    return h3_col, pop_col, geom_col


def centroid_4326(geom_col: str) -> str:
    """SQL expression: cell centroid reprojected EPSG:3857 -> EPSG:4326 (lng/lat).

    Kontur geometry is stored in Web Mercator; always_xy keeps output (lng, lat).
    """
    return f"ST_Transform(ST_Centroid(\"{geom_col}\"), 'EPSG:3857', 'EPSG:4326', always_xy := true)"
