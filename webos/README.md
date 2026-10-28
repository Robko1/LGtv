# IPTV R.T – LG webOS TV csomag

A `webos/` mappa az LG TV manifestet, a távirányító webOS-hídját, az alkalmazás ikonjait és a generált platform-indítóképet tartalmazza. A React/Vite forrás a `web/` mappában van.

## Fontos fájlok

```text
webos/appinfo.json       webOS manifest, id: hu.rt.iptv.webos
webos/webos.js           ES5-kompatibilis Magic Remote/D-pad bridge
webos/icon-rt2.png       launcher ikon
webos/largeIcon-rt2.png  nagy launcher ikon
webos/splash-screen.png  1920×1080 indítókép (a betöltőképernyő fátylai, ikon nélkül)
tools/build-webos.sh     web build + ES5 + IPK build
webos/tools/build-ipk.py helyi fejlesztői IPK-csomagoló
```

Az induló MP4 nincs a programban és nincs a `webos/assets/` mappában.

Az indítókép **generált** (`tools/make-splash.py`): a 2.5.162-es betöltőképernyő
fátylait rajzolja ki ugyanazokból az értékekből, **ikon nélkül** – a korábbi
verzió a launcher-ikon felnagyított változatát rajzolta a közepére, és a TV-n ez
mosott, rossz minőségű foltnak látszott. A kép 24 bites RGB (nem palettás), finom
ditheringgel, ezért nincs színlépcső a nagy átmeneten. A betöltőképernyő saját
ikonját (251×252 px) szándékosan NEM nagyítja fel 1920×1080-ra: az közel 1 MB
lenne, és a platform képét a TV a saját kódunk előtt dekódolja (ez az 1 GB
memóriás TV-n mérhető indulási késést okozott). A build minden alkalommal
újragenerálja a képet (`python3 tools/make-splash.py --out-dir build/webos`).

## Helyi build

A repó gyökeréből:

```bash
npm ci --no-audit --no-fund
npm ci --prefix web --no-audit --no-fund
pip install Pillow
VERSION=2.5.160 bash tools/build-webos.sh
```

Kimenet: `webos/IPTV-RT.ipk`. Ez lokális, fejlesztői/Developer Mode csomag; a fájl szándékosan nincs a `main` forráságban, csak a build és a GitHub Release használja.

A csomag ellenőrzése:

```bash
ar t webos/IPTV-RT.ipk
ar p webos/IPTV-RT.ipk data.tar.gz | tar tz | head -n 30
```

## Telepítés saját LG TV-re

1. Telepítsd az LG Content Store-ból a **Developer Mode** alkalmazást.
2. Jelentkezz be LG Developer-fiókkal, kapcsold be a Developer Mode-ot és a Key Servert.
3. PC-n használd a [webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop) alkalmazást, vagy a webOS CLI-t.
4. Add hozzá a TV IP-címét és a Developer Mode passphrase-ét.
5. Válaszd ki az `IPTV-RT.ipk` fájlt az **Install App** műveletben.

CLI-példa:

```bash
npm install -g @webos-tools/cli
ares-setup-device
ares-novacom --device <tv> --getkey
ares-install --device <tv> IPTV-RT.ipk
ares-launch --device <tv> hu.rt.iptv.webos
```

A Developer Mode-os telepítés lejárati idejét maga az LG Developer Mode alkalmazás kezeli.

## Aláírások – ne keverjük össze őket

- A GitHub commit/tag **Verified** jelzése GPG- vagy SSH-commit-aláírás. Ez nem írja alá az IPK-t.
- Hivatalos LG/webOS production/distribution aláíráshoz LG-től kapott tanúsítvány és az LG kiadási folyamata kell. A privát `.p12`/kulcs nem kerülhet Gitbe, logba vagy IPK-ba.
- A jelenlegi custom packager Developer Mode-os fejlesztői csomagot állít elő. Nem készítünk hamis tanúsítványt vagy hamis Verified jelzést.

A GitHub Actions build a csomag tartalmát, verzióját, HTML-jét, ES5-kompatibilitását és SHA-256 értékét ellenőrzi, majd a Release-be tölti fel az IPK-t.
