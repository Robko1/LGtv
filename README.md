# IPTV R.T – LG webOS TV

Ez a repó kizárólag LG webOS TV-hez készül. Az alkalmazás élő TV-csatornákat, filmeket, sorozatokat, EPG-t, kedvenceket és telefonos QR-beállítást kezel.

## Indulás és betöltőképernyő (2.5.139)

A TV indítása a saját `takarokep.jpg` borítóképpel kezdődik, és a kész főoldal
kirajzolódásáig egyetlen, folyamatos képernyő látszik:

- a webOS saját indítóképe (`splashBackground`) és a HTML betöltőképernyő
  háttere **ugyanabból a `takarokep.jpg`-ből** készül, ezért a platform képéről
  a sajátunkra váltás nem hoz új látványt (nincs fekete kocka, nincs villanás);
- a jobb felső sarokban a **TV valós rendszerideje** jár;
- a százalék, a csatornaszám, a mért sávszélesség és a hátralévő idő
  **kizárólag a futó alkalmazás tényleges adataiból** származik – nincs
  szimulált érték és nincs időzített „befejezés”. Amíg egy adat nem érkezett
  meg, `—` látszik a helyén;
- a réteg **akkor tűnik el**, amikor a főoldal már ki van festve és
  használható. Üres telepítés (nincs csatorna) is kész állapot, és ha nincs
  lejátszandó stream, a program nem vár az első videókockára.

Részletek: [BOOT-SCREEN-2026-10-27.md](BOOT-SCREEN-2026-10-27.md).

## Lejátszás és távirányító

- HTML5 `<video>` lejátszó a TV webOS médiamotorján.
- Gyors csatornaváltás, csatornánként megőrzött TS/HLS formátumemlék és automatikus élő újracsatlakozás.
- Ritka váratlan `pause`, `waiting`, `stalled`, `error` és korai `ended` esemény után a lejátszó ugyanazon a csatornán/pozíción próbál helyreállni.
- Teljes képernyőn az élő kép nem kap mesterségesen nyújtott `fill` módot; a forrás képaránya és a TV skálázása marad érvényben.
- A teljes képernyős óra az 1–6 távirányítós színsémát követi.
- A csatorna teljes sora kék körvonalat kap, a távirányítós fókusz minden vezérlőn sárga.
- A betöltés/újracsatlakozás kis forgó jelzője normál nézetben bal alul, teljes képernyőn pedig a jobb felső óra alatt látható, az audio-OSD fölött.

## Kézi hibakeresési napló

A SÁRGA gomb csak a **Kézi hibakeresési napló** ablakot nyitja meg. Adatküldés és naplózás nem indul el magától.

1. Nyomd meg a SÁRGA gombot.
2. Válaszd a **Naplózás indítása** gombot.
3. Válts arra a csatornára, amelyik visszaugrik, újratölt vagy előre-hátra ugrál.
4. Hagyd reprodukálódni a hibát, majd állítsd le a naplózást.
5. Válaszd a **Küldés Supabase-re** gombot.

A lejátszásfigyelés kézi naplózás alatt rögzíti többek között:

- `loadstart`, `loadedmetadata`, `loadeddata`, `canplay`, `playing`, `waiting`, `stalled`, `pause`, `play`, `error`, `abort`, `emptied`, `suspend`, `seeking`, `seeked`, `durationchange` és `ratechange` eseményeket;
- az élő idővonalat és a vissza-/előreugrásokat (`currentTime`, delta, `duration`);
- `seekable` és `buffered` tartományokat, `readyState`/`networkState` értéket, dekódolt/dropped képkockákat, képméretet és HTML5 médiahibát;
- csatornaváltási, újrapróbálási és automatikus helyreállítási okokat.

### A szolgáltató-beolvasás naplója (SZOLGÁLTATÓ sorok)

Ha a **filmek és sorozatok** nem, vagy csak nagyon lassan töltődnek be, a naplózást a
**Betöltés** gomb előtt érdemes elindítani: SÁRGA → Naplózás indítása → a szolgáltató
betöltése. Ilyenkor minden szolgáltatói kérés külön sorban látszik:

```text
SZOLGÁLTATÓ [bejelentkezés], OK, 340 ms, korlát=10000 ms, HTTP 200, 412 B
SZOLGÁLTATÓ [élő csatornalista], OK, 1180 ms, korlát=9000 ms, HTTP 200, 812 kB, 1834 elem
SZOLGÁLTATÓ FÁZIS [élő csatornák] kész – 1834 csatorna, 41 kategória (mód=api); 1.5 s
SZOLGÁLTATÓ FÁZIS [filmek] indul – először a bulk (egyben) végpont, hiba esetén kategóriánként
SZOLGÁLTATÓ [filmek], OK, 34210 ms, korlát=60000 ms, HTTP 200, 28 MB, 41206 elem
SZOLGÁLTATÓ FÁZIS [filmek] kész – 40000 film, 96 kategória (út=bulk (1 kérés)); 34.4 s
SZOLGÁLTATÓ [sorozatok], HIBA, 60000 ms, korlát=60000 ms, hiba=időtúllépés, próbálkozás=1/2
```

