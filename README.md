# IPTV R.T – LG webOS TV

LG webOS TV-re készült IPTV-alkalmazás: élő csatornák, filmek, sorozatok, EPG, kedvencek, feliratok és telefonos szolgáltató-beállítás. Android APK-t nem épít.

## Védett működési referencia: 2.5.176

A felhasználó által sikeresnek elfogadott alap a **2.5.176**. A következő három területet regressziós referenciának kell tekinteni: **nem szabad rutinszerűen átírni, lecserélni vagy visszaállítani egy régebbi megoldásra**. Az esetleges jövőbeli módosítás csak külön kérésre, az alaphoz képest végzett valódi TV-s ellenőrzéssel fogadható el.

### 1. Natív takarókép és azonnal megjelenő főoldal

- A webOS az `appinfo.json` `splashBackground` mezőjében megadott **`webos/splash-screen.png`** képet mutatja az alkalmazás indulása közben. Ez a jóváhagyott indítókép; ne helyettesítsük generált színátmenettel, új képpel vagy induló videóval.
- A `web/index.html` nem tartalmaz külön HTML-es takaróképet, animált betöltőképernyőt, százalékot vagy haladási sávot. A `#root` látható; a React főoldal közvetlenül épül fel.
- A `web/src/main.tsx` elindítja a Reactet, és amint a `#root` alatt tényleges DOM-elem van, meghívja a `webOSSystem.notifyAppLoaded()` függvényt, ha az elérhető. A natív kép elengedését a webOS kezeli. Az alkalmazás nem vár egy külön saját 100%-os animációra vagy a teljes csatornalistára.
- A forrásban maradt régi `bootScreen` és `reveal` állapotjelzések, illetve történelmi kommentek **nem jelentenek jelenleg látható, saját HTML-es betöltőképernyőt**. A DOM megjelenése önmagában nem bizonyítja a fizikai kijelző első képkockájának idejét.
- Üres telepítésen és mentett listával is ellenőrizendő: a natív kép után a főoldal megjelenik, nem ragad fent külön takaróréteg; a háttérben betöltődő tartalom nem akadályozhatja a nézést.

### 2. Képmegjelenítés

A működő képet és a lejátszási beállításokat meg kell őrizni. A tényleges szabályok – beleértve a CSS `!important` felülírásokat – a következők:

- A `VideoPlayer.tsx` HTML5 `<video>` elemet használ; az inline beállítás `imageRendering: auto`, `filter: none`, és VOD-nál vagy teljes képernyőn `objectFit: contain`, egyébként `cover`.
- A teljes képernyős `.iptv-fs` CSS-szabály az élő videónál **`object-fit: cover !important`**, míg az aktív film/sorozat `[data-vod-active]` esetén **`object-fit: fill !important`**. Ezek felülírják az inline értéket; a `cover` vághat, a `fill` eltérő képaránynál nyújthat. Nem állítjuk, hogy mindkét módban `contain` érvényes.
- A forrás felbontását és minőségét a stream és a TV médiamotorja is befolyásolja. A képminőség **megjelenítésének** megőrzése nem ugyanaz, mint a diagnosztikai mintavételezés: a jelenlegi, 2.5.177-es célzott sebességnapló nem indítja el a korábbi 4 másodperces képminőség-mintavevőt vagy annak külön hálózati próbáit.
- Regresszióvizsgálat: élő előnézet és teljes képernyő, majd film és sorozat teljes képernyőn; a 2.5.176-os referencia látható képe, kitöltése, színei és a váltások viselkedése ne romoljon.

### 3. EPG – műsorújság

A jelenleg megfelelőnek elfogadott működést meg kell tartani, további EPG-átalakítás nem cél. A csatornalista és a nézett csatorna a rendelkezésre álló teljes XMLTV-indexből/gyorsítótárból is megjeleníti a mostani és következő műsort. Ha a megfelelő műsor nem áll rendelkezésre, a rövid EPG-lekérés `get_short_epg` választ kér; üres eredménynél a `get_simple_data_table` végpontot is megpróbálja. A konkrét tesztelt szolgáltatónál a rövid végpont üres választ adott; ez nem általánosítható minden szolgáltatóra.

