# IPTV R.T – LG webOS TV v2.3.0

Ez a kiadás kizárólag LG webOS TV-re készült. Android APK-t ez a repó nem készít, nem tölt le és nem csomagol.

## Telepítés

- IPK: `IPTV-RT-webOS-2.3.0.ipk`
- Letöltés: [GitHub Release v2.3.0](https://github.com/Robko1/LGtv/releases/tag/v2.3.0)
- Telepítés: LG TV Developer Mode + webOS Dev Manager, vagy `ares-install`.
- Részletek: [webos/README.md](webos/README.md)

## A kiadás tartalma

- LG webOS TV-s kezelőfelület és távirányító-támogatás.
- Élő TV, Mozi, Sorozat, EPG, kedvencek és beállítások.
- TV-re optimalizált fekvő indítóképernyő.
- QR-kódos telefonos szolgáltatóbeállítás.
- Kizárólag a jelenlegi `Robko1/LGtv` repó forrásaiból készített IPK.

## Build és diagnosztika

Mindkét GitHub Actions workflow csak kézzel indítható. Az IPK build a `web/` forrásból készít webes felületet, majd a `webos/` csomagolóval állítja elő az IPK-t.