A sorokból pontosan kiderül, hol van a baj:

| Amit a sor mutat | Mit jelent |
| --- | --- |
| `korlát=… ms` | mennyi időt adtunk a kérésnek (a nagy film/sorozat lista 60 mp-et, felső korlát 90 mp) |
| `OK` + nagy `ms` | a szolgáltató él, de lassan adja a nagy listát – ez szerveroldali tulajdonság |
| `hiba=időtúllépés` | a szerver nem küldte meg a választ időben; a betöltés a többi szakasszal folytatódik |
| `újról 2. próbálkozás` | 429 vagy 5xx után automatikus újrapróba történt |
| `FÁZIS […] kész … (út=kategóriánként)` | az egyben letöltött végpont nem működött, ezért kategóriánként töltöttünk |
| `KIHAGYVA` / `MEGSZAKÍTVA` | a kategória betöltését a néző állította le, vagy a hibahatár elérte |
| `MEGSZAKÍTÓ NYITVA` | a szerver 30 mp óta semmire sem válaszolt, ezért a program átmenetileg nem indít új kapcsolatot |

A sorok nem tartalmaznak belépési adatot, stream-címet vagy felirat-címet; a válasz méretét a
`Content-Length` fejlécből olvassuk, így egy 30 MB-os lista sem másolódik le mégegyszer a
memóriában. A szakaszok (`élő csatornák`, `filmek`, `sorozatok`, `VOD metaadatok`) mindegyike
kezdő és záró sort kap eltelt idővel, így látszik, melyik szakasz viszi el az időt.

A napló legfeljebb 1 MB, sorszámozott és kezdési idővel ellátott. A küldés automatikusan leállítja a naplózást; kilépéskor szintén leáll. A Supabase-en legfeljebb az öt legfrissebb teljes napló marad.

Ha a küldés ismét átmeneti HTTP 503-at kap, az alkalmazás két rövid, automatikus újrapróbát végez. A szerver ugyanazt a sorszám/kezdési idő párt idempotensen kezeli, ezért egy elveszett válasz nem készít dupla rekordot.

### Hol keletkezik a napló, és hová kell beírni egy új sort

Ha azt kéred, hogy „ezt is írja bele a naplóba, hogy lássuk a hibát”, az új naplósort
**mindig ugyanabba a fájlba** kell beírni:

```
web/src/services/appLog.ts
```

Ebben a fájlban vannak a naplóíró függvények. Egy új sor beküldéséhez nem kell mást
tenni, mint a vizsgált kódban meghívni valamelyiket:

| Függvény | Mikor használd | Példa a naplóban |
| --- | --- | --- |
| `appLog('…')` | általános esemény | `CSATORNAVÁLTÁS START; csatorna=[HU] M1` |
| `appLogError('…', error)` | ha valami elhasalt | `Filmlista mentése sikertelen HIBA → …` |
| `logProviderEvent('…')` | szolgáltató-beolvasás | `SZOLGÁLTATÓ [filmek egyben] a válasz 102815 elemű` |
| `logProviderRequest({…})` | egy konkrét HTTP-kérés | `SZOLGÁLTATÓ [filmek], OK, 9133 ms, korlát=60000 ms, HTTP 200, 40.4 MB` |
| `logProviderPhaseStart/End(…)` | egy betöltési szakasz eleje/vége | `SZOLGÁLTATÓ FÁZIS [filmek] kész – 40000 film; 20.9 s` |

A napló **csak akkor gyűlik, ha a naplózás be van kapcsolva** (SÁRGA gomb → Naplózás
indítása). Bekapcsolt naplózás nélkül a függvények nem írnak semmit, és nem is
lassítják a programot. Belépési adat, jelszó és stream-cím soha nem kerül a naplóba:
az alkalmazás és a Supabase Edge Function is kitakarja őket (`[REDACTED]`).

### Hol találom meg a Supabase-re elküldött naplót

1. A TV-n: **SÁRGA gomb → Naplózás indítása → a hiba előidézése → Küldés Supabase-re.**
   A képernyőn látszik a napló sorszáma és a kezdési ideje.
2. A Supabase-ben: a **`QR iptv`** projekt (`hlklmcujvqsatwvdygqp`),
   **`public.tv_diagnostic_shares`** tábla. A napló szövege a **`log_text`** oszlopban van,
   a sorszáma a `log_number`, a beküldés ideje a `created_at` oszlopban.
3. A tábla **az öt legfrissebben beérkezett naplót** őrzi meg. A törlés **a beküldés
   dátuma és ideje szerint** történik: mindig a **legrégebbi `created_at`** esik ki
   elsőként, automatikusan. (Korábban a sorszám döntött, ezért egy frissen telepített
   IPK 1-es számú naplója azonnal törlődött, pedig a TV sikeres küldést jelzett.)