A teljes XMLTV feldolgozása darabolt, az eredmény tartós tárban is tárolható. A részleges vagy túl ritka index nem számít teljesen frissnek; a feldolgozó legfeljebb 16 bejegyzést tart csatornánként, kezeli a tömör és kötőjeles dátumformátumokat is. Az EPG viselkedése szolgáltatófüggő, ezért valódi TV-n a csatornalista sárga sávját, a most/következő műsort és az EPG-ablakot is ellenőrizni kell.

## Aktuális forrás és verziók

- Elfogadott működési referencia: **2.5.176**; a referencia forrása: `e994abb7a46763f9dce060209fd8cdd8a83996dc`.
- Ebben a munkafában a `web/src/appVersion.ts` **2.5.179**-et jelez. A #71 napló ebből a TV-n kipróbált változatból származik; az azóta végzett kódmódosítások új IPK-ban még ellenőrzendők.
- A `webos/appinfo.json` a forrásban jelenleg **2.5.179**. A helyi IPK-build alapértelmezésben a webes `WEB_VERSION` értékét írja a csomagolt manifestbe. A kézi GitHub Actions workflow tesztek után új patchverziót képez, és a forrásverziót a `main` ágon is frissíti. A root `package.json` és a `web/package.json` verziója nem az IPK verziójának forrása.
- A korábbi és jövőbeli **mért adatok, verziók és források** külön fájlban vannak: [README-TESZTNAPLO.md](README-TESZTNAPLO.md). A működési referencia nem egyenlő automatikusan egy mért sebességértékkel.

## TV-s vezérlés

Az alkalmazás TV-távirányítóra készül. Élő TV-n a kiválasztott csatorna **OK** gombbal vagy a Magic Remote mutatójával indítható; a már játszott csatornán az OK teljes képernyőre vált, a VISSZA vagy OK visszatér. A lejátszó felületén nincs dupla kattintásos, érintéses vagy húzással végzett csatornaváltás. A film OSD-je TV-gombokkal működik: a némítás és a külön hangerő-beállító gomb azonnal reagál, a tekerés az idővonal nyilaival érhető el. A Magic Remote mutatójának gombaktiválása és az idővonalon történő pozícióválasztás megmaradt.

A webOS manifestben a `supportTouchMode: none` kikapcsolja az alkalmazás közvetlen érintéskezelését; a telefonos **QR-beállítás ettől különálló, megtartott funkció**. A TV-k eltérő felbontásához tartozó reszponzív szabályok és a távirányító fókuszkezelése megmaradnak. A régi, futás közben nem használt részletes verziótörténet a Gitben, a `d995ebb` commit `web/src/appVersion.ts` fájljában visszakereshető; a build által használt aktuális verzióbejegyzés megmaradt.

A tisztítás és a TV-specifikus tesztek nem bizonyítanak gyorsulást vagy valós készülékes kompatibilitást. A következő IPK-t fizikai TV-n kell ellenőrizni: távirányító és Magic Remote, hangerő/tekerés, élő/videó teljes képernyő, QR-beállítás, kép és EPG.

## Kézi hibakeresési és sebességnapló

A jelenlegi forrásban a naplózás nem indul automatikusan. A SÁRGA gomb a naplóablakot nyitja meg:

1. **Naplózás indítása**.
2. Próbáld ki a gombokat, az OK-val történő teljes képernyős be- és kilépést, a csatornaváltást, majd a film/epizód indítását és az esetleges lejátszási hibát.
3. Válaszd a **Naplózás leállítása**, majd a **Küldés Supabase-re** gombot. A küldés maga is leállítja a naplózást. Az alkalmazás elhagyásakor a rögzítés leáll; előtérbe visszatérve nem indul újra magától.

A `SEBESSÉG`, `TÁVIRÁNYÍTÓ`, `TELJES KÉPERNYŐ` és lejátszási/újrapróbálási sorok az események közti időt, a médiaállapotot, puffert és ismert helyreállítási okokat mutatják. A `playing` nem bizonyítja az első látható képkockát; ahol a `requestVideoFrameCallback` nem támogatott, azt a napló jelzi. A fizikai gombnyomás és a panel tényleges festése nem mérhető közvetlenül; a képernyőváltás második `requestAnimationFrame` mérése becslés, nem kijelzőszintű igazolás. Ha az ok nem állapítható meg, nem szabad találgatni.

