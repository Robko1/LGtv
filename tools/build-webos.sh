#!/usr/bin/env bash
# TV – LG webOS TV .ipk készítése
#
# A webes felületet (web/ → build/web/index.html) beleteszi a webOS appba,
# hozzáadja a webOS specifikus fájlokat (appinfo.json, icon, webos.js) és a
# logó képkockáját indítóképként (splash-screen.png), majd Pythonnal .ipk-t
# készít. Induló videó nincs (2.5.0).
#
# Használat:
#   tools/build-webos.sh
#   SKIP_WEB=1 tools/build-webos.sh  # meglévő build/web/index.html-t használja
#
# Kimenet:
#   webos/IPTV-RT.ipk (egyetlen végleges kimenet)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WEBOS_DIR="$PROJECT_DIR/webos"
BUILD_DIR="$PROJECT_DIR/build/webos"
WEB_BUILD="$PROJECT_DIR/build/web/index.html"

# A verzió ALAPÉRTELMEZÉSBEN a webes felület verziója (web/src/appVersion.ts):
# így a kézzel épített IPK sosem lesz RÉGEBBI a TV-n már telepített változatnál
# (a webOS a régebbi verziót nem engedi telepíteni).
if [[ -z "${VERSION:-}" ]]; then
  VERSION="$(python3 - <<'PYVER'
import re
from pathlib import Path
src = Path("web/src/appVersion.ts").read_text(encoding="utf-8")
m = re.search(r"WEB_VERSION\s*=\s*'([0-9]+\.[0-9]+\.[0-9]+)'", src)
print(m.group(1) if m else "2.5.13")
PYVER
)"
fi
APP_ID="hu.rt.iptv.webos"
APP_TITLE="TV"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

# A jóváhagyott, átlátszó és lekerekített ikonokat használjuk változtatás nélkül.
# Ne generáljuk újra őket a régi gyökér ikonkep.png fájlból.
mkdir -p "$WEBOS_DIR/assets"
python3 - <<'PY'
from pathlib import Path
from PIL import Image
import base64, io
root = Path(".")
small_path = root / "webos/icon-rt2.png"
large_path = root / "webos/largeIcon-rt2.png"
for path in (small_path, large_path):
    if not path.is_file() or path.stat().st_size == 0:
        raise SystemExit(f"HIBA: hiányzik vagy üres az új ikon: {path}")
small_img = Image.open(small_path).convert("RGBA")
large_img = Image.open(large_path).convert("RGBA")
# A webes felület a két ikont adat URL-ként használja; külön, soha nem
# hivatkozott ikonkep.png fájlt nem generálunk a Vite public mappába.
# A TV saját indítóképernyője a repóban tárolt, jóváhagyott fájl.
if not (root / "webos/splash-screen.png").is_file():
    raise SystemExit("HIBA: hiányzik a webos/splash-screen.png (a logó képkocka).")
