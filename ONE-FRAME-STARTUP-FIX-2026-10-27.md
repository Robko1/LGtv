# Egy kép az elejétől a végéig – 2.5.137 (2026-10-27)

**TV-napló:** `807bcdb8-3bed-4d13-ab65-d228369124fa` (01:41:00, 79 sor, 2.5.136).

## A felhasználó leírása

> „Akkor villan fel a fekete kép, mikor az LG TV elvégezte a dolgát, azután
> felvillan a fekete, mert aztán a saját képünk kerül sorra, és az addig ott
> marad, még be nem töltődik a főoldal! Ezt a nagy villanást kell orvosolni.”
>
> Tovább: Xtream-kód bevitelekor nem ugrik fel a betöltési diagnosztika, sem a
> kis kérdéses ablak (folyamat vagy csatornák); és minden akadozik, amíg a
> sorozatok/filmek töltődnek. Kérte: az OSD-t és a 16:9-es kis képernyőt
> fixen a főoldalra tenni, az adatok csak a helyükre rajzolódjanak.

## Mérés – mi volt a „nagy villanás”

| Jel | 00:14 (#2) | 00:14 (#3) | **01:41 (#1)** |
|---|---|---|---|
| átvitt HTML | 1 567 306 B | 1 567 306 B | **1 760 370 B** |
| `válasz` | 413 ms | 863 ms | **2493 ms** |
| first-paint / FCP | 948 ms | 989 ms | **2569 ms** |
| LEGNAGYOBB TARTALOM | 1414 ms | 2532 ms | **4483 → 4674 ms** |
| REVEAL | +715 ms | +1739 ms | **+2155 ms** |
| képkocka-kihagyás | 22 | 7 | 12 (max 283 ms) |

A 4674 ms-es legnagyobb tartalom egy `<div class="absolute inset-0 z-[1]">`
volt, **1 274 140 px²** – az üres IPK lejátszó-poszterére tett, későn
dekódolódó, beégetett JPEG (2.5.135).

**A lánc:** az LG TV saját takaróképe (ellenőrzés) → a platform leveszi → a
webes ablak még **nem festett** (a HTML 1,76 MB, 2,5 mp a `válasz`) → **fekete
kocka** → 2,5 mp-nél megjön a **saját, világos logós képünk** → az ott marad,
amíg a React főoldal be nem tölt → újabb ugrás. Három különböző kép, két
fekete/világos ugrás.

A korábbi 2.5.135-ös javítások (valódi `<img decoding="sync">`, egy tartalék
PNG-réteg, áttűnés, sötét body) **működtek**, de a gyökeret nem érték el: a
HTML-be égetett 265 KB-os JPEG + 46 KB-os PNG és az 1,2 MB-nyi beégetett ES5
JavaScript miatt az első festés 2,5 mp-re csúszott.

## A javítás – NINCS két kép

### 1. A webOS takaróképét magát rajzoltuk át a főoldali vázra

`tools/make-splash-skeleton.py` → `webos/splash-screen.png` (1920×1080,
**147 KB**, 96 színre kvantálva):

- fix fejléc,
- **fix 16:9 lejátszó doboz** (benne a régi, jóváhagyott logó – a brand
  megmaradt),
- **fix OSD sáv** a lejátszó alján,
- fix jobb oldali csatornalista **8 db 16:9-es előnézeti hellyel**,
- végig sötét `#080d1a` alap.

Az LG TV ellenőrzés alatt **továbbra is ez a takarókép látszik**
(`appinfo.json`: `splashBackground: splash-screen.png`). Csak a tartalma lett
olyan, mint a kész főoldal. `bgColor` = a kép mért átlaga: `#213c51`.

### 2. A főoldal vázát a HTML rajzolja meg – még mielőtt a JS elindul

`web/index.html`: `#tv-curtain` → `#iptv-skeleton`. Tiszta HTML + CSS, **nincs
kép-dekódolás**, nincs base64:

```
[data-iptv-slot="header"]    fix fejléc
[data-iptv-slot="player"]    aspect-ratio: 16/9, benne a kis boot-logo.jpg
[data-iptv-slot="osd"]       fix OSD sáv (lejátszás, gombok, idővonal, hangerő)
[data-iptv-slot="channels"]  fix 8 sor, mindegyikben 16:9-es miniatűr
```

Mivel a TV takaróképe és ez a váz ugyanazt mutatja, a `notifyAppLoaded()`
levételénél **nincs látható váltás**. A React csak az **adatokat** rajzolja a
kész helyekre – a régiók nem mozognak (a napló 0.105-ös elrendezés-ugrása is
innen jött).

### 3. A HTML 1 760 370 B → 113 656 B

`tools/build-webos.sh` a Vite single-file kimenetéből kiemeli:

- a ~1,2 MB ES5 alkalmazást és polyfilleket → **`app.js`**,
- a ~120 KB Tailwind CSS-t → **`app.css`**,
- a logót → **`boot-logo.jpg`** (37 KB),
- és `<link rel="preload" as="script" href="app.js">`-szel már a `<head>`-ben
  elindítja a letöltést.

Az `index.html`-ben **csak** a boot CSS, a webOS híd, a kész váz és az
indítási jelek maradnak. A `válasz` így nem 2,5 mp, hanem néhány tíz ms; az
első festés **még a platform takaróképének levétele ELŐTT** megtörténik.

A CI és a csomag-ellenőrző tesztek által keresett `IPTV-ES5-APP` /
`IPTV-ES5-POLYFILLS` jelölők attribútumként a `<script src="app.js">` címkén
maradnak, így a kiadás-ellenőrzés változatlanul működik. A `npm run smoke`
füstteszt jsdomhoz visszaágyazza a két fájlt (függvénnyel, mert a
minifikált JS-ben sok a `$&` minta).

### 4. Nincs több késői kép a főoldalon

A 4674 ms-es LCP-t okozó, `url(data:image/jpeg;base64,...)` hátteret az üres
lejátszó-dobozon egy **azonnal festő CSS-átmenetre + lejátszó ikonra**
cseréltük. Nincs külső Google Fonts kérés sem (302 ms + DNS, FOUT,
elrendezés-ugrás).

A REVEAL változatlan: `notifyAppLoaded()` → a váz 200 ms alatt, inline
`!important` kompozitor-átmenettel halványul el a már kifestett felület
fölött → `ÁTTŰNÉS KÉSZ`.

## A másik három kérés

### Xtream-kód → diagnosztika + kérdéses ablak

- A QR/új szolgáltató útja `handleRefreshProvider(newProvider, false)`-t
  hívott (`manual=false`), ezért a `setDiagnosticOpen(manual && !silent)` és a
  kérdéses ablak **soha nem jelent meg**. Most `manual=true`: mindkettő
  megjelenik.
- `AddPlaylistModal`: a betöltési diagnosztika és a kérdéses ablak
  **`createPortal`-lal a `document.body`-ra** kerül (z-index
  2147481000/2147482000). Korábban a `z-[70]`-es, `backdrop-blur`-ös szülő
  mögé szorultak.
- A kérdés most egyértelmű: **„Folyamat megtekintése”** (a diagnosztika
  nyitva marad) vagy **„Csatornák megtekintése”** (minden ablak bezárul).
- Gyors bulk importnál (nincs részleges callback) a kérdés **a végén is**
  feljön, és nem tűnik el automatikusan.

### Akadozás a filmek/sorozatok alatt

- `providerImport.ts`: a részleges film-/sorozatlista **5000 elemenként**,
  nem 2000-enként kerül a felületre; minden részfrissítés után
  `await yieldToUi()`; `UI_YIELD_EVERY` 3000 → **1200**.
- `App.tsx`: `setMovies` / `setSeries` legfeljebb **1,2 másodpercenként** fut
  (a `draft` így is minden adatot tárol a mentéshez). Egy 100 ezres tömb
  teljes App-újrarajzolása helyett ~1 rajzolás/másodperc.

## Ellenőrzés

```
npx tsc --noEmit (web/tsconfig.json)   → tiszta
npm test                              → 224/224 (1 skip)
npm run build --prefix web             → OK
tools/transpile-es5.mjs                → OK
VERSION=2.5.137 bash tools/build-webos.sh
   app.css kiemelve: 119 525 byte
   app.js  kiemelve: 1 212 411 byte
   webOS index.html: 113 656 byte
   IPK: 774 KB (app.js, app.css, boot-logo.jpg, splash-screen.png mind benne)
npm run smoke                          → OK, a felület felépül
```

Csomagolt HTML jsdom-mérése: 0 beégetett JPEG, 0 külső font, 4 fix régió, 8
db 16:9 sor, `html`/`body` = `rgb(8,13,26)`, `notifyAppLoaded` = 1,
`ELŐFESTÉS → REVEAL → ÁTTŰNÉS KÉSZ`.

**Következő lépés:** a `main` ágról kézzel épített 2.5.137-es IPK, majd két
napló (első indítás + újraindítás). Figyelendő: `válasz` és `first-paint`
néhány tíz/száz ms, nincs fekete kocka, a legnagyobb tartalom közel a REVEAL-hez,
az Xtream-kód után megjelenik a diagnosztika és a kérdés, és a VOD import alatt
nem akad a távirányító.
