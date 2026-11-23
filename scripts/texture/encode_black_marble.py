"""Encode the night-lights basemap textures (public/basemap/*.jpg) from NASA Black Marble.

Source
------
NASA GIBS, layer ``VIIRS_Black_Marble`` ("Black Marble (VIIRS, Suomi NPP)", the 2016
composite), fetched 2026-11-23 with one WMS GetMap request:

    https://gibs.earthdata.nasa.gov/wms/epsg4326/all/wms.cgi?SERVICE=WMS&VERSION=1.3.0
        &REQUEST=GetMap&LAYERS=VIIRS_Black_Marble&STYLES=&CRS=EPSG:4326
        &BBOX=-90,-180,90,180&WIDTH=4096&HEIGHT=2048&FORMAT=image/png

(WMS 1.3.0 + EPSG:4326 takes the BBOX as lat,lng.) The answer is a 4096x2048 RGBA PNG,
4,971,925 bytes, sha256 fb9ff0790a33e5f9ed562913de7a78fdc76dfe9f29eca4c5173a0319e28f1078,
alpha 255 everywhere: equirectangular (plate carree), north up, -180 deg at the left edge.
Its two edge columns match (mean abs difference 0.96 of 255), so it wraps at the
antimeridian. The ``best`` endpoint and some ``all`` backends answer with a MapServer
error page -- retry. NASA imagery is public domain; GIBS asks to be acknowledged ("We
acknowledge the use of imagery provided by services from NASA's Global Imagery Browse
Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)"). The
PNG is not committed (5 MB); this script and its output are.

What it does
------------
Night lights are bright yellow-white exactly where the densest population columns stand,
which is the top of the Inferno ramp the columns are coloured with. So the lights are held
down, in the texture, before it ever reaches the GPU (the layer draws it unlit, untinted):

1. Tone curve on relative luminance Y (linear light, WCAG weights). Pixels with Y <= KNEE
   are untouched -- the land and ice tone (43, 51, 85) is Y 0.035, the sea (4, 5, 15) is
   Y 0.002, so every non-light pixel keeps its exact colour. Above the knee Y is compressed
   smoothly toward CAP: Y' = KNEE + (CAP - KNEE) * (1 - exp(-(Y - KNEE) / (CAP - KNEE))),
   which is continuous with slope 1 at the knee, monotonic (brighter lights stay brighter)
   and never reaches CAP. RGB is scaled by Y'/Y in linear light, so a light keeps its hue.
2. JPEG ringing check: JPEG rings at the edge of a light against the dark sea (a capped
   light of Y 0.10 decoded at 0.18 in a first try). The encode is decoded, and every 16x16
   block (the 4:2:0 MCU) holding a pixel above TARGET has its light pixels scaled down by
   the overshoot, then it is re-encoded -- until no decoded pixel exceeds TARGET.
3. Bound: TARGET = 0.9 x the relative luminance of Inferno at the ramp's midpoint,
   (186, 57, 83) from ``src/lib/colorRamp.ts`` (``inferno(0.5)``; ``src/lib/basemap.test.ts``
   holds this constant to it). The 10 % headroom covers a different JPEG decoder (the
   browser's) rounding differently. ``--check`` re-asserts the bound on the committed files.

Outputs: black-marble-4096.jpg (4096x2048, for devices with MAX_TEXTURE_SIZE >= 4096) and
black-marble-2048.jpg (2048x1024, a 2x2 box filter in linear light of the toned 4096
image, for WebGL 2's minimum MAX_TEXTURE_SIZE of 2048). Both progressive JPEG,
quality 85, 4:2:0.

Reproducibility: numpy + Pillow, no row loops. The output is byte-identical for the same
source and the same libjpeg build (sha256 below, made with Pillow 12.3.0 / libjpeg-turbo,
numpy 2.5.3); another libjpeg may differ in bytes, and the luminance bound is asserted on
whatever it writes.

Usage:
    python3 -I scripts/texture/encode_black_marble.py <source.png> [--out public/basemap]
    python3 -I scripts/texture/encode_black_marble.py --check [--out public/basemap]
"""

import argparse
import hashlib
import io
import os
import sys

import numpy as np
from PIL import Image

SOURCE_SHA256 = "fb9ff0790a33e5f9ed562913de7a78fdc76dfe9f29eca4c5173a0319e28f1078"
INFERNO_MID = (186, 57, 83)  # inferno(0.5), src/lib/colorRamp.ts
KNEE = 0.04
CAP = 0.11
HEADROOM = 0.9
QUALITY = 85
MAX_BYTES = 2 * 1024 * 1024
OUTPUTS = {"black-marble-4096.jpg": (4096, 2048), "black-marble-2048.jpg": (2048, 1024)}
# sha256 of the committed outputs (Pillow 12.3.0 / libjpeg-turbo); informational, see above.
EXPECTED_SHA256 = {
    "black-marble-4096.jpg": "cf031bd67c76113fc788bb8931dae0ac366b284ffcf8019158689310cdbcd930",
    "black-marble-2048.jpg": "b5eed461dd1871bb051312f7587fc656757efad9e9b65355be53b5f0682db4e8",
}

WEIGHTS = np.array([0.2126, 0.7152, 0.0722])