def icon_b64(img, px):
    thumb = img.resize((px, px), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    thumb.save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")
(root / "web/src/generatedIcon.ts").write_text(
    '// Beégetett ikonok a jóváhagyott webos ikonfájlokból.\n'
    '// Az átlátszó háttér és a lekerekített szélek megmaradnak.\n'
    'export const APP_ICON_DATA_URL = "data:image/png;base64,' + icon_b64(large_img, 128) + '";\n'
    'export const APP_ICON_SMALL_DATA_URL = "data:image/png;base64,' + icon_b64(small_img, 32) + '";\n',
    encoding="utf-8",
)
PY

# 1. web build (ha kell)
if [[ "${SKIP_WEB:-0}" != "1" ]]; then
  log "Webes felület építése (vite) webOS-hez"
  if command -v npm >/dev/null 2>&1; then
    pushd "$PROJECT_DIR/web" >/dev/null
    if [[ ! -d node_modules ]]; then
      npm install --no-audit --no-fund
    fi
    # webOS-re optimalizált build: kisebb player, gyors betöltés
    VITE_WEBOS=true VITE_WEBOS_FAST_LOAD=true VITE_WEBOS_SMALL_PLAYER=true npm run build
    popd >/dev/null
  else
    warn "Nincs npm – meglévő build/web/index.html-t használom"
  fi
fi

if [[ ! -f "$WEB_BUILD" ]]; then
  echo "HIBA: nem található web build: $WEB_BUILD" >&2
  exit 1
fi

# 1/b. ES5 fordítás régi LG webOS motorokhoz (KRITIKUS!)
# A Vite a teljes appot <script type="module">-ként ágyazza be, amit a
# Chrome 61-nél régebbi TV-motorok (webOS 3.x = Chrome 38, webOS 4.0 = Chrome 53)
# EGYÁLTALÁN NEM futtatnak le – az app el sem indult, a távirányító sem ment.
# Itt: module típus eltávolítása + Babel ES5 + core-js/regenerator/fetch polyfill.
log "Alkalmazás-script ES5 fordítása + polyfill (régi LG webOS motorokhoz)"
if [[ ! -d "$PROJECT_DIR/web/node_modules/@babel/core" ]]; then
  log "Babel függőségek telepítése (web/)"
  pushd "$PROJECT_DIR/web" >/dev/null
  npm install --no-audit --no-fund
  popd >/dev/null
fi
node "$SCRIPT_DIR/transpile-es5.mjs" "$WEB_BUILD"

# 2. webOS app mappa előkészítése
log "webOS app mappa előkészítése"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Alap fájlok másolása
cp "$WEBOS_DIR/appinfo.json" "$BUILD_DIR/appinfo.json"
cp "$WEBOS_DIR/icon-rt2.png" "$BUILD_DIR/icon-rt2.png"
cp "$WEBOS_DIR/largeIcon-rt2.png" "$BUILD_DIR/largeIcon-rt2.png"
# Indítókép (appinfo.json: splashBackground): a logóból kivágott képkocka.
cp "$WEBOS_DIR/splash-screen.png" "$BUILD_DIR/splash-screen.png"
# Kisebb (128 színű) változat: a HTML CSS-e ezt használja háttérként az
# "egy pillanat alatti megjelenés" alatt (a teljes kép 411 KB, ez ~90 KB).
python3 - "$WEBOS_DIR" "$BUILD_DIR" <<'PY'
import sys
from pathlib import Path
from PIL import Image
webos_dir, build_dir = Path(sys.argv[1]), Path(sys.argv[2])
src = Image.open(webos_dir / "splash-screen.png").convert("RGB")
# A webOS indítókép és a HTML háttér UGYANAZ a kép: nincs átmenet/villanás.
# JPEG, mert a fotó-szerű háttér így ~90 KB (PNG-ben 257 KB lenne).
src.resize((1280, 720), Image.Resampling.LANCZOS).save(
    build_dir / "splash-bg.jpg", "JPEG", quality=72, optimize=True, progressive=True
)
print("splash-bg.jpg:", (build_dir / "splash-bg.jpg").stat().st_size, "byte")
PY
mkdir -p "$BUILD_DIR/assets"
# A többi asset (logók, kicsi ikonok) bekerül; videó nem lehet köztük.
for asset in "$WEBOS_DIR/assets/"*; do
  [[ -f "$asset" ]] || continue
  case "$(basename "$asset")" in
    *.mp4|*.webm|*.mov|splash.png) continue ;;
  esac
  cp "$asset" "$BUILD_DIR/assets/"
done

# INDULÓ VIDEÓ NINCS (2.5.0): a videót kivettük a programból - a webOS saját
# indítóképernyője (splash-screen.png, a logó képkockája) után azonnal a
# főoldal indul, és az IPK is jóval kisebb. Ha véletlenül videó kerülne az
# assetek közé, a build megáll (nem akarunk véletlenül nagy csomagot).
if find "$WEBOS_DIR/assets" -maxdepth 1 -type f | grep -Ei '\.(mp4|webm|mov)$'; then
  echo "HIBA: videó van a webos/assets mappában, pedig 2.5.0-tól nincs induló videó." >&2
  exit 1
fi
# webOS specifikus JS másolása
cp "$WEBOS_DIR/webos.js" "$BUILD_DIR/webos.js"

