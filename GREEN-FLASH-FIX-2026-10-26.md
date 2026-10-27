# Zöld háttér-villanás és a visszaeső sebesség – 2.5.133

**Napló:** Supabase `tv_diagnostic_shares`, `log_number = 2`,
`id = 8b872026-71e2-4edd-b73f-c66c364ce3bb`,
`created_at = 2026-10-26 23:25:43`, 72 sor, verzió **2.5.132**, üres IPK.

Jelzés: *„induláskor felvillanás, zöld háttér felvillanás, még lassabb volt,
mint az előbbi indulás!”*

---

## 1. A két napló összehasonlítása

| Mérés | #1 (22:32:49, 2.5.130) | #2 (23:25:43, 2.5.132) |
| --- | --- | --- |
| `válasz` (HTML) | 748 ms | **246 ms** |
| `first-paint` / FCP | 1029 ms | **444 ms** |
| `bundle betöltve` | +1796 ms | **+302 ms** |
| Teljes DOM (fejléc, lejátszó, OSD, listák) | +2424 ms | **+475 ms** |
| `ELŐFESTÉS` | – | **+546 ms** |
| `load` | +2537 ms | **+565 ms** |
| `üres alkalmazás` döntés | +2705 ms | **+639 ms** |
| `REVEAL` | +2770 ms | **+933 ms** |
| `LEGNAGYOBB TARTALOM` | 3602 ms | **986 ms** |

**A mérések szerint az indulás ~3× gyorsabb lett.** A felhasználó mégis
lassabbnak érezte – ennek két, a naplóból kiolvasható oka van: a **zöld
felvillanás** és a **REVEAL előtti felesleges várakozás**.

---

## 2. Mi volt a zöld felvillanás?

A `web/index.html` fejlécében futó injektor eddig két réteget tett a
`#tv-curtain`-re (és a boot alatti body-ra):

```css
background-image: url(data:image/jpeg;base64,…1280×720 JPEG…),
                  linear-gradient(135deg,#5fe3b6 0%,#4fd8e0 45%,#63bdf3 100%);
background-color: #6ccbd3;
```

**A CSS háttérkép dekódolása NEM tartja vissza az első festést.** A 2.5.132-ben
az első festés 444 ms-nál történt (korábban 1029 ms-nál), a beégetett
1280×720-es, **progresszív** JPEG viszont csak később lett kész. Addig a
második réteg – a világoszöld `#5fe3b6 → #4fd8e0 → #63bdf3` színátmenet –
látszott. Ez a „zöld háttér felvillanás”. A gyorsabb indulás **hozta elő** a
hibát: korábban az 1029 ms alatt a kép már dekódolódott.

A progresszív JPEG ráadásul egy részlegesen dekódolt, kockás köztes képet is
kifesthet, ami szintén ugrálásnak látszik.

### A javítás

1. **Azonnal dekódolható kicsinyített kép.** A build a `splash-bg.jpg`-ből egy
   48×27 pixeles, optimalizált **PNG**-t készít (~2 kB), és beégeti a HTML-be
   (`__IPTV_SPLASH_TINY_URI__`). Ez a második CSS-réteg a zöld színátmenet
   helyett. Egy 48×27-es PNG dekódolása <1 ms, tehát **az első festés már a
   VALÓDI indítóképet mutatja** (csak homályosan). Amikor a teljes JPEG
   megérkezik, az éles kép kerül fölé – egyetlen, alig észrevehető váltás.
   *PNG szándékosan:* a csomagban pontosan egy `data:image/jpeg` lehet
   (lásd `tools/test-package-html.mjs`), az ikonok is PNG-k.

2. **A teljes kép dekódolása már a `<head>`-ben elindul.** Egy rejtett
   `new Image()` + `decode()` több száz ms előnyt ad a CSS-háttérrel szemben.

3. **Baseline (nem progresszív) JPEG.** A kép beégetett data URI, így a
   progresszív „fokozatos” betöltésnek nincs hálózati előnye, viszont
   részleges, kockás köztes képet festhet. A baseline JPEG vagy teljesen kész,
   vagy egyáltalán nincs – ilyenkor a kicsinyített réteg látszik.

4. **A statikus zöld színátmenet eltűnt.** A `html.iptv-booting body` és a
   `#tv-curtain` alaptartaléka most `background-image: none` + a kép mért
   átlagszíne (`#6ccbd3`), ami megegyezik az `appinfo.json` `bgColor`-jával.

---

## 3. Miért érződött lassabbnak?

