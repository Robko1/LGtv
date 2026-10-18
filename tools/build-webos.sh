#!/usr/bin/env bash
# IPTV R.T – LG webOS TV .ipk készítése
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
#   webos/IPTV-RT-webOS-<verzió>.ipk
#   webos/dist/IPTV-RT-webOS-<verzió>.ipk (másolat)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WEBOS_DIR="$PROJECT_DIR/webos"
BUILD_DIR="$PROJECT_DIR/build/webos"
DIST_DIR="$WEBOS_DIR/dist"
WEB_BUILD="$PROJECT_DIR/build/web/index.html"

VERSION="${VERSION:-2.3.2}"
APP_ID="hu.rt.iptv.webos"
APP_TITLE="IPTV R.T webOS"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

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

# 2. webOS app mappa előkészítése
log "webOS app mappa előkészítése"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$WEBOS_DIR/dist" "$DIST_DIR"

# Alap fájlok másolása
cp "$WEBOS_DIR/appinfo.json" "$BUILD_DIR/appinfo.json"
cp "$WEBOS_DIR/icon.png" "$BUILD_DIR/icon.png"
cp "$WEBOS_DIR/largeIcon.png" "$BUILD_DIR/largeIcon.png"
mkdir -p "$BUILD_DIR/assets"
cp -r "$WEBOS_DIR/assets/"* "$BUILD_DIR/assets/" 2>/dev/null || true
# Biztosítsuk hogy a fekvő intro videó is benne legyen
if [[ -f "$WEBOS_DIR/assets/intro_landscape.mp4" ]]; then
  cp "$WEBOS_DIR/assets/intro_landscape.mp4" "$BUILD_DIR/assets/intro_landscape.mp4"
fi

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

# FONTOS: a Vite single-file bundle megőrzi a module script típust.
# A type="module" törlése olyan kódnál, amely import.meta-t használ,
# szintaktikai hibát okozhat, és a TV a 2/7 DOM kész lépésnél marad.
# A JavaScript/CSS egyetlen HTML-be van inline-olva, ezért nincs külső modul-CORS kérés.
print(f"Vite single-file HTML megőrizve, méret: {len(html)} bytes")

# appinfo.json verzió frissítése
appinfo_path = webos_dir / "appinfo.json"
appinfo = json.loads(appinfo_path.read_text(encoding="utf-8"))
appinfo["version"] = os.environ.get("VERSION", appinfo.get("version", "2.3.2"))
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
/* Fekvő splash videó - 1920x1080 */
.webos-splash {{
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  background: #000 url('assets/splash.png') center/cover no-repeat;
  z-index: 99999;
  display: flex;
  align-items: center;
  justify-content: center;
}}
.webos-splash video {{
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}}
.webos-splash img {{
  display: none;
  position: relative;
  z-index: 1;
  width: 400px;
  height: 400px;
  object-fit: contain;
}}
/* Kisebb TV lejátszó - 1280px max, középen */
.webos-tv .video-player-wrapper {{
  max-width: 1280px;
  margin: 0 auto;
}}
/* Gyorsabb betöltés - kevesebb animáció */
.webos-tv * {{
  animation-duration: 0.15s !important;
}}
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
<div id="webos-splash" class="webos-splash">
  <video id="webos-intro-video" autoplay muted playsinline preload="auto">
    <source src="assets/intro_landscape.mp4" type="video/mp4" />
  </video>
  <img id="webos-intro-fallback" src="assets/icon_tv.png" alt="IPTV R.T" />
</div>
<script>
(function() {
  var splash = document.getElementById('webos-splash');
  var video = document.getElementById('webos-intro-video');
  var fallback = document.getElementById('webos-intro-fallback');
  var finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    if (splash) {
      splash.style.transition = 'opacity 0.5s';
      splash.style.opacity = '0';
      setTimeout(function() { if (splash.parentNode) splash.parentNode.removeChild(splash); }, 500);
    }
  }
  if (video) {
    video.addEventListener('ended', finish);
    video.addEventListener('error', function() {
      video.style.display = 'none';
      if (fallback) fallback.style.display = 'block';
      setTimeout(finish, 1500);
    });
  }
  // Biztonsági tartalék, ha a TV nem küld videóeseményt.
  setTimeout(finish, 4500);
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

IPK_NAME="IPTV-RT-webOS-${VERSION}.ipk"
IPK_PATH="$WEBOS_DIR/$IPK_NAME"
IPK_DIST_PATH="$DIST_DIR/$IPK_NAME"

python3 "$WEBOS_DIR/tools/build-ipk.py" \
  --app-dir "$BUILD_DIR" \
  --out "$IPK_PATH" \
  --id "$APP_ID" \
  --version "$VERSION"

cp "$IPK_PATH" "$IPK_DIST_PATH"

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
log "Másolat: $IPK_DIST_PATH"
echo ""
echo "Telepítés LG webOS TV-re:"
echo "  1) Kapcsold be a Developer Mode-ot TV-n (LG Content Store → Developer Mode)"
echo "  2) Telepítsd a webOS Dev Manager-t PC-re: https://github.com/webosbrew/dev-manager-desktop"
echo "  3) Csatlakozz TV-hez és Install App → válaszd az .ipk-t"
echo "  VAGY:"
echo "  4) ares-install --device <tv> $IPK_NAME"