A korábbi indulási figyelők, részletes szolgáltató-import sorok és folyamatos képminőségi minták ebben a célzott mérésben nem aktívak. A napló maximum 1 000 000 karakter; a TV helyi tárolójában csak korlátozott másolat marad. A `tv-diagnostic-share` Edge Function fogadja a küldést; a forrás szerinti megőrzés az öt legutóbb beérkezett rekord. A kliens és az Edge Function is maszkolja az ismert URL-ben szereplő hitelesítési adatokat, de szabad szövegben se adj meg jelszót vagy tokent. Átmeneti hálózati hiba, illetve 502/503/504 esetén legfeljebb két automatikus újrapróba van; a sikeres küldés után a helyi naplómásolat eldobódik, sikertelen küldésnél megmarad.

A projekt a Supabase `public.tv_diagnostic_shares` tábláját és `log_text`, `log_number`, `started_at`, `created_at` mezőit használja; a küldési forrás: `web/src/services/diagnosticShareService.ts`, a napló: `web/src/services/appLog.ts` és `web/src/services/speedDiagnostics.ts`.

## Telefonos QR-beállítás

A QR-párosítás külön funkció, nem a hibakeresési napló. A TV `web/src/services/qrProvisioningService.ts` szolgáltatása párosítási azonosítót, kódot és tokent hoz létre; a telefonos űrlap forrása `web/public/provision.html`. Az űrlap a beállított GitHub Pages címen fut, a kliens a Supabase `qr-provision-form` Edge Functiont használja; a TV 3 másodpercenként ellenőriz és átvétel után fogyasztja a munkamenetet. A kliens alapértelmezett lejárata öt perc, ha a szerver nem ad más lejáratot. A QR-link érzékeny tokent tartalmaz, ne oszd meg nyilvánosan. A szerveroldali QR Edge Function forrása nincs ebben a checkoutban, így annak aktuális működését és a telepített szolgáltatás elérhetőségét külön kell ellenőrizni.

**Figyelem:** a `QR-TELEFONOS-BEALLITAS.md` egy régi, kvdb.io-s leírás; nem a jelenlegi implementáció referenciája. A Pages workflow a `.github/disabled-workflows/` mappában van, ezért nem aktív GitHub Actions workflow.

## Forrásfa

```text
web/index.html                         natív splash utáni látható React gyökér
web/src/main.tsx                       React indítás, webOS notifyAppLoaded
web/src/App.tsx                        felület, szolgáltató és EPG-kapcsolatok
web/src/components/VideoPlayer.tsx     élő/VOD lejátszó
web/src/index.css                      teljes képernyős videó CSS-szabályok
web/src/services/epgService.ts         csatornánkénti EPG
web/src/services/epgGuide.ts           XMLTV és tartós EPG-index
web/src/services/speedDiagnostics.ts   kézi, eseményalapú sebességmérés
web/src/services/appLog.ts             kézi napló és életciklusa
web/src/services/diagnosticShareService.ts  Supabase küldés
webos/                                 manifest, natív kép, ikonok, TV-híd
supabase/                              napló Edge Function és migrációk
tools/                                 build- és regressziós tesztek
```

## Build és tesztelés

```bash
npm ci --no-audit --no-fund
npm ci --prefix web --no-audit --no-fund
(cd web && ./node_modules/.bin/tsc --noEmit)
npm test
npm --prefix web run build
# A következő parancs kész webOS buildet igényel:
npm run smoke
# Helyi IPK-hoz Python 3, Pillow és megfelelő splash PNG szükséges:
bash tools/build-webos.sh
```

Az `npm test` több csomagolt, jsdom-alapú és szintetikus regressziós próbát futtat. Egyes tesztek hiányzó eszköz vagy build esetén kihagyhatók; a sikeres tesztparancs önmagában **nem** jelenti azt, hogy minden teszt futott, vagy hogy LG TV-n is működik. A `smoke` a `build/webos/index.html` fájlt igényli, tehát csak kész webOS build után értelmezhető.

