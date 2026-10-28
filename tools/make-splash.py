#!/usr/bin/env python3
"""
A TV platform indítóképe (webOS `splashBackground`) – FOTÓ NÉLKÜL.

2.5.158: a betöltőképernyő háttere már nem fotó, hanem a `web/index.html`-ben
élő CSS színátmenet. A webOS saját indítóképe UGYANEZT a sötét színátmenetet
rajzolja ki (a fő márka-jellel a közepén), ezért a platform képéről a saját
betöltőképernyőnkre váltás nem hoz új látványt – nincs villanás, nincs
átméretezés és nincs 8 MB-os fotódekódolás az 1 GB memóriás TV-n.

Korábban ez a szkript a repóból törölt borítóképből készített egy 1,1 MB-os PNG-t
(platform indítókép) ÉS egy 161 kB-os JPEG-et (HTML háttér). Mindkettő
megszűnt: a háttér tiszta CSS, a platform kép pedig néhány kB-os PNG.

Használat:
    python3 tools/make-splash.py                 # webos/splash-screen.png frissítése
    python3 tools/make-splash.py --out-dir DIR   # a csomagba írás (build)
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
MARK = ROOT / "webos" / "largeIcon-rt2.png"
WIDTH, HEIGHT = 1920, 1080

# A web/index.html #boot-screen .stage színátmenetének színei.
TOP = (7, 38, 44)        # #07262c
MID = (4, 22, 28)        # #04161c
BOTTOM = (8, 13, 26)     # #080d1a
GLOW = (31, 120, 116)    # #1f7874


def _mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, t))
    return (
        int(a[0] + (b[0] - a[0]) * t),
        int(a[1] + (b[1] - a[1]) * t),
        int(a[2] + (b[2] - a[2]) * t),
    )


def build_background(w: int = 480, h: int = 270) -> Image.Image:
    """Sötét, 160 fokos színátmenet + teal fényfolt – kicsiben, majd felnagyítva."""
    image = Image.new("RGB", (w, h))
    pixels = image.load()
    for y in range(h):
        # 160 fokos irány közelítése: fentről lefelé, balról jobbra világosodó.
        for x in range(w):
            t = (y / h) * 0.82 + (x / w) * 0.18
            if t < 0.46:
                color = _mix(TOP, MID, t / 0.46)
            else:
                color = _mix(MID, BOTTOM, (t - 0.46) / 0.54)
            pixels[x, y] = color

    # Teal fényfolt a betöltőképernyő CSS radial-gradientje szerint.
    glow = Image.new("RGB", (w, h), (0, 0, 0))
    draw = ImageDraw.Draw(glow)
    steps = 48
    cx, cy = w * 0.5, h * 0.38
    max_r = w * 0.62
    for step in range(steps, 0, -1):
        ratio = step / steps
        radius = max_r * ratio
        strength = 0.42 * (1.0 - ratio) ** 1.6
        if strength <= 0.002:
            continue
        col = _mix((0, 0, 0), GLOW, strength)
        draw.ellipse(
            [cx - radius, cy - radius * 0.78, cx + radius, cy + radius * 0.78],
            fill=col,
        )
    glow = glow.filter(ImageFilter.GaussianBlur(radius=w * 0.02))
    image = Image.blend(image, Image.blend(image, glow, 0.55), 0.85)
    return image.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)


def build_splash() -> Image.Image:
    image = build_background()
    if MARK.is_file():
        mark = Image.open(MARK).convert("RGBA")
        side = 260
        mark = mark.resize((side, side), Image.Resampling.LANCZOS)
        # A márka-jel a kép közepe fölött, a betöltőképernyő tárcsájának helyén.
        x = (WIDTH - side) // 2
        y = int(HEIGHT * 0.42) - side // 2
        image = image.convert("RGBA")
        image.alpha_composite(mark, (x, y))
        image = image.convert("RGB")
    return image


def write_output(path: Path, image: Image.Image) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Palettás PNG: a színátmenethez bőven elég, és töredéke a valódi méretnek.
    image.convert("P", palette=Image.Palette.ADAPTIVE, colors=128).save(
        path, "PNG", optimize=True
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="TV platform indítókép készítése (fotó nélkül)")
    parser.add_argument(
        "--out-dir",
        help="Ha meg van adva, ide írja a splash-screen.png fájlt (IPK-ba).",
    )
    args = parser.parse_args()

    splash = build_splash()
    target = (Path(args.out_dir) / "splash-screen.png") if args.out_dir else (
        ROOT / "webos" / "splash-screen.png"
    )
    write_output(target, splash)
    print(f"{target}: {target.stat().st_size // 1024} kB ({WIDTH}x{HEIGHT})")


if __name__ == "__main__":
    main()
