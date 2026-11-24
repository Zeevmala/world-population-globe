"""The LOD tier table and its zoom bands — the ONE place band constants live.

Every pipeline script (``build_lods.py``, ``build_parents.py``, ``build_tiles.py``)
reads its tiers and their ``minZoom`` / ``maxZoom`` from here, and
``build_parents.py`` re-applies the bands to every manifest entry on each run, so the
committed manifest can never disagree with this table.

The banding rule: **a tier starts where its hexagon is ``BAND_PX`` CSS px across flats
at the equator.** deck.gl's ``_GlobeView`` draws ``TILE_SIZE · 2^zoom`` px around the
equator, so at the view center

    px/km(zoom, lat) = TILE_SIZE · 2^zoom / (2π · R · cos lat)

and a hexagon of mean area ``A`` is ``√(2A/√3)`` km across flats. Solving
``px/km · width = BAND_PX`` for zoom at lat 0 gives each tier's entry zoom. Nothing
below is a typed-in zoom: change the rule or add a tier and the bands follow.
``src/lib/bands.test.ts`` checks this model against deck.gl's real ``GlobeViewport``
and ``scripts/bands.test.mjs`` pins the committed manifest to it.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import h3

#: On-screen width (CSS px, across flats, at the equator) at which a tier switches on.
BAND_PX = 3.0
#: deck.gl world size at zoom 0 (px around the equator).
TILE_SIZE = 512
#: Mean Earth radius (km) — the sphere deck.gl's GlobeView projects onto.
EARTH_RADIUS_KM = 6371.0
#: Open ends of the band ladder: the coarsest tier from far out, the finest to the end.
OUTER_MIN_ZOOM = -2.0
OUTER_MAX_ZOOM = 24.0
#: Bands are published to 2 dp — far finer than any camera step the UI takes.
ZOOM_DP = 2


@dataclass(frozen=True)
class TierSpec:
    """One LOD tier as published in ``manifest.json`` (coarse → fine)."""

    lod: str
    h3_res: int
    #: UI cell-size label (nominal H3 edge, km — H3's published average edge length,
    #: rounded: r4 22.6, r5 8.5, r6 3.2, r7 1.2, r8 0.46).
    approx_km: float


#: Coarse → fine. The client walks ``manifest.lods`` in this order.
TIERS: list[TierSpec] = [
    TierSpec("overview", 4, 22.0),  # Kontur r4, whole file   (build_lods.py)
    TierSpec("r5", 5, 8.5),  # parent roll-up of mid  (build_parents.py)
    TierSpec("mid", 6, 3.0),  # Kontur r6, whole file   (build_lods.py)
    TierSpec("r7", 7, 1.2),  # parent roll-up of r8, r2-tiled (build_parents.py)
    TierSpec("r8", 8, 0.4),  # Kontur r8, r3-tiled    (build_tiles.py)
]

TIER_BY_LOD: dict[str, TierSpec] = {t.lod: t for t in TIERS}


def hex_width_km(h3_res: int) -> float:
    """Mean width across flats (km) of an H3 hexagon at ``h3_res``: √(2A/√3)."""
    area = h3.average_hexagon_area(h3_res, unit="km^2")
    return math.sqrt(2.0 * area / math.sqrt(3.0))


def entry_zoom(h3_res: int) -> float:
    """Zoom at which an ``h3_res`` hexagon is ``BAND_PX`` px across at the equator."""
    km_per_world = 2.0 * math.pi * EARTH_RADIUS_KM
    return math.log2(BAND_PX * km_per_world / (TILE_SIZE * hex_width_km(h3_res)))


def bands() -> dict[str, tuple[float, float]]:
    """``lod -> (minZoom, maxZoom)``: each tier runs from its entry to the next's."""
    starts = [OUTER_MIN_ZOOM] + [round(entry_zoom(t.h3_res), ZOOM_DP) for t in TIERS[1:]]
    ends = starts[1:] + [OUTER_MAX_ZOOM]
    return {t.lod: (lo, hi) for t, lo, hi in zip(TIERS, starts, ends)}


def apply_bands(lods: list[dict]) -> list[dict]:
    """Re-band manifest entries from :data:`TIERS` and put them in tier order.

    Entries this table does not know are kept, after the known ones, untouched.
    """
    table = bands()
    by_lod = {e["lod"]: e for e in lods}
    out: list[dict] = []
    for t in TIERS:
        e = by_lod.get(t.lod)
        if e is None:
            continue
        lo, hi = table[t.lod]
        out.append({**e, "approxKm": t.approx_km, "minZoom": lo, "maxZoom": hi})
    out += [e for e in lods if e["lod"] not in TIER_BY_LOD]
    return out
