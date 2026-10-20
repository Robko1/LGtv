#!/usr/bin/env bash
# TV – LG webOS TV .ipk készítése
#
# A webes felületet (web/ → build/web/index.html) beleteszi a webOS appba,
# hozzáadja a webOS specifikus fájlokat (appinfo.json, icon, webos.js, splash),
# majd Pythonnal .ipk-t készít.
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

VERSION="${VERSION:-2.3.18}"
APP_ID="hu.rt.iptv.webos"
APP_TITLE="TV"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

# Az új ikon helyi asset: offline is a csomag része, nem külső URL.
ICON_SOURCE="$PROJECT_DIR/ikonkep.png"
if [[ ! -s "$ICON_SOURCE" ]]; then
  echo "HIBA: hiányzik a gyökérben lévő ikonkep.png." >&2
  exit 1
fi
mkdir -p "$PROJECT_DIR/web/public" "$WEBOS_DIR/assets"
cp "$ICON_SOURCE" "$PROJECT_DIR/web/public/ikonkep.png"
python3 - <<'PY'
from pathlib import Path
from PIL import Image
root = Path(".")
img = Image.open(root / "ikonkep.png").convert("RGBA")
img.resize((80, 80), Image.Resampling.LANCZOS).save(root / "webos/icon.png", "PNG")
img.resize((130, 130), Image.Resampling.LANCZOS).save(root / "webos/largeIcon.png", "PNG")
img.resize((512, 512), Image.Resampling.LANCZOS).save(root / "webos/assets/icon_tv.png", "PNG")
# Beégetett (base64) app-ikon a felülethez: nem fájlhivatkozás, a HTML-be kerül.
import base64, io
thumb = img.resize((128, 128), Image.Resampling.LANCZOS)
buf = io.BytesIO()
thumb.save(buf, format="PNG", optimize=True)
encoded = base64.b64encode(buf.getvalue()).decode("ascii")
(root / "web/src/generatedIcon.ts").write_text(
    '// BEÉGETETT alkalmazás-ikon (a repó ikonkep.png fájljából, 128x128 PNG).\n'
    '// Nem külső hivatkozás: a csomagolt egyfájlos HTML-ben is mindig megjelenik.\n'
    '// A build (tools/build-webos.sh és a workflow) ugyanígy újragenerálja.\n'
    'export const APP_ICON_DATA_URL = "data:image/png;base64,' + encoded + '";\n',
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
cp "$WEBOS_DIR/icon.png" "$BUILD_DIR/icon.png"
cp "$WEBOS_DIR/largeIcon.png" "$BUILD_DIR/largeIcon.png"
mkdir -p "$BUILD_DIR/assets"
# Indítóvideót és indítóképet nem csomagolunk; csak nem induló funkciós assetek maradnak.
for asset in "$WEBOS_DIR/assets/"*; do
  [[ -f "$asset" ]] || continue
  case "$(basename "$asset")" in
    *.mp4|*.webm|*.mov|splash.png) continue ;;
  esac
  cp "$asset" "$BUILD_DIR/assets/"
done
# webOS specifikus JS másolása
cp "$WEBOS_DIR/webos.js" "$BUILD_DIR/webos.js"

# 3. index.html feldolgozása webOS-re
log "index.html feldolgozása webOS TV-re (fekvő splash, kisebb lejátszó, gyors betöltés)"

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
appinfo["version"] = os.environ.get("VERSION", appinfo.get("version", "2.3.18"))
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
/* Egyszerű fekvő indítófelirat – videó nélkül */
.webos-splash {{
  position: fixed; inset: 0; width: 100vw; height: 100vh;
  background: #000; z-index: 99999; display: flex; flex-direction: column;
  align-items: center; justify-content: center; color: #00BFFF;
  font-family: Arial, sans-serif; text-align: center;
}}
.webos-splash .splash-title {{ font-size: clamp(64px, 8vw, 140px); font-weight: 800; letter-spacing: 0.08em; }}
.webos-splash .splash-subtitle {{ margin-top: 22px; font-size: clamp(24px, 3vw, 48px); color: #fff; }}
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

# Fekvő splash hozzáadása body elejére
splash_html = """
<div id="webos-splash" class="webos-splash" aria-label="TV">
  <div class="splash-title">TV</div>
</div>
<script>
(function() {
  var splash = document.getElementById('webos-splash');
  setTimeout(function() {
    if (!splash) return;
    splash.style.transition = 'opacity 0.25s';
    splash.style.opacity = '0';
    setTimeout(function() { if (splash.parentNode) splash.parentNode.removeChild(splash); }, 260);
  }, 1600);
})();
</script>
"""

if "<body" in html:
    # body tag után szúrjuk be
    html = re.sub(r'(<body[^>]*>)', r'\1\n' + splash_html, html, count=1)

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
