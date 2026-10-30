![TV](webos/icon-rt2.png)

# TV

Élő csatornák, filmek és sorozatok egy LG webOS televíziós alkalmazásban. Támogatja az EPG műsorújságot, a kedvenceket, valamint a felirat- és hangsávválasztást.

## Fő funkciók

- Élő televíziózás és csatornalista.
- Filmek és sorozatok böngészése és lejátszása.
- EPG műsorújság.
- Kedvencek kezelése.
- Feliratok és hangsávok kiválasztása, illetve kikapcsolása.
- TV Doktor lejátszásfelügyelet és hibakeresés.
- Távirányítóval kezelhető felület.

## Build és tesztelés

A fejlesztői környezetben:

```bash
npm ci --no-audit --no-fund
npm install --prefix web --no-audit --no-fund
(cd web && ./node_modules/.bin/tsc --noEmit)
npm test
npm --prefix web run build
bash tools/build-webos.sh
```

A kész telepítő neve: **IPTV R.T.ipk**. A GitHubon elérhető kézi **IPK építés** workflow szintén ezt a csomagot készíti el.

## Dokumentáció

- [IPK build és kiadás](README-PUSH.md)
- [Telepítés LG TV-re](webos/README.md)
- [Aláírási tudnivalók](RELEASE-SIGNING.md)
