"""
Generate the Open Graph / social-preview card for World Population Globe.

Produces public/og-image.png (1200x630) that mirrors the live app: a deep-space
backdrop, a softly-shaded globe rimmed with atmosphere, and Inferno-ramp population
points clustered over the densest regions (Asia-centric, like the default hero view).
Deterministic — re-run after a rebrand:  python scripts/make_og_image.py
"""
from __future__ import annotations

import math
import random
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

W, H = 1200, 630
GX, GY, R = 858, 315, 256          # globe centre + radius
LON0, LAT0 = 95, 18                # orthographic view centre (Asia-forward)
BG = (5, 7, 13)                    # app background (#05070d)
OUT = Path(__file__).resolve().parent.parent / "public" / "og-image.png"
FONT_DIR = Path("C:/Windows/Fonts")

random.seed(20231101)              # Kontur snapshot date -> reproducible output

# Inferno ramp — identical 8 stops to src/lib/colorRamp.ts
INFERNO = [
    (0, 0, 4), (40, 11, 84), (101, 21, 110), (159, 42, 99),
    (212, 72, 66), (245, 125, 21), (250, 193, 39), (252, 255, 164),
]


def inferno(t: float) -> tuple[int, int, int]:
    t = min(1.0, max(0.0, t)) * (len(INFERNO) - 1)
    i = int(math.floor(t))
    f = t - i
    a, b = INFERNO[i], INFERNO[min(len(INFERNO) - 1, i + 1)]
    return tuple(round(a[k] + (b[k] - a[k]) * f) for k in range(3))


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT_DIR / name), size)


def project(lon: float, lat: float) -> tuple[float, float, bool]:
    """Orthographic projection onto the globe; bool flags the visible hemisphere."""
    lon, lat, lo0, la0 = map(math.radians, (lon, lat, LON0, LAT0))
    cosc = math.sin(la0) * math.sin(lat) + math.cos(la0) * math.cos(lat) * math.cos(lon - lo0)
    x = math.cos(lat) * math.sin(lon - lo0)
    y = math.cos(la0) * math.sin(lat) - math.sin(la0) * math.cos(lat) * math.cos(lon - lo0)
    return GX + x * R, GY - y * R, cosc > 0


# ---------------------------------------------------------------- background
img = Image.new("RGB", (W, H), BG)

# soft radial light behind the globe
glow = Image.new("L", (W, H), 0)
ImageDraw.Draw(glow).ellipse(
    [GX - R * 1.8, GY - R * 1.8, GX + R * 1.8, GY + R * 1.8], fill=64)
glow = glow.filter(ImageFilter.GaussianBlur(130))
img = Image.composite(Image.new("RGB", (W, H), (18, 23, 36)), img, glow)

# atmosphere halo just outside the sphere
atmo = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ImageDraw.Draw(atmo).ellipse(
    [GX - R - 18, GY - R - 18, GX + R + 18, GY + R + 18], fill=(70, 104, 168, 110))
atmo = atmo.filter(ImageFilter.GaussianBlur(24))
img = Image.alpha_composite(img.convert("RGBA"), atmo).convert("RGB")

# ---------------------------------------------------------------- sphere body
sph = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ImageDraw.Draw(sph).ellipse([GX - R, GY - R, GX + R, GY + R], fill=(12, 16, 28, 255))
disc = sph.split()[3]  # circular clip mask

# top-left highlight, clipped to the disc
hl = Image.new("L", (W, H), 0)
ImageDraw.Draw(hl).ellipse([GX - R * 0.85, GY - R * 0.95, GX + R * 0.45, GY + R * 0.35], fill=150)
hl = ImageChops.multiply(hl.filter(ImageFilter.GaussianBlur(72)), disc)
sph = Image.composite(Image.new("RGBA", (W, H), (32, 44, 72, 255)), sph, hl)

# bottom-right terminator shadow, clipped to the disc
sh = Image.new("L", (W, H), 0)
ImageDraw.Draw(sh).ellipse([GX - R * 0.1, GY - R * 0.05, GX + R * 1.05, GY + R * 1.05], fill=150)
sh = ImageChops.multiply(sh.filter(ImageFilter.GaussianBlur(80)), disc)
sph = Image.composite(Image.new("RGBA", (W, H), (4, 6, 12, 255)), sph, sh)

# graticule (faint lat/long lines), clipped to the disc
grat = Image.new("RGBA", (W, H), (0, 0, 0, 0))
gd = ImageDraw.Draw(grat)
for lat in range(-60, 61, 30):
    pts = [(x, y) for lon in range(-180, 181, 3)
           for (x, y, vis) in [project(lon, lat)] if vis]
    if len(pts) > 1:
        gd.line(pts, fill=(120, 150, 190, 26), width=1)
