![LGtv saját logója](webos/icon-rt2.png)

# IPTV R.T – LG webOS TV

LG webOS TV-re készült IPTV-alkalmazás (`hu.rt.iptv.webos`): élő csatornák, filmek, sorozatok, XMLTV/Xtream műsorújság (EPG), kedvencmappák, valamint felirat- és hangsávválasztás. Kizárólag LG webOS IPK csomagot épít; Android APK-t nem készít.

## TV Doktor – lejátszási diagnosztika és támogatott javítások

Az alkalmazás beépített **TV Doktor** modult tartalmaz az élő csatornák, filmek és sorozatok lejátszásának felügyeletére:

- **Élő TV diagnosztika és tanuló optimalizálás:** méri az élő csatornák indítási idejét, figyeli a médiahibákat, az indulási időtúllépéseket, a pufferkiürülést és a váratlan megállást, valamint különbséget tesz a valódi stream-/dekóderfagyás és az állóképes vagy hangalapú adások között. Hiba esetén korlátozott lépésszámban támogatott TS/HLS formátumváltást és biztonságos (`1,0–10,0 mp`) pufferlépcsőket próbál, és csak igazolt stabil lejátszás után jegyzi meg az élő csatorna profilját.
- **Film és sorozat (VOD) valós idejű lejátszássegítés memória-mentés nélkül:** a Mozi és Sorozatok tartalmaknál a TV Doktor valós időben segíti a folyamatos lejátszást (indulási védelem, pufferlépcsőzés akadásnál, pozíciótartó újracsatlakozás), de nem menti el memóriába vagy naplóba, hogy melyik film vagy sorozat és hol akadt el.
- **`0` gombos 2 oszlopos állapot- és naplóablak (élő TV közben):** a főoldalon és teljes képernyőn, kizárólag élő TV lejátszása közben a távirányító **`0`** gombja nagy, jól olvasható kétoszlopos ablakot nyit meg — bal oldalon a távirányítóval lefelé végigolvasható **Legutóbbi TV Doktor napló**, jobb oldalon az állandó állapot- és memóriaadatok, valamint a jobb felső sarokban elérhető piros **Memória: 0** nullázó gomb található. Film/sorozat lejátszásakor, Mozi/Sorozat nézetben, nyitott menükben és kód-/szövegbevitel közben a `0` gomb nem nyitja meg az ablakot.
- **Biztonsági korlátok és menüvezérlés:** a TV Doktor soha nem töröl csatornalistát, szolgáltatót, kedvencet vagy felhasználói beállítást; a **Beállítások → Rendszer → TV Doktor** dobozban a Ki/Be kapcsoló érhető el.
- **Állapotjelzés a felületen:** a már kezelt élő csatornáknál zöld 3D TV Doktor ikon jelenik meg a csatornalistában; teljes képernyős élő és VOD lejátszáskor a jobb felső óra előtt látható az állapotikon, aktív betöltés, pufferelés, hiba vagy javítás közben pedig automatikusan eltűnő állapotablak tájékoztat.

### Korlátozott hozzáférésű távoli funkciók

- A TV Doktor távoli profiljai és felhőfunkciói korlátozott hozzáférésűek, és nem érhetők el automatikusan nem jogosult készülékek számára; jogosultság hiányában a helyi lejátszás és a helyi TV Doktor korlátozás és lassulás nélkül működik tovább a készüléken.

## TV-s vezérlés és kézi hibakeresés

- **Távirányító és Magic Remote:** az alkalmazás LG TV távirányítóra készült (`supportTouchMode: none`). Élő TV-n a kiválasztott csatorna **OK** gombbal indítható, a már játszott csatornán az **OK** teljes képernyőre vált, a **VISSZA** vagy **OK** visszalép a főoldalra. A film/sorozat OSD-je a távirányító nyilaival, némítás és hangsáv/felirat választó gombjaival működik.
- **Kézi hibakeresési napló:** a naplózás nem indul automatikusan; a távirányító **SÁRGA** gombja nyitja meg a naplóablakot (**Naplózás indítása** → tesztelés → **Naplózás leállítása** / küldés). Szabad szövegben soha ne adj meg jelszót vagy személyes tokent. A tényleges IPK-verziót a build eredményében és a csomag manifestjében ellenőrizd.

## Fő könyvtárak

```text
web/      React + TypeScript + Vite felület és lejátszó
webos/    LG webOS manifest, natív indítókép, ikonok és TV-távirányító híd
tools/    webOS csomagoló és automatizált regressziós tesztek
```

## Fejlesztés, build és tesztelés

```bash
npm ci --no-audit --no-fund
npm install --prefix web --no-audit --no-fund
(cd web && ./node_modules/.bin/tsc --noEmit)
npm test
npm --prefix web run build
# Kész webOS build ellenőrzése:
npm run smoke
# Helyi IPK-csomagolás (Python 3 + Pillow szükséges):
bash tools/build-webos.sh
```

- Az `npm test` szintetikus és `jsdom`-alapú regressziós teszteket futtat; a sikeres tesztfutás nem helyettesíti a fizikai LG TV-n végzett ellenőrzést.
- **Helyi IPK-build megjegyzés:** a tárolt `webos/splash-screen.png` 1659×948-as RGB forráskép; a `tools/build-webos.sh` 1920×1080-as, palettás, 699 KiB alatti PNG-t vár. A kézi GitHub **IPK építés** workflow a runneren automatikusan elvégzi az átméretezést és palettás optimalizálást a csomagolás előtt.
- Kézi GitHub Release és `main` ág munkafolyamata: [README-PUSH.md](README-PUSH.md) • TV-re telepítés: [webos/README.md](webos/README.md) • Aláírás tudnivalók: [RELEASE-SIGNING.md](RELEASE-SIGNING.md).
