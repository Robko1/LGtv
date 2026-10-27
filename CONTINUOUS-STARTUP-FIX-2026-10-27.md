# Folyamatos indulás – 2.5.135 (2026-10-27)

Két valós TV-napló alapján, **üres IPK**-n (0 csatorna, 0 szolgáltató).

## A két napló

| | #2 | #3 |
|---|---|---|
| Küldés | 00:14:19.933 | 00:14:56.023 |
| Verzió | 2.5.134 | 2.5.134 (ugyanaz az IPK újraindítva) |
| Sorok | 104 | 73 |
| `válasz` (HTML a helyi tárból) | 413 ms | **863 ms** |
| first-paint / FCP | 948 / 948 ms | 989 / 990 ms |
| LEGNAGYOBB TARTALOM | 1414 ms | 2532 ms |
| ELŐFESTÉS KÉSZ | +579 ms | +1681 ms |
| REVEAL | +715 ms | +1739 ms |
| Takarókép eltűnt | +722 ms | +1781 ms |
| Képkocka-kihagyás | 22 (max 250 ms) | 7 (max 267 ms) |

A felhasználó mindkét indításnál **fekete felvillanást** és **zöld háttér
felvillanást** látott, és azt kérte, hogy az indulás „folyamatos legyen, mintha
körbe-körbe ugyanazt csinálnánk”.

Fontos: a kétlépcsős előfestés (2.5.131) és az üres IPK gyors döntése
(2.5.129/133) **működött** – a legnagyobb tartalom 61–77 ms-sal a takarókép
levétele ELŐTT festődött ki. A villanások nem a React-festésből, hanem a
takarókép saját megjelenítéséből jöttek.

## Két valódi ok

### 1. Zöld háttér felvillanás – a két CSS háttérréteg

A 2.5.133/134 így építette fel a takaróképet:

```js
var splashLayer = splashImage + ',' + tinyImage;   // JPEG, PNG
"#tv-curtain{background-image:" + splashLayer + ";...}"
```

Két `background-image` réteg volt: felül a beégetett 1280×720-es JPEG, alatta
egy 48×27-es PNG, a `background-color` pedig a kép mért átlagszíne, a lapos
**`#6ccbd3`** (világos türkiz – a felhasználó ezt nevezi „zöld háttérnek”).

A CSS háttérkép dekódolása **nem tartja vissza az első festést**. Amíg a felső
JPEG nem volt kész, a Chrome nem festette ki a rétegeket, csak a hátteret:
a 00:14-es naplók first-paint-je 948/989 ms, az éles kép csak ezután érkezett.
A 48×27-es PNG ezért nem tudott segíteni – ugyanannak a `background-image`
listának a második eleme volt, nem független réteg.

További gond: a beégetett JPEG **1280×720** volt, a webOS
`splashBackground` viszont **1920×1080**. A platform takaróképéről a saját
takaróképre váltáskor a logó belobbant / elmosódott.

### 2. Fekete felvillanás – három külön fekete body-szabály

A REVEAL egyetlen feladatban törölte a `#tv-curtain`-t, levette az
`iptv-booting` osztályt és meghívta a `notifyAppLoaded()`-ot. A következő
képkockán a body háttere **fekete** lett, mert három helyen is `#000` volt:

1. `tools/build-webos.sh` – a beégetett CSS: `body.webos-tv { background:#000 }`
2. `webos/webos.js` – `injectTvCss()`: `body.webos-tv { background:#000 }`
3. `web/src/themes/webos.css` – `body.webos-theme { background:#000 }`

A `webos.js` emellett 6/14/24 px-es TV-paddinget ad a `#root`-nak, amin
átlátszott a fekete body; az üres IPK lejátszó-doboza (`data-player-poster`,
`bg-[#0a1220]` + `bg-black` videó) pedig a képernyő közepét is sötétre
festette. A világos türkiz indítóképről a majdnem teljesen fekete főoldalra
való **egy ugrással** történő váltás volt a „fekete felvillanás”.

## A javítás (2.5.135)

### Egyetlen, valódi kép az első képkockától

* A takarókép most **valódi `<img id="tv-curtain-img" decoding="sync"
  fetchpriority="high">`**, `object-fit: cover`. A `decoding="sync"` azt jelenti,
  hogy a böngésző a kép dekódolását **az első festéskor, szinkron** végzi el –
  nincs olyan köztes képkocka, amin csak a háttérszín látszana. A `src`-t a
  `<head>` egyetlen beégetett adat-URI-jából kapja (a HTML-ben továbbra is csak
  **egy** `data:image/jpeg` van).
* A korai `new Image()` + `decode()` előmelegítés megmaradt, így a dekódolt
  bitmap már a cache-ben van.
* A tartalék **egyetlen** `background-image` réteg: ugyanannak a képnek egy
  **192×108-as** PNG mása (~34 kB). Nem szín, nem második CSS-réteg.
* A beégetett JPEG most **1920×1080, baseline, quality 80** – pontosan akkora,
  mint a webOS `splashBackground`. Nincs nagyítási ugrás.

