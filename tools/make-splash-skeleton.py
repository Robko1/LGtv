#!/usr/bin/env python3
"""
2.5.137 – A webOS indítókép (splashBackground) ÚJRA RAJZOLVA.

A 01:41-es TV-napló (2.5.136) szerint az indulás így nézett ki:

    LG TV ellenőrzés (világos logós takarókép)
      → FEKETE kocka (a TV levette a takaróképet, az app még nem festett:
        first-paint 2569 ms, válasz 2493 ms)
      → a SAJÁT képünk (a HTML-be égetett JPEG) megjelenik és OTT MARAD,
        amíg a főoldal be nem tölt (legnagyobb tartalom 4674 ms)
      → főoldal

A felhasználó kérte: a LG-ellenőrzés takaróképe maradjon, de a „másik képet”
cseréljük valami olyanra, ami a KEZDÉSHEZ alkalmazkodik – és tegyük fixen a
főoldalra az OSD-t és a 16:9-es kis képernyőt, hogy csak az adatok rajzolódjanak
a helyükre.

Ez a szkript egy SÖTÉT, ELŐRE RAJZOLT FŐOLDAL-VÁZAT készít 1920×1080-ban:
fix fejléc, fix 16:9 lejátszó doboz (benne a régi, jóváhagyott logóval),
fix OSD sáv, fix jobb oldali csatornalista 16:9-es előnézeti helyekkel.

Ugyanezeket a régiókat a HTML is megrajzolja (#iptv-skeleton, lásd
web/index.html), ezért a TV takaróképe és az alkalmazás ELSŐ festése
gyakorlatilag ugyanaz a kép: nincs fekete kocka, nincs „második kép”, nincs
 nagy villanás. Csak az adatok kerülnek a helyükre.

A kimenet: webos/splash-screen.png (1920×1080). A forrás logó:
tools/boot-logo.jpg (az eredeti, jóváhagyott logó kivágása).

Futtatás: python3 tools/make-splash-skeleton.py
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageStat

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "webos" / "splash-screen.png"
LOGO = ROOT / "tools" / "boot-logo.jpg"

W, H = 1920, 1080
BG = (8, 13, 26)          # #080d1a – az app saját háttere
PANEL = (11, 23, 48)      # #0b1730
PANEL_2 = (7, 14, 30)     # #070e1e
BORDER = (27, 51, 88)     # #1b3358
BAR = (30, 58, 95)        # #1e3a5f
BAR_DIM = (20, 43, 74)    # #142b4a
ACCENT = (34, 211, 238)   # #22d3ee


def rrect(draw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def build() -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # ── Fix fejléc ────────────────────────────────────────────────────────
    d.rectangle((0, 0, W, 96), fill=PANEL_2)
    d.line((0, 95, W, 95), fill=BORDER, width=2)
    rrect(d, (28, 22, 82, 76), 12, (18, 58, 85), outline=ACCENT, width=2)
    # kis lejátszó háromszög a fejléc logójában
    d.polygon([(48, 36), (48, 62), (68, 49)], fill=ACCENT)
    rrect(d, (104, 32, 316, 48), 8, BAR)
    rrect(d, (104, 56, 250, 68), 6, BAR_DIM)
    for i in range(4):
        x = 1500 + i * 100
        rrect(d, (x, 30, x + 82, 68), 10, BAR_DIM)

    # ── Fix 16:9 lejátszó doboz ───────────────────────────────────────────
    px0, py0, px1, py1 = 24, 120, 1448, 920
    rrect(d, (px0, py0, px1, py1), 20, PANEL, outline=BORDER, width=2)
    if LOGO.is_file():
        art = Image.open(LOGO).convert("RGB")
        # A 16:9-es dobozba vágjuk, hogy a régi, jóváhagyott logó megmaradjon.
        box_w, box_h = px1 - px0 - 8, py1 - py0 - 8
        scale = min(box_w / art.width, box_h / art.height)
        art = art.resize((int(art.width * scale), int(art.height * scale)), Image.Resampling.LANCZOS)
        layer = Image.new("RGB", (px1 - px0, py1 - py0), PANEL)
        layer.paste(art, ((layer.width - art.width) // 2, (layer.height - art.height) // 2))
        mask = Image.new("L", layer.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, layer.width - 1, layer.height - 1), 20, fill=255)
        img.paste(layer, (px0 + 4, py0 + 4), mask)
        d = ImageDraw.Draw(img)
    else:
        # Tartalék: CSS-szerű lejátszó háromszög, ha a logó forrása hiányzik.
        cx, cy = (px0 + px1) // 2, (py0 + py1) // 2 - 30
        d.ellipse((cx - 92, cy - 92, cx + 92, cy + 92), fill=(18, 44, 80), outline=ACCENT, width=4)
        d.polygon([(cx - 26, cy - 44), (cx - 26, cy + 44), (cx + 46, cy)], fill=ACCENT)

    # ── Fix OSD sáv a lejátszó alján ──────────────────────────────────────
    osd = Image.new("RGBA", (1376, 96), (6, 12, 26, 214))
    od = ImageDraw.Draw(osd)
    od.rounded_rectangle((0, 0, 1375, 95), 16, fill=(6, 12, 26, 214))
    od.polygon([(34, 28), (34, 68), (64, 48)], fill=(*ACCENT, 255))
    for i, x in enumerate((104, 162, 220)):
        od.rounded_rectangle((x, 34, x + 38, 62), 8, fill=(*BAR, 255))
    od.rounded_rectangle((300, 44, 1120, 52), 4, fill=(*BAR_DIM, 255))
    od.rounded_rectangle((300, 44, 690, 52), 4, fill=(*ACCENT, 255))
    od.ellipse((682, 40, 698, 56), fill=(*ACCENT, 255))
    od.rounded_rectangle((1180, 38, 1320, 58), 10, fill=(*BAR, 255))
    img.paste(osd, (px0 + 36, py1 - 120), osd)
    d = ImageDraw.Draw(img)

    # ── Fix alsó infosáv ──────────────────────────────────────────────────
    rrect(d, (px0, 936, px1, 1056), 18, PANEL, outline=BORDER, width=2)
    rrect(d, (px0 + 28, 962, px0 + 600, 984), 11, BAR)
    rrect(d, (px0 + 28, 996, px0 + 980, 1010), 7, BAR_DIM)
    rrect(d, (px0 + 28, 1020, px0 + 760, 1032), 6, BAR_DIM)

    # ── Fix jobb oldali csatornalista (16:9 előnézeti helyek) ──────────────
    sx0, sy0, sx1, sy1 = 1472, 120, 1896, 1056
    rrect(d, (sx0, sy0, sx1, sy1), 20, PANEL_2, outline=BORDER, width=2)
    rrect(d, (sx0 + 20, sy0 + 18, sx1 - 20, sy0 + 78), 12, PANEL)
    for i in range(8):
        y = sy0 + 96 + i * 104
        if y + 92 > sy1 - 12:
            break
        rrect(d, (sx0 + 20, y, sx1 - 20, y + 92), 12, PANEL)
        # 16:9-es miniatűr hely
        rrect(d, (sx0 + 32, y + 12, sx0 + 152, y + 80), 8, (16, 38, 70))
        rrect(d, (sx0 + 168, y + 22, sx1 - 44, y + 38), 8, BAR)
        rrect(d, (sx0 + 168, y + 50, sx1 - 100, y + 62), 6, BAR_DIM)

    return img


if __name__ == "__main__":
    image = build()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    # 96 színű paletta: a TV ezt a képet az ellenőrzés ELEJÉN olvassa be a
    # lassú flash tárhelyről. 598 KB → ~147 KB, szemmel nem látható különbség,
    # de a takarókép hamarabb fent van (kevesebb fekete kocka).
    quantized = image.quantize(colors=96, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    quantized.save(OUT, "PNG", optimize=True)
    mean = tuple(int(v) for v in ImageStat.Stat(quantized.convert("RGB")).mean)
    print(f"kész: {OUT} {image.size}, {OUT.stat().st_size} byte")
    print("átlagszín (appinfo.bgColor): #%02x%02x%02x" % mean)
