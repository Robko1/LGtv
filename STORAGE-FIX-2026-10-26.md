# Tárolási hiba javítása – a 2. számú, 18:44-es webOS-napló alapján

Verzió: **2.5.127** · Dátum: 2026-10-26 · Referencia: `lennylxx/webos-iptv-player`
(`storage-service.ts`, `idb-cache.ts`, `idb-database.ts`, `xtream-catalog.ts`)

---

## 1. Mit mért a 2. számú napló (18:42:59 → 18:44:35)

A napló a `tv_diagnostic_shares` táblában, `log_number = 2`, 246 sor,
verzió **2.5.126**. Az időbélyegek a TV órájához képest +1 órával
korrigáltak (lásd `appLog.ts`).

| Idő | Esemény | Magyarázat |
|---|---|---|
| 18:42:59.802 | FIGYELŐ ELINDULT | automatikus indulási diagnosztika elindult |
| 18:42:59.810 | KÖRNYEZET | Chrome/120, WebAppManager, 1920×1080 (DPR 2), 4 CPU szál, **1 GB eszközmemória**, JS halom 9.5 MB / 347 MB |
| 18:42:59.811 | webOS HÍD | `webOSSystem=van`, `webOS=NINCS`, `PalmSystem=van`, `PalmServiceBridge=van`; a Luna `webOS.service.request` **nem elérhető** |
| 18:42:59.812 | **TÁROLÓ: localStorage=OK (9 kulcs / 1932 karakter); IndexedDB=elérhető** | az adatbázis **létezik, de üres** |
| 18:42:59.814 | BETÖLTÉS / ELSŐ FESTÉS | TTFB 182 ms, first-paint **345 ms**, 1 536 227 B átvitt adat (a bundle) |
| 18:43:00.057 | „a film- és sorozatlista IndexedDB-be kerül” | a tartós tár megnyílt |
| 18:43:00.098 | **TÁROLÓ-JELENTÉS: 9 kulcs / 1860 karakter; induló készlet = 0; IndexedDB: élő = 0, film = 0, sorozat = 0** | **nincs semmilyen mentett katalógus** |
| 18:43:00.116 | „a tárolóban nincs használható csatornalista” | a régi lista elveszett |
| 18:43:02.629 | **automatikus helyreállítás indul** | 2,5 mp várakozás után elindul a teljes letöltés |
| 18:43:02.694 | ABLAK megjelenik | a diagnosztikai **felugró ablak** eltakarja a képernyőt |
| 18:43:02.809 → 18:43:03.978 | bejelentkezés (155 ms), élő kategóriák (343 ms, 340 kategória), `get_live_streams` indítása | 1 kérés, 6.6 MB |
| 18:43:03.980 | főoldal kész (4,19 mp) | a takarókép lement; ekkor még nincs egy csatorna sem |
| 18:43:08.212 | élő lista HTTP 200 (5073 ms, 6.6 MB) | |
| 18:43:16.482 | **20 190 csatorna feldolgozva – 13,8 s** | 5–6 mp-es főszál-leállások a JSON feldolgozása közben |
| 18:43:17.492 | **ABLAK: „Az élő TV-csatornák frissítve”** | újabb felugró ablak, 6 mp-es leállással |
| 18:43:17.662 → 18:43:55.277 | filmek: 40.4 MB / 14,5 s hálózat + **16,2 s feldolgozás** → 102 824 film | 37,6 s; a lejátszás közben 16 mp-re megáll a fő szál |
| 18:43:55.380 → 18:44:08.186 | sorozatok: 29.2 MB / 7,3 s → 24 974 sorozat | 12,8 s |
| 18:44:08.191 → 18:44:10.220 | 20 db `get_vod_info` részletes kérés | 2 s |
| 18:44:10.249 | **import kész: 70 460 ms – 20 190 / 102 824 / 24 974** | összesen **~76 MB** letöltés |
| 18:44:23.876 | **HOSSZÚ FELADAT: 13 027 ms (self)** | a három `diffCatalogs()` 100 ezer elemen + a halasztott mentés |
| 18:44:24 → 18:44:35 | rövid EPG-kérések, csatornaváltás, kézi napló ablak | **egyetlen „elmentve” sor sincs a naplóban** |

