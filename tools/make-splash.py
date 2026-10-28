#!/usr/bin/env python3
"""
A TV platform indítóképe (webOS `splashBackground`) – folyamatos induláshoz.

2.5.162 – NINCS BENNE IKON, ÉS PONTOSAN A BETÖLTŐKÉPERNYŐ FÁTYLAI.

A felhasználói észrevétel: az IPK indításakor „egy kicsit ikon kép jelenik meg,
az is nagyon rossz minőségű”. Az ok az volt, hogy ez a szkript a 130×130-as
launcher-ikont felnagyítva (260×260) rajzolta a kép közepére, a színátmenetet
pedig 128 színre csökkentett, palettás PNG-be tette – a TV-n ez mosott, sávos
képet adott.

A 2.5.162-es betöltőképernyő háttere a felhasználó saját IPTV-ikonja (251×252
px, a HTML-ben beágyazva). Ezt a platform `splashBackground` képébe NEM lehet
beletenni: 1920×1080-ra felnagyítva közel 1 MB lenne, és a platform képét a TV
a saját kódunk ELŐTT dekódolja – ez lassítaná az indulást (a korábbi 1,1 MB-os
fotó pontosan ezt okozta).

Ezért a platform kép a betöltőképernyő FÁTYLAIT rajzolja ki ugyanazokból az
értékekből, amelyek a `#boot-screen` CSS-ében vannak:
  • három fátyol (radial + két lineáris), fényfolt és vignetta;
  • a háttér és a fátylak alapszíne a dizájn palettája (#04141a / #073b3e);
  • valódi 24 bites RGB + finom dithering (nincs színlépcső/sávosodás a TV
    paneljén).
A platform képéről a saját, MÁR ANIMÁLT betöltőképernyőnkre váltás így
gyakorlatilag észrevehetetlen: ugyanaz a sötét türkiz köd, csak a saját
animációnk és a valós adatok jelennek meg rajta.

A build minden alkalommal újragenerálja (`--out-dir`), ezért az IPK-ba nem
kerülhet elavult kép.

Használat:
    python3 tools/make-splash.py                 # webos/splash-screen.png frissítése
    python3 tools/make-splash.py --out-dir DIR   # a csomagba írás (build)
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
WIDTH, HEIGHT = 1920, 1080

# ── A web/index.html #boot-screen rétegeinek pontos értékei ────────────────
# 1) .stage: background-color #04141a + lineáris 160deg színátmenet + fényfolt
STAGE_BG = (4, 20, 26)          # #04141a
LINEAR_TOP = (7, 59, 62)        # #073b3e (a dizájn --deep színe)
LINEAR_MID = (4, 22, 28)        # #04161c
LINEAR_BOTTOM = (8, 13, 26)     # #080d1a
GLOW_CORE = (14, 124, 116)      # #0e7c74 (a dizájn --teal színe)
GLOW_EDGE = (6, 32, 38)         # rgba(6,32,38,.10)
# 2) .scrim rétegei
SCRIM1 = (4, 20, 26)            # radial-gradient(120% 85% at 50% 42%)
SCRIM2 = (3, 17, 22)            # linear-gradient(180deg …)
SCRIM3 = (6, 44, 46)            # linear-gradient(100deg …)
VIG = (2, 12, 16)               # inset 0 0 190px rgba(2,12,16,.95)


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


# Bayer 8×8 mátrix a sávosodás ellen (±1,5 színlépcső).
_BAYER = (
    (0, 32, 8, 40, 2, 34, 10, 42),
    (48, 16, 56, 24, 50, 18, 58, 26),
    (12, 44, 4, 36, 14, 46, 6, 38),
    (60, 28, 52, 20, 62, 30, 54, 22),
    (3, 35, 11, 43, 1, 33, 9, 41),
    (51, 19, 59, 27, 49, 17, 57, 25),
    (15, 47, 7, 39, 13, 45, 5, 37),
    (63, 31, 55, 23, 61, 29, 53, 21),
)


def build_splash() -> Image.Image:
    """A betöltőképernyő háttere pixelről pixelre, ikon nélkül."""
    image = Image.new("RGB", (WIDTH, HEIGHT))
    pixels = image.load()

    # lineáris 160 fok: a függőlegestől 20 fokkal jobbra dől
    dx, dy = 0.342, 0.940
    span = WIDTH * dx + HEIGHT * dy
    glow_dx, glow_dy = 0.342, 0.940  # a 160 fokos színátmenet iránya

    # .scrim 1 – radial-gradient(120% 85% at 50% 42%) – a % a SUGÁR!
    s1_cx, s1_cy = WIDTH * 0.5, HEIGHT * 0.42
    s1_rx, s1_ry = WIDTH * 1.20, HEIGHT * 0.85
    s1_table = [(0.0, 0.10), (0.46, 0.55), (1.0, 0.90)]
    # .scrim 2 – linear-gradient(180deg …)
    s2_table = [(0.0, 0.86), (0.26, 0.16), (0.62, 0.20), (1.0, 0.92)]
    # .scrim 3 – linear-gradient(100deg …)
    s3_dx, s3_dy = 0.985, -0.174  # 100 fok: jobbra és enyhén felfelé
    # A CSS a színátmenetet a doboz vetületi hosszára feszíti ki – így nincs
    # „levágott” sáv a kép szélén (korábban látható él keletkezett).
    s3_span = abs(WIDTH * s3_dx) + abs(HEIGHT * s3_dy)
    # .vig – inset 0 0 190px
    vig_blur = 190.0

    for y in range(HEIGHT):
        row_bayer = _BAYER[y & 7]
        for x in range(WIDTH):
            # 1) alap színátmenet
            t = (x * dx + y * dy) / span
            if t < 0.46:
                color = _mix(LINEAR_TOP, LINEAR_MID, t / 0.46)
            else:
                color = _mix(LINEAR_MID, LINEAR_BOTTOM, (t - 0.46) / 0.54)

            # 2) fényfolt: 120% 90% at 50% 38% – a százalék a SUGÁRRA vonatkozik
            gx = (x - WIDTH * 0.5) / (WIDTH * 1.20)
            gy = (y - HEIGHT * 0.38) / (HEIGHT * 0.90)
            gr = (gx * gx + gy * gy) ** 0.5
            if gr < 1.0:
                if gr <= 0.52:
                    color = _over(color, GLOW_CORE, 0.42 + (0.10 - 0.42) * (gr / 0.52))
                else:
                    color = _over(color, GLOW_EDGE, 0.10 * (1.0 - (gr - 0.52) / 0.48))

            # 3) három fátyol
            s1x = (x - s1_cx) / s1_rx
            s1y = (y - s1_cy) / s1_ry
            color = _over(color, SCRIM1, _stops((s1x * s1x + s1y * s1y) ** 0.5, s1_table))
            color = _over(color, SCRIM2, _stops(y / HEIGHT, s2_table))
            s3t = (x * s3_dx + y * s3_dy + HEIGHT * abs(s3_dy)) / s3_span
            color = _over(color, SCRIM3, _stops(s3t, [(0.0, 0.62), (0.55, 0.0)]))

            # 4) vignetta (a szélektől befelé halványuló sötétítés)
            edge = min(x, y, WIDTH - 1 - x, HEIGHT - 1 - y)
            if edge < vig_blur:
                fall = 1.0 - edge / vig_blur
                color = _over(color, VIG, 0.72 * fall * fall)

            # 5) dithering – a 8 bites kerekítés ne rajzoljon látható sávokat
            d = (row_bayer[x & 7] / 64.0 - 0.5) * 1.6
            pixels[x, y] = (
                min(255, max(0, int(round(color[0] + d)))),
                min(255, max(0, int(round(color[1] + d)))),
                min(255, max(0, int(round(color[2] + d)))),
            )

    return image


def write_output(path: Path, image: Image.Image) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Valódi 24 bites RGB: nincs paletta, nincs színlépcső a TV panelen.
    image.save(path, "PNG", optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="TV platform indítókép (ikon nélkül, a betöltőképernyő fátylaival)")
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
        f"({WIDTH}x{HEIGHT}, NINCS BENNE IKON, a #boot-screen fátylai)"
    )


if __name__ == "__main__":
    main()
