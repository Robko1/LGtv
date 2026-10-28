#!/usr/bin/env python3
"""
A TV platform indítóképe (webOS `splashBackground`) – folyamatos induláshoz.

2.5.163 – A PLATFORM KÉP A BETÖLTŐKÉPERNYŐ ELSŐ KÉPKOCKÁJA.

A felhasználó kérése: a takarókép és az indítási animáció UGYANAZ a látvány
legyen, és már az IPK indulásakor látszódjon. A `web/index.html`
betöltőképernyőjének háttere a saját IPTV-ikon (faltól falig, sötétítve,
telítve, 30 mp-es lassú úszással), fölötte fátylak, rács és vignetta.

Ez a szkript UGYANAZT rajzolja ki 1920×1080-ban:
  • a hátteret a `web/index.html`-be ágyazott ikonból nagyítja (cover), a CSS
    filtereivel (brightness .88, saturate 1.2, contrast 1.04) és a kép 1.08-as
    nagyításával – így a platform kép és a saját animált képernyőnk első
    képkockája gyakorlatilag ugyanaz;
  • három fátyol (radial + két lineáris), 84 pixeles rács és vignetta,
    ugyanazokból az értékekből, mint a `#boot-screen` CSS-ében;
  • valódi 24 bites RGB + finom dithering (nincs színlépcső/sávosodás a TV
    paneljén).

Az ikon forrása MINDIG a `web/index.html` – nincs külön másolat, ezért a
platform kép nem tud elavulni. A kép 1920×1080-ra nagyítva néhány száz kB;
a TV helyben olvassa, hálózat nélkül.

A build minden alkalommal újragenerálja (`--out-dir`).

Használat:
    python3 tools/make-splash.py                 # webos/splash-screen.png frissítése
    python3 tools/make-splash.py --out-dir DIR   # a csomagba írás (build)
"""

from __future__ import annotations

import argparse
import base64
import io
import re
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
WIDTH, HEIGHT = 1920, 1080
BOOT_PAGE = ROOT / "web" / "index.html"
ICON_ZOOM = 1.08        # a .bootbg scale(1.08)-a
GRID_STEP = 84          # .grid 84 pixeles rácsa
# Kis amplitúdójú dithering: a kép sötét, sima részein (a fátylak alatt) ez
# tünteti el a 8 bites színlépcsőket, a PNG méretét mérhetően nem növeli.
DITHER = 1.2
# A kész kép utolsó lágyítása: a 251 px-es ikon felnagyítva pixelközel van, a
# TV paneljén ez csillogást adna; 4 px Gauss eltünteti, a fátylakat nem.
FINAL_BLUR = 2

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
VIG = (2, 12, 16)               # inset 0 0 320px rgba(2,12,16,.95)
GRID = (143, 182, 180)          # .grid vonalai (rgba(143,182,180,…))


def load_boot_icon() -> Image.Image:
    """A betöltőképernyő háttere: a web/index.html-be ágyazott ikon.

    Nincs külön képfájl – a platform kép és a saját képernyőnk MINDIG ugyanabból
    a képből készül, ezért nem tud elválni egymástól.
    """
    html = BOOT_PAGE.read_text(encoding="utf-8")
    match = re.search(r'data:image\/jpeg;base64,([^"]+)"', html)
    if not match:
        raise SystemExit(
            "HIBA: a web/index.html-ben nincs beágyazott ikon (data:image/jpeg)."
        )
    raw = base64.b64decode(match.group(1))
    return Image.open(io.BytesIO(raw)).convert("RGB")


