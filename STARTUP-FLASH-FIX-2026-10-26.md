# A „nagy felvillanás” és a gyorsítás – 2.5.131

**Napló:** Supabase `tv_diagnostic_shares`, `log_number = 1`,
`id = 0d46905a-5351-4b1b-8d0f-9cf06f0b6484`,
`created_at = 2026-10-26 22:32:49`, 70 sor, verzió **2.5.130**, üres IPK.

A felhasználó jelzése: *„induláskor 1 nagy felvillanás volt… a gyorsaság kezd
jó lenni, de ha találsz még valamit amin gyorsítani lehet, az jó lesz.”*
Külön kérés: a kézi hibakeresési napló **„Utolsó 5 elküldött napló”** sorain a
napló sorszámát és az idő feliratát a saját függőleges dobozuk méretére kell
növelni, kilógás nélkül, olvashatóbban.

---

## 1. Mi volt az az egy nagy felvillanás?

A 2.5.129-es javítás után a sebesség rendben van: a REVEAL a korábbi
**10 563 ms** helyett **+2770 ms**-nál történt, a 9 mp-es `időtúllépés` ág nem
sült el, üres IPK-n nem indul hálózati letöltés. **De a napló utolsó nagy
hibája megmaradt:**

| Idő | Esemény |
| --- | --- |
| +1790 ms | `ELEM MEGJELENT: TAKARÓKÉP` |
| +1796 ms | `bundle betöltve (main.tsx)` |
| +1889 / +1920 ms | `TÁROLÓ` / `MÉDIA` (a halasztott diagnosztikai próbák) |
| +2424…+2427 ms | fejléc, lejátszó, OSD, oldalsáv, mappasáv, csatornalista a DOM-ban |
| **+2518 ms** | `KÉPKOCKA-KIHAGYÁS: 500 ms` (a bundle futtatása + React első render) |
| +2620…+2705 ms | `TARTÓS TÁROLÓ`, `TÁROLÓ-JELENTÉS: 0/0/0`, `üres alkalmazás…` |
| +2753 ms | `KÉPKOCKA-KIHAGYÁS: 233 ms` |
| **+2770 ms** | `REVEAL – a kész felület megjelent (üres alkalmazás – kész felület)` |
| +2829 ms | `ELEM ELTŰNT: TAKARÓKÉP` |
| **+2879…+3479 ms** | **`KÉPKOCKA-KIHAGYÁS: 600 ms` – a fő szál leállt** |
| **+3602 ms** | **`LEGNAGYOBB TARTALOM: 3602 ms`** (az üres állapot szövege) |

A takarókép **+2770 ms**-nál tűnt el, de a legnagyobb tartalom csak
**+3602 ms**-nál lett ténylegesen kifestve: **~830 ms**-nyi üres/fekete
képkocka, benne egy 600 ms-os főszál-leállással. Ez a „nagy felvillanás”.

### A valódi ok

A `web/index.html` eddig ezt csinálta:

```css
html.iptv-booting #root   { visibility: hidden; }
html.iptv-revealed #root  { visibility: visible; }
```

`visibility: hidden` esetén a böngésző **egyáltalán nem festi ki** az elemet.
A `main.tsx` `afterPaint()` két `requestAnimationFrame`-je tehát egy **üres,
rejtett fát** „festett meg” – a képkocka-őr sem a valódi festési költséget
mérte. A `__IPTV_REVEAL__` aztán egyetlen feladatban:

1. eltávolította a `#tv-curtain`-t,
2. `visibility: visible`-re állította a `#root`-ot,
3. lecserélte a `<html>` osztályt (ezzel a body 4K-s hátterét is),
4. meghívta a `notifyAppLoaded()`-ot.

Ebben a pillanatban kellett a webOS Chrome 120-nek a **teljes 3840×2160-es
felületet** (videó, OSD, oldalsáv, 1,5 MB CSS) először kirajzolnia. Egy 1 GB
RAM-os TV-n ez 600 ms – és közben a takarókép már nem volt a képernyőn.

> Nem elrendezés-ugrás volt: a naplóban az induláskor **0** layout-shift
> szerepel. A jelenség a **hiányzó első festés**, nem az elemek elmozdulása.

---

## 2. A javítás: kétlépcsős megjelenítés

**1. lépcső – előfestés a takarókép alatt.**
A `main.tsx` amint látja, hogy a fejléc és a mappasáv a DOM-ban van, meghívja
az új `__IPTV_PREPARE_REVEAL__()` HTML-hidat. Az hozzáad egy
`iptv-prerender` osztályt:

```css
html.iptv-prerender #root { visibility: visible; }
```

A `#tv-curtain` (`z-index: 2147483000`, átlátszatlan, a logós indítóképpel)
**végig fent marad**, tehát a felhasználó semmit nem lát a változásból – a
böngésző viszont már a takarókép alatt, láthatatlanul elvégzi a drága
4K-s festést. A `offsetHeight` olvasás szinkron elrendezést kényszerít, a
`afterPaint()` két képkockája pedig már a **valódi** fát festi és méri.

**2. lépcső – egyetlen kompozitor-váltás.**
A `REVEAL` ekkor már csak a takaróképet emeli le és a natív indítóképet
zárja be. Nincs újabb raszterizálás, nincs üres képkocka.

**Biztonsági háló:** ha a `main.tsx` valamiért nem hívná meg az előfestést,
a `__IPTV_REVEAL__` maga is meghívja (idempotens), így a `#root` soha nem
marad rejtve. A 9 mp-es és a 12 mp-es biztonsági időzítők változatlanok.

A naplóban most egy új korai jelzés is lesz:

```
ELŐFESTÉS – a főoldal a takarókép alatt kifestve
```

### További gyorsítás: nincs kétszeres tár-próba

