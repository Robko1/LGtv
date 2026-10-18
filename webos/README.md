# IPTV R.T – kizárólag LG webOS TV

> Ez a repó önálló LG webOS TV-alkalmazás. A forrás, build és csomagolás kizárólag ebben a repóban történik.

## Mi ez?

- **Forrás mappa:** `webos/` – LG webOS TV app forrása (appinfo.json, icon, index.html, webos.js, splash)
- **Build kimenet:** `webos/IPTV-RT-webOS-<verzió>.ipk` és `webos/dist/` másolat
- **Kinézet:** LG webOS TV-re kialakított (React + Tailwind), reszponzív TV-re
- **Lejátszó:** kisebb (1280x720 alap, de 1920x1080-ra skálázódik), natív `<video>` + hls.js, webOS natív HLS támogatás is
- **Betöltés:** gyors mód – csak élő TV először (1 kérés), VOD kategóriák gyorsan, film/sorozat tartalom lusta (csak ha a felhasználó Mozi/Sorozat menübe lép) – így 20k csatorna is 2-3s alatt indul TV-n
- **Splash videó:** fekvő 1920x1080 `assets/intro_landscape.mp4` és `assets/splash.png`, LG TV fekvő képernyőjére tervezve (1080x2400)

## Fájlok

```
webos/
  appinfo.json          – webOS manifest (id: hu.rt.iptv.webos, version: 1.25.0, 1920x1080)
  icon.png              – 80x80 TV launcher ikon
  largeIcon.png         – 130x130 nagy ikon
  index.html            – buildelt web app (Vite singlefile + webos.js injektálva)
  webos.js              – webOS specifikus: Magic Remote, gyors betöltés, kisebb lejátszó, fekvő splash
  webOSTV.js            – webOS lib stub
  assets/
    splash.png          – 1920x1080 fekvő splash (fekete + IPTV R.T logo)
    icon_tv.png         – 512x512 TV ikon
    intro_landscape.mp4 – 1920x1080 fekvő intro videó (3s, IPTV R.T + LG webOS TV)
  tools/
    build-ipk.py        – Python .ipk csomagoló (ar archive: debian-binary, control.tar.gz, data.tar.gz)
  dist/
    IPTV-RT-webOS-*.ipk – kicsomagolt app másolat (opcionális)
```

## Build

### Helyi build (npm + Python)

```bash
tools/build-webos.sh
# vagy gyors, web build nélkül:
SKIP_WEB=1 tools/build-webos.sh
```

Kimenet:
- `webos/IPTV-RT-webOS-1.25.0.ipk`
- `webos/dist/` másolat

### Mit csinál a build?

1. `web/` Vite build `VITE_WEBOS=true VITE_WEBOS_FAST_LOAD=true` – kisebb player, gyors betöltés
2. `build/web/index.html` → `build/webos/index.html` + `webos.js` injektálás + fekvő splash HTML + `webos-tv` body class
3. `webos/` + `build/webos/` → `data.tar.gz` → `control.tar.gz` + `debian-binary` → ar archive `.ipk`

### Ellenőrzés

```bash
ar t webos/IPTV-RT-webOS-1.25.0.ipk
# debian-binary, control.tar.gz, data.tar.gz

ar p webos/IPTV-RT-webOS-1.25.0.ipk data.tar.gz | tar tz | head -n 20
# ./usr/palm/applications/hu.rt.iptv.webos/appinfo.json
# ./usr/palm/applications/hu.rt.iptv.webos/index.html
# ./usr/palm/applications/hu.rt.iptv.webos/icon.png
# ...
```

## Telepítés LG webOS TV-re

### 1. Developer Mode bekapcsolása TV-n

1. LG Content Store → keresd: **Developer Mode** → Telepítés
2. Nyisd meg, jelentkezz be LG Developer fiókkal
3. Kapcsold be **Dev Mode Status** → **On**, **Key Server** → **On**
4. Jegyezd fel a TV IP-jét és a jelszót (passphrase)

### 2. Dev Manager PC-n

- Töltsd le: https://github.com/webosbrew/dev-manager-desktop (Windows/Mac/Linux)
- Telepítsd, indítsd el
- Add hozzá TV-t: IP + passphrase
- Csatlakozás után **Install App** → válaszd az `.ipk`-t

