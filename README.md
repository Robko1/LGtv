# IPTV R.T – LG webOS TV

> **v2.3.0 – LG webOS TV külön repo, távirányító fix + külön kinézet + QR telefonos beállítás**
> - Ez a repo **csak LG webOS TV**-re való, külön fejlesztés Android-tól
> - Android verzió külön repo-ban: https://github.com/Robko1/teszt-iptv (Android-only v2.3.0)
> - Telepítés: [webos/README.md](webos/README.md)

## Mi ez?

LG webOS TV alkalmazás (IPK) IPTV R.T-hez:
- Élő TV, Mozi, Sorozat, EPG, kedvencek, beállítások
- Távirányító (D-pad) + Magic Remote + egér támogatás
- Külön kinézet: kisebb lejátszó (1280px max), gyors betöltés, fekvő splash
- QR kódos telefonos provider beállítás (nem kell TV távirányítóval pötyögni)

## Felépítés

```
LGtv/
├── web/                      # React webes felület (Vite, singlefile)
│   ├── src/
│   │   ├── main.tsx          # LG-only, mindig webos-theme
│   │   ├── themes/webos.css  # csak TV kinézet
│   │   └── ...
│   ├── package.json
│   └── vite.config.ts
├── webos/                    # LG webOS TV specifikus
│   ├── appinfo.json          # v2.3.0, hu.rt.iptv.webos
│   ├── webos.js              # Magic Remote + D-pad + modal fókusz fix 2.3.0
│   ├── icon.png / largeIcon.png
│   ├── assets/               # splash.png, icon_tv.png, intro_landscape.mp4
│   └── tools/build-ipk.py    # IPK csomagoló (ar archive)
├── tools/
│   ├── build-webos.sh        # FIX: type=module + crossorigin eltávolítás file:// CORS-hoz
│   └── *.mjs                 # tesztek
├── .github/workflows/
│   ├── webos-build.yml       # IPK építés kézi indítással (workflow_dispatch)
│   └── webos-diagnosis.yml   # FIX: csak FIGYELMEZTETÉS, nem HIBA + marker keresés webos.js-ben is
├── provision.html            # QR telefonos beállítás weboldal
├── QR-TELEFONOS-BEALLITAS.md # QR flow leírás
└── icon.jpg
```

## Workflow-k

| Feladat | Fájl | Indítás |
|---------|------|---------|
| LG diagnosztika | `webos-diagnosis.yml` | Kézi: Actions → IPTV – LG webOS diagnosztika |
| IPK építés | `webos-build.yml` | Kézi: Actions → IPTV – webOS TV IPK építése |

Mindkettő **csak kézi** indítással megy, nem automatikus.

### Fix-ek 39110438592 futásból

- **build-webos.sh**: `re.sub` type=module + crossorigin eltávolítás – file:// nem támogatja module-t, CORS hibát okozott
- **webos-diagnosis.yml**: 6. lépés már csak FIGYELMEZTETÉS, nem exit 1, ha type=module marad (build-webos.sh javítja)
- **Marker keresés**: `webOS`, `IS_WEBOS_TV`, `IS_LG_WEBOS` keresése HTML-ben ÉS webos.js-ben is

## Telepítés LG TV-re

1. **Developer Mode** bekapcsolása TV-n: LG Content Store → Developer Mode → Be
2. **webOS Dev Manager** telepítése PC-re: https://github.com/webosbrew/dev-manager-desktop
3. TV és PC egy hálózaton, Dev Managerben TV hozzáadása (IP + passphrase)
4. **IPK telepítés**: Dev Manager → Install → `IPTV-RT-webOS-2.3.0.ipk` kiválasztása
   - VAGY parancssorból: `ares-install --device <tv> IPTV-RT-webOS-2.3.0.ipk`

Az IPK a GitHub Release-ből is letölthető: `v2.3.0` → `IPTV-RT-webOS-2.3.0.ipk`

## QR telefonos beállítás

Nem kell TV távirányítóval URL-t, usert, passt pötyögni:

1. TV-n Menü → QR kód gomb → mutat egy 6 jegyű kódot + QR linket
2. Telefonnal QR beolvasás → `https://.../provision.html?tv=CODE` megnyílik
3. Telefonon beírod: szerver URL, felhasználó, jelszó, lista típus
4. TV automatikusan poll-ol (kvdb.io bucket `IPTV_RT_QR_8bc03776`) és behúzza a beállításokat

Részletek: [QR-TELEFONOS-BEALLITAS.md](QR-TELEFONOS-BEALLITAS.md) + `provision.html`

## Fejlesztés

```bash
git clone https://github.com/Robko1/LGtv.git && cd LGtv
cd web && npm ci && VITE_WEBOS=true npm run build
# IPK építés
VERSION=2.3.0 bash ../tools/build-webos.sh
# Kimenet: webos/IPTV-RT-webOS-2.3.0.ipk
```

## Verzió

- **v2.3.0** – LG külön repo + Android-only szétválasztás + távirányító fix + QR
- IPK: `IPTV-RT-webOS-2.3.0.ipk` (kb. 500-600KB)
- appinfo.json: `hu.rt.iptv.webos` v2.3.0

Android verzió: https://github.com/Robko1/teszt-iptv (v2.3.0 Android-only)