for lon in range(-180, 180, 30):
    pts = [(x, y) for lat in range(-90, 91, 3)
           for (x, y, vis) in [project(lon, lat)] if vis]
    if len(pts) > 1:
        gd.line(pts, fill=(120, 150, 190, 26), width=1)
grat.putalpha(ImageChops.multiply(grat.split()[3], disc))
sph = Image.alpha_composite(sph, grat)

# ---------------------------------------------------------------- population
# (lon, lat, weight, spread_deg, count) — dense urban regions
HOTSPOTS = [
    (78, 25, 1.00, 7, 170), (88, 23, 1.00, 5, 130), (76, 19, 0.92, 4, 70),
    (114, 31, 0.96, 7, 150), (120, 30, 0.90, 5, 90), (139, 36, 0.88, 3, 64),
    (107, 11, 0.82, 6, 80), (110, -6, 0.86, 5, 84), (67, 28, 0.80, 6, 80),
    (45, 33, 0.62, 7, 56), (10, 50, 0.72, 9, 96), (31, 30, 0.64, 3, 40),
    (3, 8, 0.58, 7, 60), (37, -1, 0.5, 6, 40),
]

pts: list[tuple[float, float, float]] = []  # (px, py, density)
for lon0, lat0, w, sp, n in HOTSPOTS:
    for _ in range(n):
        lon = lon0 + random.gauss(0, sp)
        lat = lat0 + random.gauss(0, sp * 0.8)
        x, y, vis = project(lon, lat)
        if not vis:
            continue
        d = max(0.0, min(1.0, w - random.random() * 0.45))
        pts.append((x, y, d))
# sparse global texture
for _ in range(260):
    lon = random.uniform(-180, 180)
    lat = math.degrees(math.asin(random.uniform(-1, 1)))
    x, y, vis = project(lon, lat)
    if vis:
        pts.append((x, y, random.uniform(0.04, 0.28)))

pts.sort(key=lambda p: p[2])  # brightest drawn last (on top)
pop = Image.new("RGBA", (W, H), (0, 0, 0, 0))
pd = ImageDraw.Draw(pop)
for x, y, d in pts:
    if math.hypot(x - GX, y - GY) > R - 1:  # stay on the disc
        continue
    col = inferno(d)
    r = 1.0 + d * 3.4
    pd.ellipse([x - r * 2.6, y - r * 2.6, x + r * 2.6, y + r * 2.6], fill=(*col, 40))  # glow
    pd.ellipse([x - r, y - r, x + r, y + r], fill=(*col, 238))                          # core
sph = Image.alpha_composite(sph, pop)

img = Image.alpha_composite(img.convert("RGBA"), sph).convert("RGB")

# ---------------------------------------------------------------- text
draw = ImageDraw.Draw(img, "RGBA")
TX = 74
draw.text((TX, 150), "World", font=font("segoeuib.ttf", 70), fill=(245, 247, 252))
draw.text((TX, 224), "Population", font=font("segoeuib.ttf", 70), fill=(245, 247, 252))
draw.text((TX, 298), "Globe", font=font("segoeuib.ttf", 70), fill=(245, 160, 38))

draw.text((TX + 2, 398), "8 billion people, rendered live as extruded",
          font=font("segoeui.ttf", 25), fill=(208, 214, 226))
draw.text((TX + 2, 430), "H3 hexagon columns down to 400 m.",
          font=font("segoeui.ttf", 25), fill=(208, 214, 226))

# Inferno legend bar
lx, ly, lw, lh = TX + 2, 500, 300, 12
for i in range(lw):
    draw.line([(lx + i, ly), (lx + i, ly + lh)], fill=inferno(i / (lw - 1)))
draw.text((lx, ly + 20), "Low", font=font("segoeui.ttf", 17), fill=(150, 160, 175))
hi = font("segoeui.ttf", 17)
draw.text((lx + lw - draw.textlength("High density", font=hi), ly + 20),
          "High density", font=hi, fill=(150, 160, 175))

# footer URL, bottom-right
fu = font("segoeui.ttf", 19)
draw.text((W - 30 - draw.textlength("zeevmala.github.io/world-population-globe", font=fu), H - 40),
          "zeevmala.github.io/world-population-globe", font=fu, fill=(140, 150, 166))

img.save(OUT, "PNG")
print(f"wrote {OUT}  ({OUT.stat().st_size // 1024} KB, {img.size[0]}x{img.size[1]})")
