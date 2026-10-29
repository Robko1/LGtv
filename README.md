![LGtv saját logója](webos/icon-rt2.png)

# IPTV R.T – LG webOS TV

LG webOS TV-re készült IPTV-alkalmazás (`hu.rt.iptv.webos`): élő csatornák, filmek, sorozatok, XMLTV/Xtream műsorújság (EPG), kedvencmappák, valamint felirat- és hangsávválasztás. Kizárólag LG webOS IPK csomagot épít; Android APK-t nem készít.

## TV Doktor – lejátszási diagnosztika és támogatott javítások

Az alkalmazás beépített **TV Doktor** modult tartalmaz az élő csatornák, filmek és sorozatok lejátszásának felügyeletére:

- **Lejátszási diagnosztika és hibafelismerés:** méri a csatorna- és VOD-indítási időket, figyeli a médiahibákat, az indulási időtúllépéseket, a pufferkiürülést, a váratlan megállást, és különbséget tesz a valódi stream-/dekóderfagyás, illetve az állóképes vagy hangalapú adások között.
- **Támogatott automatikus javítási lépések:** hiba vagy elakadás esetén korlátozott lépésszámban (munkamenetenként legfeljebb 5 lépés, percenként korlátozott beavatkozással) támogatott TS/HLS formátumváltást próbál élő adásoknál, biztonságos határok között (`1,0–10,0 mp`) módosítja a pufferprofilt (`fast`, `balanced`, `stable`, `adaptive-1..3`), újraindítja a megakadt adatfolyamot, és csak igazolt stabil lejátszás után rögzíti a profilt sikeresként. Ha a javítási lépések kimerülnek, biztonságosan visszaáll az alap lejátszási működésre.
- **Biztonsági korlátok:** a TV Doktor soha nem töröl csatornalistát, szolgáltatót, kedvencet vagy felhasználói beállítást; a helyi memória mérete és elemszáma korlátozott, és a **Beállítások → Rendszer → TV Doktor** menüben a **Memória: 0** gombbal bármikor nullázható.
- **Állapotjelzés a felületen:** a már kezelt élő csatornáknál zöld 3D TV Doktor ikon jelenik meg a csatornalistában; teljes képernyős élő és VOD lejátszáskor a jobb felső óra előtt látható az állapotikon, aktív betöltés, pufferelés, hiba vagy javítás közben pedig automatikusan eltűnő állapotablak tájékoztat.

### Korlátozott hozzáférésű védett memória és távoli funkciók

- A TV Doktor **védett távoli memóriája, tanult központi profiljai és a Supabase-hez kötött funkciók korlátozott hozzáférésűek**, és **nem érhetők el automatikusan más telepítések vagy nem jogosult készülékek számára**.
- Jogosult párosítás nélkül az alkalmazás helyi lejátszása, valamint a TV Doktor helyi diagnosztikai és javítási funkciói korlátozás és lassítás nélkül működnek a készüléken, de a védett központi adatokhoz való hozzáférést a szerver elutasítja.
- Kliensoldali, módosítható környezetben futó alkalmazás önmagában nem tudja 100%-os fizikai bizonyossággal igazolni a TV hardverazonosságát; a védett távoli adatok elérése ezért szerveroldali jogosultság-ellenőrzéshez kötött.

## Védett működési referencia: 2.5.176

A felhasználó által elfogadott működési alap a **2.5.176** (`e994abb7a46763f9dce060209fd8cdd8a83996dc`). A következő három terület regressziós referencia, amely csak külön kérésre és fizikai LG TV-s ellenőrzés mellett módosítható:

1. **Natív indítókép és közvetlen főoldal:** a webOS az `appinfo.json` `splashBackground` mezőjében megadott `webos/splash-screen.png` képet jeleníti meg. Nincs saját HTML-es takarókép, százalékjelző vagy induló videó; a React főoldal felépülésekor a `webOSSystem.notifyAppLoaded()` jelzi a rendszernek a kész állapotot.
2. **Képmegjelenítés:** HTML5 `<video>` elem természetes színekkel (`filter: none`, `imageRendering: auto`). Teljes képernyőn az élő adás `object-fit: cover !important`, az aktív film/sorozat (`[data-vod-active]`) `object-fit: fill !important` szabályt használ.
3. **EPG – műsorújság:** a csatornalista és az élő sáv a darabolt XMLTV-indexből/gyorsítótárból és szükség esetén a rövid EPG-végpontokból (`get_short_epg`, tartalékként `get_simple_data_table`) jeleníti meg az aktuális és következő műsort.

## TV-s vezérlés és kézi hibakeresés

- **Távirányító és Magic Remote:** az alkalmazás LG TV távirányítóra készült (`supportTouchMode: none`). Élő TV-n a kiválasztott csatorna **OK** gombbal indítható, a már játszott csatornán az **OK** teljes képernyőre vált, a **VISSZA** vagy **OK** visszalép a főoldalra. A film/sorozat OSD-je a távirányító nyilaival, némítás és hangsáv/felirat választó gombjaival működik.
- **Kézi hibakeresési napló:** a naplózás nem indul automatikusan; a távirányító **SÁRGA** gombja nyitja meg a naplóablakot (**Naplózás indítása** → tesztelés → **Naplózás leállítása** / küldés). Szabad szövegben soha ne adj meg jelszót vagy személyes tokent. A verziózott TV-s méréseket a [README-TESZTNAPLO.md](README-TESZTNAPLO.md) tartalmazza.

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