4. Egy sor lekérdezés a legújabb naplóhoz:

   ```sql
   select log_number, created_at, log_text
   from public.tv_diagnostic_shares
   order by created_at desc
   limit 1;
   ```

A naplót a **`supabase/functions/tv-diagnostic-share`** Edge Function fogadja és tárolja.
Ehhez a küldő kódhoz és a tároláshoz csak indokolt esetben nyúlunk – a napló **tartalmát**
azonban bárhol bővíthetjük az `appLog.ts` függvényeivel.

## Telefonos QR-beállítás

A telefonos szolgáltató-beállítás külön funkció, nem a hibakeresési napló része. A telefonos oldal forrása:

- `web/public/provision.html`
- leírás: [QR-TELEFONOS-BEALLITAS.md](QR-TELEFONOS-BEALLITAS.md)

## Forrásfa

```text
web/                         React + Vite felület
web/src/components/          lejátszó, csatornalista, menük és modálok
web/src/services/appLog.ts   kézi napló és főszál-fagyásfigyelő
web/src/services/diagnosticShareService.ts
                             Supabase küldés/history, 503 újrapróba
web/src/services/playbackRecovery.ts
                             élő/VOD helyreállítási döntési logika
takarokep.jpg                az indítókép/betöltőképernyő EGYETLEN forrása
tools/make-splash.py         takarokep.jpg → splash-screen.png + splash-bg.jpg
webos/                       LG manifest, webOS bridge, ikonok, indítókép
supabase/                    Edge Function és SQL migráció
tools/                       build- és futásidejű tesztek
```

A programból eltávolított, nem használt régi gyökérfájlok: a régi induló MP4, a gyökérben megkettőzött ikonok, a nem hivatkozott `web/public/ikonkep.png`, a régi gyökérbeli `provision.html`, valamint a forráságban tárolt előző IPK. Az aktuális IPK build- és GitHub Release-artefakt, nem forrásfájl. A pontos hivatkozási audit: [ASSET-AUDIT.md](ASSET-AUDIT.md).

## Build

```bash
npm ci --no-audit --no-fund
npm ci --prefix web --no-audit --no-fund
pip install Pillow            # az indítókép generálásához (tools/make-splash.py)
npm test
(cd web && ./node_modules/.bin/tsc --noEmit)
npm --prefix web run build
npm run smoke
VERSION=2.5.139 bash tools/build-webos.sh
```

A build az indítóképet **minden alkalommal** a `takarokep.jpg`-ből generálja
(`tools/make-splash.py`), ezért az IPK-ba nem kerülhet elavult kép.

A build kimenete helyben `webos/IPTV-RT.ipk`, de az IPK a `.gitignore` szerint nem kerül a `main` forráságba. A kézi GitHub Actions build a sikeres csomagot a verziózott Release-be tölti fel.

## IPK-aláírás és GitHub „Verified” jelzés

Ez két külön dolog:

1. **LG/webOS IPK-aláírás:** a Developer Mode-ban telepített csomag fejlesztői IPK-ként működik. Hivatalos, más készülékeken is elfogadott LG/webOS aláíráshoz LG fejlesztői/disztribúciós tanúsítvány és az LG által előírt kiadási folyamat kell. Privát tanúsítványt nem teszünk a repóba, és a GitHub token/GPG-kulcs nem írja alá az IPK-t.
2. **GitHub zöld „Verified”:** ez a Git commit vagy tag kriptográfiai aláírását jelenti, nem az IPK-t. Ehhez a GitHub-fiókhoz hozzáadott GPG- vagy SSH-aláíró kulcs és az Actions-ben tárolt megfelelő privát kulcs szükséges. A workflow mindkét utat támogatja, de csak akkor kapcsolja be, ha ezek a kulcsok valóban a felhasználó GitHub-fiókjához tartoznak; hamis „Verified” jelzést nem generálunk. A konkrét secret-lista: [RELEASE-SIGNING.md](RELEASE-SIGNING.md).

A normál Developer Mode-os TV-teszteléshez jelenleg nincs szükség production IPK-aláírásra. A telepítés részletes menete: [webos/README.md](webos/README.md).

## Tesztek

```bash
npm test
node tools/test-playback-recovery.mjs
node tools/test-player-runtime.mjs
node tools/test-provider-load.mjs
node tools/test-storage-quota.mjs
(cd web && ./node_modules/.bin/tsc --noEmit)
npm --prefix web run build && npm run smoke
```

A `test-provider-load.mjs` a szolgáltató-beolvasást vizsgálja: a nagy film/sorozat lista
időkorlátját, a megszakító viselkedését időtúllépésnél és valódi kapcsolati hibánál, a
takarókép és a képernyős hibaüzenet időzítését, a csatornakijelölés megtartását, valamint
azt, hogy a szolgáltató-beolvasás sorai valóban bekerülnek a kézi naplóba.