def to_linear(srgb):
    return np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)


def to_srgb8(linear):
    s = np.where(linear <= 0.0031308, linear * 12.92, 1.055 * np.power(np.maximum(linear, 0), 1 / 2.4) - 0.055)
    return np.clip(np.round(s * 255), 0, 255).astype(np.uint8)


def luminance8(u8):
    return to_linear(u8.astype(np.float64) / 255) @ WEIGHTS


L_MID = float(luminance8(np.array(INFERNO_MID, dtype=np.uint8)))
TARGET = HEADROOM * L_MID


def tone(linear):
    """The knee-and-shoulder curve on Y, applied as a scale in linear light (keeps hue)."""
    y = linear @ WEIGHTS
    span = CAP - KNEE
    y_out = np.where(y <= KNEE, y, KNEE + span * (1 - np.exp(-(y - KNEE) / span)))
    scale = np.where(y > KNEE, y_out / np.maximum(y, 1e-12), 1.0)
    return linear * scale[..., None]


def encode(u8):
    buf = io.BytesIO()
    Image.fromarray(u8).save(buf, "JPEG", quality=QUALITY, progressive=True, optimize=True, subsampling="4:2:0")
    return buf.getvalue()


def decode(data):
    return np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))


def encode_bounded(linear):
    """Encode, and scale the lights of every MCU whose decoded pixels overshoot TARGET, until none does."""
    h, w, _ = linear.shape
    lights = (linear @ WEIGHTS) > KNEE
    for it in range(40):
        data = encode(to_srgb8(linear))
        y = luminance8(decode(data))
        if y.max() <= TARGET:
            return data, it
        ratio = np.where(y > TARGET, TARGET / np.maximum(y, 1e-12), 1.0)
        block = ratio.reshape(h // 16, 16, w // 16, 16).min(axis=(1, 3))
        factor = np.repeat(np.repeat(block, 16, axis=0), 16, axis=1)
        factor = np.where(factor < 1, factor * 0.97, 1.0)
        linear = linear * np.where(lights, factor, 1.0)[..., None]
    raise SystemExit("ringing correction did not converge")


def check(out_dir):
    ok = True
    for name, (w, h) in OUTPUTS.items():
        path = os.path.join(out_dir, name)
        data = open(path, "rb").read()
        u8 = decode(data)
        y = luminance8(u8)
        seam = float(np.abs(u8[:, 0].astype(int) - u8[:, -1].astype(int)).mean())
        good = u8.shape[:2] == (h, w) and len(data) < MAX_BYTES and float(y.max()) <= L_MID
        ok &= good
        print(
            f"{'ok  ' if good else 'FAIL'} {name}: {u8.shape[1]}x{u8.shape[0]}, {len(data):,} bytes (< {MAX_BYTES:,}), "
            f"max relative luminance {float(y.max()):.4f} <= Inferno midpoint {L_MID:.4f}, "
            f"antimeridian seam mean |diff| {seam:.2f}, sha256 {hashlib.sha256(data).hexdigest()}"
        )
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("source", nargs="?")
    ap.add_argument("--out", default=os.path.join("public", "basemap"))
    ap.add_argument("--check", action="store_true", help="only re-check the committed outputs")
    a = ap.parse_args()
    if a.check:
        sys.exit(0 if check(a.out) else 1)
    if not a.source:
        ap.error("source PNG required (or --check)")

    raw = open(a.source, "rb").read()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != SOURCE_SHA256:
        raise SystemExit(f"source sha256 {digest} is not the documented {SOURCE_SHA256}")
    im = Image.open(io.BytesIO(raw))
    if im.mode == "RGBA" and im.getchannel("A").getextrema() != (255, 255):
        raise SystemExit("source has transparent pixels")
    src = np.asarray(im.convert("RGB"))
    linear = to_linear(src.astype(np.float64) / 255)
    toned = tone(linear)
    y_src = linear @ WEIGHTS
    print(
        f"source {src.shape[1]}x{src.shape[0]}: max Y {y_src.max():.4f}; "
        f"{(y_src > KNEE).mean() * 100:.2f} % of pixels above the knee {KNEE} (the rest are left exactly as they are); "
        f"{(y_src > L_MID).mean() * 100:.2f} % brighter than the Inferno midpoint {L_MID:.4f}"
    )

    os.makedirs(a.out, exist_ok=True)
    h, w, _ = toned.shape
    half = toned.reshape(h // 2, 2, w // 2, 2, 3).mean(axis=(1, 3))
    for name, img in (("black-marble-4096.jpg", toned), ("black-marble-2048.jpg", half)):
        data, iters = encode_bounded(img)
        with open(os.path.join(a.out, name), "wb") as f:
            f.write(data)
        sha = hashlib.sha256(data).hexdigest()
        expected = EXPECTED_SHA256.get(name)
        note = "" if expected is None else (" (matches the committed file)" if sha == expected else " (DIFFERS from the committed file's sha256 -- another libjpeg?)")
        print(f"wrote {name}: {len(data):,} bytes after {iters} ringing pass(es), sha256 {sha}{note}")
    sys.exit(0 if check(a.out) else 1)


if __name__ == "__main__":
    main()
