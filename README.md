# TV – LG webOS TV

> **v2.5.1 – kizárólag LG webOS TV, távirányító + QR telefonos beállítás**
> - Ez a repó kizárólag LG webOS TV-re készül.
> - Nem tölt le, nem másol és nem használ forráskódot másik alkalmazásrepóból.
> - Telepítés: [webos/README.md](webos/README.md)

## Mi ez?

LG webOS TV alkalmazás (IPK) TV-hez:
- Élő TV, Mozi, Sorozat, EPG, kedvencek, beállítások
- Távirányító (D-pad) + Magic Remote + egér támogatás
- **Színes távirányítógombok – egyetlen, egységes kezelés**:
  - **Piros**: képernyős diagnosztika be-/kikapcsolása
  - **Zöld**: hangsávválasztó (Audio)
  - **Sárga**: csatorna hozzáadása a kedvencekhez
  - **Kék**: csatornamozgatási mód
  - A zöld/sárga/kék gomb nem nyit Beállításokat, EPG-t vagy Kategóriákat; ezek a régi, ütköző hozzárendelések eltávolítva.
- Külön kinézet: kisebb lejátszó (1280px max), gyors betöltés; induló videó nélkül, a logó képkockájával mint indítókép
- **Két lejátszó motor** (Menü → Rendszer → Lejátszó motor), a választás megmarad:
  - **Beépített (HTML5)**: HLS, automatikus MPEG-TS váltás, teljes OSD – alapértelmezett
  - **Natív (TV dekóder)**: a szolgáltató eredeti MPEG-TS címe közvetlenül a TV hardveres
    dekóderén, automatikus formátumváltás nélkül, visszafogott felülettel
- **2.4.3 teljesítmény**: a kijelölési sorszám O(n²) számítása megszűnt, az EPG már nem
  rajzolja újra a teljes listát félpercenként, a lejátszás közbeni állapotfrissítés
  legfeljebb 2 másodpercenként fut, a backdrop-elmosás és a globális CSS-átmenetek
  kikapcsolva TV-n
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
│   ├── assets/               # (nincs benne videó vagy indítókép)
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

## A hét javított hiba (v2.5.12) – a VALÓDI okok

Az első kör (v2.5.10) a React oldalát javította, de a távirányító navigációt
a **`webos/webos.js`** capture-fázisú ES5 kezelője végzi, a teljes képernyős
OSD pedig a lejátszó **mögött** volt. Ezért nem látszott a változás a TV-n.

| # | igazi ok | javítás |
|---|---|---|
| 3 | a `webos.js` **minden** útvonala a lista *dobozára* fókuszált (`focusAndReveal(listEl)`, `tabindex=0` + `listEl.focus()`, ENTER, CH+/-)\* | minden út a `firstChannelRow()`-ra visz; a `focusAndReveal` elutasítja a listboxot; a doboz semmilyen navigációval nem jelölhető ki |
| 3 | a sorok kijelölője kék (`#06b6d4`) volt | visszaállítva **sárgára** (`#fbbf24`), mint a fejléc és a mappák |
| 4 | az OSD `z-index: 10000`, a teljes képernyős lejátszó `2147483000` | az OSD `2147483001` – a kép **fölött** |
| 1 | 140 ms-os beúszás + „2 mp után elég a fejléc" korai megjelenés | nincs beúszás; a megjelenéshez fejléc + mappasáv + sorok + logók + **első képkocka** kell; saját takarékép-réteg (`#tv-curtain`) tűnik el egyetlen váltással |
| 1 | a TV-doboz fekete volt az első képkockáig | addig a csatorna logója látszik (`data-player-poster`) |
| 5–6 | 4 fókusz-időzítő a `webos.js`-ben; film/sorozat lista `setTimeout(0)`-val a főoldal festése közben | 1 időzítő; `requestIdleCallback`; a főoldali kép 4 időzítő + 3 kép helyett 1 + 1 |
| 7 | a `Promise.all` a lassabb kategóriavégpontra várt; a csatornák csak a teljes feldolgozás után jelentek meg | a kategóriák külön ígéret (hiba esetén üres); az első **1500 csatorna** után azonnali előnézet, a teljes lista felülírja (nincs félkész mentés) |

