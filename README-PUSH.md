# LGtv – main ág és kézi IPK-build

A repó: <https://github.com/Robko1/LGtv>. A kézi **IPK építés** GitHub Actions workflow a `main` ág forrását tölti le, nem egy tetszőleges fejlesztői ágat. A módosításokat ezért előbb ellenőrzés után a `main` ágba kell egyesíteni. Ne inicializáld újra a repót, ne cseréld le másik projektre, és ne használj force push-t a forráságra.

## Kézi GitHub build

1. Győződj meg róla, hogy a szükséges forrásváltozások már a `main` ágon vannak.
2. GitHub → **Actions → IPK építés → Run workflow**.
3. A workflow telepíti a függőségeket, futtatja a regressziós teszteket, majd – ha ezek sikeresek – a `web/src/appVersion.ts` aktuális patchverzióját eggyel növeli, hozzáigazítja a manifestet és a verzióemelést visszamenti a `main` ágra. Ezután építi és ellenőrzi az IPK-t. **Ezért egy későbbi csomagolási hiba esetén is előfordulhat, hogy a verzióemelés már a main ágra került.**
4. A workflow a jóváhagyott `webos/splash-screen.png` fájlt a runneren 1920×1080-as, 699 KiB alatti palettás PNG-vé alakítja a build előtt. Nem állít elő helyette új színátmenetes indítóképet.
5. Sikeres build és ellenőrzés után az **`IPTV R.T.ipk`** build artifactba és az aktuális `vX.Y.Z` GitHub Release-be kerül. A Release-verziót a tényleges futás határozza meg, nem egy régi, dokumentációba beégetett szám; az új Release-ben csak az aktuális IPK marad.


## Minden kiadás után

- Ellenőrizd, hogy a workflow valóban sikeres lett, és a Release-ben a megfelelő verziójú IPK található. A sikeres `npm test` nem pótolja a kihagyott teszteket vagy a valódi LG TV-s ellenőrzést.
- TV-n ellenőrizd a natív takarókép utáni indulást, az élő/film/sorozat lejátszást és az EPG működését.
- A tényleges IPK-verziót a build eredményében és a csomag manifestjében ellenőrizd; ne használj régi vagy feltételezett verziószámot.
- Az alkalmazás ellenőrzi a legfrissebb GitHub Release-t, de a TV-n az IPK telepítéséhez webOS fejlesztői eszköz szükséges; nem állítunk csendes öntelepítést.

Az LG IPK-aláírás és a GitHub commit/tag **Verified** jelzése külön dolog: [RELEASE-SIGNING.md](RELEASE-SIGNING.md).
