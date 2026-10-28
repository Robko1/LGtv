# IPTV R.T – verziózott tesztnapló és referencia

Ez a fájl a jövőbeli összehasonlítások közös helye. A **védett működési alap 2.5.176**: a natív indítókép utáni közvetlen főoldal, a jelenlegi képmegjelenítés és a működő EPG. Ezek leírása és megőrzési szabálya: [README.md](README.md). A felhasználó ezt az állapotot sikeresnek jelezte; ez nem helyettesít egy számszerű TV-s mérést.

## Hogyan értelmezzük az adatokat?

- A **tesztelt verziót** a tényleges napló `verzió=` sorából vagy a kész IPK manifestjéből kell kiolvasni. Az a verzió, amelynek változáslistája egy korábbi hibát említ, nem feltétlenül azonos a tesztelt verzióval.
- A lent külön hivatkozott #39–#42 és #46 rekordok a Supabase `public.tv_diagnostic_shares` táblájából, 2026-10-28-án olvasott, még megőrzött naplók. A szerver csak az öt legutóbb beérkezett naplót tartja meg; később egy rekord már nem feltétlenül lesz visszakereshető. A teljes naplókat, stream-URL-t, hitelesítési adatokat és QR-tokeneket ne másoljuk ebbe a nyilvános fájlba.
- A készülék neve és webOS-verziója a #42 és #46 naplóban **„nem derül ki”**; a napló Chromium `120.0.6099.270` user agentet jelez. A hiányzó TV-modellt nem szabad megtippelni.
- A táblabeli `created_at` az adatbázis UTC-időbélyege. A régi kliens a naplósorok óráját egy órával korrigálta, ezért a régi sorok abszolút időpontját nem szabad ellenőrzés nélkül összehasonlítani az adatbázis idejével. Az alábbi, események közötti relatív idők ettől függetlenek.
- A régi teljes képernyős mérés `requestAnimationFrame`-hez kötött alkalmazásoldali időt rögzített, **nem** a fizikai gomb lenyomását vagy a TV-panel tényleges festését. A 2.5.177 célzott mérésben második rAF szerepel; ezért az eltérő mérési végpontokat nem szabad változatlanul összehasonlítani. A `playing` sem bizonyítja a látható első videóképet.
- Az egyes minták nem általános teljesítménygaranciák: a stream, a szolgáltató, a gyorsítótár, a háttérmunka, a készülék és a hálózat befolyásolja őket.

## Megőrzött történeti mérések

### 2.5.168 – régi TV-naplók #39–#42

Forrás: Supabase naplók, `verzió=2.5.168`. A táblázat a régi `FELFEDÉS` sorban szereplő belső időt mutatja; ez **nem** a 2.5.176 natív indítókép elengedésének újramérése.

| Napló | `FELFEDÉS` | Teljes képernyő BE – mért minták | Főoldalra KI – mért minták |
| --- | ---: | --- | --- |
| #39 | 2489 ms | 13,0; 30,9; 54,4; 6,6 ms | 158,5; 143,3; 177,5; 151,6 ms |
| #40 | 2086 ms | 15,9; 8,7; 8,4; 51,2 ms | 149,1; 143,4; 174,3; 170,1 ms |
| #41 | 2233 ms | 15,4; 14,2; 7,7; 14,7 ms | 144,3; 158,6; 155,6; 175,1 ms |
| #42 | 2102 ms | 13,2; 8,4; 8,0; 10,1 ms | 212,0; 160,4; 169,6; 145,9 ms |

A felsorolások a naplón belüli időrendet követik. A #42 utolsó KI-mintája **VISSZA** gombbal történt, a többi felsorolt KI-minta OK-val. A #42 naplóban az első formátumpróbával sikeres MPEG-TS csatornaváltási összesítések között például **1256 ms**, **1480 ms**, **1601 ms** és **2419 ms** szerepel. Ezek a régi összesítések a forrásbetöltéstől a `playing` eseményig mérnek, nem feltétlenül a gombtól a fizikai képkockáig.

