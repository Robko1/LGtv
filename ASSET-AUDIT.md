# Forrásfájl- és asset-audit

Dátum: 2026-10-25

A törlés előtt a forrás-, build- és runtime-hivatkozásokat átnéztem (`rg`, Vite/webOS build-script, `appinfo.json`, smoke/build tesztek). Csak az alábbi, bizonyítottan nem használt vagy generált fájlok kerültek ki.

## Törölt fájlok

| Fájl | Ellenőrzött ok |
|---|---|
| `Autos_TV_logo_nagy_TV_gyors_1920x1080.mp4` | Régi gyökérbeli indulóvideó; a jelenlegi build a `takarokep.jpg`-ből generált `webos/splash-screen.png` képet használja, és a `webos/assets/` videót tiltja. Nincs forrás- vagy build-hivatkozás. |
| `icon-rt2.png` | Gyökérbeli duplikátum; a manifest és a build kizárólag `webos/icon-rt2.png`-t másol. |
| `largeIcon-rt2.png` | Gyökérbeli duplikátum; a manifest és a build kizárólag `webos/largeIcon-rt2.png`-t másol. |
| `web/public/ikonkep.png` | Régi, nem hivatkozott generált PNG. A React felület a `web/src/generatedIcon.ts` adat URL-jeit használja; a build ezt a public fájlt nem másolja. |
| `provision.html` | Régi gyökérbeli QR-oldal; a működő telefonos oldal a `web/public/provision.html`, az App és build erre hivatkozik. |
| `webos/IPTV-RT.ipk` | Korábbi build-artefakt, nem forrás. Az IPK-t `tools/build-webos.sh` állítja elő és a GitHub Release tárolja; `webos/*.ipk` mostantól ignorált. |

## Megtartott, működéshez szükséges fájlok

- `web/public/provision.html`: a külön telefonos szolgáltató-beállítás QR-felülete.
- `webos/icon-rt2.png` és `webos/largeIcon-rt2.png`: `appinfo.json` launcher ikonok és a webes adat-URL forrásképei.
- `takarokep.jpg`: az **indítókép egyetlen forrása** – ebből készül a `webos/splash-screen.png` (webOS `splashBackground`) és a `web/public/splash-bg.jpg` (a HTML betöltőképernyő háttere).
- `webos/splash-screen.png`: a `takarokep.jpg`-ből generált 1920×1080 indítókép (a build is ezt állítja elő a csomagba).
- `webos/webos.js`, `webos/webOSTV.js`: webOS bridge/runtime fájlok; a build és az app használja.
- `webos/tools/build-ipk.py`, `tools/build-webos.sh`: csomagolási és buildlépések.

## Bizonytalan fájlok

A fenti auditban nem maradt olyan fájl, amelynek törlését bizonytalan hivatkozás mellett hajtottam végre. A `webos/assets/` mappában maradó jövőbeli assetet csak külön forrás- és build-hivatkozás-ellenőrzés után szabad eltávolítani.

## 2.5.139 – indítókép-forrás

| Fájl | Állapot |
|---|---|
| `takarokep.jpg` | **Új egyetlen forrás** az indítóképhez és a betöltőképernyő hátteréhez. |
| `tools/make-splash.py` | Új generátor: `takarokep.jpg` → `webos/splash-screen.png` + `web/public/splash-bg.jpg`; a build `--out-dir` móddal a csomagba ír. |
| `tools/make-splash-skeleton.py` | Törölve: a régi előre rajzolt főoldali váz generátora (a felhasználó kérésére a váz megszűnt). |
| `tools/boot-logo.jpg` | Törölve: a váz kis logója; az új betöltőképernyőn nincs külön logó-fájl. |
| `web/public/splash-bg.jpg` | Új, generált fájl a HTML háttérhez (baseline JPEG, q86). |
