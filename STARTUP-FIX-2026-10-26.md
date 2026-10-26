# Üres IPK gyors, sima indulása – 2.5.129

**Napló:** Supabase `tv_diagnostic_shares`, `log_number = 1`,
`id = fb37f46a-7bc5-49f8-be16-f15e14976861`,
`created_at = 2026-10-26 21:31:49`, 67 sor, verzió `2.5.128`.

A felhasználó jelezte: az IPK-t **üresen** telepítette (0 szolgáltató, 0
csatorna, semmit nem töltött fel), és már az indításkor „beugrált valami”, a
start nem volt sima és lassú is volt.

---

## A napló idővonala (2.5.128)

| Idő | Esemény |
| --- | --- |
| +975 ms | a csomagolt `index.html` válasza (1 553 727 B) |
| +1088 ms | first-paint / first-contentful-paint |
| +1430 ms | az automatikus `BOOT-DIAG` diagnosztika elindul |
| +1751…1753 ms | **fejléc, lejátszó, OSD, oldalsáv, mappasáv, csatornalista már a DOM-ban** |
| +1761 / +2097 / +2182 / +2284 ms | 167 / 350 / 200 / 183 ms-os képkocka-kihagyások |
| +1917 ms | `ELEM MEGJELENT: DIAGNOSZTIKAI DOBOZ` (a `webos.js` rejtett, 6 elemű doboza) |
| +2110 ms | `KÉPERNYŐ: takarókép=fent`, videó `kész=0, áll` |
| +2184 ms | tartós tár: 0 élő / 0 film / 0 sorozat |
| +2287 ms | `nincs használható mentett lista – automatikus első betöltés indul` (pedig nincs szolgáltató) |
| **+9257 ms** | `INDULÁS: főoldal kész és kirajzolva` |
| **+10563 ms** | `REVEAL – … (időtúllépés)` |
| +10668 ms | `LEGNAGYOBB TARTALOM: 11564 ms`, elem = `<p class=text-xs.mt-1.text-slate-500>` (az üres állapot szövege) |
| +13417 ms | a felhasználó kézzel megnyitja a napló ablakot (nem az indulás oka) |

**Következtetés:** a kész, üres felület már 1,75 mp-nél készen volt, de a
takarókép 9,3 mp-ig fent maradt, és egyetlen hirtelen „időtúllépés” váltással
ugrott elő. Ez a látható lassúság és ugrálás.

### Miért várt 9 mp-ig?

A `web/src/main.tsx` megjelenítési feltétele legalább **3 csatornasor** vagy
egy ablak volt, és ezen felül az **első videókocka** (`__IPTV_VIDEO_READY__`).
Üres alkalmazásban:

* nincs egyetlen csatornasor sem → `listReady()` sosem lett igaz,
* nincs stream → a videó `readyState = 0`, az első képkocka **soha nem jön el**,
* a `FRAME_GAP_LIMIT_MS = 240` őr a 167–350 ms-os indulási akadások miatt
  újra és újra elhalasztotta a megjelenést,
* így csak a 9000 ms-es kemény korlát engedte le a takaróképet.

A diagnosztika közben a fő szálat is terhelte: szinkron localStorage-próba és
`<video>` képességmérés, mutációnkénti teljes részfa-bejárás, 250 ms-os
képernyő-mintavétel, plusz a `webos.js` által az első festéskor létrehozott
rejtett diagnosztikai doboz (6 DOM-elem) és a négyszeri fókusz-próba.

---

## A javítás

### 1. Az üres állapot a **kész** állapot

* `web/src/App.tsx` – a modul betöltésekor, még a React render **előtt**
  `<html data-iptv-boot="checking">`, a tároló-felmérés után `empty` vagy
  `content`. Hiba/elakadás esetén a `finally` is dönt.
* `web/src/components/ChannelList.tsx` – az üres állapot `data-boot-empty`
  DOM-jelet kap, és statikusan szebb kártyát (ikon, nagyobb cím) mutat.
* `web/src/main.tsx` – `emptyBoot()` esetén a megjelenítés **nem vár** sorra,
  logóra vagy videókockára: `revealWhenPainted("üres alkalmazás – kész felület")`.

### 2. Nincs több végtelen halogatás

* `MAX_FRAME_GAP_RETRIES = 2` – a képkocka-őr legfeljebb kétszer halaszt.
* `revealPending` + `revealWhenPainted()` – **egyetlen** megjelenítési lánc,
  nincs több párhuzamos `requestAnimationFrame`-várakozás (ez volt az ugrálás).
