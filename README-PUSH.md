# LGtv – main ág és kézi build

A projekt repója: https://github.com/Robko1/LGtv  
A változtatások közvetlenül a `main` ágra kerülnek. Ne inicializáld újra a repót, ne tölts fel másik projektből származó forrást, és ne használj force push-t.

## 1. Forrás és diagnosztika ellenőrzése

GitHub → **Actions** → **LG webOS – kézi diagnosztika és web build** → **Run workflow**.

Ez ellenőrzi a webes buildet, a LG webOS manifestet, a verzióegyezést, az IPK-csomagoló szintaxisát és azt, hogy a webes forrásban ne maradjon Android-specifikus híd.

## 2. IPK készítése és közzététele

Ha a diagnosztika sikeres, GitHub → **Actions** → **IPTV – webOS TV IPK építése** → **Run workflow**.

A build a jelenlegi `Robko1/LGtv` repó forrásaiból készíti az `IPTV-RT-webOS-2.3.1.ipk` csomagot, majd a `v2.3.1` GitHub Release-be teszi. A Release-ben csak az aktuális IPK marad.

## Fontos

- Csak LG webOS TV-re készülő IPK van; Android APK-t ez a repó nem épít.
- A GitHub-frissítés a legfrissebb Release-t ellenőrzi. Az IPK telepítéséhez webOS fejlesztői eszköz szükséges; az alkalmazás nem tudja magát csendben frissíteni.
- Az IPK sikeres buildjét és a valódi LG TV-s lejátszást minden kiadásnál külön ellenőrizni kell.