### A TV által elvégzett ellenőrzések induláskor
A `startupDiagnostics.ts` / `index.html` réteg: UA és képernyő, CPU szálak,
`deviceMemory`, JS halom, webOS-hidak (`webOSSystem`, `PalmSystem`,
`PalmServiceBridge`, Luna), localStorage kulcsszám, IndexedDB elérhetőség,
MPEG-TS/HLS/MP4/HEVC/H.264 `canPlayType`, navigációs időzítések, első festés,
legnagyobb tartalom (LCP), erőforrások, lassú kérések, képkocka-kihagyások,
DOM-elemek megjelenése/eltűnése, elrendezés-ugrások, médiaesemények.
Ezek **nem lassították** az indulást (345 ms első festés, 1,5 MB bundle).

### Mi lassította az indulást
1. **Üres tároló → teljes 76 MB-os újratöltés (67,6 mp).** Ez a 95 %-a a teljes
   indulási időnek. A hálózat önmagában ~28 mp, a JSON-feldolgozás további
   ~35 mp (16,2 mp-es egybefüggő főszál-blokkokkal).
2. **2,5 mp mesterséges várakozás** az automatikus helyreállítás előtt.
3. **Három párhuzamos visszatöltő effekt** (800/900/1200 ms + `requestIdleCallback`),
   amelyek ugyanazokat a listákat többször is dekódolták.
4. **Két felugró ablak** (diagnosztika + „csatornák frissítve”).
5. **13 mp-es főszál-leállás** az import után: három `diffCatalogs()` hívás
   100 000+ elemen, ÉS CSAK EZUTÁN kezdődött a mentés.

---

## 2. A tényleges hibák (amik miatt minden indításkor újra letöltött)

1. **A mentés csak a 67 mp-es import LEGVÉGÉN futott.** A naplóban nincs egyetlen
   `elmentve` sor sem: a néző az import utáni 25 mp-ben bezárta az alkalmazást,
   a mentés így nem ért a **fejléc** kiírásáig. Fejléc nélkül a következő
   indulás üres tárat látott.
2. **A webOS az import alatt bezárta az IndexedDB-kapcsolatot.** A régi
   `idbStore` egyetlen, halott `IDBDatabase` példányt használt tovább: az
   írások vagy kivétellel estek el, vagy egy soha vissza nem térő kérésre
   vártak. A referencia `idb-database.ts` pontosan erre vezeti be az
   `onclose` / `onversionchange` érvénytelenítést.
3. **A 4 mp-es megnyitási időkorlát `null`-t cache-elt örökre.** Egy lassú
   megnyitás után a teljes munkamenet localStorage-tartalékra váltott.
4. **257 külön tranzakció** (400 elem/adag, 102 824 film) – a mentés több tíz
   másodpercig tartott.
5. **Sikertelen IDB-írás után a teljes listát a 5 MB-os localStorage-ba
   erőltette**, ami garantált kvótahibát és adatvesztést okozott.
6. **Nem kértünk tartós (persisted) tárolót**, így a böngésző eldobhatta az
   adatbázist az alkalmazás bezárásakor.
7. **Nincs TTL / frissességi bélyeg**: a gyorsítótárat vagy azonnal újra
   letöltöttük, vagy soha nem ellenőriztük.

---

## 3. Alkalmazott javítások