A `inspectStoredCatalogs()` belülről meghívta a `describeStoredContent()`-ot,
majd az `App.tsx` boot-effektje – mivel üres telepítésnél a plan `null` –
**még egyszer** ugyanazt a jelentést kérte. Ez 3 felesleges IndexedDB
metaadat-olvasás és egy újabb localStorage-bejárás volt közvetlenül az első
festés előtt. Az új `lastStoredContentReport()` a felmérés friss eredményét adja
át az Appnak; a tároló-felmérés minden híváskor újra számol, ezért import után
sem marad elavult adat. A többi hívó (tesztek, kézi frissítés) változatlanul a
saját `describeStoredContent()`-ját kapja.

A napló TÁROLÓ és MÉDIA sorai, a környezet-, tároló-, erőforrás- és
képkocka-mérések mind megmaradtak – a diagnosztika továbbra is ugyanolyan
részletes, csak nem a látható első festéssel versenyez.

---

## 3. Az utolsó 5 elküldött napló – nagy, nem kilógó feliratok

A `DiagnosticShareModal` korábban mindkét feliratot `text-sm` (14 px) méretben,
egy alacsony sorban mutatta. Most minden rekord **saját, legalább 72 px magas
dobozt** kap:

* **„Napló #N”** – `text-3xl` / nagy képernyőn `text-[34px]`, `font-black`,
  `leading-none`, `tabular-nums`, `whitespace-nowrap`;
* **időbélyeg** (`ÉÉÉÉ-HH-NN ÓÓ:PP:MM`) – `text-xl` / `text-2xl`,
  `font-mono font-bold`, `leading-none`, `tabular-nums`, nagyobb óra ikon;
* a szakasz címe és a „Még nincs elküldött napló.” sor is `text-base` lett.

**Kilógás ellen:** a sor `flex-wrap` + `min-h-[72px]` + `overflow-hidden`, a
dátum `min-w-0 max-w-full`, a szöveg `break-words`, az ikon `shrink-0`. Ha a
képernyő keskenyebb, a dátum a saját sorába tördelődik (a doboz nő), nem vágódik
le és nem lóg ki. A `leading-none` miatt a betűk pontosan a saját sorukban
ülnek, nem érnek a doboz széléhez. A `title` attribútum a teljes időpontot is
mutatja.

---

## 4. Tesztek és ellenőrzés

* **`tools/test-smooth-reveal.mjs` – 8 új ellenőrzés** (jsdom, a valódi
  `index.html`-lel):
  * előfestéskor a `#root` már `visible`, de a takarókép **fent marad** és a
    `notifyAppLoaded()` **nem** fut le;
  * az előfestés idempotens, és bekerül az indulási jelek közé;
  * a REVEAL egyetlen váltással dolgozik: takarókép le, `#root` látható,
    indítókép le, `iptv-prerender` megmarad;
  * ha az előfestés kimarad, a REVEAL akkor is pótolja;
  * a `main.tsx` a DOM-kész pillanatában, a két animációs kép **előtt** fest;
  * nincs több dupla `describeStoredContent()` a boot alatt, és a felmérés
    import után sem ad vissza elavult jelentést;
  * a két felirat mérete, sormagassága és sortörés-biztossága.
* **`tools/test-empty-boot.mjs`** kiegészült egy viselkedési teszttel, amely a
  `main.tsx` valódi kódját futtatva ellenőrzi, hogy az előfestés a takarókép
  alatt, a REVEAL **előtt** megtörténik (11/11 zöld).
* A verzió-ellenőrzések most **dinamikusak**: a `WEB_VERSION` és az
  `appinfo.json` egyezését nézik, így egy kézi verzióugrás (2.5.129 → 2.5.130
  → 2.5.131) többé nem töri össze a tesztkészletet.
* A `tools/test-loading-diagnostic.mjs` időnként elbukott a párhuzamos
  futtatásnál (a React effect 30 ms-on belül nem ért véget): a fix `tick()`
  helyett rövid, 2 mp-es poll várja meg a feltételt – így a teljes `npm test`
  stabilan zöld.
* `npx --prefix web tsc --noEmit -p web/tsconfig.json` – tiszta.
* `npm test` – a teljes készlet zöld, benne a csomagolt IPK-val futó
  `test-applog-runtime` is.
* Vite build → ES5 transzpilálás → `tools/build-webos.sh` → 2.5.131 IPK,
  `npm run smoke` OK.
* A becsomagolt `index.html` üres indulásának mérése jsdom-ban: az
  `ELŐFESTÉS` jelzés a REVEAL **előtt** jelenik meg, és a REVEAL oka továbbra
  is `üres alkalmazás – kész felület` (nem `időtúllépés`).

---

## 5. Érintett fájlok

`web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`,
`web/src/services/contentStore.ts`,
`web/src/components/DiagnosticShareModal.tsx`,
`web/src/appVersion.ts`, `webos/appinfo.json`,
`tools/test-smooth-reveal.mjs`, `tools/test-empty-boot.mjs`,
`tools/test-requirements.mjs`, `package.json`,
`STARTUP-FLASH-FIX-2026-10-26.md`.

**Következő lépés:** a `main` ágról épített 2.5.131-es IPK-t üresen elindítani.
A következő naplóban az `ELŐFESTÉS` jelzésnek a `REVEAL` **előtt** kell lennie,
a `LEGNAGYOBB TARTALOM` időpontjának pedig közelítenie kell a REVEAL-hoz
(a 2.5.130-as +2770 / +3602 ms helyett). Ha még mindig van egy 500–600 ms-os
képkocka-kihagyás a REVEAL UTÁN, akkor a webOS `notifyAppLoaded()` platform-
hívása vagy a body hátterének cseréje okozza – arra a következő körben megyünk
rá.
