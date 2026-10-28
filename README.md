# IPTV R.T – LG webOS TV

Ez a repó kizárólag LG webOS TV-hez készül. Az alkalmazás élő TV-csatornákat, filmeket, sorozatokat, EPG-t, kedvenceket és telefonos QR-beállítást kezel.

## Indulás és betöltőképernyő (2.5.167)

A takarókép és a saját betöltőképernyő **ugyanaz a látvány**: a `web/index.html`
indítóképernyője a TV beolvasásának végétől a **100%-ig** látszik, és csak utána
jelenik meg a főoldal:

- a képernyő **álló**: nincs vászon-részecske, forgó tárcsa, filmszemcse,
  pásztázó sor, fénylegyező, virágzás, záró fátyol és fejléc-óra. A #32–#37
  TV-naplók szerint pont ezek a folyamatos újrarajzolások vették el a
  képkockákat az indulástól (2–3,7 mp-es képkocka-kihagyások);
- **középen a valós százalék** (gyűrűvel), közvetlenül alatta a **töltősáv**,
  majd a mért statisztikák. A százalék, a csatornaszám, a letöltött adat, a
  sávszélesség és a hátralévő idő **kizárólag a futó alkalmazás tényleges
  adataiból** származik – nincs szimulált érték, nincs időzített „befejezés”,
  és amíg egy adat nem érkezett meg, `—` látszik a helyén;
- a háttér **színátmenet** (sötét teál + középső fényfolt, fátyol, vignetta,
  84 pixeles rács), nem 1920×1080-ra felnagyított fotó: nincs képfilter, nincs
  `scale`, nincs minden képkockán ismételt raszterezés. Az IPTV-ikon a
  fejléc- és a jobb alsó jelvényben maradt meg (egyszer beágyazva);
- a webOS saját indítóképe (`splashBackground`) **ugyanazt a kompozíciót**
  rajzolja: a `tools/make-splash.py` ugyanazokból a színmegállókból,
  fátylakból, rácsból és vignettából generálja 1920×1080-ban, 24 bites RGB-ben.
  A fájl **88 kB** (korábban 607 kB), ezért a platform kép és a saját
  képernyőnk közötti váltás továbbra sem látszik;
- a platform kép **a tényleges első festésnél** kerül le (`paint` bejegyzés:
  `first-paint` / `first-contentful-paint`, 1500 ms-os biztonsági hálóval),
  nem egy képkocka-visszahívásnál: a visszavágás a festés előtt is lefuthat,
  és a 18. naplóban a levétel (+327 ms) után még ~490 ms-ig üres ablakháttér
  látszott („fekete–zöldes háttér váltakozás”);
- a réteg **akkor tűnik el**, amikor a főoldal már ki van festve és
  használható. Üres telepítés (nincs csatorna) is kész állapot, és ha nincs
  lejátszandó stream, a program nem vár az első videókockára.

## EPG (műsorújság)

A szolgáltató `get_short_epg` végpontja ezen a panelen minden kérésre üres
választ ad (19 bájt: `{"epg_listings":[]}`), ezért a műsort a teljes
műsorújságból (`xmltv.php`, ~62 MB) töltjük. A #32–#37 naplók szerint ezt
eddig a **90 mp-es teljes időkorlát** és a **64 MB-os plafon** minden indulásnál
megszakította (`AbortError`), így műsor soha nem jelent meg. Most:

- csak akkor szakítjuk meg a letöltést, ha **60 mp-ig nem érkezik adat**
  (8 perces biztonsági felső korláttal, 192 MB-os plafonnal);
- megszakításkor is **megmarad a már beolvasott rész**, és a napló kimondja a
  megszakítás okát, valamint a kihagyott (időablakon kívüli) műsorok számát;
- a kész (vagy részleges) index a **tartós tárba** íródik, ezért a következő
  induláskor azonnal betöltődik – a sárga csík már a főoldal megjelenésekor
  ott van, a frissítés a háttérben fut.

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

### Képmínőség-napló (KÉPMINŐSÉG sorok)

A cél, hogy a legjobb, legélesebb kép beállítását **mért adatokra** lehessen
alapozni. A naplózás indítása után a lejátszó – ugyanabba a kézi naplóba –
4 másodpercenként egy `KÉPMINŐSÉG` sort ír, streamenként pedig egy záró
`KÉPMINŐSÉG ÖSSZESÍTÉS` sort. A naplózás nélkül a mérés nem fut.

```text
KÉPMINŐSÉG; mód=élő; cím=[HU] M1 UHD; formátum=MPEG-TS (.ts);
forrás=1920x1080 (Full HD); doboz=1920x1080 CSS px (≈3840x2160 fizikai, DPR 2);
skálázás=1.00x; képkocka=25.0/s; eldobott=3 (0.1%); sérült=0;
puffer-előre=3.4 s; pufferelés=1 alk., 320 ms;
bitráta=8.4 Mbps (HLS lista (deklarált)); kodek=H.264/AVC (PMT); hangkodek=AAC;
HDR=stream: nem jelzett, panel: HDR-képes; ready=4; network=2
```

