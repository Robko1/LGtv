# IPTV-RT – LG webOS TV v{{CURRENT_VERSION}}

**Legutóbbi build készítése:** {{RELEASE_DATETIME}}  
**Letölthető IPK legutóbbi feltöltése/frissítése:** {{RELEASE_UPDATED_DATETIME}}  
**Most feltöltött alkalmazás verziója:** {{CURRENT_VERSION}}  

**Előző IPK verziója:** {{PREVIOUS_VERSION}}  
**Előző IPK feltöltésének dátuma és ideje:** {{PREVIOUS_DATETIME}}  

---

## Letöltés

- **Fájl:** `IPTV-RT.ipk`
- A build a feltöltés után ellenőrzi az elkészült IPK és a GitHub Release-ben letölthető fájl SHA-256 ellenőrzőösszegét.
- A Release-ben kizárólag egyetlen IPK maradhat.

Ez a kiadás **kizárólag LG webOS TV-re** készült. Android APK-t ez a repó nem készít, nem tölt le és nem csomagol.

A build kézzel indítható, a `Robko1/LGtv` repó `main` ágából épít. A következő build verziószáma a forrásban beállított alkalmazásverzió lesz; verzióemeléshez a `webos/appinfo.json` és a `web/src/appVersion.ts` verzióját együtt kell módosítani.