### 2.5.170 – TV-napló #46

Forrás: Supabase #46, `verzió=2.5.170`, `created_at=2026-10-28 17:07:05.283636+00`.

| Mérőszám | Naplóban szereplő érték | Határ / megjegyzés |
| --- | --- | --- |
| Régi `FELFEDÉS` | 1730 ms | Alkalmazáson belüli korábbi jelzés, nem bizonyított panel-festési idő. |
| Teljes képernyő BE | 18,7; 18,2; 20,5; 19,8 ms | Négy felsorolt OK-minta a régi mérési módszerrel. |
| Főoldalra KI | 271,4; 176,0; 169,5; 199,6 ms | A négy fenti BE után mért OK-s kilépés; az első 271,4 ms-nál a leghosszabb naplózott lépésköz 249,3 ms. |
| Csatorna, egy MPEG-TS próbával | 3125; 1674; 1809 ms | Három naplózott, sikeres `playing`-összesítés; nem a panel első képe. |
| XMLTV | 84,0 s; 55 621 KB; 2665 csatorna; 33 685 megtartott műsor | A napló 180 742 feldolgozott blokkot, 126 347 időablakon kívülit, 690 érvénytelen időpontút, 0 cím nélkülit és 9911 korlát miatt kihagyottat közöl. |

### A forrásban megőrzött régebbi hibajelenségek

Ezek az `e994abb7` commit `web/src/appVersion.ts` változáslistájának állításai. A hozzájuk tartozó nyers naplók nincsenek a jelenleg megőrzött öt rekord között, ezért itt nem állítunk többet, mint amit a forrás leír.

| A megállapítást rögzítő változat | Hivatkozott történeti adat | Értelmezés |
| --- | --- | --- |
| 2.5.164 | #18: a régi levételi jelzés +327 ms; first-paint 815 ms; FCP 1081 ms | Régi indítási probléma és különböző mérési pontok, nem a jelenlegi natív splash mérése. |
| 2.5.166 | #20–#21: a 102 871 filmes teljes visszatöltés 32–35 s | Történeti, a lista üres megjelenéséhez kapcsolódó mérés; a pontos tesztelt buildet a változáslista nem azonosítja. |
| 2.5.166 | 23 069 ms-os csatornaváltás és egy 100 ms-ra tervezett, 16 s-et késő újrapróba | A változáslista a háttér-listafrissítést és főszál-terhelést írja le; nem mai referenciaidő. |
| 2.5.176 | #38–#42: a rövid EPG-válasz 19 bájt; egy teljes XMLTV-feldolgozásban 203 140 blokkból 103 műsor maradt 96 csatornához | A konkrét szolgáltatóról szóló régi megállapítás, nem minden szolgáltató jellemzője. |

### 2.5.176 – elfogadott működési alap

- **Indítás:** a felhasználó a natív takarókép és a közvetlen főoldal működését sikeresnek nevezte. Az `e994abb7` forrás `notifyAppLoaded()`-et a React gyökér első DOM-eleme után hívja; a külön HTML-takaró/haladási sáv hiányzik.
- **Kép:** a felhasználó a kép megjelenítését sikeresnek nevezte. A tényleges `cover`/`fill` CSS-értékeket a fő README rögzíti; nincs a megőrzött naplókban ehhez az elfogadott 2.5.176-os teszthez rendelt, ellenőrzött számszerű képminőségi eredmény.
- **EPG:** a felhasználó működőnek nevezte; nincs a megőrzött öt rekord között `verzió=2.5.176` TV-napló. A korábbi 2.5.168/2.5.170 mérési számokat ezért nem írjuk át 2.5.176-os eredményként.
- **Indítási idő, csatornaváltási idő, film- és epizódindítás, eszköz pontos típusa:** a rendelkezésre álló 2.5.176-os TV-s mérés **nem ismert**. Új adatokkal kell kiegészíteni, nem becsléssel.

