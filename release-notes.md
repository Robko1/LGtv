# IPTV R.T – LG webOS TV v2.3.2

Ez a kiadás kizárólag LG webOS TV-re készült. Android APK-t ez a repó nem készít, nem tölt le és nem csomagol.

## Javítás ebben a kiadásban

- Javítva az indulásnál megálló „2/7 DOM kész” képernyő: a webOS IPK-csomagoló többé nem távolítja el a Vite által generált JavaScript moduljelölést.
- A body meglévő CSS-osztályai megmaradnak; a webOS-osztályok nem hoznak létre duplikált class attribútumot.
- Az IPK build ellenőrzi, hogy a csomagolt `index.html` bájtra pontosan egyezik-e az aktuális builddel.
- A verzió minden webOS csomagban 2.3.2.

## Telepítés

- IPK: `IPTV-RT-webOS-2.3.2.ipk`
- Letöltés: [GitHub Release v2.3.2](https://github.com/Robko1/LGtv/releases/tag/v2.3.2)
- Telepítés: LG TV Developer Mode + webOS Dev Manager, vagy `ares-install`.

## Kiadás tartalma

- Kizárólag a jelenlegi `Robko1/LGtv` repó forrásaiból készített LG webOS TV IPK.
- A build külön ellenőrzi a csomagolt `index.html` és az aktuális HTML-build egyezését.
- Mindkét GitHub Actions workflow kizárólag kézzel indítható.
