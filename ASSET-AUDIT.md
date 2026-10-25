# Forrásfájl- és asset-audit

Dátum: 2026-10-25

A törlés előtt a forrás-, build- és runtime-hivatkozásokat átnéztem (`rg`, Vite/webOS build-script, `appinfo.json`, smoke/build tesztek). Csak az alábbi, bizonyítottan nem használt vagy generált fájlok kerültek ki.

## Törölt fájlok

| Fájl | Ellenőrzött ok |
|---|---|
| `Autos_TV_logo_nagy_TV_gyors_1920x1080.mp4` | Régi gyökérbeli indulóvideó; a jelenlegi build a `webos/splash-screen.png` képkockát használja, és a `webos/assets/` videót tiltja. Nincs forrás- vagy build-hivatkozás. |
| `icon-rt2.png` | Gyökérbeli duplikátum; a manifest és a build kizárólag `webos/icon-rt2.png`-t másol. |
| `largeIcon-rt2.png` | Gyökérbeli duplikátum; a manifest és a build kizárólag `webos/largeIcon-rt2.png`-t másol. |
| `web/public/ikonkep.png` | Régi, nem hivatkozott generált PNG. A React felület a `web/src/generatedIcon.ts` adat URL-jeit használja; a build ezt a public fájlt nem másolja. |
| `provision.html` | Régi gyökérbeli QR-oldal; a működő telefonos oldal a `web/public/provision.html`, az App és build erre hivatkozik. |
| `webos/IPTV-RT.ipk` | Korábbi build-artefakt, nem forrás. Az IPK-t `tools/build-webos.sh` állítja elő és a GitHub Release tárolja; `webos/*.ipk` mostantól ignorált. |

## Megtartott, működéshez szükséges fájlok

- `web/public/provision.html`: a külön telefonos szolgáltató-beállítás QR-felülete.
- `webos/icon-rt2.png` és `webos/largeIcon-rt2.png`: `appinfo.json` launcher ikonok és a webes adat-URL forrásképei.
- `webos/splash-screen.png`: az `appinfo.json` indítóképének és a build háttérképének forrása.
- `webos/webos.js`, `webos/webOSTV.js`: webOS bridge/runtime fájlok; a build és az app használja.
- `webos/tools/build-ipk.py`, `tools/build-webos.sh`: csomagolási és buildlépések.

## Bizonytalan fájlok

A fenti auditban nem maradt olyan fájl, amelynek törlését bizonytalan hivatkozás mellett hajtottam végre. A `webos/assets/` mappában maradó jövőbeli assetet csak külön forrás- és build-hivatkozás-ellenőrzés után szabad eltávolítani.
