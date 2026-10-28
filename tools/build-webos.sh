#!/usr/bin/env bash
# TV – LG webOS TV .ipk készítése
#
# A webes felületet (web/ → build/web/index.html) beleteszi a webOS appba,
# hozzáadja a webOS specifikus fájlokat (appinfo.json, icon, webos.js) és a
# generált platform-indítóképet (splash-screen.png), majd Pythonnal .ipk-t
# készít. Induló videó nincs; a platform indítókép (2.5.163) UGYANAZ a kép,
# mint a betöltőképernyő háttere: a web/index.html-be ágyazott saját ikon.
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
# A TV saját indítóképe a feltöltött webos/splash-screen.png fájl.
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
# INDÍTÓKÉP – mindig a felhasználó által feltöltött képet csomagoljuk.
# Ne generáljunk helyette zöld színátmenetet: az IPK-ba ennek a fájlnak
# kell bekerülnie, amelyet az appinfo.json splashBackground mezője használ.
test -s "$WEBOS_DIR/splash-screen.png" || {
  echo "HIBA: hiányzik a feltöltött webos/splash-screen.png." >&2
  exit 1
}
python3 - <<'PY'
from pathlib import Path
from PIL import Image
path = Path("webos/splash-screen.png")
with Image.open(path) as image:
    image.load()
    if image.size != (1920, 1080):
        raise SystemExit(f"HIBA: a feltöltött indítókép mérete {image.size}, várt 1920x1080.")
    if image.mode != "P":
        raise SystemExit(f"HIBA: a feltöltött indítókép módja {image.mode}, várt palettás PNG (P).")
    if path.stat().st_size >= 699 * 1024:
        raise SystemExit(f"HIBA: az indítókép {path.stat().st_size} byte, a megengedett maximum 699 KiB alatt van.")
PY
cp "$WEBOS_DIR/splash-screen.png" "$BUILD_DIR/splash-screen.png"
log "A feltöltött splash-screen.png bemásolva az IPK-ba"
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
import shutil

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

# webOS.js beolvasása (a stílus a <head>-be, a szkript a <body> végére kerül)
webos_js = (webos_dir / "webos.js").read_text(encoding="utf-8")

