# Kézi IPK-build és kiadás

A projekt GitHub-tárolója: <https://github.com/Robko1/LGtv>.

A módosításokat a **main** ágra kell tenni, mert a kézi IPK-build ebből az ágból készíti a telepítőt.

## IPK készítése

1. Ellenőrizd, hogy a kívánt módosítások a `main` ágon vannak.
2. Nyisd meg a GitHubon az **Actions → IPK építés** munkafolyamatot.
3. Válaszd a **Run workflow** lehetőséget.
4. Várd meg a build és az ellenőrzések befejezését.
5. Sikeres futás után töltsd le az **IPTV R.T.ipk** csomagot az artifactok közül vagy a kiadási oldalról.

## Ellenőrzés

A sikeres build után érdemes LG TV-n is ellenőrizni:

- az alkalmazás elindulását;
- az élő csatornák lejátszását;
- a filmek és sorozatok lejátszását;
- az EPG műsorújságot;
- a távirányító működését.

A számítógépes tesztek önmagukban nem helyettesítik a televízión végzett ellenőrzést.

## Kiadás

A build során létrejövő telepítő neve **IPTV R.T.ipk**. Az IPK telepítése LG TV-re fejlesztői módban, a webOS telepítőeszközével végezhető el.

Az aláírásról és a tanúsítványokról külön dokumentum szól: [RELEASE-SIGNING.md](RELEASE-SIGNING.md).