def _cover(image: Image.Image, width: int, height: int, zoom: float) -> Image.Image:
    """object-fit: cover + a .bootbg scale() nagyítása, középre igazítva."""
    scale = max(width / image.width, height / image.height) * zoom
    resized = image.resize(
        (max(width, round(image.width * scale)), max(height, round(image.height * scale))),
        Image.LANCZOS,
    )
    left = (resized.width - width) // 2
    top = (resized.height - height) // 2
    return resized.crop((left, top, left + width, top + height))


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
    """A betöltőképernyő első képkockája pixelről pixelre, 1920×1080-ban."""
    # ── 1) a háttér: a saját ikon, cover, 1.08 nagyítás, a CSS filtereivel ──
    base = _cover(load_boot_icon(), WIDTH, HEIGHT, ICON_ZOOM)
    base = base.filter(ImageFilter.GaussianBlur(2))       # a felnagyított kép lágy
    base = ImageEnhance.Brightness(base).enhance(0.88)    # brightness(.88)
    base = ImageEnhance.Color(base).enhance(1.20)         # saturate(1.2)
    base = ImageEnhance.Contrast(base).enhance(1.04)      # contrast(1.04)
    base_pixels = base.load()

    image = Image.new("RGB", (WIDTH, HEIGHT))
    pixels = image.load()

    # .scrim 1 – radial-gradient(120% 85% at 50% 42%) – a % a SUGÁRRA vonatkozik
    s1_cx, s1_cy = WIDTH * 0.5, HEIGHT * 0.42
    s1_rx, s1_ry = WIDTH * 1.20, HEIGHT * 0.85
    s1_table = [(0.0, 0.10), (0.46, 0.55), (1.0, 0.90)]
    # .scrim 2 – linear-gradient(180deg …)
    s2_table = [(0.0, 0.86), (0.26, 0.16), (0.62, 0.20), (1.0, 0.92)]
    # .scrim 3 – linear-gradient(100deg …)
    s3_dx, s3_dy = 0.985, -0.174
    s3_span = abs(WIDTH * s3_dx) + abs(HEIGHT * s3_dy)
    # .vig – inset 0 0 clamp(90px,18vw,320px) rgba(2,12,16,.95)
    vig_blur = 320.0
    # .grid – 84 pixeles rács, opacity .30, radiális maszkkal (28% → 100%)
    g_cx, g_cy = WIDTH * 0.5, HEIGHT * 0.5
    g_rx, g_ry = WIDTH * 1.20, HEIGHT * 0.90

    for y in range(HEIGHT):
        row_bayer = _BAYER[y & 7]
        for x in range(WIDTH):
            color = base_pixels[x, y]

            # ── 2) három fátyol, ugyanabban a sorrendben, mint a CSS-ben ──
            s1x = (x - s1_cx) / s1_rx
            s1y = (y - s1_cy) / s1_ry
            color = _over(color, SCRIM1, _stops((s1x * s1x + s1y * s1y) ** 0.5, s1_table))
            color = _over(color, SCRIM2, _stops(y / HEIGHT, s2_table))
            s3t = (x * s3_dx + y * s3_dy + HEIGHT * abs(s3_dy)) / s3_span
            color = _over(color, SCRIM3, _stops(s3t, [(0.0, 0.62), (0.55, 0.0)]))

            # ── 3) rács (a fátylak FÖLÖTT, ahogy a CSS z-indexe is) ──
            grx = (x - g_cx) / g_rx
            gry = (y - g_cy) / g_ry
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

            # ── 4) vignetta (a szélektől befelé halványuló sötétítés) ──
            edge = min(x, y, WIDTH - 1 - x, HEIGHT - 1 - y)
            if edge < vig_blur:
                fall = 1.0 - edge / vig_blur
                color = _over(color, VIG, 0.62 * fall * fall)

            # ── 5) dithering – a 8 bites kerekítés ne rajzoljon látható sávokat ──
            d = (row_bayer[x & 7] / 64.0 - 0.5) * DITHER
            pixels[x, y] = (
                min(255, max(0, int(round(color[0] + d)))),
                min(255, max(0, int(round(color[1] + d)))),
                min(255, max(0, int(round(color[2] + d)))),
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