A napló szerint az üres döntés **+639 ms**-nál készült el, de a REVEAL csak
**+933 ms**-nál történt – **294 ms felesleges várakozás**:

```
+546  ELŐFESTÉS – a főoldal a takarókép alatt kifestve
+548  KÉPKOCKA-KIHAGYÁS: 167 ms
+639  Indulás: üres alkalmazás…     ← döntés kész
+670  KÉPKOCKA-KIHAGYÁS: 183 ms
+908  KÉPKOCKA-KIHAGYÁS: 217 ms
+933  REVEAL
```

A 2.5.131-es kétlépcsős megjelenítés az előfestést a takarókép alatt
elvégezte, **de a `revealWhenPainted()` utána még két ÚJABB
`requestAnimationFrame`-et várt**. A három képkocka-kihagyás (167/183/217 ms)
miatt ez a két rAF 294 ms-ig tartott. Közben a `load` esemény már +565 ms-nál
megtörtént, vagyis a webOS natív indítóképe korán lekerülhetett, és a DOM
takarókép (a zöld tartalékkal) **~370 ms-ig** látszott – innen a „lassabb”
érzés.

### A javítás

- A `__IPTV_PREPARE_REVEAL__()` most **saját maga** méri a két animációs
  képkockát, és beállítja a `__IPTV_PREPAINT_SETTLED__` jelzőt
  (új naplójel: `ELŐFESTÉS KÉSZ – két képkocka a takarókép alatt`).
- A `main.tsx` `revealWhenPainted()` – ha a jelző igaz – **azonnal** megjelenít,
  nem vár újabb két rAF-et. Ha nem igaz (nagyon korai döntés), a régi
  `afterPaint()` kétképkockás, képkocka-őrrel védett út marad tartaléknak.
- A megjelenítési döntés pollolása 60 ms → **40 ms**.

Várt eredmény a következő TV-naplóban: az `üres alkalmazás` döntés és a
`REVEAL` között **néhány tíz ms** lesz a 294 ms helyett, és a `load` →
`REVEAL` ablak is ~100 ms alá csökken.

---

## 4. Nyitott kérdés – erre a következő mérés után válaszolok

A felhasználó felvetette, hogy a kezdő főoldalra **előre, fixen** be lehetne
rajzolni az OSD és a kis nézet csatornáinak helyét 16:9-ben, és amikor a
csatornák betöltődnek, csak az adatok kerülnének a már kijelölt helyekre. Így a
teljes képernyő ↔ kis nézet váltás is gyorsabb lehetne, mert nem kellene újra
rajzolni a keretet.

**A kérdésre szándékosan nem adok most választ**: a felhasználó kérte, hogy
előbb jöjjön a következő mérés, és utána döntsünk. Az ötletet rögzítettem itt,
hogy a következő napló (a fenti zöldháttér- és időzítés-javításokkal) alapján
tudjuk megítélni.

---

## 5. Tesztek és ellenőrzés

- `tools/test-smooth-reveal.mjs` **13 ellenőrzés** (5 új a zöld villanásra és
  az előfestés-kész jelzőre): nincs zöld színátmenet, a kicsinyített kép
  jelölője pontosan egyszer szerepel, a korai `Image.decode()` bent van a
  `<head>`-ben, a build PNG-ként és csak az első előfordulást cseréli,
  baseline JPEG, valamint a két képkockát a HTML-híd méri.
- A `tools/test-package-html.mjs` meglévő ellenőrzései (egy beégetett JPEG,
  egy jelölő, `#6ccbd3` alapszín, `<head>`-injektálás) változatlanul érvényesek.
- `npx --prefix web tsc --noEmit -p web/tsconfig.json` – tiszta.
- `npm test` – teljes készlet zöld.
- Vite build → ES5 → `tools/build-webos.sh` → **2.5.133 IPK**, `npm run smoke`.
- A becsomagolt `index.html` jsdom-mérése: 0 csatorna, nincs zöld tartalék,
  az `ELŐFESTÉS KÉSZ` jelzés a `REVEAL` előtt van, és a REVEAL oka továbbra is
  `üres alkalmazás – kész felület` (nem `időtúllépés`).

## 6. Érintett fájlok

`web/index.html`, `web/src/main.tsx`, `web/src/appVersion.ts`,
`tools/build-webos.sh`, `tools/test-smooth-reveal.mjs`,
`webos/appinfo.json`, `GREEN-FLASH-FIX-2026-10-26.md`.