### Sehol nincs fekete a boot-láncban

* Mindhárom `background:#000` szabályt `#080d1a`-ra cseréltük (az app saját
  sötétkék alapszíne).
* `html { background-color:#6ccbd3 }` – a vászon sem fekete.
* `html.iptv-booting body { background-color:#6ccbd3 !important }` és
  `html.iptv-revealed body { background-color:#080d1a !important }` – az
  `!important` kell, mert a webOS híd később injektált CSS-e is állítgatja a
  body-t.
* Az üres IPK lejátszó-doboza (`[data-player-poster]`) a
  `html[data-iptv-boot="empty"]` szabállyal **megtartja az indítóképet**; a
  „Kapcsolódás…” és a logó-doboz csak akkor jelenik meg, ha már van csatorna.
  Így a főoldal első képkockája nem fekete, hanem a már látott kép.

### A képernyő nem ugrik, hanem folyamatosan áttűnik

A REVEAL most három lépés, de a felhasználó csak egy folyamatos váltást lát:

1. `notifyAppLoaded()` – a platform takaróképe eltűnik, de a mi **azonos képű**
   takaróképünk fent van (nincs látható változás).
2. A `html` osztálya `iptv-booting` → `iptv-revealed iptv-handoff`: a body
   háttere a sötétkékre vált, **de a takarókép még átlátszatlanul fed**.
3. A takarókép `opacity: 1 → 0` **200 ms** alatt, kompozitor-átmenettel
   halványul el a már kifestett, átlátszatlan felület FÖLÖTT. A
   `transitionend` (vagy egy 240 ms-os biztonsági időzítő) után a réteg
   kikerül a DOM-ból.

**Nem a felület úszik be!** A régi, 140 ms-os „beúszás” azért villogott, mert
a felületet tette áttetszővé, és alatta látszott a zöld háttér. Most az
átlátszatlan takarókép tűnik el fokozatosan. A `transition` azért
`!important`, mert a `webos.css` és a `webos.js` minden elemre rákényszeríti a
`transition-duration: 0s !important` szabályt; a magasabb specificitású
`#tv-curtain.iptv-fading` felülbírálja.

Változatlan marad: a két képkockás előfestés, az üres IPK azonnali döntése,
a 40 ms-os ellenőrző ciklus, a 3,5/9/12 mp-es biztonsági hálók, a rejtett
diagnosztikai doboz tilalma, a TÁROLÓ/MÉDIA naplósorok, az utolsó 5 napló
nagy, sortörés-biztos feliratai.

## Eredmény a csomagolt IPK-n (jsdom mérés)

```
beégetett JPEG: 1                    (1920×1080, baseline)
beégetett kis PNG: 1 (+ ikonok)
kép forrása beégetett: true
kép decoding: sync | fetchpriority: high
korai Image.decode előmelegítés: true
takarókép TARTALÉK réteg (egyetlen): true
NINCS két CSS-réteg: true
üres poszter szabály: true
fekete body szabály: false
html vászon szín: rgb(108, 203, 211)
takarókép opacity induláskor: 1
notifyAppLoaded hívások: 1
átmenet: iptv-curtain iptv-fading | opacity: 0
root látható: visible
átmenet után takarókép: null
jelek: ELŐFESTÉS | REVEAL – folyamatos áttűnés | ÁTTŰNÉS KÉSZ
```

`npx tsc --noEmit` tiszta, `npm test` 220/220 (1 skip), Vite + ES5 + IPK
build, `npm run smoke` mind rendben. A következő lépés: a felhasználó a
`main` ágról kézzel megépíti a 2.5.135-ös IPK-t, és újra küld két naplót.

## Válasz az előre rajzolt, fix váz kérdésére

**Igen, érdemes – és az első lépését már be is építettem.** A lényeg nem az,
hogy a DOM-ot „előre lefessük” (React azt a takarókép alatt már megteszi),
hanem hogy a **régiók mérete és helye soha ne változzon**:

* a lejátszó 16:9-es doboza, az OSD, a mappasáv és a csatornalista helye
  fix; ezekbe csak adat (csatornanév, logó, EPG) kerül;
* így a teljes képernyő ⇄ kis nézet váltás nem épít új DOM-fát, csak a fix
  dobozok láthatóságát/portréját változtatja – nincs újrarendezés, nincs
  elrendezés-ugrás (a 00:14-es naplókban 0.105 / 0.062 volt);
* az üres állapot poszter-doboza most ugyanazt a képet mutatja, mint az
  indítókép – ez a fix váz első, már kipróbált eleme.

A teljes, statikus HTML-váz (amit még a bundle betöltése ELŐTT kirajzolnánk)
**jelenleg nem kell**: a mérések szerint a főoldal már a REVEAL elött 60–80
ms-sal kifestődik, és a mostani két villanást nem a DOM, hanem a takarókép
okozta. Ha a következő naplókban a REVEAL és a LEGNAGYOBB TARTALOM között
újra több száz ms lenne, akkor jön a következő lépés: statikus, számított
méretű váz a HTML-ben, amelyet React csak adattal tölt fel.