### 2.5.177 – helyi sebességnapló-változat, TV-teszt előtt

- A munkafában a `WEB_VERSION` 2.5.177. A napló manuális indítású, a külön indulási és képminőség-mintavétel nem fut; a képmegjelenítés referencia-szabályai ettől külön értelmezendők.
- 2026-10-28-án a helyi `npm test` és a TypeScript-ellenőrzés, valamint a Vite webes build sikeresen lefutott. A tesztfutás legalább egy ffmpeg-függő esetet, a hiányzó Android-hidat és a kész webOS buildet igénylő napló-runtime tesztet kihagyta; ez nem teljes TV-s igazolás. A célzott sebességnapló és a valódi React lejátszó jsdom-tesztje lefutott.
- A helyi IPK-build az ellenőrzéskor a meglévő splash-kép méreténél megállt. A TV-n telepített 2.5.177-es IPK-ról és az új naplóról **nincs még mérési eredmény**. A kézi GitHub build patchverziót emelhet: a későbbi eredményt a tényleges csomagverzióhoz kell rögzíteni.

### 2.5.178 – TV-napló #71, a jelen javítás előtti mérés

Forrás: Supabase #71, `verzió=2.5.178`, `created_at=2026-10-28 21:30:23.527557+00`. A napló relatív idői, nem új javítás utáni eredmények:

- Az első három teljes képernyőre váltás a második rAF-ig **298,5 / 266,0 / 338,9 ms**, az első három visszatérés **195,1 / 165,0 / 263,1 ms**. A React commit az érintett mintákban néhány–16 ms; a hosszú feladatok pontos oka a naplóból nem azonosítható. A második rAF renderelési lehetőség, nem a panel bizonyított festése.
- A tíz sikeres csatornaváltási összesítés a forráspróbától `playing`-ig **1282–2948 ms**, átlaguk **1889 ms**; mindegyik egy próbával sikerült. Az első két célzott mintában a kiválasztástól `src`-ig kb. 45–50 ms, `playing`-ig kb. 1774 / 1946 ms; a `loadstart` és `loadedmetadata` között kb. 1421 / 1613 ms telt el. A hálózat, szolgáltató és TV-médiamotor részesedése nem választható szét a naplóból, és a `playing` nem bizonyítja a panelen megjelent képet. A két másodperces őr két lassabb sikeres mintában már látott metaadatot/puffert és türelmi időt adott; ebből nem következik téves fallback.
- Az ezután készített, még TV-n nem mért javítás élő teljes képernyő alatt fenntartja a lejátszó és OSD helyét; kiszűri a gyors oda-vissza váltás elavult képkocka-callbackjeit; a csatorna-sorszám indexét lista/sorrend változáskor építi, nem minden csatornaváltásnál. Az indítókép, a videó `cover`/`fill` és a műsoradatok kezelése változatlan. A remélt TV-s gyorsulás, a pontos elrendezés és az EPG visszatérése új IPK-val, fizikai TV-n ellenőrizendő; az alkalmazás nem tud garantáltan gyorsítani a médiamotoron vagy a hálózaton.
- Helyben a TypeScript-ellenőrzés, a Vite build és az `npm test` sikeres; a valódi React/jsdom lejátszó gyors BE–KI–BE váltása, a visszatérés/fókusz védelme és a sorszámindex is tesztelve. A jsdom nem ellenőrzi a TV valós flex-elrendezését, GPU-ját vagy festési sebességét. Az ffmpeg-függő eset, a hiányzó Android-híd és a kész webOS buildet igénylő naplóteszt kimaradt. IPK-t a helyi webes build nem készít.

## Következő TV-s teszt – rögzítési minta

Új tesztnél másold ezt a blokkot, és csak ténylegesen ellenőrzött adatokat írj bele. A hiányzó érték: `nem ismert` vagy `nem mérhető`.