A tesztek a valódi `webos.js`-t futtatják jsdom-ban
(`tools/test-tv-navigation.mjs`), így a navigáció viselkedése mérhető:
**29 teszt**, a workflow **5b** lépésében.

## Korábbi kör (v2.5.10)

| # | hiba | hol | mitől jó most |
|---|---|---|---|
| 1 | a webOS indítókép **nem tűnt el**, a félkész felület villant | `web/index.html`, `web/src/main.tsx` | a `webOSSystem.notifyAppLoaded()` az `__IPTV_REVEAL__` része, és a megjelenítés két animációs kép után történik: a kész kép már a képernyőn van → egyetlen váltás |
| 2 | az élő kép **üres sávot** hagyott | `VideoPlayer.tsx` | `object-fit: cover` élő képnél (kitölt, de nem torzít); a VOD maradt `contain`/`fill` |
| 3 | a **teljes csatornalista kijelölhető** volt | `ChannelList.tsx`, `App.tsx` | a listbox dobozának nincs `tabindex`-e, semmi nem hívja a `.focus()`-át, a mappasáv csak a mappa-gombokra fókuszol; a fókusz mindig egy csatornasorra kerül |
| 4 | teljes képernyőn **nem jelent meg az OSD** | `App.tsx` | `osdHideDelay = 0` = „soha ne tűnjön el" (korábban: soha ne jelenjen meg); gombnyomásra visszajön |
| 5 | teljes képernyőre váltás = **új oldal, új stream** | `VideoPlayer.tsx` | CSS-átfedés ugyanazon a `<video>` elemen; a natív Fullscreen API-t kivettük (nullázza a webOS dekódolót) |
| 6 | csatornaváltáskor **9 felesleges újraelrendezés** | `VideoPlayer.tsx` | 1 kényszerített mérés + 1 animációs kép + 1 időzítő (korábban 4 időzítő, 3 egymásba ágyazott kép, 2 mérés) |
| 7 | a **bejelentkezés blokkolta** a csatornalistát | `providerImport.ts` | a hitelesítés a háttérben fut a csatornakérés mellett; a fiókadatokat csak a csatornák után olvassuk ki |

A javítások **mindegyike tesztelve** van:

```bash
npm test        # tools/test-requirements.mjs – 17 teszt, a hét pontra
```

A GitHub Actions IPK-build (`.github/workflows/webos-build.yml`) az **5b**
lépésben lefuttatja ezeket, és a build nem indul tovább, ha bármelyik bukik.

## Fejlesztés

```bash
git clone https://github.com/Robko1/LGtv.git && cd LGtv
npm install --no-audit --no-fund
cd web && npm install --no-audit --no-fund && VITE_WEBOS=true npm run build
# IPK építés
VERSION=2.5.10 bash ../tools/build-webos.sh
# Kimenet: webos/IPTV-RT.ipk
```

A javítások ellenőrzése a kész csomagban (a GitHubon kiadott IPK-n):

```bash
ar p IPTV-RT.ipk data.tar.gz > d.tar.gz
tar xzf d.tar.gz ./usr/palm/applications/hu.rt.iptv.webos/index.html
grep -c notifyAppLoaded  usr/palm/applications/hu.rt.iptv.webos/index.html   # 1. pont
grep -c 'objectFit:"cover"' usr/palm/applications/hu.rt.iptv.webos/index.html # 2. pont
grep -c requestFullscreen usr/palm/applications/hu.rt.iptv.webos/index.html   # 0 = 5. pont
```

## Verzió

- **v2.5.88** – kézi hibakeresés, képernyőminőség és TV-fókusz (részletes leírás: `web/src/appVersion.ts`):
  - A SÁRGA teletext gomb nem indít automatikus naplózást és nem készít QR-kódot: kézzel indítható/leállítható a naplózás, majd a sorszámozott napló külön Küldés gombbal megy Supabase-re.
  - A napló 1 MB-ig gyűjt, az utolsó öt elküldött sorszám és dátum látszik; kilépéskor automatikusan leáll.
  - A játszott csatornasor teljes kék körvonalat kap, a távirányító fókusza sárga marad, a teljes képernyős óra pedig követi az 1–6 színsémát.
  - A ritka váratlan pause/fagyás ugyanazon a streamen automatikusan helyreáll, a TS/HLS formátumemlékezet újraindítás után is megmarad.
  - A teljes képernyős élő kép nem kap mesterséges széthúzást; a TV saját hardveres skálázása és a forrás képaránya marad érvényben.
