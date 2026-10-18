# IPTV-RT 2.3.3 – LG webOS TV

Ez a kiadás kizárólag LG webOS TV-re készült. Android APK-t ez a repó nem készít, nem tölt le és nem csomagol.

- A telepítő neve mindig: `IPTV-RT.ipk`
- A telepítőn belüli webOS alkalmazásverzió: **2.3.3** (`webos/appinfo.json` és `web/src/appVersion.ts`).
- Az IPK minden kézi buildnél újraépül a `main` ág aktuális forrásából, és a meglévő Release fájlját cseréli.
- Állandó letöltési oldal: https://github.com/Robko1/LGtv/releases/tag/v2.3.1
- A csomagolt `index.html` bájtra pontosan ellenőrzött a builddel.
- A build kizárólag kézzel indítható.

Megjegyzés: a GitHub Release címkéje továbbra is `v2.3.1`; ez nem az IPK belső alkalmazásverziója.