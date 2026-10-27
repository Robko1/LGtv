# Új betöltőképernyő a `takarokep.jpg`-ből – 2.5.139 (2026-10-27)

**Kiindulás:** a felhasználó által adott `Inditas.html` (a kívánt megjelenés) és
`takarokep.jpg` (a kívánt háttér). A kérés nem a régi viselkedés javítása volt,
hanem az **indítóképernyő lecserélése** – az IPK összeállításától a TV
főoldalának megjelenéséig.

## Mit kell tudni egy mondatban

A webOS saját indítóképe **és** a saját betöltőképernyőnk háttere ugyanabból a
`takarokep.jpg`-ből készül, a jobb felső sarokban a TV **valós rendszerideje**
jár, a százalék/csatornaszám/sebesség/hátralévő idő pedig **kizárólag** a futó
alkalmazás tényleges adataiból származik – a réteg akkor tűnik el, amikor a
főoldal már ki van festve és használható.

## A fájlok útja az IPK-ba

```text
takarokep.jpg (1920×1080, a repó gyökerében – EGYETLEN forrás)
        │
        ├─ tools/make-splash.py ──> webos/splash-screen.png   (a repóban is)
        │                       └─> build/webos/splash-screen.png   ← webOS splashBackground
        │
        └─ tools/make-splash.py ──> web/public/splash-bg.jpg  (a repóban is)
                                └─> build/webos/splash-bg.jpg  ← a HTML betöltőképernyő háttere
                                    (Vite: web/public → build/web → build/webos)

tools/build-webos.sh
   1. vite build (web/ → build/web)  +  transpile-es5.mjs (ES5 + polyfill)
   2. appinfo.json, ikonok, webos.js másolása
   3. python3 tools/make-splash.py --out-dir build/webos   ← MINDEN buildnél a forrásból
   4. index.html feldolgozása (app.css / app.js kiemelése, preload)
   5. webos/tools/build-ipk.py (ar: debian-binary + control.tar.gz + data.tar.gz)
```

Az IPK-ban (`./usr/palm/applications/hu.rt.iptv.webos/`):

| Fájl | Szerep |
|---|---|
| `splash-screen.png` | `appinfo.json` → `splashBackground`; a platform indítóképe |
| `splash-bg.jpg` | `<img id="boot-bg">` – a betöltőképernyő teljes háttere (baseline JPEG, q86) |
| `index.html` | a betöltőképernyő + a takaró réteg + a megjelenítő híd (~128 KB) |
| `app.js`, `app.css` | az ES5-re fordított alkalmazás (külön fájlban, hogy a HTML kicsi maradjon) |

A két kép **ugyanaz**: 1920×1080, ugyanabból a JPEG-ből. A webOS indítóképéről a
saját képernyőnkre váltás ezért nem hoz új látványt, nincs átméretezés és nincs
színugrás. Az `appinfo.json` `bgColor` értéke a kép mért átlagszíne (`#84bebc`).

## A betöltőképernyő (web/index.html)

- `#tv-curtain` → `#boot-screen` → `#boot-bg` (a teljes háttér, `object-fit: cover`),
  fölötte fátyol/rács/ vignetta, a `takarokep.jpg` világos színeihez hangolva.
- **Fejléc jobb felső sarok:** `#boot-clock` (óó:pp), `#boot-clock-sec`,
  `#boot-date` – mind a `new Date()`-ből, másodpercenként (`setInterval(tickClock, 1000)`,
  az egyetlen időzítő a betöltőképernyőn).
- **Tárcsa:** SVG gyűrű (`#boot-ring`, `2π·122` kerület), `#boot-pct`, `#boot-step`,
  `#boot-status`, `#boot-detail`.
- **Mérő:** `#boot-channels` (csatorna), `#boot-speed` (Mbps), `#boot-eta` (mm:ss),
  szegmentált sáv `#boot-fill` / `#boot-head`.
- Alapállapot: `0%`, és **minden adat helyén `—`** – a képernyő nem talál ki értéket.

## A híd – csak valós adat

`window.__IPTV_BOOT__.update({ percent, phase, step, detail, channels, bytesPerSecond, etaSeconds, version })`
és `.complete()`. A hívó a `web/src/services/bootScreen.ts`:

| Mező | Honnan jön |
|---|---|
| `percent` | a **ténylegesen befejezett** szakaszok: bundle 8, React 16, tároló 26, mentett lista 42/54, szolgáltató 40→78, főoldal 88, festés 94, kész 100 |
| `phase`, `step` | ugyanazok a valós szakaszok (1/7…7/7) |
| `channels` | az App állapotában lévő csatornák száma (`bootScreenChannels`) |
| `bytesPerSecond` | a `net.ts` által mért bájt / eltelt idő, **csak sikeres** válaszból, simítva |
| `etaSeconds` | a mért eltelt időből és a valós százalékból számolt becslés; mérés nélkül `—` |
| `version` | `WEB_VERSION` |

