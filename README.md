# IPTV R.T – LG webOS TV

Ez a repó kizárólag LG webOS TV-hez készül. Az alkalmazás élő TV-csatornákat, filmeket, sorozatokat, EPG-t, kedvenceket és telefonos QR-beállítást kezel.

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

A napló legfeljebb 1 MB, sorszámozott és kezdési idővel ellátott. A küldés automatikusan leállítja a naplózást; kilépéskor szintén leáll. A Supabase-en legfeljebb az öt legfrissebb teljes napló marad.

Ha a küldés ismét átmeneti HTTP 503-at kap, az alkalmazás két rövid, automatikus újrapróbát végez. A szerver ugyanazt a sorszám/kezdési idő párt idempotensen kezeli, ezért egy elveszett válasz nem készít dupla rekordot.

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
webos/                       LG manifest, webOS bridge, ikonok, indítókép
supabase/                    Edge Function és SQL migráció
tools/                       build- és futásidejű tesztek
```

A programból eltávolított, nem használt régi gyökérfájlok: a régi induló MP4, a gyökérben megkettőzött ikonok, a nem hivatkozott `web/public/ikonkep.png`, a régi gyökérbeli `provision.html`, valamint a forráságban tárolt előző IPK. Az aktuális IPK build- és GitHub Release-artefakt, nem forrásfájl. A pontos hivatkozási audit: [ASSET-AUDIT.md](ASSET-AUDIT.md).

## Build

```bash
npm ci --no-audit --no-fund
npm ci --prefix web --no-audit --no-fund
npm test
(cd web && ./node_modules/.bin/tsc --noEmit)
npm --prefix web run build
npm run smoke
VERSION=2.5.90 bash tools/build-webos.sh
```

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
(cd web && ./node_modules/.bin/tsc --noEmit)
npm --prefix web run build && npm run smoke
```
