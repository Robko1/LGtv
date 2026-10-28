#!/usr/bin/env python3
"""
A TV platform indítóképe (webOS `splashBackground`) – 2.5.167.

A felhasználói követelmény: az indítóképernyő legyen GYORS és NYUGODT, a
hangsúly a középen lévő százalékon és a töltősávon. Ezért a 2.5.167-es kép
már NEM egy 1920×1080-ra felnagyított fotó (az a PNG-ben ~600 kB volt,
és a TV-nek minden képkockán újra kellett rasztereznie), hanem UGYANAZ a
színátmenetes kompozíció, amit a saját betöltőképernyőnk `.bootbg` rétege
rajzol:

  • sötét teál alap (`#073B3E → #04161C → #08111F`),
  • középen halvány fényfolt (ugyanaz a radial-gradient, mint a CSS-ben),
  • háromrétegű fátyol, 84 pixeles rács és vignetta – a CSS értékeivel,
  • valódi 24 bites RGB, dithering NÉLKÜL (a lágy átmenet nem sávosodik,
    a zaj viszont feleslegesen növelné a fájlt).

Mivel a platform kép és a saját képernyőnk UGYANEZT a kompozíciót rajzolja,
a platform kép levételekor nincs színváltás – és a fájl néhány tíz kB.

A build minden alkalommal újragenerálja (`--out-dir`).

Használat:
    python3 tools/make-splash.py                 # webos/splash-screen.png frissítése
    python3 tools/make-splash.py --out-dir DIR   # a csomagba írás (build)
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
WIDTH, HEIGHT = 1920, 1080
GRID_STEP = 84          # .grid 84 pixeles rácsa
FINAL_BLUR = 2          # a rács éleit lágyítja, a fátylakat nem bántja

# ── A web/index.html #boot-screen rétegeinek pontos értékei ────────────────
# 1) .bootbg: lineáris 180deg színátmenet + középső fényfolt
LINEAR_TOP = (7, 59, 62)        # #073b3e (a dizájn --deep színe)
LINEAR_MID = (4, 22, 28)        # #04161c
LINEAR_BOTTOM = (8, 13, 26)     # #080d1a
GLOW_CORE = (20, 150, 138)      # .bootbg radial-gradient színe
# 2) .scrim rétegei
SCRIM1 = (4, 20, 26)            # radial-gradient(120% 85% at 50% 42%)
SCRIM2 = (3, 17, 22)            # linear-gradient(180deg …)
SCRIM3 = (6, 44, 46)            # linear-gradient(100deg …)
VIG = (2, 12, 16)               # inset 0 0 320px rgba(2,12,16,.95)
GRID = (143, 182, 180)          # .grid vonalai (rgba(143,182,180,…))


def _mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    return (
        int(a[0] + (b[0] - a[0]) * t + 0.5),
        int(a[1] + (b[1] - a[1]) * t + 0.5),
        int(a[2] + (b[2] - a[2]) * t + 0.5),
    )


def _over(base: tuple[int, int, int], top: tuple[int, int, int], alpha: float) -> tuple[int, int, int]:
    return _mix(base, top, 0.0 if alpha < 0 else (1.0 if alpha > 1 else alpha))


def _stops(r: float, table: list[tuple[float, float]]) -> float:
    """Darabonként lineáris átmenet a CSS színmegállóiból."""
    if r <= table[0][0]:
        return table[0][1]
    for index in range(1, len(table)):
        left, right = table[index - 1], table[index]
        if r <= right[0]:
            span = right[0] - left[0]
            if span <= 0:
                return right[1]
            return left[1] + (right[1] - left[1]) * ((r - left[0]) / span)
    return table[-1][1]


def build_splash() -> Image.Image:
    """A betöltőképernyő első képkockája pixelről pixelre, 1920×1080-ban.

    FONTOS: ugyanazok az értékek, mint a `web/index.html` `#boot-screen`
    rétegeiben. Ha ott változik egy szín, itt is változtatni kell – a két kép
    csak így tud váltás nélkül egymásba simulni.
    """
    image = Image.new("RGB", (WIDTH, HEIGHT))
    pixels = image.load()

    # .bootbg – radial-gradient(58% 62% at 50% 44%) + lineáris 180deg
    g_cx, g_cy = WIDTH * 0.50, HEIGHT * 0.44
    g_rx, g_ry = WIDTH * 0.58, HEIGHT * 0.62
    glow_table = [(0.0, 0.42), (0.42, 0.20), (0.72, 0.0)]

    # .scrim – radial-gradient(120% 85% at 50% 42%)
    s1_cx, s1_cy = WIDTH * 0.5, HEIGHT * 0.42
    s1_rx, s1_ry = WIDTH * 1.20, HEIGHT * 0.85
    s1_table = [(0.0, 0.10), (0.46, 0.55), (1.0, 0.90)]
    # .scrim – linear-gradient(180deg …)
    s2_table = [(0.0, 0.86), (0.26, 0.16), (0.62, 0.20), (1.0, 0.92)]
    # .scrim – linear-gradient(100deg …)
    s3_dx, s3_dy = 0.985, -0.174
    s3_span = abs(WIDTH * s3_dx) + abs(HEIGHT * s3_dy)
    # .vig – inset 0 0 clamp(90px,18vw,320px) rgba(2,12,16,.95)
    vig_blur = 320.0
    # .grid – 84 pixeles rács, opacity .30, radiális maszkkal (28% → 100%)
    gr_cx, gr_cy = WIDTH * 0.5, HEIGHT * 0.5
    gr_rx, gr_ry = WIDTH * 1.20, HEIGHT * 0.90

    for y in range(HEIGHT):
        for x in range(WIDTH):
            # ── 1) .bootbg: a lineáris alap (GLOW_CORE felé világosodva) ──
            t = y / HEIGHT
            if t <= 0.52:
                color = _mix(LINEAR_TOP, LINEAR_MID, t / 0.52)
            else:
                color = _mix(LINEAR_MID, LINEAR_BOTTOM, (t - 0.52) / 0.48)
            gx = (x - g_cx) / g_rx
            gy = (y - g_cy) / g_ry
            glow = _stops((gx * gx + gy * gy) ** 0.5, glow_table)
            if glow > 0.0:
                color = _over(color, GLOW_CORE, glow)

            # ── 2) három fátyol, ugyanabban a sorrendben, mint a CSS-ben ──
            s1x = (x - s1_cx) / s1_rx
            s1y = (y - s1_cy) / s1_ry
            color = _over(color, SCRIM1, _stops((s1x * s1x + s1y * s1y) ** 0.5, s1_table))
            color = _over(color, SCRIM2, _stops(t, s2_table))
            s3t = (x * s3_dx + y * s3_dy + HEIGHT * abs(s3_dy)) / s3_span
            color = _over(color, SCRIM3, _stops(s3t, [(0.0, 0.62), (0.55, 0.0)]))

            # ── 3) rács (a fátylak FÖLÖTT, ahogy a CSS z-indexe is) ──
            grx = (x - gr_cx) / gr_rx
            gry = (y - gr_cy) / gr_ry
            gr = (grx * grx + gry * gry) ** 0.5
            if gr > 0.28:
                mask = min(1.0, (gr - 0.28) / 0.72)
                alpha = 0.0
                if x % GRID_STEP == 0:
                    alpha = 0.16 * 0.30 * mask
                elif y % GRID_STEP == 0:
                    alpha = 0.10 * 0.30 * mask
                if alpha > 0.0:
                    color = _over(color, GRID, alpha)

            # ── 4) vignetta ──
            edge = min(x, y, WIDTH - 1 - x, HEIGHT - 1 - y)
            if edge < vig_blur:
                fall = 1.0 - edge / vig_blur
                color = _over(color, VIG, 0.62 * fall * fall)

            pixels[x, y] = (
                min(255, max(0, int(round(color[0])))),
                min(255, max(0, int(round(color[1])))),
                min(255, max(0, int(round(color[2])))),
            )

    if FINAL_BLUR:
        image = image.filter(ImageFilter.GaussianBlur(FINAL_BLUR))
    return image


def write_output(path: Path, image: Image.Image) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Valódi 24 bites RGB: nincs paletta, nincs színlépcső a TV panelen.
    image.save(path, "PNG", optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="TV platform indítókép (a betöltőképernyő első képkockája)")
    parser.add_argument(
        "--out-dir",
        help="Ha meg van adva, ide írja a splash-screen.png fájlt (IPK-ba).",
    )
    args = parser.parse_args()

    image = build_splash()
    target = (Path(args.out_dir) / "splash-screen.png") if args.out_dir else (
        ROOT / "webos" / "splash-screen.png"
    )
    write_output(target, image)
    print(
        f"{target}: {target.stat().st_size // 1024} kB "
        f"({WIDTH}x{HEIGHT}, a betöltőképernyő első képkockája)"
    )


if __name__ == "__main__":
    main()
