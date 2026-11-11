#!/usr/bin/env python3
"""Beépített (data-URL) csatornalogók tömörítése a bundle-ben – 2.5.264.

A web/src/generatedHuLogos.ts fájlban minden logó `data:image/png;base64,…`
alakban van. Ez a script minden képet újratömörít úgy, hogy:
  - a hosszabb oldal legfeljebb --max-px (alap 128) pixel,
  - palettás (P módú) PNG legyen legfeljebb --colors (alap 128) színnel,
  - a fájlméret kisebb legyen (ha az új nem kisebb, az eredeti marad).

Ha minden kép már megfelel (méret + paletta), a script érintetlenül hagyja a
fájlt (gyorsellenőrzés – a webos-build workflow minden buildnél lefuttatja, és
így csak akkor dolgozik, ha tényleg nagyobb képek kerültek be).

Használat:
  python3 tools/optimize-embedded-logos.py [web/src/generatedHuLogos.ts] \
      --max-px 128 --colors 128
"""
import argparse
import base64
import io
import re
import sys
from pathlib import Path

from PIL import Image

DATA_URL_RE = re.compile(r"data:image/png;base64,([A-Za-z0-9+/=]+)")


def palette_colors(img: Image.Image) -> int:
    """A ténylegesen használt színek száma (P módban a paletta használat)."""
    if img.mode != "P":
        return 1 << 30
    colors = img.getcolors(maxcolors=1 << 24)
    return len(colors) if colors is not None else 1 << 30


def already_ok(img: Image.Image, max_px: int, colors: int) -> bool:
    return (
        img.mode == "P"
        and img.width <= max_px
        and img.height <= max_px
        and palette_colors(img) <= colors
    )


def optimize_png(data: bytes, max_px: int, colors: int) -> bytes:
    with Image.open(io.BytesIO(data)) as img:
        img.load()
        if already_ok(img, max_px, colors):
            return data
        has_alpha = img.mode in ("RGBA", "LA") or (
            img.mode == "P" and "transparency" in img.info
        )
        source = img.convert("RGBA") if has_alpha else img.convert("RGB")
        if source.width > max_px or source.height > max_px:
            scale = min(max_px / source.width, max_px / source.height)
            new_size = (max(1, round(source.width * scale)), max(1, round(source.height * scale)))
            source = source.resize(new_size, Image.Resampling.LANCZOS)
        # Logóknál a dither NEM segít (nagyobb fájl), ezért NONE. RGBA-hoz csak
        # a FASTOCTREE mód engedélyezett (MEDIANCUT csak RGB-hez jó).
        if has_alpha:
            quantized = source.quantize(colors=colors, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
        else:
            quantized = source.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        buffer = io.BytesIO()
        quantized.save(buffer, format="PNG", optimize=True, compress_level=9)
        result = buffer.getvalue()
        return result if len(result) < len(data) else data


def main() -> int:
    parser = argparse.ArgumentParser(description="Beépített PNG logók tömörítése.")
    parser.add_argument("file", nargs="?", default="web/src/generatedHuLogos.ts")
    parser.add_argument("--max-px", type=int, default=128)
    parser.add_argument("--colors", type=int, default=128)
    args = parser.parse_args()

    path = Path(args.file)
    if not path.is_file():
        print(f"HIBA: nincs ilyen fájl: {path}")
        return 1
    text = path.read_text(encoding="utf-8")
    matches = list(DATA_URL_RE.finditer(text))
    if not matches:
        print(f"Nincs tömörítendő data-URL a fájlban: {path}")
        return 0

    total_before = 0
    total_after = 0
    changed = 0
    skip = 0

    def replace(match: re.Match) -> str:
        nonlocal total_before, total_after, changed, skip
        raw = base64.b64decode(match.group(1))
        total_before += len(raw)
        new = optimize_png(raw, args.max_px, args.colors)
        if new is raw or new == raw:
            skip += 1
            total_after += len(raw)
            return match.group(0)
        changed += 1
        total_after += len(new)
        return "data:image/png;base64," + base64.b64encode(new).decode("ascii")

    new_text = DATA_URL_RE.sub(replace, text)
    print(
        f"Logók: {len(matches)} db, változtatva={changed}, már megfelelő={skip}; "
        f"méret: {total_before} -> {total_after} byte "
        f"({100.0 * total_after / max(1, total_before):.1f}%)"
    )
    if changed:
        path.write_text(new_text, encoding="utf-8")
        print(f"Írva: {path} ({path.stat().st_size} byte a fájl)")
    else:
        print("Minden kép már megfelelő – a fájl változatlan.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