# A stílus a <head>-be kerül (az első festéshez kell), a webOS SZKRIPT viszont
# a <body> VÉGÉRE (2.5.160). Előbb 81 kB ES5 JS-t kellett kiértékelni a
# <head>-ben, MIELŐTT a betöltőképernyő egyáltalán kifestődhetett – ez a
# platform indítókép utáni holtidő egyik fő oka volt. A szkript a DOM végén
# fut le, még a DOMContentLoaded ELŐTT, és mindig az app.js (a két képkocka
# után indított betöltő) ELŐTT, így a `window.WEBOS_*` jelzők ugyanúgy
# megvannak, amikor az app elindul.
style_injection = f"""
<!-- LG webOS TV specifikus -->
<style>
/* webOS TV - fekvő teljes képernyő, kisebb lejátszó */
body.webos-tv, body.lg-webos {{
  /* 2.5.135: NEM #000. A fekete body háttér volt a REVEAL utáni „fekete
     felvillanás” (a #root 6/14/24 px-es TV-paddingjén átlátszott). */
  background: #080d1a;
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

script_injection = f"""
<!-- LG webOS TV specifikus (a <body> végén: nem késlelteti az első festést) -->
<script>
// webOS TV detektálás és gyors betöltés
{webos_js}
</script>
"""

if "</head>" in html:
    html = html.replace("</head>", style_injection + "\n</head>")
else:
    html = style_injection + html

if "</body>" in html:
    html = html.replace("</body>", script_injection + "\n</body>")
else:
    html = html + script_injection

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

# ═══════════════════════════════════════════════════════════════════════════
# 2.5.137 – A HTML KICSI MARAD: a hatalmas JS/CSS KÜLÖN FÁJLBA KERÜL.
#
# A 01:41-es napló: a csomagolt index.html 1 760 370 byte volt, a TV
# `válasz`=2493 ms, `first-paint`=2569 ms. A böngésző CSAK a teljes fájl
# beolvasása UTÁN festett, ezért a platform takaróképének levétele után
# hosszú FEKETE kocka jött, majd a „saját képünk” és végül a főoldal.
#
# Most a Vite által egy fájlba égetett ~1,2 MB-nyi ES5 JS-t és ~120 KB CSS-t
# kiemeljük app.js / app.css fájlokba. Az index.html ~80 KB marad (csak a
# boot CSS, a webOS híd és az ELŐRE RAJZOLT főoldali váz van benne), így az
# első festés szinte azonnal megtörténik – MÉG a platform takaróképének
# levétele ELŐTT. Nincs üres kocka, nincs második kép, nincs nagy villanás.
# ═══════════════════════════════════════════════════════════════════════════

def externalize_styles(source: str) -> str:
    """A nagy (Vite/Tailwind) <style> blokkokat app.css-be teszi át."""
    chunks = []
    first_at = [None]

    def take(match):
        inner = match.group(1)
        # A nagy stíluslapot mérettől függően külső CSS-fájlba tesszük.
        # Nincs külön HTML-es betöltőképernyő, amelyhez a CSS-t bent kellene tartani.
        if len(inner) < 40000:
            return match.group(0)
        chunks.append(inner)
        if first_at[0] is None:
            first_at[0] = match.start()
            return '<link rel="stylesheet" href="app.css">'
        return ''

    result = re.sub(r'<style[^>]*>([\s\S]*?)</style>', take, source)
    if chunks:
        (build_dir / "app.css").write_text("\n".join(chunks), encoding="utf-8")
        print(f"app.css kiemelve: {sum(len(c) for c in chunks)} byte")
    return result


# ─────────────────────────── GYORS APP-INDÍTÁS ───────────────────────────
# A 19-es TV-napló (16:27:15) mérése:
#   • első festés 1308 ms, FCP 1629 ms – a HTML 173 KB, ez önmagában rendben;
#   • „HOSSZÚ FELADAT: 2101 ms” és „KÉPKOCKA-KIHAGYÁS: 1667 / 3666 ms” – a
#     betöltő animáció a bundle kiértékelése alatt megállt (az első 8 mp-ben
#     összesen 2 képkocka ment ki).
#
# A nagy bundle-t egy pici ES5 betöltő indítja el. A platform natív PNG-je
# marad látható, amíg az alkalmazás HTML/React felülete elindul. Ráadásul a
# core-js/regenerator/fetch polyfill (több száz KB) csak a RÉGI motorokon kell:
# modern webOS-on (Chrome 68+) egyáltalán nem töltjük le és nem értékeljük ki.
LOADER_JS = (
    "(function(){"
    "var d=document;"
    "function start(){"
    "var tag=d.querySelector('script[data-iptv-es5-app]');"
    "if(!tag){return;}"
    "var src=tag.getAttribute('src');"
    "function run(){"
    "var s=d.createElement('script');s.src=src;s.async=false;"
    "(d.body||d.documentElement).appendChild(s);"
    "}"
    "var modern=!!(window.Promise&&window.fetch&&window.Symbol&&window.Map&&window.Set&&"
    "window.WeakMap&&window.Intl&&Object.assign&&Array.from&&Object.entries&&"
    "Element.prototype.closest&&String.prototype.includes);"
    "if(modern){run();return;}"
    "var p=d.createElement('script');p.src='polyfills.js';p.async=false;"
    "p.onload=run;p.onerror=run;"
    "(d.body||d.documentElement).appendChild(p);"
    "}"
    "var raf=window.requestAnimationFrame;"
    "if(raf){raf(function(){raf(function(){setTimeout(start,0);});});}"
    "else{setTimeout(start,16);}"
    "})();"
)


def externalize_scripts(source: str) -> str:
    """A polyfill + ES5 app <script> blokkokat külön fájlokba teszi át."""
    polyfills = []
    app_chunks = []
    replaced = [False]

    def take(match):
        inner = match.group(2)
        is_app = "IPTV-ES5-APP" in inner
        is_poly = "IPTV-ES5-POLYFILLS" in inner
        if not is_app and not is_poly:
            return match.group(0)
        (app_chunks if is_app else polyfills).append(inner)
        if replaced[0]:
            return ''
        replaced[0] = True
        # A(z) `app.js` hivatkozás MARAD a HTML-ben (a <head> preloadja és a
        # csomag-ellenőrző tesztek ezt keresik), de ismeretlen típusú, ezért a
        # böngésző NEM tölti be magától: csak a lenti, pici betöltő indítja.
        return (
            '<script src="app.js" type="text/iptv-deferred" '
            'data-iptv-es5-app="IPTV-ES5-APP" '
            'data-iptv-es5-polyfills="IPTV-ES5-POLYFILLS"></script>\n'
            '<script>' + LOADER_JS + '</script>'
        )

    result = re.sub(r'<script([^>]*)>([\s\S]*?)</script>', take, source)
    if not app_chunks:
        raise SystemExit("HIBA: nem találtam az ES5 alkalmazás-szkriptet a HTML-ben.")
    if polyfills:
        (build_dir / "polyfills.js").write_text("\n;\n".join(polyfills), encoding="utf-8")
        print(f"polyfills.js kiemelve: {sum(len(c) for c in polyfills)} byte (csak régi motoron töltődik)")
    (build_dir / "app.js").write_text("\n;\n".join(app_chunks), encoding="utf-8")
    print(f"app.js kiemelve: {sum(len(c) for c in app_chunks)} byte")
    return result


html = externalize_styles(html)
html = externalize_scripts(html)

# A böngésző előolvasója MÁR a <head> feldolgozásakor kezdje letölteni az
# 1,2 MB-os app.js-t, így mire a parser a dokumentum végére ér (ahol a
# <script> áll), a fájl már a gyorsítótárban van. A váz eközben már kifestődött.
if "<link rel=\"preload\" as=\"script\" href=\"app.js\">" not in html:
    html = html.replace("</head>",
        '<link rel="preload" as="script" href="app.js">\n</head>', 1)

# A betöltőképernyőnek NINCS háttérképe (2.5.158): a háttér CSS színátmenet,
# ezért nincs letöltendő/dekódolandó fotó az első festés előtt.
splash_png = build_dir / "splash-screen.png"
if not splash_png.is_file():
    raise SystemExit("HIBA: hiányzik a splash-screen.png (a platform indítókép).")
if splash_png.stat().st_size >= 699 * 1024:
    raise SystemExit("HIBA: a splash-screen.png nem kisebb 699 KiB-nál – más vagy nem optimalizált kép került a csomagba.")


# Az egyetlen képre mutató hivatkozások relative URL-ek maradnak: a webOS
# az index.html melletti fájlokat helyben, hálózat nélkül olvassa.
(build_dir / "index.html").write_text(html, encoding="utf-8")
print(f"webOS index.html kész: {len(html)} bytes")

# provision.html másolása ha van – QR telefonos beállítás LG TV-n is
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
