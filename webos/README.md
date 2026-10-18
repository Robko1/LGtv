# IPTV R.T – kizárólag LG webOS TV

> Ez a repó önálló LG webOS TV-alkalmazás. A forrás, build és csomagolás kizárólag ebben a repóban történik.

## Mi ez?

- **Forrás mappa:** `webos/` – LG webOS TV app forrása (appinfo.json, icon, index.html, webos.js, splash)
- **Build kimenet:** `webos/IPTV-RT-webOS-<verzió>.ipk` és `webos/dist/` másolat
- **Kinézet:** LG webOS TV-re kialakított (React + Tailwind), reszponzív TV-re
- **Lejátszó:** kisebb (1280x720 alap, de 1920x1080-ra skálázódik), natív `<video>` + hls.js, webOS natív HLS támogatás is
- **Betöltés:** gyors mód – csak élő TV először (1 kérés), VOD kategóriák gyorsan, film/sorozat tartalom lusta (csak ha a felhasználó Mozi/Sorozat menübe lép) – így 20k csatorna is 2-3s alatt indul TV-n
- **Splash videó:** fekvő 1920x1080 `assets/intro_landscape.mp4` és `assets/splash.png`, LG TV fekvő képernyőjére tervezve (1920x1080)

## Fájlok

```
webos/
  appinfo.json          – webOS manifest (id: hu.rt.iptv.webos, version: 2.3.1, 1920x1080)
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
- `webos/IPTV-RT-webOS-2.3.1.ipk`
- `webos/dist/` másolat

### Mit csinál a build?

1. `web/` Vite build `VITE_WEBOS=true VITE_WEBOS_FAST_LOAD=true` – kisebb player, gyors betöltés
2. `build/web/index.html` → `build/webos/index.html` + `webos.js` injektálás + fekvő splash HTML + `webos-tv` body class
3. `webos/` + `build/webos/` → `data.tar.gz` → `control.tar.gz` + `debian-binary` → ar archive `.ipk`

### Ellenőrzés

```bash
ar t webos/IPTV-RT-webOS-2.3.1.ipk
# debian-binary, control.tar.gz, data.tar.gz

ar p webos/IPTV-RT-webOS-2.3.1.ipk data.tar.gz | tar tz | head -n 20
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
ares-install --device <tv> IPTV-RT-webOS-2.3.1.ipk
ares-launch --device <tv> hu.rt.iptv.webos
```

### 4. USB? (webOS-en nincs közvetlen USB telepítés, csak Dev Mode)

LG webOS TV-re külső IPK telepítéshez Developer Mode szükséges.

## Letöltés

- **IPK buildkimenet:** `webos/IPTV-RT-webOS-2.3.1.ipk` (a kézi build hozza létre; csak sikeres build után létezik a repóban)
- **GitHub Release:** https://github.com/Robko1/LGtv/releases/tag/v2.3.1

## Technikai részletek (fejlesztőknek)

- **appinfo.json:** id `hu.rt.iptv.webos`, type `web`, main `index.html`, resolution `1920x1080`, webOS TV-hez szükséges engedélyek
- **webos.js:** Magic Remote, Back (461), Channel Up/Down, színes és média gombok
- **HTML:** webOS script + TV-s CSS; fekvő splash és TV-re optimalizált megjelenés
- **Gyors betöltés:** élő TV először, film- és sorozattartalom igény szerinti betöltése
- **IPK formátum:** ar archívum, benne `control.tar.gz`, `data.tar.gz` és az LG webOS alkalmazás fájljai

## Verzió

- **LG webOS IPK:** `hu.rt.iptv.webos`, v2.3.1
- **Kimenet:** `webos/IPTV-RT-webOS-2.3.1.ipk`

Ez a repó kizárólag LG webOS TV-re készül, és csak IPK-csomagot állít elő.
