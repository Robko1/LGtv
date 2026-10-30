# TV – telepítés LG webOS készülékre

Ez az útmutató az alkalmazás saját LG televízióra történő telepítését és a helyi IPK-buildet ismerteti.

## Telepítés

1. Telepítsd az LG Content Store-ból a **Developer Mode** alkalmazást.
2. Jelentkezz be LG Developer-fiókkal, majd kapcsold be a Developer Mode-ot és a Key Servert.
3. Számítógépen indítsd el a [webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop) alkalmazást, és csatlakoztasd a televíziót.
4. Telepítsd a sikeres buildből letöltött **IPTV R.T.ipk** fájlt.

## Helyi IPK-build

A repó gyökeréből Node.js és Python 3 használatával:

```bash
npm ci --no-audit --no-fund
npm ci --prefix web --no-audit --no-fund
python3 -m pip install Pillow
npm test
bash tools/build-webos.sh
```

Sikeres csomagolás esetén a telepítő a `webos/IPTV R.T.ipk` útvonalon található.

## Fontos

A helyi build sikere önmagában nem igazolja, hogy minden funkció megfelelően működik a televízión. Telepítés után ellenőrizd az indulást, a lejátszást, az EPG-t és a távirányítós vezérlést.

Az aláírási és tanúsítvány-információkat a [RELEASE-SIGNING.md](../RELEASE-SIGNING.md) dokumentum tartalmazza.
