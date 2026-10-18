# IPTV R.T – IPTV mindörökre 2 – Android TV + LG webOS TV támogatás

**Telepítés:**

- **Android telefon / tablet / TV box / stick:** töltsd le az `IPTV-mindorokre-2.apk` fájlt (v36, ~41 MB), nyisd meg – régi verzió helyére települ. Lista, kedvencek, beállítások megmaradnak.
- **LG webOS TV:** töltsd le az `IPTV-RT-webOS-1.26.0.ipk` fájlt (537 KB), telepítés Dev Mode + Dev Managerrel. Részletek: `LG-WEBOS-TELEPITES.md` és `webos/README.md`

## Újdonságok ebben a verzióban

### 1. Android TV támogatás – univerzális APK (v1.25.0 / v36)

- Egy APK telefonra ÉS Android TV-re (box, stick, beépített Android TV)
- TV launcher: LEANBACK_LAUNCHER + banner – megjelenik TV főképernyőjén
- Tájolás javítva TV-n: fekvő alapértelmezett, nem kényszerít állóba – telefonon marad álló főoldal
- D-pad / távirányító támogatás natívan: WebView fókusz, nyilak, Enter, Back, média gombok továbbítva
- Touchscreen nem kötelező – TV-n is telepíthető

### 2. LG webOS TV változat – külön mappában (v1.26.0 / IPK 1.26.0)

- **Külön mappa:** `webos/` – nem keverve Androiddal (`android/`), ugyanaz a kinézet mint Androidon
- **Kisebb TV lejátszó:** 1280x720 alap, 1920x1080-ra skálázódik, kevesebb erőforrás, gyorsabb indulás – „valami kisebb tv lejátszó legyen benne”
- **Gyors betöltés:** csak élő TV először (1 kérés), VOD kategóriák gyorsan, film/sorozat tartalom lusta (Mozi/Sorozat menüre töltődik) – „gyorsan töltse be a szolgáltatótól a csatornákat”
- **Fekvő splash videó:** 1920x1080 `intro_landscape.mp4` + `splash.png`, nem álló 1080x2400 mint Androidon – „bejelentkező videót tv re tervezd ne álló videó legyen”
- **Magic Remote:** Back (461) → Escape, Channel Up/Down, színes gombok, média gombok
- **IPK formátum:** ar archive (debian-binary 2.0, control.tar.gz, data.tar.gz) → `/usr/palm/applications/hu.rt.iptv.webos/`
- **Letöltés ugyanoda mint Android:** `apk/IPTV-RT-webOS-1.26.0.ipk` + Releases v2.0.0 + `webos/` mappába

### 3. Korábbi javítások megmaradtak

- Gyorsított betöltés (20k csatorna, 40k film, 15k sorozat 102s → ~40-50% gyorsabb)
- Filmek/sorozatok bulk egyben lekérés (23 kérés helyett 1)
- 2 concurrent kérés, 80ms gap, circuit breaker, ritkább yield 500/500
- Fekvő teljes képernyő automatikus nyújtás (fill) minden csatornaváltáskor – élő, mozi, sorozat
- Mozi/sorozat álló 16:9 keret mint élő TV-nél
- Élő hiba Újrapróbálás Stabil pufferrel, hangsáv azonnali váltás
- Teljesen reszponzív: telefon, tablet, laptop, TV (1920px+), egér, billentyűzet, D-pad

## Telepítés

### Android TV / telefon

- Downloader: `https://github.com/Robko1/teszt-iptv/releases/download/v2.0.0/IPTV-mindorokre-2.apk`
- USB / Send Files to TV / ADB
- Részletek: `TV-TELEPITES.md`

### LG webOS TV

- Developer Mode: LG Content Store → Developer Mode → On
- Dev Manager: https://github.com/webosbrew/dev-manager-desktop → Install App → IPK
- ares-cli: `ares-install --device tv IPTV-RT-webOS-1.26.0.ipk`
- Részletek: `LG-WEBOS-TELEPITES.md` és `webos/README.md`

## Verziók

- Web: **1.26.0** – LG webOS TV támogatás
- Android APK: **v36** `IPTV mindörökre 2` – `apk/IPTV-mindorokre-2.apk`
- webOS IPK: **v1.26.0** `hu.rt.iptv.webos` – `webos/IPTV-RT-webOS-1.26.0.ipk` + `apk/` másolat
- Release: **v2.0.0** – mindkettő
