# IPTV R.T – LG webOS TV

> **v2.3.3 – kizárólag LG webOS TV, távirányító + QR telefonos beállítás**
> - Ez a repó kizárólag LG webOS TV-re készül.
> - Nem tölt le, nem másol és nem használ forráskódot másik alkalmazásrepóból.
> - Telepítés: [webos/README.md](webos/README.md)

## Mi ez?

LG webOS TV alkalmazás (IPK) IPTV R.T-hez:
- Élő TV, Mozi, Sorozat, EPG, kedvencek, beállítások
- Távirányító (D-pad) + Magic Remote + egér támogatás
- Külön kinézet: kisebb lejátszó (1280px max), gyors betöltés; nincs indítóvideó vagy splash kép
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
│   ├── appinfo.json          # v2.3.3, hu.rt.iptv.webos
│   ├── webos.js              # Magic Remote + D-pad + OK fókusznavigáció
│   ├── icon.png / largeIcon.png
│   ├── assets/               # icon_tv.png (nincs splash vagy intro videó)
│   └── tools/build-ipk.py    # IPK csomagoló (ar archive)
├── tools/
│   ├── build-webos.sh        # FIX: type=module + crossorigin eltávolítás file:// CORS-hoz
│   └── *.mjs                 # tesztek
├── .github/workflows/
│   ├── webos-build.yml       # IPK építés kézi indítással (workflow_dispatch)
│   └── webos-manual-diagnosis.yml   # FIX: csak FIGYELMEZTETÉS, nem HIBA + marker keresés webos.js-ben is
├── provision.html            # QR telefonos beállítás weboldal
├── QR-TELEFONOS-BEALLITAS.md # QR flow leírás
└── icon.jpg
```

## Workflow-k

| Feladat | Fájl | Indítás |
|---------|------|---------|
| LG diagnosztika | `webos-manual-diagnosis.yml` | Kézi: Actions → LG webOS – kézi diagnosztika és web build |
| IPK építés | `webos-build.yml` | Kézi: Actions → IPK építés |

Mindkettő **csak kézi** indítással megy, nem automatikus.

### Fix-ek 39110438592 futásból

- **build-webos.sh**: `re.sub` type=module + crossorigin eltávolítás – file:// nem támogatja module-t, CORS hibát okozott
- **webos-manual-diagnosis.yml**: külön, kézzel indítható LG webOS buildellenőrzés
- **Marker keresés**: `webOS`, `IS_WEBOS_TV`, `IS_LG_WEBOS` keresése HTML-ben ÉS webos.js-ben is

## Telepítés LG TV-re

1. **Developer Mode** bekapcsolása TV-n: LG Content Store → Developer Mode → Be
2. **webOS Dev Manager** telepítése PC-re: https://github.com/webosbrew/dev-manager-desktop
3. TV és PC egy hálózaton, Dev Managerben TV hozzáadása (IP + passphrase)
4. **IPK telepítés**: Dev Manager → Install → `IPTV-RT.ipk` kiválasztása
   - VAGY parancssorból: `ares-install --device <tv> IPTV-RT.ipk`

A sikeres kézi IPK-build után a GitHub Release `v2.3.1` tartalmazza az `IPTV-RT.ipk` csomagot.

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
cd web && npm install --no-audit --no-fund && VITE_WEBOS=true npm run build
# IPK építés
VERSION=2.3.3 bash ../tools/build-webos.sh
# Kimenet: webos/IPTV-RT.ipk
```

## Verzió

- **v2.3.1** – LG webOS-only build + távirányító fix + QR
- IPK: `IPTV-RT.ipk` (kb. 500-600KB)
- appinfo.json: `hu.rt.iptv.webos` v2.3.3