**Helyi IPK-build ismert akadálya:** a tárolt `webos/splash-screen.png` ebben a checkoutban 1659×948-as RGB kép, kb. 1,4 MiB; a `tools/build-webos.sh` 1920×1080-as, palettás, 699 KiB alatti PNG-t követel, ezért ezen a fájlon megáll. A képet nem szabad pusztán a dokumentáció javítása miatt lecserélni. A kézi GitHub Actions workflow a meglévő képet a runneren átméretezi és palettássá alakítja a build előtt; a helyi script ezt nem végzi el. A létrejövő kép és IPK TV-s vizuális ellenőrzése továbbra is szükséges.

A kézi GitHub workflow neve **IPK építés**, a repó `main` ágát veszi alapul, és siker esetén `webos/IPTV-RT.ipk` artifactot, valamint verziózott GitHub Release-t készít. Részletek: [README-PUSH.md](README-PUSH.md), telepítés: [webos/README.md](webos/README.md). Az IPK helyi buildtermék, nem Git-forrás. Az LG Developer Mode-os IPK és a GitHub commit/tag „Verified” aláírása külön dolog: [RELEASE-SIGNING.md](RELEASE-SIGNING.md).

## Ideiglenes Android-logikájú csatornaváltási próba (2026-10-29)

**Cél:** az LG webOS élő csatornaváltását rövid tesztre az Androidos tesztapp közvetlen indítási logikájához igazítani. Ez kísérleti változtatás, a TV-n még ellenőrizni kell.

### Mi volt előtte?
- Az élő csatorna indításakor az LG a korábbi formátum-emlékezetet és a beállított TS/HLS formátumot is figyelembe vette.
- A lejátszási útvonal a HTML5 videón keresztül ment, és a szokásos indulási watchdog, formátum-fallback, valamint automatikus újrapróbálkozás is részt vehetett a folyamatban.
- Az Android teszt az élő URL-t közvetlenül a natív MPV-nek adja át; a `.m3u8` címet előtte `.ts`-re alakítja.

### Mit változtattunk a próbához?
- A `web/src/components/VideoPlayer.tsx` élő csatornaváltása közvetlenül beállítja a videó `src` címét és meghívja a `play()`-t.
- Élő adásnál a `.m3u8` cím `.ts`-re alakul, az előzőleg megjegyzett formátum és a fallback próba erre a tesztútvonalra nincs használva.
- A próbaútvonal nem hív külön `video.load()`-ot, nem indít indulási watchdogot, és hiba esetén nem próbál automatikusan másik formátumra váltani.
- A filmek és sorozatok útvonalát ez a teszt nem módosítja.
- A `webos-build.yml` workflow-t ellenőriztük: kizárólag `workflow_dispatch` indítja, `main`-ről épít, a meglévő teszteket (`npm test`) és buildet futtatja. Automatikus indítás nincs beállítva. A workflow-t ez a módosítás nem indította el, ezért build-siker még nincs igazolva.

### Visszaállítás
A módosítás előtti teljes állapot mentése itt van: **`backup/channel-switch-before-android-test-20261029`**.

Ha a TV-s próba nem jó, a `main` ágon futtasd:
```bash
git checkout main
git checkout backup/channel-switch-before-android-test-20261029 -- web/src/components/VideoPlayer.tsx
git commit -m "Rollback Android-style channel switch test"
git push origin main
```

Ez visszaállítja az eredeti `VideoPlayer.tsx`-et. A próba alapértelmezetten aktív. A régi fallback/recovery regressziós tesztek a `window.__IPTV_ANDROID_STYLE_LIVE_ZAP_TEST__ = false` kapcsolóval külön a korábbi útvonalat tesztelik; ez a TV-s próba működését nem kapcsolja ki.

### Buildhiba javítása – 2026-10-29
- A `40918288667` workflow a regressziós tesztnél állt meg: a pufferprofil megváltoztatása nem indíthatja újra az aktuális streamet.
- A próba során véletlenül a `loadKey` is függött a `bufferMode` értékétől. Ezt visszaállítottuk `const loadKey = streamUrl;` értékre, a csatornaváltási közvetlen indítás megmaradt.
- A hibás futásban 1 teszt bukott el; az IPK-építési lépések emiatt el sem indultak. A javítás után új, kézi workflow-futtatás szükséges.