- **v2.5.86** – megbízhatósági és sebességi csomag (részletes leírás: `web/src/appVersion.ts`):
  - Élő TV: pufferelésnél / újracsatlakozásnál a kép **nem tűnik el** (csak egy kis átlátszó jelző van), nincs többé végleges fekete hibaképernyő – a lejátszó fokozatos visszalépéssel folyamatosan próbálkozik.
  - Film / sorozat: a megszakadt stream a **legutolsó pozícióról magától folytatódik**; a korai `ended`, a `play()` `AbortError`-ja és az automatikus hangsávválasztás nem állítják meg a filmet.
  - Gyorsabb csatornaváltás: a részletes diagnosztika csak a QR-mérési ablakban fut, az időbélyeg-formázó gyorsítótárazott, a kritikus naplóírás összevont.
  - Új, képkocka-alapú lejátszásfigyelő (`web/src/services/playbackRecovery.ts`), teljes TypeScript-tisztaság, 2 új futásidejű teszt.
- **v2.5.10** – a hét hiba javítása: indítókép egyetlen váltással (`notifyAppLoaded`), kitöltő élő kép, a csatornalista doboza nem jelölhető ki, teljes képernyős OSD, CSS-átfedéses teljes képernyő, kevesebb újrarajzolás, nem blokkoló bejelentkezés + 17 teszt
- **v2.5.1** – egy pillanat alatti indulás (a kész felület egyszerre jelenik meg), kisebb csomag
- **v2.5.0** – induló videó kivéve: a logó képkockája az indítókép, utána azonnal a főoldal; kisebb IPK
- **v2.4.10** – az induló videó visszaállítva a bevált (body-inline) felállásra
- **v2.4.9** – az induló videó az első pillanatban indul (bootstrap az app előtt), néma indítás, nincs kétszeri próbálkozás
- **v2.4.8** – a csatorna csak az induló videó után indul (dekóder-ütközés javítása), a videó végigjátszódik
- **v2.4.7** – az indítókép a videó első kockája, 720p induló videó, félbeszakadás elleni plakát
- **v2.4.6** – fekete indítókép (nincs fehér villanás), TV-barát induló videó, videó-diagnosztika
- **v2.4.5** – indulási hibaüzenet javítás: erőforrás-betöltési hiba nem takarja el a kész felületet
- **v2.4.4** – induló (bejelentkező) videó a csomagban, TV felirat nélkül; a videó végére a felület a háttérben összeáll
- **v2.4.3** – távirányítós menüsor-kör, OK = azonnali teljes képernyő, csatornabetöltés mód (Xtream API / M3U), 9 soros lista
- **v2.4.0** – teljesítmény-javítások + választható lejátszó motor (HTML5 / natív)
- **v2.3.1** – LG webOS-only build + távirányító fix + QR
- IPK: `webos/IPTV-RT.ipk` (kb. 945 KB)
- appinfo.json: `hu.rt.iptv.webos` v2.5.88

## Tesztek

```bash
npm install && npm --prefix web install
npm test                                   # forrás/viselkedés-, formátum-, napló- és lejátszás-tesztek
node tools/test-playback-recovery.mjs      # az újracsatlakozási politika valódi futtatása
node tools/test-player-runtime.mjs         # a VideoPlayer Reactben, jsdom-mal (pause / ended / error / fekete overlay)
npx --prefix web tsc --noEmit              # teljes TypeScript-ellenőrzés
npm --prefix web run build && npm run smoke
VERSION=2.5.86 bash tools/build-webos.sh   # webos/IPTV-RT.ipk
```

A `test-player-runtime.mjs` a régi kódon 11 ellenőrzésen bukik el, az újon mindegyik átmegy – így a két jelentett TV-hiba regressziója azonnal észrevehető.