| Mező | Mit jelent |
| --- | --- |
| `forrás=` | a **dekódolt kép tényleges mérete** – ez a néző által látott részletgazdagság alapja |
| `doboz=` | a videó megjelenítési felülete CSS pixelben, valamint a **fizikai** képpontszám (`DPR`-rel) és a `skálázás=` ebből számolt mértéke |
| `képkocka=` | mért képkockasebesség (a `getVideoPlaybackQuality` / `requestVideoFrameCallback` számlálóiból) |
| `eldobott=` / `sérült=` | a mérési ablakban eldobott és sérült képkockák száma és aránya |
| `pufferelés=` / `puffer-előre=` | hányszor és mennyi ideig kellett pufferelni, illetve mennyi tartalék van a lejátszási pont előtt |
| `bitráta=` | a **forrása is** szerepel: `HLS lista (deklarált)`, `MKV fejléc`, `TV sourceInfo`, `fájlméret/hossz átlag` vagy `hálózati mérés`; ha a TS nem ad adatot, `nem mérhető` |
| `kodek=` / `hangkodek=` | HLS `CODECS`, MPEG-TS `PMT` streamtípus vagy MKV `CodecID` alapján (pl. H.264/AVC, H.265/HEVC, AAC, AC-3, E-AC-3) |
| `HDR=` | a stream jelzése (PQ/HDR10, HLG – HLS `VIDEO-RANGE`, MKV színmetaadat, TV `sourceInfo`) és a panel jelzése (`dynamic-range: high`) |

Emellett a fejléc-próbák külön sorban mondják meg, **mit kínál a szolgáltató**:
HLS-nél a master lista összes variánsát (`KÉPMINŐSÉG FEJLÉC (HLS master)`),
MPEG-TS élő adásnál a PMT kodekjeit (`KÉPMINŐSÉG FEJLÉC (PMT)`), MKV filmnél a
fejléc képsávját (`KÉPMINŐSÉG FEJLÉC (MKV)`), valamint a TV médiaszolgáltatásának
adatait (`KÉPMINŐSÉG TV (sourceInfo)`). A mintavétel kezdetén egy `KÉPMINŐSÉG
KÉPESSÉG` sor rögzíti a panel felbontását, DPR-jét, színterét és a támogatott
kodekeket (H.264/HEVC/VP9/AV1, HLS, TS).

Ha a dekódolt kép Full HD alatti, vagy kisebb, mint a szolgáltató által kínált
legjobb szint, a napló `KÉPMINŐSÉG FIGYELMEZTETÉS` sort ír. Ez azért fontos,
mert a valós naplók tanúsága szerint több „UHD” nevű csatorna is csak
720×405-ös (SD) képet ad – ilyenkor a kép élességét **nem a lejátszó**
beállítása korlátozza, hanem a szolgáltatói stream (másik csatorna- vagy
UHD-változat kell).

Ez a két naplóhely ugyanaz, mint eddig: a sorokat a `web/src/services/appLog.ts`
(`logPlaybackQuality`, `logPlaybackQualitySummary`, `logPlaybackQualityEvent`)
írja, a mérést a `web/src/components/VideoPlayer.tsx` képminőség-mintavevője
végzi.

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
web/src/services/tvDevice.ts TV típus (modell, webOS verzió) a napló fejlécéhez
web/src/services/embeddedSubtitleService.ts
                             MKV fejléc + TV sourceInfo (felirat ÉS képminőség-adat)
web/src/services/liveSubtitleService.ts
                             PMT/HLS olvasás (felirat ÉS képminőség-adat)
tools/make-splash.py         a platform indítókép (splash-screen.png) generálása
webos/                       LG manifest, webOS bridge, ikonok, indítókép
supabase/                    Edge Function és SQL migráció
tools/                       build- és futásidejű tesztek
```

A programból és a repóból eltávolított, nem használt fájlok: a régi induló MP4,
a gyökérben megkettőzött ikonok, a nem hivatkozott `web/public/ikonkep.png`, a
gyökérbeli `provision.html` (a működő oldal `web/public/provision.html`), a
`web/src/utils/webos.ts` (soha nem importált segéd), az `Inditas.html`
dizájn-makett, a `takarokep.jpg` és a belőle készült `web/public/splash-bg.jpg`
(a betöltőképernyőnek nincs többé háttérképe), valamint a nyolc korábbi,
elavult állapotjelentés (`*-FIX-2026-*.md`, `BOOT-SCREEN-2026-10-27.md`,
`ASSET-AUDIT.md` – a tartalmuk a `web/src/appVersion.ts` változáslistájában és a
commit-üzenetekben maradt meg). Az aktuális IPK build- és GitHub
Release-artefakt, nem forrásfájl.

## Build

```bash
npm ci --no-audit --no-fund
npm ci --prefix web --no-audit --no-fund
pip install Pillow            # a platform indítókép generálásához (tools/make-splash.py)
npm test
(cd web && ./node_modules/.bin/tsc --noEmit)
npm --prefix web run build
npm run smoke
VERSION=2.5.167 bash tools/build-webos.sh
```

A build az indítóképet **minden alkalommal újragenerálja**
(`tools/make-splash.py`), ezért az IPK-ba nem kerülhet elavult kép. A kép a
betöltőképernyő hátterének kompozíciója (színátmenet, három fátyol, 84 pixeles
rács, vignetta), 1920×1080-ban, 24 bites RGB-ben – **88 kB**, dithering nélkül
(a lágy átmenet nem sávosodik). A generátor ugyanazokat a színmegállókat
használja, mint a `web/index.html` `.bootbg` rétege, ezért a platform kép és a
saját betöltőképernyő nem válik el egymástól.

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
node tools/test-quality-diagnostics.mjs
node tools/test-tv-device.mjs
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