# 3. index.html feldolgozása webOS-re
log "index.html feldolgozása webOS TV-re (nincs induló videó, kisebb lejátszó, gyors betöltés)"

# A web build egy single file HTML, ebbe injektáljuk a webOS dolgokat
VERSION="$VERSION" python3 - << 'PY'
import pathlib
import json
import re
import os

web_build = pathlib.Path("build/web/index.html")
build_dir = pathlib.Path("build/webos")
webos_dir = pathlib.Path("webos")

html = web_build.read_text(encoding="utf-8")

# A tools/transpile-es5.mjs már eltávolította a type="module" script típust
# (a Chrome<61 TV-motorok a module scriptet nem futtatják le!), ES5-re fordította
# az alkalmazást és polyfilleket fűzött elé. Itt csak ellenőrzünk.
if re.search(r'<script[^>]*type="module"', html):
    raise SystemExit('HIBA: module script maradt a HTML-ben - a régi LG TV-ken az app el sem indulna. Futtasd: node tools/transpile-es5.mjs')
if "IPTV-ES5-APP" not in html or "IPTV-ES5-POLYFILLS" not in html:
    raise SystemExit("HIBA: az ES5-re fordított app vagy a polyfill blokk hiányzik a HTML-ből.")
print(f"Vite single-file HTML (ES5 + polyfill, module script nélkül), méret: {len(html)} bytes")

