#!/usr/bin/env python3
"""
A TV indítóképe – a `takarokep.jpg` az EGYETLEN forrás.

A felhasználó által megadott takaróképből két fájl készül:

  1. `splash-screen.png` (1920×1080) – a webOS saját indítóképe
     (appinfo.json → `splashBackground`). Ez a LG ellenőrzése és a platform
     indítás alatt látszik.
  2. `splash-bg.jpg` (1920×1080, BASELINE JPEG) – a HTML betöltőképernyő
     teljes háttere (`web/index.html` → `<img id="boot-bg">`).

A kettő UGYANABBÓL a képből, UGYANABBAN a felbontásban készül, ezért a
webOS indítóképéről a saját betöltőképernyőnkre váltás nem hoz új látványt –
nincs villanás, nincs átméretezés, nincs második kép.

A baseline (nem progresszív) JPEG szándékos: a progresszív JPEG részleges
dekódolása kockás köztes képet festhet az első képkockán.

Használat:
    python3 tools/make-splash.py                 # webos/ + web/public frissítése
    python3 tools/make-splash.py --out-dir DIR   # a csomagba írás (build)

A build (`tools/build-webos.sh`) a `--out-dir` módot használja, így az IPK-ba
MINDIG a takarokep.jpg-ből frissített kép kerül.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "takarokep.jpg"
WIDTH, HEIGHT = 1920, 1080
JPEG_QUALITY = 86


def build_background() -> Image.Image:
    """A takarókép 1920×1080-as, 16:9-ra igazított változata."""
    if not SOURCE.is_file():
        raise SystemExit(f"HIBA: hiányzik a forrás takarókép: {SOURCE}")
    image = Image.open(SOURCE).convert("RGB")
    if image.size != (WIDTH, HEIGHT):
        # Középre igazított, torzításmentes méretezés 16:9-re.
        image = image.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
    return image


def write_outputs(image: Image.Image, png_path: Path, jpg_path: Path) -> None:
    png_path.parent.mkdir(parents=True, exist_ok=True)
    jpg_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(png_path, "PNG", optimize=True)
    image.save(jpg_path, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=False)


def main() -> None:
    parser = argparse.ArgumentParser(description="TV indítókép készítése a takarokep.jpg-ből")
    parser.add_argument(
        "--out-dir",
        help="Ha meg van adva, ide írja a splash-screen.png és splash-bg.jpg fájlt (IPK-ba).",
    )
    args = parser.parse_args()

    image = build_background()

    if args.out_dir:
        out = Path(args.out_dir)
        write_outputs(image, out / "splash-screen.png", out / "splash-bg.jpg")
    else:
        write_outputs(
            image,
            ROOT / "webos" / "splash-screen.png",
            ROOT / "web" / "public" / "splash-bg.jpg",
        )

    for name in ("splash-screen.png", "splash-bg.jpg"):
        path = (Path(args.out_dir) / name) if args.out_dir else (
            ROOT / "webos" / name if name.endswith(".png") else ROOT / "web" / "public" / name
        )
        print(f"{name}: {path.stat().st_size} byte ({WIDTH}x{HEIGHT})")


if __name__ == "__main__":
    main()
