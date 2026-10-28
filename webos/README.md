# IPTV R.T – LG webOS TV csomag

A `webos/` mappa a manifestet, a távirányítóhídat, a jóváhagyott ikonokat és a natív indítóképet tartalmazza. A React/Vite alkalmazás a `web/` könyvtárban van.

## Védett indítási referencia: 2.5.176

A felhasználó által sikeresnek elfogadott működés a **natív webOS takarókép után közvetlenül megjelenő főoldal**. A `webos/appinfo.json` a `splashBackground: "splash-screen.png"` fájlt használja; a React `#root` nincs saját HTML-takaróval elrejtve. A `web/src/main.tsx` a gyökér első DOM-elemének megjelenése után hívja a `webOSSystem.notifyAppLoaded()`-et, ha van ilyen API. Nincs külön saját animáció, százalékos indítóképernyő vagy induló videó. A DOM-jelzés nem azonos a fizikai kijelző festési időpontjának mérésével.

**Ne cseréld le a jóváhagyott képet vagy ezt a folyamatot régi, generált splashre/animációra.** A képmegjelenítés és EPG is védett referencia: [fő README](../README.md); verziózott mérések: [tesztnapló](../README-TESZTNAPLO.md).

## Fontos fájlok

```text
webos/appinfo.json       manifest; app ID: hu.rt.iptv.webos
webos/webos.js           webOS távirányító- és felülethíd
webos/icon-rt2.png       launcher ikon
webos/largeIcon-rt2.png  nagy launcher ikon
webos/splash-screen.png  felhasználó által feltöltött natív indítókép
tools/build-webos.sh     web build, ES5-fordítás és IPK-építés
webos/tools/build-ipk.py helyi fejlesztői IPK-csomagoló
```

## Helyi build

A repó gyökeréből, Node.js 22 és Python 3 mellett:

```bash
npm ci --no-audit --no-fund
npm ci --prefix web --no-audit --no-fund
# Pillow telepítése a saját Python-környezetbe:
python3 -m pip install Pillow
npm test
bash tools/build-webos.sh
```

A script alapértelmezésben a `web/src/appVersion.ts` `WEB_VERSION` értékét használja a **csomagolt** manifesthez; `VERSION=x.y.z` környezeti változóval ez felülírható. Kimenet siker esetén: `webos/IPTV-RT.ipk`, amely Git által ignorált fejlesztői csomag.

**Ismert helyi akadály:** a checkoutban lévő `splash-screen.png` 1659×948, RGB és kb. 1,4 MiB. A script 1920×1080, palettás (`P`), 699 KiB alatti PNG-t ellenőriz, így ezen a forráson megáll. A script nem generálja és nem alakítja át az indítóképet. A kézi GitHub **IPK építés** workflow a meglévő fájlt a runneren átméretezi és palettásra optimalizálja a csomagolás előtt; ez nem azonos a helyi script viselkedésével. Bármilyen jóváhagyott képi változtatást külön kell kezelni és TV-n ellenőrizni.

Sikeres csomagolás után például:

```bash
ar t webos/IPTV-RT.ipk
ar p webos/IPTV-RT.ipk data.tar.gz | tar tz | head -n 30
npm run smoke  # build/webos/index.html szükséges
```

## Telepítés saját LG TV-re

1. Telepítsd az LG Content Store-ból a **Developer Mode** alkalmazást.
2. Jelentkezz be LG Developer-fiókkal, kapcsold be a Developer Mode-ot és a Key Servert.
3. PC-n használd a [webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop) alkalmazást vagy a webOS CLI-t, és add hozzá a TV-t a Developer Mode adataival.
4. Telepítsd a sikeres buildből vagy Release-ből származó `IPTV-RT.ipk` fájlt.

CLI-példa a repó gyökeréből:

```bash
npm install -g @webos-tools/cli
ares-setup-device
ares-novacom --device <tv> --getkey
ares-install --device <tv> webos/IPTV-RT.ipk
ares-launch --device <tv> hu.rt.iptv.webos
```

A Developer Mode lejáratát az LG alkalmazása kezeli. A helyi vagy CI build sikere önmagában nem igazolja a kép, EPG és indulás működését az adott televízión.

## Aláírás és kiadás

A GitHub commit/tag **Verified** jelzése nem az IPK aláírása. A jelenlegi csomagoló Developer Mode-os fejlesztői IPK-t készít; hivatalos LG/webOS terjesztéshez az LG által előírt tanúsítvány és eljárás szükséges. A privát kulcs nem kerülhet Gitbe, naplóba vagy chatbe. Részletek: [RELEASE-SIGNING.md](../RELEASE-SIGNING.md). A kézi GitHub build verziót emel, csomagot ellenőriz és Release-t hoz létre: [README-PUSH.md](../README-PUSH.md).