# appinfo.json verzió frissítése
appinfo_path = webos_dir / "appinfo.json"
appinfo = json.loads(appinfo_path.read_text(encoding="utf-8"))
appinfo["version"] = os.environ.get("VERSION", appinfo.get("version", "2.5.1"))
(build_dir / "appinfo.json").write_text(
    json.dumps(appinfo, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)

# webOS.js injektálása a <head>-be
webos_js = (webos_dir / "webos.js").read_text(encoding="utf-8")

# Keresünk </head>-et és elé szúrjuk a webOS scriptet + stílust
injection = f"""
<!-- LG webOS TV specifikus -->
<script>
// webOS TV detektálás és gyors betöltés
{webos_js}
</script>
<style>
/* webOS TV - fekvő teljes képernyő, kisebb lejátszó */
body.webos-tv, body.lg-webos {{
  background: #000;
  overflow: hidden;
}}
/* NINCS induló videó/splash overlay: a webOS saját indítóképernyője (a logó
   képkockája) után azonnal a főoldal jön. */
#boot-error-screen {{ z-index: 2147483000; }}
/* Kisebb TV lejátszó - 1280px max, középen */
.webos-tv .video-player-wrapper {{
  max-width: 1280px;
  margin: 0 auto;
}}
/* FONTOS: korábban itt minden elem animációja 0.15s-re volt gyorsítva
   (animation-duration: 0.15s !important) – ettől a töltéskerék és az óra
   őrülten pörgött/villogott a TV-n. Szándékosan eltávolítva. */
</style>
"""

if "</head>" in html:
    html = html.replace("</head>", injection + "\n</head>")
else:
    html = injection + html

# webOS body osztályok hozzáadása a meglévő class attribútum megőrzésével.
def add_webos_body_classes(match):
    tag = match.group(0)
    classes = ["webos-tv", "lg-webos", "tv-mode"]
    class_match = re.search(r'\bclass=["\']([^"\']*)["\']', tag)
    if class_match:
        existing = class_match.group(1).split()
        merged = list(dict.fromkeys(existing + classes))
        return tag[:class_match.start(1)] + " ".join(merged) + tag[class_match.end(1):]
    return tag[:-1] + ' class="webos-tv lg-webos tv-mode">'
html = re.sub(r'<body\b[^>]*>', add_webos_body_classes, html, count=1)

# NINCS külön webOS splash overlay: a TV saját indítóképernyője (a logó
# képkockája) után azonnal a főoldal jön (2.5.0-tól nincs induló videó).

# A TAKARÓKÉP BEÉGETÉSE (data URI).
#
# A webOS indítóképével AZONOS képet base64-ben írjuk a HTML-be. Erre azért
# van szükség, mert a külső splash-bg.jpg betöltése + dekódolása aszinkron:
# az első festésnél még csak a zöld színátmenet látszott, és a kép csak utána
# ugrott a helyére - a néző ezt úgy élte meg, hogy a takarókép "össze-vissza
# ugrál" indítás közben. Beégetve már az első festésnél a végleges kép van a
# képernyőn, és a takarókép egyetlen váltással tűnik el a kész főoldal javára.
splash_bg = build_dir / "splash-bg.jpg"
if "__IPTV_SPLASH_DATA_URI__" not in html:
    raise SystemExit("HIBA: a web/index.html nem tartalmazza a __IPTV_SPLASH_DATA_URI__ jelölőt.")
if splash_bg.is_file():
    import base64
    data_uri = "data:image/jpeg;base64," + base64.b64encode(splash_bg.read_bytes()).decode("ascii")
    # Csak AZ ELSŐ előfordulást cseréljük: a Python str.replace alapból mindet
    # cseréli, és egy megjegyzésben szereplő jelölő oda is beégette a 120 kB-os
    # képet – ez volt az IPK 2.5.106 → 2.5.110 közti ~185 kB-os ugrásának fele.
    html = html.replace("__IPTV_SPLASH_DATA_URI__", data_uri, 1)
    print(f"splash-bg.jpg beégetve a takaróképbe: {len(data_uri)} karakter")
else:
    # Jelölő nélkül maradna egy érvénytelen url(); ilyenkor üresre cseréljük,
    # így a CSS a tartalék színátmenetre esik vissza.
    html = html.replace("__IPTV_SPLASH_DATA_URI__", "")
    print("FIGYELEM: nincs splash-bg.jpg - a takarókép a tartalék színátmenetet használja.")

# Kiírás
(build_dir / "index.html").write_text(html, encoding="utf-8")
print(f"webOS index.html kész: {len(html)} bytes")

# provision.html másolása ha van – QR telefonos beállítás LG TV-n is
import shutil
provision_src = pathlib.Path("build/web/provision.html")
if provision_src.exists():
    shutil.copy(provision_src, build_dir / "provision.html")
    print(f"provision.html másolva webOS-be: {provision_src.stat().st_size} bytes")
PY

# 4. További webOS fájlok
log "További webOS fájlok"

# webOS library (opcionális, de ajánlott)
cat > "$BUILD_DIR/webOSTV.js" << 'JS'
// webOS TV library stub - ha nincs, akkor is működik
window.webOS = window.webOS || {};
window.webOS.platformBack = window.webOS.platformBack || function() { return false; };
JS

# 5. IPK csomag készítése
log "IPK csomag készítése"

IPK_NAME="IPTV-RT.ipk"
IPK_PATH="$WEBOS_DIR/$IPK_NAME"

python3 "$WEBOS_DIR/tools/build-ipk.py" \
  --app-dir "$BUILD_DIR" \
  --out "$IPK_PATH" \
  --id "$APP_ID" \
  --version "$VERSION"


# 6. Ellenőrzés
log "Ellenőrzés"
if command -v ar >/dev/null 2>&1; then
  echo "  IPK tartalom (ar t):"
  ar t "$IPK_PATH" || true
  echo "  data.tar.gz tartalom:"
  ar p "$IPK_PATH" data.tar.gz | tar tz | head -n 30
else
  echo "  ar nem elérhető, de IPK kész"
fi

SIZE=$(wc -c < "$IPK_PATH")
log "Kész: $IPK_PATH ($((SIZE / 1024)) KB)"
echo ""
echo "Telepítés LG webOS TV-re:"
echo "  1) Kapcsold be a Developer Mode-ot TV-n (LG Content Store → Developer Mode)"
echo "  2) Telepítsd a webOS Dev Manager-t PC-re: https://github.com/webosbrew/dev-manager-desktop"
echo "  3) Csatlakozz TV-hez és Install App → válaszd az .ipk-t"
echo "  VAGY:"
echo "  4) ares-install --device <tv> $IPK_NAME"