```text
Dátum és idő / időzóna:
Tesztelt IPK verzió és build/commit:
TV-modell, webOS, böngésző, ha ténylegesen ismert:
Naplószám / forrás:
Szolgáltató, streamformátum (jelszó és URL nélkül):
Hálózat és tesztkörülmények / előzmény:
Indítás: natív takarókép -> főoldal; mérési pontok és értékek:
Kép: élő előnézet / teljes képernyő / film / sorozat; referencia szerinti-e:
EPG: csatornalista / most-következő / EPG-ablak; referencia szerinti-e:
OK -> teljes képernyő: mérési módszer, egyes minták ms-ban:
OK -> főoldal: mérési módszer, egyes minták ms-ban:
Csatornaváltás: kiválasztás -> betöltés -> playing -> első kompozitor-képkocka, ha mérhető:
Film / epizód: kiválasztás -> playing -> első kompozitor-képkocka, ha mérhető:
Várakozás / hiba / újraindítás: esemény, időtartam, naplózott ok:
Összehasonlítás: melyik korábbi verzió, azonos mérési pont és körülmények:
Eredmény: sikeres / probléma / nem tesztelt; bizonyíték:
```

A tesztsorokat újabb verzió esetén hozzá kell adni, a régieket nem szabad az új eredménnyel felülírni. Az automatikus teszt eredményét és a felhasználó tényleges LG TV-s visszajelzését külön kell kezelni.

### 72-es napló – főoldali OSD visszatérés

A 2.5.179-es, #72 kézi naplóban az első három kilépésnél a lejátszó React-commitja az OK után 5,4–8,6 ms-nál szerepel; a második `requestAnimationFrame` 161,2–187,4 ms-nál, a főoldal állapotjelölésének effektje a napló időbélyegei szerint kb. 278–295 ms-nál jelent meg. Ezek külön események: nem mérik közvetlenül az OSD pozícióját vagy a TV paneljén látható festést, és a csúszás okát sem bizonyítják.

Az élő lejátszónak most állandó flex-helye van: teljes képernyő alatt sem cserélődik ideiglenes pszeudoelemre, az OSD pedig a teljes képernyős lejátszó mögött marad. Az élő lejátszó belső overlayének elrejtése többé nem ad `display:none` jelzést a főoldali OSD-nek. A fókuszkizárás, a VOD saját OSD-kezelése, a két képkockával késleltetett EPG-munka és a videó képmódja változatlan. A valódi böngészős geometriateszt `tools/test-osd-layout-browser.mjs`: web build után a `PLAYWRIGHT_MODULE` és `BROWSER_EXECUTABLE` környezeti változókkal futtatható; ezek nélkül kihagyja magát. A TV saját videósíkját és paneljének festését ez nem igazolja, fizikai TV-s ellenőrzés szükséges.

### 74-es napló – teljes képernyős OSD átvillanása

A 2.5.181-es #74 napló első három élő visszalépésénél a lejátszó commitja az OK után 3,6–6,5 ms, a főoldal állapotjelölésének effektje az időbélyegek alapján kb. 265–353 ms után szerepel. A felhasználó gyors visszatérést, de a teljes képernyős OSD és fekete árnyék pillanatnyi átvillanását jelezte. A napló a tényleges panel-festést vagy a villanást nem méri.

A teljes képernyős élő OSD most csak a lejátszó `iptv-tv-fullscreen` body-jelölése mellett látható; a jelölést a lejátszó kilépéskor festés előtt eltávolítja. Így a még le nem bontott OSD szövege és árnyéka sem jelenhet meg a főoldal fölött. A főoldal és EPG helyreállítása, a videókép, a távirányító és az időzítők változatlanok. A valódi lejátszóval és még mountolt fullscreen OSD-vel futó teszt az átmeneti állapotot és a gyors újra belépést is ellenőrzi; fizikai LG TV-s ellenőrzés továbbra is szükséges.