| Fájl | Változtatás |
|---|---|
| `web/src/services/idbStore.ts` | Új, **újranyitható** adatbázis-réteg: `onclose` / `onversionchange` érvénytelenítés, időkorlátos kérések, sikertelen nyitás **nem végleges**, kötegelt `putMany` / `removeMany` **egy tranzakcióban**, `navigator.storage.persist()` + régi webOS-on `webkitPersistentStorage.requestQuota(256 MB)`, `navigator.storage.estimate()` alapú keret. |
| `web/src/services/contentStore.ts` | 1200 elem/adag + 12 adag/tranzakció (**~8 tranzakció 257 helyett**), a **fejléc mindig utolsó tranzakcióként** íródik; kvótahiba esetén régi generációk felszabadítása + egyszeri újrapróbálás; **nincs nagy lista a localStorage-ba**; katalógus-állapot (`catalog-state-v2`) 12 órás TTL-lel, `markCatalogChecked()` csak a bélyeget írja; 20 részletes VOD-metaadat külön rekordban; `inspectStoredCatalogs()` + `restoreStoredContent()` **egyetlen megosztott visszatöltés** dekódolás-gyorsítótárral; szakaszonkénti mentés a `durable` partialokból. |
| `web/src/services/providerImport.ts` | A `PartialContent` új `durable` jelzője: a kész élő / film / sorozat szakasz **azonnal** a tartós tárba kerül, még a 67 mp-es import közben. |
| `web/src/App.tsx` | Három időzítős, párhuzamos visszatöltő effekt → **egy** tároló-felmérés és **egy** azonnali visszatöltés; a 2,5 mp → **0 ms**; a 13 mp-es `diffCatalogs()` blokk megszűnt (olcsó darabszám-eltérés); az automatikus betöltés **nem nyit felugró ablakot**; a háttér-ellenőrzés (12 óra után) egyetlen 44 kB-os kategória-kéréssel, csendben fut. |
| `web/src/appVersion.ts`, `webos/appinfo.json` | Verzió: **2.5.127**, részletes kiadási naplóval. |
| `tools/test-durable-restart.mjs` | **Új, 31 pontos valódi újraindítási próba** 102 824 filmmel: mentés, bezárás, visszatöltés, kapcsolat-újranyitás, félbeszakadt írás, TTL, VOD-extrák. |
| `tools/test-requirements.mjs`, `test-persistence.mjs`, `test-live-cache.mjs`, `storage-quota.spec.ts` | Az új architektúrának megfelelő, de ugyanazon garanciákat ellenőrző állítások. |

### Referenciából átvett elvek (nem kódmásolat)
- `idb-database.ts`: egy verziózott, tartós adatbázis; a rendszer által bezárt
  kapcsolat érvénytelenítése; sikertelen nyitás nem végleges.
- `idb-cache.ts`: kötegelt, tranzakció-lezárással várt írás; kvótabecslés és
  elárvult generációk takarítása; TTL és frissességi bélyeg.
- `xtream-catalog.ts`: **stale-while-revalidate** – a gyorsítótár azonnal
  kiszolgál, a lejárt listát a háttérben frissítjük; üres/sikertelen
  újratöltés nem írja felül a jó adatot.
- `storage-service.ts`: a kis beállítások (localStorage) és a nagy katalógus
  (IndexedDB) következetes szétválasztása.

---

## 4. Eredmény / tesztek

- `npx tsc --noEmit -p web/tsconfig.json` – **0 hiba**.
- `npm test` – **teljes tesztkészlet zöld** (185 node:test alteszt + 19 önálló
  próbaszkript), beleértve az új `test-durable-restart.mjs` **31/31** ellenőrzését.
- `npm run build --prefix web` – sikeres Vite single-file build (930 kB).
- `tools/transpile-es5.mjs` – sikeres ES5 átírás (Chrome 38 / webOS 3.x),
  nincs `type="module"`.
- `bash tools/build-webos.sh` – **IPK 2.5.127** elkészült (1083 KB);
  `npm run smoke` – a csomagolt `index.html` hibátlanul felépül.
- A 100 ezres katalógus mentése a szimulált TV-n **~0,1 s** (korábban 0,57 s
  volt a gyors Node-ban, a TV-n több tíz mp), a visszatöltés hálózat nélkül,
  másodpercek alatt kész.

**Következő lépés:** a `main` ágról kézzel épített IPK telepítése után a
kézi naplóban ezeket a sorokat érdemes keresni: `TARTÓS TÁROLÓ`,
`TÁROLÓ-JELENTÉS`, `TARTÓSAN elmentve`, `TARTÓS VISSZATÖLTÉS készen`.
Ha ezek megvannak, a következő teljes bezárás után **nem szabad** újabb
`Xtream import indul` sornak megjelennie.