* 3,5 mp-es gyors biztonsági háló, ha a tároló-felmérés nem döntene. A 9 mp-es
  kemény korlát megmarad végső hálónak, de normál indulásnál nem sül el.
* Az `index.html` 12 mp-es hálója változatlan: továbbra is az alkalmazás dönt.

### 3. Nincs hálózati letöltés üres IPK-nál

Ha nincs szolgáltató és nincs mentett lista, az App **nem** indít automatikus
első betöltést (`setLiveRecoveryNeeded(false)`), és a napló egyértelműen ezt
írja: `Indulás: üres alkalmazás – nincs szolgáltató, nincs mentett lista…`.
0 csatorna marad, amíg a felhasználó listát nem ad hozzá.

### 4. A diagnosztika nem lassítja az első festést

* A `TÁROLÓ` (szinkron localStorage írás/olvasás) és a `MÉDIA` (`<video>`
  létrehozás + 5 `canPlayType`) sorok a **következő feladatban** íródnak
  (`scheduleSlowStartupProbes`), de a napló tartalma változatlan – a napló
  gyors lezárásakor a `stopStartupDiagnostics()` még kiírja őket.
* A `MutationObserver` a React által egy feladatban beszúrt elemeket
  **kötegelten**, 40-es adagokban dolgozza fel (`MAX_PENDING`).
* A képernyő-mintavétel 250 ms helyett 500 ms az első 15 mp-ben.
* `webos/webos.js`: a felület-őr (`diagUiCheck`) **nem hozza létre** a rejtett
  diagnosztikai dobozt induláskor; az csak gombnyomásra vagy valódi, 15 mp
  utáni hiba esetén épül fel. Az üres IPK-n a fókusz-próba sem ismétli meg
  négyszer a DOM-bejárást.

---

## Tesztek

* `tools/test-empty-boot.mjs` – **10 új ellenőrzés**, köztük 4 viselkedési
  teszt, amely a `main.tsx` **valódi** megjelenítési blokkját futtatja jsdom-ban
  (ESBuild TypeScript-transzformációval, hamis órával):
  * üres IPK videó és csatornasorok nélkül is azonnal megjelenik,
  * `data-iptv-boot="empty"` esetén a 9 mp-es „időtúllépés” **nem** sül el,
  * `checking` esetén a 3,5 mp-es gyors háló lép életbe,
  * `content` jelzésnél megmarad a kész-listára váró viselkedés,
  * a képkocka-őr legfeljebb kétszer halaszt.
* `npx --prefix web tsc --noEmit -p web/tsconfig.json` – tiszta.
* `npm test` – **194 / 194** ellenőrzés zöld (a csomagolt IPK-val futtatott
  `test-applog-runtime` is, amely ellenőrzi, hogy a `MÉDIA`, `TÁROLÓ`,
  `KÉPERNYŐ`, `HTML JELZÉS` sorok megmaradtak).
* `npm run smoke` – a becsomagolt `build/webos/index.html` felépíti a főoldalt.
* Vite build → ES5 transzpilálás → `bash tools/build-webos.sh` → 2.5.129 IPK.

### Mért eredmény a becsomagolt index.html-en (jsdom, üres tár)

```
bootState   = empty
channels    = 0
diag box    = false            (nincs rejtett diagnosztikai doboz)
revealed    = true
reveal mark = +315 ms  REVEAL – a kész felület megjelent (üres alkalmazás – kész felület)
```

A 2.5.128-as TV-napló **9257 ms**-es `főoldal kész` / **10 563 ms**-es
`REVEAL (időtúllépés)` / **11 564 ms**-es LCP értékei helyett az üres felület
már az első festéskor, egyetlen váltással jelenik meg, miközben a napló
továbbra is tartalmazza a környezet, a média, a tároló, a képernyő és az
elemesemények sorait.

> Megjegyzés: a jsdom 315 ms-e egy asztali környezet mérése; a webOS TV
> motorján a mért 1,75 mp-es DOM-kész idő körül várható a megjelenés. A lényeg,
> hogy a 9 mp-es időtúllépési út üres induláskor nem sül el.

---

## Érintett fájlok

`web/src/main.tsx`, `web/src/App.tsx`,
`web/src/components/ChannelList.tsx`,
`web/src/services/startupDiagnostics.ts`,
`web/src/appVersion.ts`, `webos/webos.js`, `webos/appinfo.json`,
`tools/test-empty-boot.mjs`, `tools/test-requirements.mjs`, `package.json`,
`STARTUP-FIX-2026-10-26.md`.