### 3. ares-cli (fejlesztői)

```bash
npm install -g @webosose/ares-cli
ares-setup-device # add TV
ares-install --device <tv> IPTV-RT-webOS-1.25.0.ipk
ares-launch --device <tv> hu.rt.iptv.webos
```

### 4. USB? (webOS-en nincs közvetlen USB telepítés, csak Dev Mode)

A webOS TV-kre csak Developer Mode-on keresztül lehet 3rd party appot telepíteni, nincs „ismeretlen forrás” mint Androidon.

## Letöltés

Ugyanoda mint az Android APK:

- **IPK a repóban:** `webos/IPTV-RT-webOS-2.3.0.ipk`
- **GitHub Release:** https://github.com/Robko1/LGtv/releases/tag/v2.3.0 → `IPTV-RT-webOS-2.3.0.ipk`

## Technikai részletek (fejlesztőknek)

- **appinfo.json:** id `hu.rt.iptv.webos`, type `web`, main `index.html`, resolution `1920x1080`, icon 80x80, largeIcon 130x130, splash 1920x1080, permissions `com.webos.media`, `disableBackHistoryAPI: true`, `supportPortraitMode: false` (fekvő)
- **webos.js:** `IS_WEBOS_TV=true`, `WEBOS_FAST_LOAD=true`, `WEBOS_SMALL_PLAYER=true`, `WEBOS_LANDSCAPE_SPLASH=true`, Magic Remote Back (461) → Escape, Channel Up/Down, színes gombok, média gombok, `webOSRelaunch`, `visibilitychange`
- **index.html injektálás:** webOS script + CSS (kisebb lejátszó 1280px max, fekvő splash 100vw/100vh, fókusz gyűrű 3px #00BFFF, gyorsabb animáció 0.15s), body class `webos-tv lg-webos tv-mode`, splash div `#webos-splash` 2s után eltűnik
- **Gyors betöltés:** `providerImport.ts` detektálja `WEBOS_FAST_LOAD` vagy `Web0S` UA-t → csak élő TV + VOD/sorozat kategóriák gyorsan, tartalom üres, VOD lusta később (App.tsx-ben Mozi/Sorozat menüre töltődik)
- **Kisebb lejátszó:** `webos.ts` `getWebOSPlayerSize()` 1280x720, CSS `max-width: 1280px` középen, kevesebb erőforrás, gyorsabb indulás
- **Fekvő videó:** `assets/intro_landscape.mp4` 1920x1080 3s, `assets/splash.png` 1920x1080, nem álló 1080x2400 mint Androidon
- **IPK formátum:** ar archive (debian-binary 2.0, control.tar.gz, data.tar.gz), data tartalmazza `/usr/palm/applications/hu.rt.iptv.webos/` – webOS TV-n ide települ

## Verzió

- Web: **1.26.0** (tervezett) – webOS TV támogatás
- webOS IPK: **v1.25.0** `hu.rt.iptv.webos` – `webos/IPTV-RT-webOS-1.25.0.ipk` + `apk/` másolat + Release v2.0.0
- Android APK: **v36** `IPTV mindörökre 2` – `apk/IPTV-mindorokre-2.apk`

## Különbség Android vs webOS

|  | Android (APK) | LG webOS (IPK) |
|---|---|---|
| Mappa | `android/` + `apk/` | `webos/` + `apk/` (másolat) |
| Formátum | .apk (aapt2+d8+apksigner) | .ipk (ar+tar.gz) |
| Telepítés | Downloader/USB/ADB | Dev Mode + Dev Manager / ares-install |
| Splash | álló 1080x2400 mp4 | fekvő 1920x1080 mp4 + png |
| Lejátszó | natív libmpv + FFmpeg (UnifiedPlayer) | kisebb <video> + hls.js + webOS natív HLS |
| Betöltés | bulk VOD 1 kérés + 2 concurrent | gyors: csak élő TV először, VOD lusta |
| Ikon | app_icon.jpg + app_banner.jpg | icon.png 80x80 + largeIcon.png 130x130 + splash.png 1920x1080 |
| Távirányító | D-pad + Back + média | Magic Remote + Back (461) + színes + Channel Up/Down |