A szolgáltatói betöltés valódi folyamatjelzője (`diagnosticProgress`) a képernyő
40–78%-ára képződik; a filmek/sorozatok letöltése (40% fölött) már nem tolja
tovább a képernyőt, mert a felület ekkor használható.

**Amit szándékosan nem tartalmaz:** `Math.random`, szimulált számláló, CHANNELS
demó-konstans, időzített „befejezés”, demó-újraindítás (ezek az `Inditas.html`
bemutató motorjában voltak). A `#boot-error-screen` a valódi hibaszöveget mutatja.

## A takaró eltűnése

```text
React kirajzol → headerReady()/chromeReady() a #root-on BELÜL
      → bootScreenPhase('shell') 88%
      → preparePaint()  → __IPTV_PREPARE_REVEAL__()  (html.iptv-prerender, #root látható,
                                                        de a #tv-curtain fedi)  → 94%
      → két képkocka (__IPTV_PREPAINT_SETTLED__)
      → checkRendered(): header + mappasáv + lista (vagy üres állapot) + logók + videó
      → revealNow(): bootScreenComplete() (100%) + __IPTV_REVEAL__()
            → webOSSystem.notifyAppLoaded()  (a platform indítóképe lekerül)
            → html.iptv-revealed, #root látható
            → #tv-curtain 200 ms alatt elhalványul (opacity 1 → 0)
            → transitionend vagy 240 ms → __IPTV_FINISH_REVEAL__() (a réteg kikerül)
```

- **Nincs villanás:** a főoldal már a takarókép alatt kifestődik; a váltás
  egyetlen kompozitor-lépés. A platform kép és a saját háttér ugyanaz a fotó.
- **Üres telepítés = kész:** `data-iptv-boot="empty"` esetén azonnal megjelenik a
  kész (üres) felület; a lejátszó doboza színátmenetes posztert kap, nem fekete
  négyzetet.
- **Nincs stream → nincs videóvárakozás:** az App a
  `<html data-iptv-stream="active|none">` jelzőt a tényleges állapotból állítja
  (`customStreamUrl || activeChannel`); `none` esetén a `main.tsx` nem vár az
  első képkockára.
- **Biztonsági hálók:** `main.tsx` 3,5 mp-nél (ha a fejléc kész) / 9 mp-nél
  legkésőbb megjelenít; az `index.html` 12 mp-es hálója csak elakadt indulást ment.
- A `webos.js` felület-őre (`diagUiCheck`) **kihagyja** a takaró réteg elemeit,
  különben a betöltőképernyő saját `<header>`-je miatt a 15 mp-es hibaképernyő
  soha nem jelenne meg valódi elakadásnál.

## Amit a felhasználó kért, és hol teljesül

| Kérés | Hol |
|---|---|
| `takarokep.jpg` teljes képernyős háttér | `#boot-bg` + `boot-scrim` (a kép látszik, csak a szélek sötétebbek) |
| Valós rendszeridő jobb felül | `#boot-clock` / `tickClock()` |
| Valós százalék, csatornaszám, sebesség, hátralévő idő | `bootScreen.ts` + `App.tsx` + `net.ts` |
| Nincs demó-szimuláció, nincs időzített befejezés | lásd fent; a tesztek tiltják |
| Fájlok útja az IPK-ba | `tools/build-webos.sh` + `tools/make-splash.py` |
| A takaró csak kész felületnél tűnik el | `main.tsx` → `index.html` REVEAL-lánc |
| Üres telepítés = kész, nincs videóvárakozás | `data-iptv-boot`, `data-iptv-stream` |
| Minden más funkció marad | a teljes tesztkészlet (229 teszt) zöld |

## Fordítás és ellenőrzés

```bash
npm test                                   # 229 teszt (node --test + próbák)
(cd web && ./node_modules/.bin/tsc --noEmit)
VERSION=2.5.139 bash tools/build-webos.sh  # Pillow kell: pip install Pillow
npm run smoke                              # a csomagolt HTML valóban felépül
ar t webos/IPTV-RT.ipk
ar p webos/IPTV-RT.ipk data.tar.gz | tar tz | grep -E 'splash|app\.|index'
```

A `tools/test-smooth-reveal.mjs`, `test-continuous-startup.mjs`,
`test-package-html.mjs`, `test-empty-boot.mjs`, `test-boot-screen.mjs` és
`provider-load.spec.ts` a fenti viselkedést rögzíti (a régi skeleton/boot-logo
ellenőrzések helyett).
