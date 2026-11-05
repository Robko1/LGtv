export const WEB_VERSION = '2.5.322';

// A webOS kezelő (webos.js) innen olvassa a verziót a SÁRGA gombos
// kézi diagnosztikához - így az mindig a valóban futó kiadást mutatja.
try { (window as unknown as { IPTV_RT_WEB_VERSION?: string }).IPTV_RT_WEB_VERSION = WEB_VERSION; } catch { /* SSR/teszt környezetben nincs window */ }

// A build a legfrissebb bejegyzés verzióját is szinkronizálja. A régi történet a Gitben marad.
export const WEB_VERSION_HISTORY = [
  {
    version: '2.5.322',
    date: '2026-11-05',
    changes: [
      'TV DOKTOR BAL OLDAL FIXÁLT — NEM LAPOZHATÓ: a bal oldali „TV Doktor napló (kategóriák)” + 8 dobozos zöld panel mostantól teljesen rögzített, nem mozog lefelé sehová. A kompatibilis wrapper overflow-y-auto → overflow-hidden, aria „rögzített”, gap-3→2, zöld doboz flex-1 min-h-[360px] → flex-1 min-h-0 overflow-hidden. Már nincs 2 fókuszolható lapozás — a 4 kategória doboz (2×2) az egyetlen mozgás, a 8 útvonal nem görget.',
      'TV DOKTOR 8 DOBOZ VÉGIG LÁTSZIK — KIS MÉRET, DE OLVASHATÓ: a 8 doboz min-h 58/64px → 42/46px, padding px-4 py-3 → px-3 py-2, gap 2.5→1.5, írás text-base→sm/md:text-base/lg:text-[15px] + text-sm→xs/md:text-sm/lg:text-sm egymás mellett (flex-row). Így mind a 8 doboz egy képernyőn, levágás nélkül látszik (a 005123-as képen csak 6-ig ért a zöld vonal), nincs lapozás, mégis szép nagy és egységes.',
      'TV DOKTOR 8 DOBOZ HÁTTÉRSZÖVEG TÖRÖLVE ÉS ZÖLD DOBOZ VÉGIG LEÉR (2.5.320 folyt.): a „Tanulás (fent): …” háttérszöveg már kikerült, a zöld keret most már mind a 8 dobozt körbeveszi, nincs lógó vonal.',
    ],
  },
  {
    version: '2.5.320',
    date: '2026-11-05',
    changes: [
      'TV DOKTOR 8 DOBOZ JAVÍTÁSA — HÁTTÉRSZÖVEG TÖRÖLVE ÉS ZÖLD DOBOZ VÉGIG LEÉR: a Tanult útvonalak 8 doboza mögötti „Tanulás (fent): összes tanulás … (tartós) • Tanult útvnalak (lent): …” háttérszöveg teljesen kikerült (a 002254-es képen a dobozok mögött látszott és a zöld keret nem ért le). A zöld doboz most végig leér (flex-1 min-h-[360px], border-2, p-3.5 gap-2.5), a 8 doboz egységesen kitölti a szabad helyet.',
      'TV DOKTOR 8 DOBOZ ÍRÁS NAGYOBB ÉS EGYMÁS MELLETT: mind a 8 doboz (teli és üres) mostantól flex-row, egymás mellé rendezett, nagyobb és egységes — cím: text-base→xl:text-2xl (★ TS + balanced), részletek: text-xs→xl:text-xl (1482ms • 2 ok / 1 hiba • 1 akadás) — van elég hely jobbról-balról, nem kell görgetni, távolról is olvasható. Min-height 46/52px → 58/64px, gap 1.5→2.5.',
      'JOBB OLDAL ÖSSZÉBB — 3 SZÖVEG TÖRÖLVE (002421-es kép): „Jól működik minden – gyors csatornaváltás aktív.” + „Minden szám valós — a hosszú memóriából és a védett Supabase-ből frissül, nem minta (2.5.311)” zöld sor + „Optimális (1 MB keret) – bőséges szabad hely, nem lassítja a TV-t” legalsó sor mind kikerült. Így a jobb oldal összébb megy, nem kell lapozni, az infók egy képernyőn látszanak.',
    ],
  },
  {
    version: '2.5.319',
    date: '2026-11-04',
    changes: [
      'ORSZÁG % KÖR VÉGIG LÁTSZIK NAGYOBBAN: az Országok betöltő 3D kör mostantól 100%-nál sem tűnik el, hanem végig látszik a modal tetején. Átmérő 56px (w-14 md:w-16) → 80-96px (w-20 md:w-24), felirat 11px → 16-18px, ugyanott középen — a 100% utáni nagyobb kör jelzi a teljes 20 197-es lista beragadását, nem tűnik el.',
      'ORSZÁG KATTINTÁSNÁL UGRÁS A TETEJÉRE: ha egy országra kattint (pl. Magyarország 107) és kinyílnak az alkategóriák, az ország kártyája azonnal a lista tetejére ugrik (scrollTo 0 + ország beúszik), és csak utána nyílik le — a többi ország lefelé scroll marad, nem kell a 340-es lista közepén keresni a lenyílást.',
      'DIAGNOSZTIKA — FEHÉR X TÖRÖLVE: a Betöltési diagnosztika jobb felső fehér X gombja és 12×12-es kerete teljesen kikerült; az ablak csak a VISSZA gombbal (Esc/Backspace) vagy 10 mp után magától záródik — nincs fehér doboz a sötét fejlécben.',
      'ÉLŐ LISTA REBOOT VÉDELEM — FAST BOOT JAVÍTVA: a TV-napló #4 szerint reboot után az élő lista 106/20197-re esett vissza és a 41 adagos teljes mentést 1 adagos 106-os írta felül. Mostantól a dirty-mentés és a saveLiveContentAsync is csak TELJES élő listát (channels >= totals.live) ír az IndexedDB-be; részleges (boot) csak a kis localStorage HU+kedvenc készletet frissíti. Reboot után így csak HU+kedvenc van a képernyőn (FAST BOOT), a teljes 20 197 csak Ország megnyitásra tölt vissza (hálózat nélkül, IDB-ből).',
      'MOZI 2024→2026 SORRENDI REGRESSZIÓ JAVÍTVA: a Mozi első adag (500) eddig szolgáltatói sorrendben (régi elöl) mentődött, ezért 68%-nál 2024-et (L&Harper, Whispers) mutatott, míg 100%-nál 2026-ot — a Sorozat 39%-nál már 2026-ot mutatott, mert a sorozat lista már rendezett volt. Mostantól a Mozi és a Sorozat mentése is sortByReleaseYearDesc szerint rendezetten íródik az IDB-be, így az első 500 is a legfrissebb 2026-os filmeket adja, nem a régi 2024-et — a kép 3x reprodukált hibája végleg megszűnt.',
    ],
  },
  {
    version: '2.5.318',
    date: '2026-11-04',
    changes: [
      'ORSZÁGOK BETÖLTŐ % — KÖR A MODAL TETEJÉN: az Országok (Kategóriák) ablak tetején, ahol van hely, mostantól 3D kör mutatja a teljes élő lista visszatöltését (cián, 0-100% a helyi tárból). Csak az Ország menüre kattintva indul, előtte 0% — a kör mellett „ORSZÁGOK • X / Y csatorna • Betöltés… N%” sorok, a teljes lista számával (pl. 9 200 / 20 190). A teljes lista továbbra sem töltődik induláskor.',
      'MOZI POSZTEREK — UGYANÚGY MINT A SOROZATOKNÁL: a Mozi rács mostantól pontosan a Sorozatok logikáját követi visszatöltéskor — év szerint csökkenő, stabil sorrend (sortByReleaseYearDesc) közös, azonos PAGE_SIZE=25 / NEXT_BATCH_AT=15 lapozás és azonos helyi poszter-előtöltés (preloadPosterImage). A korábbi másodlagos streamId szerinti rendezés kikerült, ezért a mozi poszterek ugyanabban az ütemben, ugyanúgy jelennek meg mint a sorozatoké.',
      'MOZI/SOROZAT % DOBOZ — TÉNYLEG ÖSSZÉBB: a középre helyezett kék/sárga kör + darabszám doboz magassága most tényleg a kör átmérője (h-80 md:h-96), az outer fejléc paddingje p-3/p-4-ről px-3 py-1.5-re szűkült (gap 2.5→1.5), a belső gap és py is csökkent (gap-3→2, py-1→0.5). Így a kör teteje = doboz teteje, kör alja = doboz alja, nincs felesleges hely fent/lent — a korábbi doboz csak köré tett keret volt, a magasság ugyanannyi maradt.',
      'INDULÁS VILLÁMGORSÍTÁS — MÉRT OK: a boot eddig az IDB-s fav-keresést (loadLiveChannelsByIds, 17 adag végigolvasása) is megvárta a splash levétele előtt — ezért nem lett gyorsabb a FAST BOOT ellenére. Most a helyi HU készlet (localStorage) már a modulból a képernyőn van, a splash 54%-ra (restored) azonnal ugrik és a markLiveReady() még az inspectStoredCatalogs előtt lefut; a kedvencek pótlása háttérben (void then) történik, nem blokkolja a felfedést. Emiatt nincs mozi/sorozat/kategória betöltés induláskor — csak HU + később a kedvencek — és az első festés 1–2 mp-en belül megvan a korábbi 4–5 mp helyett.',
    ],
  },
  {
    version: '2.5.317',
    date: '2026-11-04',
    changes: [
      'MOZI — LEGFRISSEBB ELÖL (mint a Sorozatoknál): a Mozi nézet mostantól a legfrissebb filmeket mutatja elöl — év szerint csökkenő, azonos éven belül a nagyobb streamId (újabb a szolgáltatónál) előre, így a frissen felkerült filmek azonnal az első sorban látszanak (eddig az év nélküli filmek a végére kerültek).',
      'MOZI/SOROZAT % DOBOZ JAVÍTÁS — KÖZÉPEN A KATEGÓRIA MELLETT, DOBOZ A KÖR TETEJÉTŐL AZ ALJÁIG, SZÖVEG CSERE: a kék (Mozi) / sárga (Sorozat) 3D kör + darabszám mostantól NEM a jobb sarokban, hanem középen a Kategóriák gomb mellett van, egy közös dobozban (border + bg), a doboz magassága pontosan a kör magassága (h-20 md:h-24, a kör tetejétől az aljáig), a két szöveg felcserélve: középen „X betöltve” / „Betöltés…” , alul „Y a tárolóban” (eddig fordítva volt).',
      'ORSZÁGOK LUSTA TÖLTÉSE ELLENŐRIZVE — FAST BOOT MEGMARADT: induláskor továbbra is csak a magyar + kedvenc csatornák töltődnek (localStorage boot készlet + 1 IDB adag), a teljes élő lista, az EPG és a többi ország csak az Ország menü megnyitásakor töltődik — hálózat nélkül, a tartós tárból (pendingFullLivePlanRef / triggerFullLiveRestore). A kód a c1c0c81-es alapon is megvan, nincs lemaradt merge.',
      'TV DOKTOR — MŰKÖDŐ CSATORNA NEM LESZ „NEM ELÉRHETŐ”: a naplód (#2) szerint a Supabase kapcsolat él (connected 1129ms, 106 profil, 0 várólista, last_sync 2026-11-04), a legutóbbi futásban leállított_halott_csatorna=0 — a korábban működő csatornánál (M2 UHD) a javítási létra 3-5. lépésben a tanult útvnalat próbálja újra, és kimerüléskor csak 60 mp rövid hűtés (haltCount max 1) jár, nem 30 perc. Kiegészítve: ha van tanult útvonal, 5/5 után is újrapróbálja tanulttal (learned_route_retry_after_exhaustion) és nem jelöli halottnak.',
    ],
  },
  {
    version: '2.5.315',
    date: '2026-11-04',
    changes: [
      'TANULT ÚTVONALAK MAX 8 — FÜGGŐLEGES OSZLOP KÖZÉPRE IGAZÍTOTT NAGY ÍRÁSSAL: a TV Doktor 0-popup bal oldalán a Tanult útvonalak már nem 2 oszlopban (4+4) hanem FÜGGŐLEGESEN EGYMÁS ALATT jelenik meg — 8 doboz egy oszlopban, középre igazított nagy írással, a bal fél szabad részét egyenletesen kitöltve. Mindegyik doboz nagy, jól látható (format + bufferProfile középen, alatta 13–16px-es „X ms • Y ok / Z hiba” szintén középen), a legjobb (★) kiemelt emerald szegéllyel és fénnyel, az üres helyek szaggatott „— üres —” dobozzal — így nagy TV-n távolról is jól olvasható és a 8 elfér függőlegesen.',
    ],
  },
  {
    version: '2.5.312',
    date: '2026-11-04',
    changes: [
      'SUPABASE VISSZAOLVASÁS BEKÖTÉSE — IPK ÚJRAINDÍTÁS UTÁN IS A TÁROLT ADATOKBÓL DOLGOZIK: a Supabase-be feltöltött 8 tanult útvonal/csatorna (tv_doctor_routes_upsert/fetch) mostantól bizonyíthatóan visszatöltődik a TV-re és a TV Doktor abból dolgozik már az első csatornaváltáskor — nem indul újra a tanulás. A szerveroldali tv_doctor_routes_upsert mostantól INSERT-et is végez ha a csatorna profilja még nem létezett (eddig csak UPDATE), így frissen tanult csatornák IPK újraindításkor sem vesznek el; a kliens 1,2s után automatikusan lehúzza a központi memóriát és mergeCloudRoutesIntoLocal akkor is létrehozza a helyi rekordot ha az üres volt. Külön egységteszt tools/test-tv-doctor-supabase-roundtrip.mjs igazolja a teljes kört: helyi tanulás → Supabase payload → IPK üres → fetch → hasLearnedProfile=true (tanult gyorsprofil).',
      'TV DR KÉZI HIBA NAPLÓ (CSAK TV DOKTOR, NEM A NAGY NAPLÓ): a Supabase push/fetch és az induláskor létrejövő állapotkép mostantól a TV Doktor naplóba is ír (tvDoctorLog), nem csak a nagy naplóba — a SÁRGA gombbal indított kézi TV DR naplóban külön sorok látszanak: "TV DOKTOR FELHŐ ÚTVONAL: X csatorna mentve/letöltve", "TV DR FELHŐ MENTÉS/VISSZATÖLTÉS RÉSZLET: csatornakulcsok", és "TV DR SUPABASE VISSZAOLVASÁS BEKÖTVE: 1,2s után ..." — a felhasználó a sárga menüben csak a TV DR naplót indítva ellenőrizheti, hogy a Supabase-ről való visszaolvasás valóban megtörtént és a TV a tárolt adatokból dolgozik.',
    ],
  },
  {
    version: '2.5.311',
    date: '2026-11-04',
    changes: [
      'MOZI/SOROZAT 3D KÖR NAGYÍTÁS TV-RE: a Mozi (kék) és Sorozat (sárga) visszatöltő kör mostantól sokkal nagyobb (80–96px vs 56px), kitölti a fejléc dobozt; a középső % felirat 11px → 16–18px, a mellette lévő darabszámok 10–12px → 14–18px (FILMEK/SOROZATOK, a tárolóban, betöltve) — nagy TV-n távolról is jól olvasható, a doboz mérete változatlan.',
      'TV DOKTOR 0-POPUP FÓKUSZ ROBUSZTUSÍTÁS (fehér teljes bal oldal javítás): a 0 gombbal nyíló ablak fókusza mostantól MINDIG a bal felső Tanulás dobozon áll, többszöri próbálkozással (30ms + 50/150/250ms retry), a teljes bal oldal wrapper (data-tv-doctor-log-scroll) már nem fókuszálható (tabIndex -1, nincs amber gyűrű, outline:none) és a data-tv-default is a Tanulás dobozra került — a fehér kijelölés megszűnt, csak a kiválasztott doboz kap amber gyűrűt.',
      'TV DOKTOR ADATOK VALÓDISÁGÁNAK TISZTÁZÁSA: a jobb oldalon minden szám valós (Tanult profilok 57/1600, Központi profilok 106, TV Doktor memória 94KB — a hosszú memóriából/Supabase-ből frissül, nem minta); a bal oldalon a felső Tanulás doboz az összes tanulás (globális, pl. 3 db), az alsó Tanult útvonalak lista a kiválasztott csatorna 8 útvonala (pl. 2/8) — a kettő nem ugyanaz, de mindkettő a tárolt adatokból dolgozik, felirattal tisztázva.',
    ],
  },
  {
    version: '2.5.310',
    date: '2026-11-04',
    changes: [
      'TV DOKTOR 0-POPUP FÓKUSZ: a 0 gombbal nyíló TV Doktor ablak megnyitásakor a fókusz mostantól a bal felső Tanulás dobozon áll (nem a teljes bal oldal fehér/amber kijelölése); a bal oldali wrapper focus gyűrűje megszűnt, csak a kiválasztott kategória-doboz kap amber gyűrűt – a 2x2 rács (Tanulás | Segítség / Aktiválódás | Hiba) nyilakkal logikusan bejárható (le/fel a rácsban, jobbra/balra, Home/End, Esc) és a jobb felső Memória:0 közvetlenül elérhető.',
      'TV DOKTOR TANULT ÚTVONALAK SOHA NEM KEZDŐDNEK ÚJRA (IPK újraindítás után is): a csatornánkénti max.8 tanult útvnal (formátum+puffer) mostantól a hosszú memóriából (localStorage) azonnal, IPK újraindításkor is visszatöltődik és azonnal alkalmazásra kerül (már 1 igazolt indulástól, korábban 3 kellett); a HU felismerés kulcs-előtaggal és névvel is működik, hogy a korábban tanult profilok ne vesszenek el; a Supabase-ből való visszaállítás IPK újraindításkor akkor is létrehozza a hiányzó csatornareckordot a 8 útvnallal, ha a helyi tár üres volt (eddig csak meglévőre fésült), és a felhő-szinkron gyorsult (3,8s → 1,2s) – azért tároljuk a tanulásokat, hogy fel is használjuk!',
    ],
  },
  {
    version: '2.5.309',
    date: '2026-11-04',
    changes: [
      'MOZI/SOROZAT 3D KÖR FOLYAMATJELZŐ: a Mozi és Sorozat menü külön-külön, a megnyitáskor automatikusan a helyi tárból (IDB) kezdi a visszatöltést; a jobb oldalon már a betöltés előtt látszik a tárolóban lévő filmek/sorozatok pontos darabszáma; a darabszám-szöveg helyett modern, 3D hatású kör jelenik meg (filmeknél kék, sorozatoknál sárga), középen 0–100% felirattal; 100%-nál a teljes lista plusz a ténylegesen visszatöltött darabszám jelenik meg. Csak helyi tár, nincs új szolgáltatói letöltés, a két lista független.',
    ],
  },
  {
    version: '2.5.308',
    date: '2026-11-04',
    changes: [
      'FAST BOOT: IPK indításkor azonnal csak a mentett magyar induló csatornák és a kedvenc mappákba elmentett csatornák töltődnek be a főoldalon – hálózat nélkül, a tartós tárból. Az összes többi csatorna, a műsorújság (EPG/XMLTV) és a VOD poszterek NEM töltődnek induláskor; betöltésük csak az Ország menü megnyitásakor indul, letöltés és adatvesztés nélkül, a meglévő mentett adatok megtartásával. A magyar + kedvenc induló készlet a localStorage mellett az IndexedDB első adagjaiból is pótolódik, és mentéskor a magyarok után a kedvencek is előre kerülnek, így újraindítás után is azonnal látszanak.',
      'TV DOKTOR 0-POPUP JAVÍTÁS (2x2 + NAGY ABLAK + 4+4): a bal oldali 4 kategória-doboz (Tanulás | Segítség / Aktiválódás | Hiba) fix 2x2 rácsban, nagy átlapoló ablak rákattintásra (nem tolja a rácsot), laponként görgethető (nyilak/PageUp/PageDown/Home/End/Enter), logikus fókusz (fel/le 2x2-ben, jobbra/balra, Home/End, Esc/Backspace), Tanult útvonalak (max.8) közvetlenül a 4 doboz alatt, csak bal oldalon 4+4 elrendezésben (1 5 / 2 6 / 3 7 / 4 8), alul üresen hagyva; nincs alsó színes sáv, nincs átfedés, nincs nyúlás.',
    ],
  },
  {
    version: '2.5.307',
    date: '2026-11-04',
    changes: [
      'TV DOKTOR 0-POPUP ÁTSZERVEZÉS: a bal oldali szövegek dobozokba kerültek ugyanazzal a látvánnyal mint jobb oldalt – felül külön Tanulás (minden tanult bejegyzés, ALL, nem 15) és Segítség (legfrissebb 15) doboz, alattuk Aktiválódás 15 és Hiba csatornánál 15 egymás mellett két oszlopban; mindegyik doboz fókuszálható, OK-ra nyílik/csukódik és laponként görgethető (PageUp/PageDown/nyilak/OK), jobb oldalon a maradék dobozok (Supabase, Működési állapot, Hibajelzés, Memória) feljebb tolódtak; a Tanult útvnalak sáv alul teljes szélességű 4 kockás sávként jelenik meg (nem nyitható).',
      'EPG TELJES LEVÁLASZTÁSA A DOKTORRÓL: minden EPG-kezelés, naplózás és megjelenítés kikerült a TV Doktorból (watchTvDoctorEpg stub, epgStats, guide-műsorújság frissítések, disabled/assist számlálók, kategória-panel EPG sáv) – az EPG továbbra is megy a főoldalon, de a Doktornak semmilyen műsorújság-adat nem kell.',
      'KÉZI SÁRGA TELEXT NAPLÓ (Sárga gomb) ELLENŐRZÉS: a két kézi napló (Nagy + TV DR) csak kézzel indítva naplóz a leállításig/küldésig, folyamatos 1 MB-os buffer (nem 15-korlát), a naplózott hibák elküldhetők saját Supabase funkcióba, a 0-popup bal dobozai külön: Tanulás mind, a többi 15 legfrissebb – a kézi napló és a 0-ablak 15-korlátja független.',
      'PER-KATEGÓRIA MEGŐRZÉS: Tanulás legfeljebb 500 bejegyzésig mind megmarad (globál 800 védőkorlát), Segítség/Aktiválódás/Hiba csatornánként csak 15 legfrissebb; csak a magyar tanult útvnalak (max 8/csatorna) kerülnek tartós tárolóba/Supabase-be.',
    ],
  },
  {
    version: '2.5.303',
    date: '2026-11-04',
    changes: [
      'EXKLUZÍV, VILLÁMGYORS MOZI/SOROZAT VISSZATÖLTÉS: Mozi vagy Sorozat fülre kattintva MINDEN háttérmunka (élő lista 20k, 25+25 előnézet, 500-as részletek, EPG/műsorújság, plakát-előmelegítés) azonnal leáll, és CSAK a kért lista tölt vissza a tartós IDB tárból – semmi más nem fut, amíg el nem kattint onnan. Nincs többé induláskori 25+25 plakát-előnézet és 500-as mentés, csak kattintásra töltünk, ezért az indulás könnyű és a váltás azonnali (nincs 1200 ms késleltetés). Az élő lista visszatöltése is megszakítható: ha közben Mozit nyit a néző, az élő a következő adaghatáron (≤100 ms) leáll – a VOD sorban következik, villámgyorsan.',
      'EPG SZÜNET MOZI ALATT: a műsorújság időzítői (2500 ms + 30 perc) Mozi/Sorozat nézetben szünetelnek, csak élőre visszaérve indulnak újra – nem versenyeznek a VOD dekódolással, nem foglalják a főszálat nézés közben.',
      'Mentések változatlanul tartósak: a 2.5.300-as IPK-újraindítás utáni 0-s felülírás javítása megmaradt, a dirty-mentés továbbra is csak teljes listánál ír (üres nem írja felül a 103k-t).',
    ],
  },
  {
    version: '2.5.300',
    date: '2026-11-04',
    changes: [
      'JAVÍTÁS: MOZI VOD KÖNYVTÁR 0 IPK újraindítás után – a 0-s lista többé nem írja felül a 103k-s tartós mentést. Korábban a „movies.length === 0 || movies.length >= totalCounts.vod” ág miatt egy üres lista is complete-nek számított és felülírta az IDB-t; most stricter: teljes darabszám ismert esetén csak akkor mentünk, ha elértük azt (totalCounts.vod === 0 ? true : movies.length >= totalCounts.vod). A sorozatok már jól működtek, most a mozik is tartósan megmaradnak újraindítás után.',
      'RÁCS TISZTÍTÁS – FÓKUSZ JAVÍTÁS (képernyőképek alapján): a Mozi és Sorozat fő poszterrácsáról lekerült a jobb felső piros kuka; a fókusz így nem akad a kukán, a D-pad nyilak végig a poszterek között mennek. A „Törlés a memóriából” továbbra is elérhető az adatlapban (poszterre OK → részletek → Törlés gomb), változatlanul a vodRemovals jegyzékbe ír.',
    ],
  },
  {
    version: '2.5.298',
    date: '2026-11-04',
    changes: [
      'TV DOKTOR KI/BE FÓKUSZ (Beállítások → Rendszer): a dobozon OK mostantól a kapcsolóra (data-tv-box-default) viszi a fókuszt, nem kapcsolja át rejtetten; a kapcsolóról bármely nyíl (le/fel/jobbra/balra) a SAJÁT dobozára ugrik vissza, onnan a fel/le már a következő beállításra lép – a globális webOS réteg és a beállítások saját navigációja együtt kezeli, nincs fókuszcsapda.',
      'MOZI / SOROZAT VISSZATÖLTÉSI DARABSZÁM: a fejléc eddig csak a képernyőn lévő 500-as adagot és a szolgáltató ígért összlétszámát mutatta; mostantól a TV saját, tartós tárából (CatalogState.sections) ténylegesen visszatöltött mennyiség is látszik („• TV-memóriában: N”), így a valós visszatöltés ellenőrizhető.',
      'PIROS KUKA TÖRLÉS A MEMÓRIÁBÓL (Mozik & Sorozatok): minden poszter jobb felső sarkában piros kuka ikon, az adatlapon is „Törlés a memóriából” gomb – a törlés providerenkénti tartós jegyzékbe (vodRemovals) kerül, a rácsról azonnal eltűnik, a következő visszatöltéskor és szolgáltatói frissítéskor sem jön vissza, a lista a következő automatikus mentésnél már nélküle íródik ki.',
      'KIADÁSI ÉV SZERINTI RENDEZÉS (Mozik & Sorozatok): a rács mostantól a kiadási év szerint csökkenően rendezett (legfrissebb elöl: 2026 → 2025 → …), az év mezőből vagy a cím végi „(YYYY)”-ből; év nélküli elemek a lista végén, stabil sorrendben.',
      'TV DOKTOR CSAK MAGYAR CSATORNÁT MEMORIZÁL: a tanuló siker/hiba rögzítés (recordDoctorChannelSuccess/Failure) külföldi csatornánál (nem HU) nem hoz létre tartós rekordot és nem kerül felhőbe – a kedvencekben lévő idegen adók miatti felesleges memória megszűnt.',
      'TV DOKTOR NE JELÖLJÖN MŰKÖDŐ CSATORNÁT NEM MŰKÖDŐNEK: korábban már sikeresen indult csatornánál a javítási létra 3-5. lépésében is a memóriában tanult, legjobb útvonalát próbálja újra (tanult_route_retry), és kimerülésnél csak rövid, 60 mp-es hűtést kap (haltCount max 1) – egy átmeneti hiba nem zárja ki 30 percre.',
    ],
  },
  {
    version: '2.5.297',
    date: '2026-11-04',
    changes: [
      'TV DOKTOR KI/BE KAPCSOLÓ (Beállítások → Rendszer): a menüben az OK gomb mostantól mindig végrehajtja a fókuszált gombot. A webOS távirányítójának OK gombja gyakran csak keyCode 13-ként érkezik (key = „Unidentified”), ilyenkor a böngésző nem váltotta ki a kattintást – ezért lehetett a kapcsolóra fókuszálni, de nem lehetett átkapcsolni. Ez minden menügombra érvényes, nem csak a TV Doktoréra.',
      'MŰSORÚJSÁG IDŐZÓNA (a magyar műsorújság mostantól MINDEN országban magyar időt mutat): a panelek és az XMLTV gyakran időzóna nélkül adja a műsoridőket (pl. „20261104020000”). Ezeket eddig a készülék saját idejeként olvastuk, ezért Írországban (UTC+0) a magyar műsorújság egy órával csúszott, és a „most futó” a már lejárt, előző műsort jelölte.',
      'Az időzóna nélküli időpontokat mostantól MAGYAR időként (CET/CEST, az EU nyári időszámítás szabályai szerint) értelmezzük, a műsoridőket pedig magyar időben írjuk ki – a magyar újsággal egyezően, a „most” jelölés a valóban futó műsorra esik. A megadott időzónát (+0100, Z) továbbra is tiszteletben tartjuk.',
      'A régi, elcsúszott időpontokkal mentett műsorújság egyszer automatikusan újratöltődik magyar időben (a tartós gyorsítótár jelölést kap), így nem kell kézzel törölni semmit.',
    ],
  },
  {
    version: '2.5.296',
    date: '2026-11-04',
    changes: [
      'FÓKUSZCSAPDA A MENÜBEN (Beállítások → Rendszer): a TV Doktor dobozán a LEFELÉ nyíl eddig a doboz saját Ki/Be kapcsolójára vitte a fókuszt, onnan pedig vissza a doboz keretére – így a menüben felfelé/lefelé haladva a kijelölés a doboz és a kapcsoló között pattogott, a többi beállítás (Supabase-párosítás, OSD, Mozi & Sorozat, LG webOS) pedig elérhetetlenné vált.',
      'EGYSÉGES MENÜNAVIGÁCIÓ: a Rendszer fülön mostantól minden doboz pontosan egy fókuszlépés – fel/le az előző/következő beállításra lép (a legfelső dobozról fel a Rendszer fülre), a doboz belső vezérlőit (Ki/Be kapcsoló, gombok, legördülő listák) pedig JOBBRA nyíllal vagy OK-val lehet elérni.',
      'NINCS VISSZAPATTANÁS: ha a fókusz egy doboz belső vezérlőjén áll, a sor végén a fel/le nyíl tovább lép a szomszéd dobozra ahelyett, hogy visszaugrana a doboz keretére – így a kapcsolóról is azonnal tovább lehet menni.',
    ],
  },
  {
    version: '2.5.295',
    date: '2026-11-04',
    changes: [
      'TV DOKTOR TANULÓ ÚTVONALAK (a gyors csatornaváltás továbbfejlesztése): a TV Doktor mostantól minden adásból tanul, és csatornánként (a főoldali magyar csatornáknál) legfeljebb 8 legjobb „útvonalat” jegyez meg – a lejátszási formátumot (TS/HLS) és a pufferprofilt EGYÜTT, a mért indulási idővel. Indításkor a legjobban bevált útvonal indul; ha egy új, jobb útvonal születik, azonnal a legjobbak közé kerül, a leggyengébb pedig kiesik.',
      'JAVÍTÁS A SAJÁT TANULÁSBÓL: ha indulási hiba vagy megakadás van, a TV Doktor nem váltogat vakon formátumot és puffert, hanem előbb azokat az útvonalakat próbálja ki, amelyek ezen a csatornán korábban már működtek – így gyorsabban áll helyre a folyamatos nézés.',
      'SUPABASE MEMÓRIA: a tanult útvonalak a felhőbe is felkerülnek a párosított eszköz tokenjével védett, külön memória-kapcsolaton (tv_doctor_routes_upsert / tv_doctor_routes_fetch), így egy másik TV vagy egy újratelepítés is azonnal a bevált beállításokkal indul – induláskor a program előbb ezt a memóriát tölti le, és csak utána szinkronizál. Csak a szükséges adat megy fel: formátum, pufferprofil, mérési számok – stream URL, jelszó, film- vagy sorozatcím soha.',
      'CSAK MAGYAR CSATORNÁKRÓL TÁROLUNK: a nem magyar csatornákat a TV Doktor továbbra is segíti (gyors indulás, formátumváltás, javítás), de róluk sem a készüléken, sem a felhőben nem marad adat – a korábbi, más országokról összegyűlt tanulás automatikusan törlődik.',
      'A MEMÓRIA NEM HÍZHAT MEG: a készüléken csatornánként legfeljebb 8 bejegyzés van (a leggyengébb automatikusan kiesik), a felhőben csatornánként ugyanígy 8, csak magyar csatorna, ismeretlen vagy hibás sor pedig nem is kerülhet be.',
      'AUTOMATIKUS TISZTÍTÁS: a Supabase memória minden szinkron után rendet tesz – csak magyar csatornák maradnak, csatornánként legfeljebb 8 útvonal, a 30 napnál régebbi események és a felesleges sorok törlődnek, így hosszú távon sem halmozódik fel adat.',
      'A 0-GOMBOS ABLAK: a felugró TV Doktor ablak mostantól mutatja a nézett csatorna tanult útvonalait (melyik indul, mennyi a mért indulási idő), és a működése (megnyitás, zárás, memória nullázás, Supabase-teszt) bekerül a naplóba – az élő, 48 soros eseménylistát viszont nem szemeteli.',
      'Film és sorozat (VOD): a TV Doktor továbbra is csak a folyékony lejátszást segíti (újraindítás, pufferemelés), de filmről vagy sorozatról SEMMILYEN adatot nem tárol – ez tudatosan így marad.',
    ],
  },
  {
    version: '2.5.294',
    date: '2026-11-04',
    changes: [
      'ÚJRAINDÍTÁS UTÁN CSAK 500 FILM („MOZI VOD KÖNYVTÁR 500 / 103048”): a teljes film lista visszatöltése eddig akkor is „késznek” számított, ha a felület nem vette át (a néző közben visszament élő TV-re, vagy épp szolgáltatói frissítés futott) – így a képernyőn tartósan az első 500 filmes adag maradt, és semmilyen későbbi megnyitás nem töltötte újra. Mostantól a szakasz csak akkor kész, ha a lista tényleg a felületre került, a részleges adag pedig soha nem csökkenti a már meglévő teljes listát.',
      'A Frissítés (nincs változás / elhalasztva / kész / hiba / megszakítva) után a program megnézi, hogy a nyitott Mozi/Sorozat nézet listája hiányos-e, és ha igen, a tartós tárból, letöltés nélkül pótolja.',
      'HIÁNYOS MENTÉS JAVÍTÁSA: ha a készüléken a film lista fejléce több adagot ígér, mint amennyi tényleg a tárolóban van (régi, kvótahibás mentés), a Frissítés ezt mostantól felismeri, a film indexlistát EGYSZER újratölti, és teljes generációként menti – a kedvencek és a folytatási pozíciók megmaradnak, az élő és a sorozat lista érintetlen. A diagnosztika ezt kiírja: „Kész – a hiányos filmlista helyreállt”.',
    ],
  },
  {
    version: '2.5.293',
    date: '2026-11-03',
    changes: [
      'GYORS ZAP tényleg működik (#24/#26-os napló, „csatornaváltás 5 mp, nem 1 mp"): a CH+/CH− mostantól a ref-ből (azonnal frissülő azonosítóból) számolja a következő csatornát, így gyors egymás utáni váltásnál nem ugrunk vissza ugyanarra, és az előkészítés (prefetch) mindig a valóban következő csatornát tölti előre – eddig egy lépéssel lemaradva a rossz csatornát töltötte, ezért a GYORS ZAP soha nem váltott be, és minden váltás hidegen 2-5 mp-ig tartott.',
      'Zap-őr: váltás után a webOS egy ideig még a régi csatorna pufferét jelenti – ezt mostantól nem számítjuk az új adás indulási adatának, és amíg az új cím töltődik (NETWORK_LOADING), nem indítunk felesleges formátum-újrapróbát (ez a #24-es naplóban 2 mp helyett 4,7 mp-es váltást okozott).',
      'Nézés közbeni leállások megszüntetése (#24-es napló: 81 mp-es VOD-visszatöltés futott végig élő TV közben, LEÁLLÁS 2,5-2,6 mp): a Mozi/Sorozat teljes visszatöltése mostantól adagonként megszakítható – ha a néző visszament élőbe, az olvasás a következő adagnál leáll; a film/sorozat mentési adagméret 2000-ről 500 sorra csökkent, így egy adag beolvasása ~0,6 mp a korábbi ~2,5 mp helyett.',
    ],
  },
  {
    version: '2.5.280',
    date: '2026-11-03',
    changes: [
      'GYORSULÁS NÉZÉS KÖZBEN (#22/#23-as napló, „minden kurva lassú, a távkapcsoló nem reagál azonnal"): a teljes listák újraírása (20 193 csatorna + 103 043 film + 25 046 sorozat = 22-50 mp főszál-foglalás a #22-es naplóban, LEÁLLÁS 2,5-3,3 mp) mostantól NEM fut lejátszás közben – a mentés 3 mp-enként újrapróbálkozik, és csak akkor ír, ha nincs aktív lejátszás (kilépéskor azonnal ment). Emellett a visszatöltött listák azonosítója rögtön „már mentettnek” számít, így egy későbbi változás (pl. egy ország betöltése) nem írja ki újra mind a három teljes listát.',
      'HÁTTÉR-TÖLTÉS LEÁLLÍTÁSA (#22-es napló, „össze-vissza tölt be minden"): a Mozi/Sorozat teljes visszatöltése csak akkor indul, ha a menü 1,2 mp után is nyitva van (gyors átlapolásnál nem indul 40 mp-es IDB-olvasás), és ha a néző közben visszament élő TV-re, a 103 ezres lista NEM kerül a felületre (nincs teljes újrarajzolás, nincs fókuszugrás).',
      'ORSZÁGOK A HELYÜKRE (#22-es napló, „az országok kategóriája nem jó helyre vannak berakva"): a csatornalista (keresési találatok, kedvenc mappák, vegyes kategóriák) mostantól ORSZÁGONKÉNT csoportosítva jelenik meg, a Kategóriák menü sorrendjében (Magyarország elöl, utána magyar ABC) – a CH+/CH− így nem ugrik át egyik országból a másikba (#22: [HU] TV2 UHD után rögtön [UK] CHU CHU TV jött). Az országkategóriák rendezése is magyar ABC-re váltott (a régi alapértelmezett locale máshogy rendezte őket).',
      'FÓKUSZ (#22-es napló, „össze-vissza ugrál a fókusz"): a Kategóriák panel ha a lista újraépülése miatt a fókusz kikerült a panelből, automatikusan visszaáll az első sorra – a nyilak így mindig működnek, nem „ugrálnak össze-vissza". A nagy háttérmunkák megszűnésével a főoldali fókusz is stabil marad.',
      'EPG továbbra is CSAK magyar (#22: „csak magyar EPG, nem 10 vagy 20 MB szarság" – ez a 2.5.279 óta így van, a #22-es napló szerint a tároló 215 csatorna/2511 műsor, a 30+ MB-os újbóli letöltés kihagyva).',
    ],
  },
  {
    version: '2.5.279',
    date: '2026-11-03',
    changes: [
      'EPG CSAK magyar csatornákra (#20/#21-es napló, „az EPG csak a magyar csatornákra kell, a többi csak lassítja a TV-t"): a műsorújság feldolgozásnál és a tartós tárolónál is csak a magyar (HU) csatornákat vesszük figyelembe – a nem magyar blokkokat kihagyjuk, így a tároló 10-50 MB helyett pár MB lesz, és a csatornaváltás közbeni főszál-leállások (LEÁLLÁS 2,5 mp a #20-as naplóban) megszűnnek. A szolgáltató teljes (minden országos) xmltv.php letöltése 32 MB-nál leáll, és korábban megáll, amint elég magyar csatorna érkezett – nem töltünk le minden országot.',
      'GYORS CSATORNAVÁLTÁS (#20/#21-es napló, „1 másodperc alatt meg kell történnie, ne a TV Doktort javítsd"): (1) előkészítés (prefetch) – a lejátszó rejtett második videóeleme előre betölti a következő/előző csatornát; váltáskor ezt a kész pufferű elemet veszi át a fő lejátszó, így a kép már a váltás pillanatában ott van; (2) a zap-őr nem indítja újra az éppen pufferelő streamet („már van puffer, mégis újratöltöttük" – a #20-as naplóban ebből lett 4,4-5,8 mp-es váltás); most csak akkor próbál újra, ha tényleg nincs adat, egyébként a lejátszás-őrig vár; (3) az indulási őr 2 mp helyett 1,5 mp.',
    ],
  },
  {
    version: '2.5.278',
    date: '2026-11-03',
    changes: [
      'GYORSÍTÁS (#18/#19-es napló, „retten lassú/fagy minden"): az EPG (műsorújság) feldolgozás inkrementálissá vált – korábban minden beérkező blokkra újra végigfutott a zárójel-keresés a teljes (akár 8 MB-os) pufferen, ami egy 10-20 MB-os újságnál önmagában 2,7-3,1 mp-es főszál-leállást okozott (LEÁLLÁS a #18-as naplóban). Most csak az új szöveget dolgozzuk fel lépésenként, a leállások megszűnnek.',
      'EPG magyar adók ELŐRE (#18-as napló): ha a visszatöltött újság kevés magyar adót fed le, most előbb a kis, gyors nyilvános HU újságokat töltjük le (másodpercek alatt), és csak utána indul a nagy szolgáltatói XMLTV a háttérben – a magyar sárga műsorsor így azonnal megjelenik, nem 2-3 perc múlva.',
      'Felhőszinkron ritkítás (#19-es napló): a TV Doktor Supabase szinkronja 14 mp-es debouncing helyett most 60 mp után, de két küldés között legalább 3 perc telik el – a #19-es naplóban 15-60 másodpercenként ment ki szinkron 5,4 mp-es válaszidővel nézés közben; most ritkábban, nagyobb kötegekben megy.',
      'Pufferőr: 8 mp-nél nagyobb előrenyúffer esetén már nem várunk 750 ms megerősítő szünetet – ott biztosan akadás van, a beavatkozás azonnal indul (#18: 11 mp előrenél is vártunk).',
    ],
  },
  {
    version: '2.5.277',
    date: '2026-11-03',
    changes: [
      'TV Doktor teljes átdolgozás (#16/#17-es napló): (1) újraaktiválási hűtő csatornánként – egy kimerült javítási létra után 8 percig csak a rövid (2 lépéses) ellenőrzés futhat, így az ARENA 4 oda-vissza kapcsolásnál már nem indul újra teljes 5 lépéses létra 25–30 másodpercenként; (2) egy létrán belül a sikertelen formátumot többször NEM próbálja újra – megszűnt a HLS↔TS ingadozás; (3) a halott-csatorna jelölés kézi újraválasztásnál AZONNAL törlődik (NAT GEO WILD UHD esete), és ismétlődő kimerülésnél skálázódik (3→30 perc); (4) a TV Doktor mostantól az EPG-t is figyeli – az új műsorújság-tárolót (epgGuide) nézi, és csak akkor indít frissítést (ensureGuide), ha hiányzik, elavult (>3 óra) vagy kevés magyar adót fed le; egyébként nem dolgozik; (5) a memóriában csak tanulható adat marad (napló-gyűrű 80→48), a kijelzett memória így kisebb.',
      'Kedvencek – pontos hozzáadás (#17-es kérés): a mappaválasztó fejlécében mostantól látszik, pontosan hány csatorna kerül a mappába („Pontosan N csatorna kerül a mappába (csak ez a csoport)”) – így egy országon belüli alkategória (pl. UK → Kids 24/7) kiválasztásánál rögtön látszik, ha véletlenül az egész országot jelöltük volna ki. A csillag továbbra is kapcsoló: hozzáad ↔ egész csoport kivétele minden mappából.',
      'Mozi/Sorozat induláskor (#17-es kérés): induláskor csak 25+25 film/sorozat töltődik be (induló részhalmaz a tartós tárból); a teljes lista csak a menü megnyitásakor töltődik be on demand, a tartós IndexedDB tárolóból, hálózat nélkül. A visszafejtett nagy listák többé NEM kerülnek a RAM-ba (decodedCache felső határ 5000 tétel) – a kis memória csak a fő magyar csatornákat, beállításokat és a szükségeseket tartalmazza. A szolgáltató adatait továbbra is csak egyszer tölti le az app, onnan csak olvassa a tartós tárat – IPK-frissítés vagy újraindítás után sem töltődik újra.',
    ],
  },
  {
    version: '2.5.276',
    date: '2026-11-03',
    changes: [
      'Mozi/Sorozat eltűnés javítása IPK-frissítés után (#14-es napló): a teljes filmlista (103 021 film) soha nem fért bele a webOS ~5 MB-os tárolójába, ezért a kötegelt mentés kvótahibával meghiúsult, a fejléc sosem íródott ki, és frissítés után „0/103021 film” lett (az élő lista kis mérete miatt megmaradt). Mostantól a film-/sorozatmentésnek van bájtkerekete (max 2 MB, a tényleges szabad helyhez igazítva): ami belefér, azt elmentjük, a fejléc „partial” jelölést kap, így újraindítás után is van lista, és a háttér-ellenőrzés később visszapótolja a hiányzó részt. Ez egyben megszünteti a több másodperces főszál-leállásokat is, amiket a 100 ezres lista újra-kódolása okozott mentés-újrapróbáláskor nézés közben.',
      'Kedvencek – ország/alkategória csillaga kapcsoló (#14-es kérés): ha a kategória csillagát már „teli” állapotban nyomod meg, az EGÉSZ kategória kikerül minden kedvenc mappából (korábban ilyenkor csak újra megnyílt a mappaválasztó, kivétel nem volt). Hozzáadáskor továbbra is csak a kiválasztott kategória saját csatornái kerülnek be – idegen kategória elemei nem. Az egyes csatornák egyenkénti csillaga változatlanul működik (hozzáad/kivesz minden mappából).',
    ],
  },
  {
    version: '2.5.275',
    date: '2026-11-03',
    changes: [
      'Gyorsítás (#11-es napló): ha a panel összes EPG végpontja (xmltv.php, get.php url-tvg, /epg.xml /guide.xml /xmltv.xml) egy teljes próba után üres volt, ezt 24 órára elmentjük – a későbbi frissítések (30 percenként) így már NEM töltenek le újra több MB-os M3U-t és nem próbálják újra a jelölt útvonalakat, hanem egyenesen a nyilvános HU újságokhoz mennek; 24 óra után újra próbáljuk (hátha a panel közben beállította az EPG-t). A naplóban külön sor: „a panel EPG végpontjai … üresnek bizonyultak – … KIHAGYVA”.',
      'Gyorsítás (#11-es napló): a mentett műsorújság akkor is „frissnek” számít, ha az időablaka még érvényes (a mentés + 12 óra még a jövőbe mutat) – így a 30+ MB-os nyilvános HU újságokat nem 3 óránként, hanem csak akkor töltjük újra, amikor a mentett műsorok tényleg kifutnának; ez szünteti meg a nézés közbeni több másodperces főszál-leállásokat (LEÁLLÁS 3–6 mp) az újratöltéskor.',
      'Gyorsítás (#11-es napló): az M3U url-tvg keresése 512 KB helyett csak az első 64 KB-t olvassa és regexeli (a url-tvg mindig a #EXTM3U fejlécben van) – kevesebb letöltés és főszáli munka minden próbánál.',
      'EPG (#11-es napló): új többes aliasz-tábla (HU_EPG_IDS_EXTRA) a még műsor nélküli magyar adókhoz – AXN CE → AXN / AXN.hu / HU1#AXN.hu, BOOMERANG → Cartoonito.hu / HU1#Cartoonito.hu / CARTOONITO / CARTOON, DISNEY JR → DISNEYJUNIOR / DisneyJunior.hu / HU1#Disney.Junior.hu, E ENTERTAINMENT → E_ENTERTAINMENT / E!Entertainment.hu, HIT TV → HITTV / HIT.TV.hu, TV 1000 → TV1000 / TV1000.hu, M PLUS → M+.hu / MPlus.hu; az epgshare01 HU1 táblából a „HU1#…” előtagos azonosítók is közvetlenül próbálva (az újság ténylegesen „HU1#AXN.hu” alakú id-eket használ).',
    ],
  },
  {
    version: '2.5.274',
    date: '2026-11-02',
    changes: [
      'EPG (#5-ös napló): a visszatöltött műsorújság „frissnek” minősítése mostantól azt is ellenőrzi, hogy a magyar adók tényleg kapnak-e műsort – a #5-ös naplóban a memóriában lévő 1039 csatornás mentés „friss” volt, mégis csak 89/107 magyar adónak jutott műsor (nem a HU-forrásokból jött), ezért most ilyenkor frissítünk, és a nyilvános HU újságok (epgshare01 HU1, aldork04 lgtv-epg, iptv-epg.org epg-hu) is lefutnak; a naplóban külön sor jelzi: „a visszatöltött újság csak X/Y magyar adót fed le”. Ugyanez a feltétel a letöltés utáni tartalékláncra is rákerült (ha a magyar lefedettség alacsony marad, a nyilvános HU lánc akkor is próbálkozik).',
      'Napló óra (#5-ös napló): ennél a TV-nél a rendszer-időzóna +01:00-t jelez, a falióra viszont Europe/Dublin (téli GMT) – ezért minden napló-időbélyeg 1 órával későbbinek látszott (00:25 helyett 23:29 volt a valódi idő). Mostantól a napló időbélyegei és a kézi napló ablakának dátumai fixen Europe/Dublin időzónában készülnek (nyári időben automatikusan +01:00).',
      'Kézi hibakeresési napló (#5-ös kérés): a „TV Doktor működésének teljes leírása” doboz kikerült az ablakból – nem jelenik meg és nem foglal helyet, így az „UTOLSÓ 5 ELKÜLDÖTT NAPLÓ” mind az 5 sora látható; a TV DR indítás/leállítás/küldés gombjai az alsó gombsorban maradnak, a működés változatlan.',
      'Teljesítménymérés naplózása (#5-ös kérés): minden nézetváltás (TV ↔ Mozi ↔ Sorozatok) új időmérős naplósorral indul („NÉZETVÁLTÁS indul: …”, háttér-állapottal: EPG csatornaszám, fut-e provider-frissítés, teljes képernyő, csatornalista mérete), és külön „NÉZETVÁLTÁS kész: … lista=N db, eltelt=X ms” sor jelzi, mikor jelent meg valóban a lista; a teljes képernyő be/ki váltások közt eltelt idő is naplózódik („TELJES KÉPERNYŐ BE/KI – előző váltás óta eltelt=X ms”), a meglévő csatornaváltási és főszál-leállási mérések mellett.',
      'EPG (#3-as napló): a #3-as napló szerint a 2.5.269-es javítás működik (üres xmltv.php után a részleges visszatöltés ellenére is lefutnak a nyilvános HU újságok: epgshare01 HU1 +159 csatorna, magyar adók 90/107, majd iptv-epg.org epg-hu +122 csatorna, összesen 95/107 magyar adónak lett műsora) – de az iptv-org.github.io/epg/guides/hu/… két fájl HTTP 404-et adott, ezért kikerültek a láncból, helyettük az iptv-org magyar lista alapján naponta kétszer frissülő aldork04.github.io/lgtv-epg/guide.xml került be (GitHub Pages, sima XML).',
      'EPG (#3-as napló): az iptv-org stílusú „@SD”/„@HD”/„@Hungary” végű csatornaazonosítók („Viasat2.hu@SD”) esetén az indexeléskor és a kereséskor is levágjuk a „@…” utótagot, így a csupasz „viasat2.hu” is betalál.',
      'EPG (#3-as napló): második beépített magyar azonosítótábla (huEpgIds.ts HU_EPG_IDS_IPTV, 596 kulcs) az iptv-org adatbázis magyar csatornáiból (név + alt_nevek) – így a még hiányzó adók is kapnak műsort az iptv-org alapú újságból: AXN CE → AXNCEE.es, AXN White/Sony Max → Viasat2.hu, AXN Black/Sony Movie → ViasatFilm.hu, Boomerang → CartoonitoCEE.uk, Disney Jr → DisneyJunior.hu, HIT TV → HITTV.es, M+ → C8.hu; a guideKeyFor minden táblából próbál.',
      'EPG (#3-as napló): a hiányzó magyar adók felsorolásából a „##### … #####” csoportfejlécek kihagyva (nem valódi adók), hogy a lista csak valódi hiányzó neveket mutasson.',
      'EPG (#2-es kérés): CSAK a magyar csatornák kapnak EPG-t, semmi másra – a nyilvános EPG láncból a 3 globális (összes országos, 128 MB-os) fájl kikerült, csak a kis magyar HU fájlok maradtak (epgshare01 epg_ripper_HU1, iptv-org mediaklikk.hu + tvmusor.hu, iptv-epg.org epg-hu), így a letöltés és a tartós tároló is kicsi; a per-csatornás get_simple_data_table tartalék is csak [HU] csatornákra fut (countryCode=HU).',
      'EPG (#2-es napló): beépített HU EPG azonosítótábla (web/src/services/huEpgIds.ts, 193 bejegyzés/413 kulcs) – ugyanaz a logika, mint a csatornalogóknál: a magyar csatorna neve (aliaszokkal, [..] és minősítő szavak nélkül, „hu” előtag nélkül, spieler→spiler) → a nyilvános újság .hu végű azonosítója (pl. „RTL Klub” → „RTL.hu”); a guideKeyFor ezt a jelöltet is próbálja, így a panel és az újság eltérő elnevezései ellenére is betalál a műsor.',
      'EPG (#2-es napló, hibajavítás): a részleges visszatöltött újság (1658 csatorna) miatt az üres xmltv.php után a „channels===0” tartalék-lánc soha nem futott le (a #2-es naplóban így a magyar adók 21/107-nél ragadtak, és egyetlen nyilvános EPG sor sem volt) – mostantól az dönt, hogy a LETÖLTÉS mennyi ÚJ műsort adott (statKept különbség), és ha 0, akkor url-tvg → jelölt útvonalak → nyilvános HU újságok próbája mindenképp lefut; a betöltési sorban külön „újonnan N” érték is látszik, és részleges visszatöltés esetén a per-csatornás tartalék is újra engedélyezett.',
      'EPG (#2-es kérés): részletes magyar lefedettségi napló – minden nyilvános HU forrás után külön sor: előtte/utána csatornaszám ÉS hogy a magyar adókból hány kapott eddig műsort (pl. „magyar adók műsorral eddig: 91/107”); az indulás utáni lefedettségi sor pedig a pontos magyar csatornaszámot („HU-EPG: magyar csatornák a listában pontosan=107, műsort kapott=91”) és a még hiányzó neveket is kiírja (max 30), hogy az azonosítótáblát ki lehessen egészíteni.',
      'EPG (#1-es napló): a nyilvános EPG újságok közül az epgshare01 ALL_SOURCES működött a TV-ről is (HTTP 200, ~200 MB-os .gz, a 128 MB-os plafonig olvasva 1658 csatorna/20 584 műsor), de abból a magyar adóknak csak 17/107 lett meg – ezért mostantól a globális fájl után MINDIG végigmegyünk a kis magyar (HU) fájlokon is (epgshare01 HU1, iptv-org mediaklikk.hu + tvmusor.hu, iptv-epg.org HU) és hozzáadjuk őket az indexhez, hogy a magyar adók teljesen le legyenek fedve; minden forrás külön naplózva előtte/utána csatornaszámmal („melyik újság mit adott”).',
      'EPG (#1-es napló): a csatornaillesztés tovább finomítva – az epg_channel_id mellé próbáljuk a „.hu” végű és a „.hu” nélküli változatot is („tv2” ↔ „tv2.hu”), a névnél pedig a „[HU]” előtag levágása mellett a „spieler”→„spiler” helyesírási változatot is („SPIELER2 TV” ↔ „Spiler 2 TV”).',
      'EPG (#14, nyilvános EPG újság): ha a szolgáltató saját műsorújsága üres (a #13-as naplóban a LOWEND panel üres <tv></tv>-t küld, az M3U-ban sincs url-tvg), mostantól NYILVÁNOS, mindig elérhető XMLTV forrásokból töltünk műsort: először az összes országos globális fájlok (epgshare01 ALL_SOURCES, epg.pw), aztán a magyar külön fájlok (epgshare01 epg_ripper_HU1, iptv-org mediaklikk.hu és tvmusor.hu HU, iptv-epg.org HU) – minden próba EPG-ÁLLAPOT sorral naplózva (HTTP státusz + hány csatorna lett), a .gz fájlok olvasás közben DecompressionStream-mel bontva, saját idő-/méretkorláttal; tartósan elmentjük. Tesztkörnyezetben (nincs window) kikapcsolva.',
      'EPG (#14): a csatorna–műsorújság összerendelés akkor is működik, ha a nyilvános újság más azonosítót használ, mint a panel: az epg_channel_id csak akkor számít, ha tényleg szerepel az újságban, különben név alapján keresünk tovább, a „[HU]” országjelző levágott változatával is („hutv2” → „tv2”), így az újság display-name-jei („TV2”) is betalálnak.',
      'EPG (#14): új lefedettségi naplósor az indulás után – a listában hány csatorna kapott műsort az újságból, ebből hány magyar [HU] adó (a listában pontosan annyi magyar adó van, ahány [HU] csatorna).',
      'HU csatornalogó (#13): SUPER TV 2 beépített data-URL logót kapott (ext-super-tv-2; forrás: Wikimedia Commons File:Super TV2 logo.png, public domain; 128 px, palettás) + név-aliaszok („super tv 2”, „super tv2”, „supertv2”, „hu super tv 2”) – a #13-as naplóban ez volt az egyetlen magyar csatorna beépített logó nélkül, a picons URL-jét a TV nem éri el.',
      'Beépített logók (#13): a 8 mp-es logó-watchdog mostantól NEM minősít végleg hibásnak egy HELYI (data:/blob:) forrást – a #13-as naplóban egy 3 mp-es főszál-leállás alatt a még töltődő beépített logók (CARTOONITO, TV PAPRIKA, TV2 COMEDY/SEF/UHD/KIDS, VIASAT 3/6, TV 1000) egy csapásra „végleg nem tölthető be” lettek, pedig a PNG-k hibátlanok; valódi betöltési hibánál az onError továbbra is végigfut a tartalék láncon.',
      'Menü (#13): a Listák fülön több szolgáltató esetén a lefelé nyíl mostantól a KÖVETKEZŐ provider-dobozra lép (nem ugrik át rögtön az „Összes lista és tesztcsatorna törlése” gombra), felfelé pedig az előző dobozra; a törlés gombról felfelé az utolsó provider-doboz kapja a fókuszt – így minden alsó lista és a tesztcsatorna-törlés is elérhető sorban.',
      'EPG (#13): az ensureGuide „töltődik” zára mostantól SZINKRONAN, az első await előtt áll be – a #13-as naplóban két hívás 17 ms különbséggel kétszer töltötte le a műsorújságot (a második index.clear()-je kidobta az első részleges eredményét, a duplázott kérések miatt a panel 429-cel válaszolt). Üres (0 csatornás) végeredmény után 5 perc hűtés: nem fut újra teljes kör (xmltv.php + M3U-scan + per-csatornás lekérdezések) perceken belül.',
      'EPG (#13, 2.5.212 összehasonlítás): a 2.5.212-es verzió (commit 4f18c2d7) EPG-végpontjai megegyeznek a mostaniakkal (xmltv.php, player_api.php get_short_epg/get_simple_data_table, url-tvg keresés nélkül); a #13-as napló szerint ezen a panelen (LOWEND) az xmltv.php üres <tv></tv>-t, a get.php M3U pedig url-tvg nélküli fejlécet ad, a get_simple_data_table pedig 105 kérésre 0 műsort – tehát a panel oldalán nincs EPG adat, nem kódhiba; a rövid-EPG „üres végpont” verdikt mostantól EPG-ÁLLAPOT előtaggal a mérési szűrőn is átmegy.',
      'HU csatornalogók (#12): a 7 logó nélküli magyar csatorna (ATV Spirit, HIT TV, APOSTOL TV, PAX TV, TV 1000, ERDÉLY TV, M4/UHD) beépített data-URL logót kapott (Hungary-Picons GitHub-tár, Wikimedia Commons, hivatalos oldalak; max. 128 px, 128 szín) – a provider picons szerverei a TV-ről nem elérhetők, így csak beépítve működnek; név-aliaszok a HU_CHANNEL_LOGOS táblában.',
      'EPG (#12): a műsorújság mostantól NEM vár a VOD visszatöltésre (az élő lista után rögtön indul; a #12-es naplóban a 103k VOD 14,5 mp-ig blokkolta a fő szálat, ezért az ütemezett EPG soha nem futott le); minden ensureGuide korai kilépés (provider gate, friss, töltődik, megszakító) és az ütemezett indulás is EPG-ÁLLAPOT sorral naplózva; m3u providerhez is működik az EPG (url-tvg a listából, jelölt XMLTV útvonalak a lista könyvtárában/gyökerében); a discovery próbák (get.php nem-200 törzs, type=m3u, /epg.xml /guide.xml /xmltv.xml) m3u esetén is lefutnak és naplózódnak.',
      'HU csatornalogók (#11): a beépített (data-URL) logók mostantól azonnal (loading=eager) és blob objektum-URL-ként töltődnek, mert a lusta betöltés a virtuális listában a 8 mp-es watchdog előtt „beragadt”; a keresés a szóköz nélküli változatot is próbálja („viasat 3” → „viasat3”); a régi raw.githubusercontent.com-os helyi felülírások többé nem írják felül a beépített logókat.',
      'IPK képek: a beépített HU logók mostantól max. 128 px-es, max. 128 színű palettás PNG-k, és a webos-build workflow az ipk készítése előtt a splash mellett az összes beépített logót és ikont is újratömöríti – kisebb IPK.',
      'EPG (#11): az url-tvg keresés már a get.php válasz törzsében is keres nem-200 válasznál, kipróbálja a type=m3u változatot és a panel alap útvonalain az /epg.xml, /guide.xml, /xmltv.xml jelölt XMLTV címeket is; minden próba HTTP státusza és a törzs eleje a naplóba kerül; a get_simple_data_table hibáinak státusza is naplózva.',
      'Teljes képernyős élő TV csatornaváltás (#11): teljes képernyőn a lejátszó összes rétege (konténer, poszter, videó, töltőjelző) mostantól MINDIG fekete (csak a natív áadás marad átlátszó) – a 2.5.263 „csak képkockánál átlátszó” állapot ellenére is felvillant a főoldal a váltáskor, mert a képkocka csak két képkockával később érkezik.',
      'Két külön kézi napló: a nagy (rendszer) napló és a csak TV Doktor napló külön kapcsolható, külön sorszám-címkével („NAGY NAPLÓ” / „TV DR”) egy ablakban, külön küldőgombbal; a sikeres küldés után az adott napló leáll és nullázódik; a TV Doktor adatai többé nem kerülnek a nagy naplóba; a TV Doktor naplót külön edge funkció (tv-doctor-log) fogadja külön táblába.',
    ],
  },
  {
    version: '2.5.263',
    date: '2026-11-02',
    changes: [
      'Teljes képernyős élő TV csatornaváltáskor (#11): amíg az új csatorna első képkockája meg nem érkezik, a lejátszó összes rétege (konténer, poszter, videóelem, „Gyors kapcsolódás…” töltőjelző) mostantól FEKETÉN tartja a teljes képernyőt – korábban ezek teljes képernyőn átlátszóak voltak (2.5.246), ezért a váltás idejére a főoldal „beugrott” a teljes képernyős nézetbe. Amint az adás ad képkockát, a videó továbbra is kitölti a kijelzőt, a háttér továbbra sem látszik.',
    ],
  },
  {
    version: '2.5.261',
    date: '2026-11-02',
    changes: [
      'HU csatornalogók (#10): a teljes magyar logótár (96 PNG a tv-logo/tv-logos countries/hungary mappából) és a #10-es napló hiányzó márkáinak nemzetközi változatai (28 db, pl. Disney, Discovery, Nickelodeon, Nat Geo, Eurosport, Cartoon Network, BBC Earth, JimJam…) mostantól BEÉPÍTVE vannak a bundle-ben, data-URL-ként (generatedHuLogos.ts) – a #10-es napló szerint a TV sem a raw.githubusercontent.com-ot, sem a picons szervereket nem éri el, ezért a távoli logók soha nem voltak megbízhatóak. Induláskor új naplósor: „HU-LOGÓ-TÁR: beépített=124, tábla-kulcs=…, felülírás=…, képi gyorsítótár=…”.',
      'EPG (#10): a panelen az xmltv.php üres 200-at ad, ezért ha a teljes XMLTV 0 csatornát hoz, most az M3U lista (get.php) fejlécéből keressük ki az url-tvg="…" címet, és onnan töltjük le a műsorújságot ugyanazzal a folyamatos olvasóval; továbbá minden üres/kis EPG-válasz törzsének első karakterei is a naplóba kerülnek (EPG-ÁLLAPOT), hogy lássuk, mit válaszol pontosan a panel. A per-csatornás get_simple_data_table tartalék megmarad.',
    ],
  },
  {
    version: '2.5.260',
    date: '2026-11-02',
    changes: [
      'HU csatornalogók (#9): ha egy magyar csatornához nincs saját logó a tárolóban, mostantól a szolgáltatói logót használjuk tartalékként (a #8 napló szerint mind a 107 HU csatornának van szolgáltatói logója, csak kb. 80-nak saját) – így a „többi" csatorna sem marad app-ikonon; a saját logó hibája után is megpróbáljuk a szolgáltatóit. Minden HU logókép (saját vagy szolgáltatói) data-URL-ként a localStorage-ba kerül, újraindítás után azonnal, hálózat nélkül.',
      'EPG (#9): a #8 napló szerint ezen a panelen a teljes XMLTV letöltés üres (0 bájt, 0 csatorna), ezért nem jelent meg műsor. Most ha a nagy XMLTV üres, háttérben per-csatornás get_simple_data_table kéréssel töltjük az első 250 csatorna (élén a magyarok) műsorát a műsorújság-indexbe és a tartós tárba; a válasz státusza/fejléce és a végpont-verdiktek (EPG-ÁLLAPOT előtag) mostantól látszanak a kézi naplóban is (a mérési szűrő eddig kidobta az „EPG:” sorokat).',
    ],
  },
  {
    version: '2.5.258',
    date: '2026-11-01',
    changes: [
      'HU csatornalogók gyorsítása (#8): a saját magyar logók képei a localStorage-ban is tartósan élnek (data-URL, kulcs: iptv_rt_hu_logo_img_v1) – újraindítás után rögtön, hálózati kérés és „újrarendeződés” nélkül jelennek meg, és a logó-URL-leképezések induláskor egyszer véglegesítve szintén a localStorage-ba kerülnek (iptv_rt_hu_logos_v1), mint a csatornák; a letöltéskori extra fetch a HU logóknál megszűnt (egy kérés elég, abból mentünk).',
      'Film/sorozat lejátszásakor az egész élő nézet fekete (nem csak az oldalsáv) – a sötétkék főoldal többé nem üt el a fekete takarás mellől (#8).',
      'Mozi posztereken játékidő (#8): az import-háttér előmelegítése most már akkor is lekéri az első 25 film részletes adatait, ha az év a címből is kiolvasható (korábban ilyenkor egyetlen film sem került be, így a „perc” sehol nem jelent meg); ráadásul görgetés közben a látható filmadag hiányzó játékideje is háttérben pótlódik (adagonként max. 25 kérés, 2 párhuzamosan, tartósan elmentve), így a posztereken mindenhol ott a „NN perc”, ahol a szolgáltató tudja.',
    ],
  },
  {
    version: '2.5.256',
    date: '2026-11-01',
    changes: [
      'Magyar csatornalogók (#7 képernyőkép + #8-as napló, 21:37): a saját HU logótár (tv-logo/tv-logos) minden URL-je mostantól .png-re végződik – eddig a generált ~100 bejegyzés kiterjesztés nélkül hivatkozott, ezért 404-et kapott és app-ikon esett vissza (csak az 5 kézi aliasz működött). Ugyanitt új név-aliaszok a #8 napló 107 HU csatornáiból (AXN Black/White/CE, Cool, Arena 4, Story 4, Fishing & Hunting, Ozone Network, Spieler/Spieler2, Viasat Nature/History).',
      'Mozi kártyák és adatlap: az évszám akkor is megjelenik, ha csak a címből olvasható ki („… (2024)”); a játékidő továbbra is mindenhol ott, ahol ismert (kártya + fejléc).',
      'Film/sorozat indításakor a csatornalista helyén teljes képernyőn IS fekete takarás látszik – a webOS kis lejátszó ilyenkor nem fedi a teljes kijelzőt, ezért korábban a főablak látszott át (#7 képernyőkép, 205120).',
      'Betöltési diagnosztika ablak jobb felső X gombja kijelölve többé nem fehér hátterű – csak a sima fehér ✕ látszik.',
      'TV Doktor ikon teljes képernyőn (óra előtt): a sötét korong/háttér és a keret megszűnt, csak maga a 3D ikon látszik (#7 képernyőkép, 203635).',
      'VOD adatlap (mozi ÉS sorozat közös): a doboz kisebb és középre kerül, így a jobb felső X nem kerül a kijelző szélére és nem takaródik; megnyitáskor a fókusz rögtön a kék LEJÁTSZÁS gombon van, nem az X-en (#7 képernyőképek, 203048/203209).',
    ],
  },
  {
    version: '2.5.254',
    date: '2026-11-01',
    changes: [
      'Magyar csatornalogók (#6 képernyőképek): HU csatornánál mostantól CSAK a saját logót használjuk és a szolgáltatói logót egyáltalán nem kérjük le (a picons szerver beragadása miatt a főoldalon várakozás/lassulás volt); a HU_CHANNEL_LOGOS tábla a tv-logo/tv-logos gyűjtemény összes magyar logójára ki van töltve (100+ csatorna), a keresés „[HU]” előtag és HD/UHD/TV utótag nélkül is működik; ha nincs saját logó, rögtön app-ikon, hálózati kérés nélkül. A kézi napló most kiírja az összes magyar csatorna nevét és kulcsát (HU CSATORNANEVEK), hogy a hiányzó logók könnyen pótolhatók legyenek.',
      'Film/sorozat lejátszásakor (nem teljes képernyőn) a csatornalista helyén fekete takarás jelenik meg – nem a főoldal (#6 képernyőkép); a lista közben rejtve marad a DOM-ban, visszatéréskor minden megmarad.',
      'Újraindítás után a Mozi/Sorozat első adaga (500-500 elem) rögtön megjelenik visszatöltéskor – poszterek és darabszám azonnal, nem kell megvárni a teljes listát; a teljes lista továbbra is a végén, egyben érkezik.',
      'Filmkártyák: ha a bulk lista nem küld évet, a cím végéről olvassuk ki („… (2019)” → 2019), így több kártyán jelenik meg az évszám.',
      'VOD adatlap (mozi ÉS sorozat közös, egy helyen): a fejléc tartalma függőlegesen középre kerül, a kis poszter nincs a bal felső sarokban és az X nem takarja (#6 képernyőkép).',
      'TV Doktor ablak teljes képernyőn: a fekete háttér átlátszóvá vált, mögötte a lejátszó látszik.',
    ],
  },
  {
    version: '2.5.252',
    date: '2026-11-01',
    changes: [
      'Magyar csatornalogók a #5 kézi napló (2026-11-01 19:00) alapján: a saját HU logótár (huChannelLogos) mostantól a tv-logo/tv-logos publikus GitHub-gyűjtemény közvetlen URL-jeivel van feltöltve (M1/M2/M4/M5, Duna, RTL-csoport, TV2-csoport, Hír TV, AMC, Dikh TV stb.), és magyar csatornánál az ELSŐ logóhiba után rögtön ezeket próbáljuk – a szolgáltatói picons szerver (103.176.90.x) több magyar logónál beragad, a régi láncban a saját logó csak a legvégén jött. A keresés a „[HU]” előtag nélkül is működik.',
      'Rétegezés (#5 képernyőképek): minden nézet-pane saját nem átlátszó háttérrel rendelkezik, így film indításakor és az OSD-ben nem látszik át a rejtett Mozi/Sorozat pane (korábban a főoldal + induló film + mozi poszterek egyszerre látszottak).',
      'Újraindítás utáni azonnali Mozi/Sorozat (#5 napló): ha az indulás üres tárolót látott és emiatt automatikus frissítés futott, a háttér-visszatöltés (élő + VOD + első 25-25 plakát előmelegítése + műsorújság) most a frissítés vége után is elindul; a Mozi/Sorozat megnyitása pedig akkor is a tárolóból tölt, ha még nincs terv betöltve (korábban „0 / 103020 – betöltés folyamatban” ragadt be).',
      'VOD adatlap fejléc (#5 képernyőkép): a bal oldali poszter kisebb és középre/lejjebb került, így fent nem lóg ki a háttér fölé, és a bezáró X gomb nem takarja.',
    ],
  },
  {
    version: '2.5.250',
    date: '2026-11-01',
    changes: [
      'Indulás és filmfeldolgozás gyorsítása a #4 kézi napló (2026-11-01 18:09) alapján: a lapos bulk film/sorozat sorok feldolgozása egyetlen menetben fut (a #4 naplóban 103 ezer film feldolgozása 65,5 mp volt a TV-n); a befejező „kész” jelzés többé nem várja meg a háttérben futó tartós film/sorozat mentéseket (a naplóban ez önmagában 50 mp + 14 mp volt) – a darabolt mentés így is összeomlásbiztos; induláskor a főoldal után a Mozi+Sorozat lista is visszatöltődik, és az első 25-25 plakát előmelegszik a tároló gyorsítótárából, így a menük megnyitása nem vár.',
      'Magyar csatornalogók: „beragadt” logókérés (a szerver kapcsol, de nem válaszol) 8 mp után sikertelennek számít, és továbbfut a tartalék láncon (séma → saját HU logótár → gyorsítótár → app-ikon) – a #4 naplóban 2 magyar csatorna (DIKH TV HD, HIT TV) logója maradt örökre üresen.',
      'Év és játékidő mindenhol: a filmkártyákon és az adatlap fejlécén a bulk listából hiányzó év/játékidő pótlódik – import közben az első 25 film és minden sorozat részletes adata háttérben, adatlap-megnyitáskor pedig csak valódi hiánynál egyetlen kérés (az eredmény tartósan elmentődik, következő megnyitásnál már nincs kérés).',
      'Nézetváltás: a pane-ek nem display:none-nal rejtődnek, hanem mindig ki vannak rajzolva és csak rétegződnek – a TV gomb lenyomásakor a főoldal EGYBEN áll össze (nem darabokból), és film indításakor sem rajzolódik újra az egész főoldal.',
      'IPK újraindítás után az alkalmazás továbbra is az utoljára nézett magyar csatornával, a TV (élő) nézetben indul.',
    ],
  },
  {
    version: '2.5.248',
    date: '2026-11-01',
    changes: [
      'Első letöltés gyorsítása a #3 kézi napló (2026-11-01 18:37) alapján: a 25 ezres sorozatonkénti get_series_info (évadok) többé NEM blokkolja az importot – háttérben fut, miután a csatornalista már a felületen van (a naplóban ez a fázis órákig futott, a betöltés „5 percig töltött”); a kész évadok 500-asával tartósan mentődnek, újraindítás után sincs újra letöltés.',
      'Filmfeldolgozás és filmmentés gyorsítása: a tárolt sorok dekódolásakor a „[]” mezők parse-olása kimarad, a mentésnél az üres tömbök stringify nélkül íródnak, és a tartós írás 4 köteg mélységig párhuzamosan fut (a naplóban: filmfeldolgozás 62 mp, filmmentés 52,6 mp).',
      'Csatornalogó-hiba naplózása: ha egy logó végleg nem tölthető be, CSATORNALOGÓ-HIBA sor kerül a kézi naplóba (a #3 napló csak azt mutatta, hogy a tárolóban megvan a logó – a megjelenítési hibát így lehet majd lokalizálni).',
    ],
  },
  {
    version: '2.5.246',
    date: '2026-11-01',
    changes: [
      'A fejléc TV / Menü / Sorozatok / Mozi ikonjai mögötti korong mostantól a távirányító 1–6 színgombjának megfelelő színű (sárga / piros / kék / rózsaszín / zöld / fehér) – az ikonrajz az eredeti maradt, csak a korábban fehér háttérkorong váltja a színét.',
      'Visszatérés a Mozi/Sorozat nézetből a főoldalra: a csatornalista mostantól AZONNAL, EGYBEN jelenik meg (villámgyors), nem töltődik vissza szaggatva – az EPG-adat rejtett nézetben is megmarad.',
      'Első letöltés finomabb időmérése a kézi naplóban: IMPORT-FÁZIS sorok szakaszonként (élő/filmek/sorozatok) külön letöltési és feldolgozási idővel; a változás-összevetés ujjlenyomata (rawItemSignature) mostantól mezővetítésből számol, nem teljes JSON-ból (gyorsabb nagy filmkatalógusnál).',
      'Csatornalogó-diagnosztika a kézi naplóban szűretlen prefixekkel (CSATORNALOGÓ, KATEGÓRIA): látszik, hogy a szolgáltató küld-e logót a HU csatornákhoz (stream_icon), és hova kerül a tárolóban.',
      'LOGÓ-HIÁNY jelentés kézi naplózásnál: pontosan felsorolja, mely magyar (HU) csatornákhoz nincs megjeleníthető logó; új saját magyar logótár (huChannelLogos), amelyből CSAK HU csatornák kapnak logót, ha a szolgáltatónak nincs.',
      'Teljes képernyőn a TV Doctor panelen kívül nincs többé fekete háttér: a lejátszó konténer, poszter, videó és töltő réteg átlátszó teljes képernyőn (a hibaüzenet félig áttetsző sötét marad az olvashatóságért).',
      'Első letöltés gyorsítása a #2 kézi napló (2026-11-01) alapján: a filmek/sorozatok feldolgozása 4800 helyett 1200 soronként lélegzik (a naplóban 13× 3,4–8,2 mp-es főszál-leállás volt a filmszakaszban), a film/sorozat tartós mentése 500 helyett 2000 soros adagokba íródik (206 adag/37,3 mp helyett ~52 adag), és a mentési szakaszok külön IMPORT-FÁZIS sorokkal mérhetők (mentés-élő/filmek/sorozatok).',
      'Mozi/Sorozatok átalakítása: az első letöltés csak a szükséges adatokat kéri le és menti tartósan (film: cím, poszter, háttérkép, év, játékidő, kategória, azonosító, lejátszási adatok+formátum; sorozat: ezeken felül évadok/epizódok, epizód címe/posztere/lejátszási adatai – get_series_info az első importkor). Megszűnt a böngészés közbeni és adatlap-megnyitáskori szolgáltatói lekérés; a lejátszási URL csak indításkor épül újra a mentett azonosítókból. A poszterek/háttérképek is letöltődnek és tartósan az ugyanazon IndexedDB-ben (iptv_rt_content/chunks, content-img- kulcsok) tárolódnak, onnan jelennek meg újra.',
      'Mozi/Sorozat listanézet: kártyán csak poszter, alatta cím, majd egy sorban év (sárga) és játékidő (kék) – csillag, kedvenc és egyéb jelvények nélkül. Film/sorozat adatlap: a háttérkép tölti ki a teljes felületet, bal oldalon kisebb poszter, jobb oldalon cím, év, játékidő és nagy kék LEJÁTSZÁS gomb; sorozatnál alatta görgethető, távirányítóval választható évad- és epizód-dobozok (epizód: cím, SxxEyy, jobb oldalt nagy kék LEJÁTSZÁS).',
    ],
  },
  {
    version: '2.5.241',
    date: '2026-10-31',
    changes: [
      'A frissítés 6%-nál/98%-nál való beragadásának javítása: a mentési és feldolgozási ciklus többé nem függ a webOS időzítőitől (a TV az időzítőket hosszú, gombnyomás nélküli letöltés alatt 60 másodpercenként egyszer engedte futni – a napló szerint a fő szál pontosan 60 000 ms-os periódusokban éledt fel, és a 206 adagos filmmentés örökre beragadt).',
      'Az ELTELT IDŐ óra a betöltő ablakban időzítő-fojtás alatt is jár (requestAnimationFrame-alapú tartalék).',
      'A frissítés nem tölti le feleslegesen az egész listát: az árva-katalógus őr mostantól csak kifejezett törlés-jelző esetén takarít – egy átmeneti tárolvasási hiba többé nem törölheti a teljes mentett katalógust.',
      'Kézi frissítés teljes letöltése alatt nem indul el magától az élő adás: a nézett csatorna félre van téve, és az ablak bezárásakor folytatódik.',
      'A betöltő ablak X gombja sima fehér (nem piros).',
      'A kézi napló ablak azonnal a helyi listát mutatja, és külön jelzi, amíg az utolsó 5 elküldött napló a szerverről frissül.',
    ],
  },
  {
    version: '2.5.240',
    date: '2026-10-31',
    changes: [
      'A fejléc TV / Menü / Sorozatok / Mozi ikonjai mostantól együtt színeződnek a távirányító 1–6 színgombjával (ugyanaz a hat szín, mint az óránál) – az ikonrajz részletei és árnyalatai megmaradnak.',
      'Az ikonok mögül a világos háttérkorong eltűnt – nincs többé fehér háttér a fejléc ikonjai mögött.',
    ],
  },
  {
    version: '2.5.239',
    date: '2026-10-31',
    changes: [
      'Teljes törlés javítva: az „Összes lista és tesztcsatorna törlése” mostantól MEGVÁRJA a tartós tár (IndexedDB) tényleges kiürülését, és csak utána tölti újra az appot – eddig a lassú TV-n a csatornák „visszajöttek”, miközben a szolgáltató már eltűnt.',
      'Árva katalógus önjavítás: ha induláskor van mentett csatornakészlet, de egyetlen szolgáltató sincs (félbemaradt törlés nyoma), az app kitakarítja a maradványt és üresen indul – nem tölti vissza a törölt listát.',
      'Új X gomb a betöltési ablak jobb felső sarkában: azonnal LEÁLLÍTJA a futó frissítést és bezárja az ablakot (a mentett tartalom marad). A gomb fókuszt kap, így az OK gomb is ezt nyomja – nem indítja újra a frissítést.',
      'Dupla gombnyomás-őr: amíg egy szolgáltató frissítése fut, az újabb Frissítés gombnyomás nem indítja elölről az egészet, csak újra megnyitja a folyamat ablakát.',
      'A kért teljes, elemenkénti ellenőrzés (2 percen belüli második Frissítés) is megerősítést kér indulás előtt – nagy letöltés soha nem indul Igen nélkül.',
      'Kézi napló időbélyeg javítva: a napló mostantól a TV saját időzónájában ír (eddig fixen ír idő szerint, ezért 1 órával eltért a faliórától).',
    ],
  },
  {
    version: '2.5.238',
    date: '2026-10-31',
    changes: [
      'SEMMI nem fut magától – a 12 óránkénti, magától induló teljes összevetés kikerült. Változatlan kategóriáknál a Frissítés mindig a gyors „nincs változás” választ adja, akármikor volt az utolsó teljes ellenőrzés.',
      'Teljes, elemenkénti összevetést kizárólag a néző indíthat: a gyors „nincs változás” után 2 percen belüli ÚJABB Frissítés gombnyomással. Ez találja meg a meglévő kategórián belüli új/törölt elemeket is.',
      'Minden más változatlan: változás észlelésekor a „Letöltsem a változásokat?” kérdés után csak Igen válaszra indul a különbség-letöltés (kedvencek, sorrend és törölt csatornák megmaradnak).',
    ],
  },
  {
    version: '2.5.237',
    date: '2026-10-31',
    changes: [
      'Visszatért a régi (2.5.210-es) GYORS kézi frissítés: a Frissítés gomb először csak a három kategórialistát kéri le (~44 kB, 1-2 mp). Ha a kategóriák nem változtak és az utolsó teljes összevetés 12 órán belüli, a frissítés azonnal kész – a nagy listák le sem töltődnek.',
      'Változás észlelésekor az alkalmazás RÁKÉRDEZ: „Letöltsem a változásokat?” – a letöltés csak az Igen válasz után indul, és csak a különbséget frissíti (a kedvencek, a sorrend és a törölt csatornák megmaradnak, semmi nem duplázódik).',
      'A gyors ellenőrzés ismert korlátja, hogy a meglévő kategórián BELÜLI új elemeket (darabszám-változást) nem látja – az Xtream API darabszámot csak a teljes indexlisták letöltésével ad. Ezt két védelem fedi le: 12 óránként a Frissítés teljes, elemenkénti összevetést futtat, és a gyors „nincs változás” után 2 percen belüli ÚJABB gombnyomás azonnal teljes összevetést indít.',
      'Semmi nem indul magától: minden ellenőrzés és letöltés kizárólag a kézi Frissítés gombnyomásra fut.',
    ],
  },
  {
    version: '2.5.236',
    date: '2026-10-31',
    changes: [
      'A fejléc TV / Menü / Sorozatok / Mozi gombjain az ikon a doboz tetejétől az aljáig ér, és világos háttérkorongot kapott, hogy a sötét ikonrajz jól kivehető legyen (a dobozok mérete változatlan).',
      'A Menü & Beállítások három fülén (Listák, Kedvencek, Rendszer) nagyobb az ikon, a felirat a doboz legaljára került – a fülek mérete változatlan, háttér ott nincs.',
      'A Mr Bean mappaikon kék képhátterét oldalra kiterjesztettük, így a kép az egész dobozt kitölti (nem maradnak üres sávok), mint a HBO Max és UK ikonoknál.',
      'Filmkártya játékidő-javítás: a „2 perc” hiba megszűnt – a kettőspontos idő (pl. 02:14) és a percet tartalmazó duration_secs mező is helyesen értelmeződik, és a hihető játékidő elsőbbséget kap a hibás kulcsok apró értékeivel szemben.',
      'A Mozi/Sorozat kártyán a MAGYAR hang mindig elöl jelenik meg, ha a szolgáltató adataiban szerepel; ismert hangnyelv híján „Angol” a felirat – lejátszás közben derül ki a valódi hangsávlista.',
    ],
  },
  {
    version: '2.5.235',
    date: '2026-10-31',
    changes: [
      'TV Doktor ikon javítva: az állapotgyűrű a doktor alakja MÖGÉ került (nem vágja el a fejét/vállát), és az ikon belső margót kapott, így hiánytalanul elfér a főoldali sor és a teljes képernyős sarok helyén.',
      'Frissítés: a MEGVÁLTOZOTT film/sorozat mostantól friss részletes adatot is kap (poszter, leírás, évadok) – eddig a régi, elavult részletadat maradt a tárban; a kereten túli változott elemeknél az elavult részletadat törlődik, és böngészés közben töltődik újra frissen.',
      'Első betöltés gyorsítása: az 1-es TV-napló szerint a letöltés alatt a háttérben elindult az élő adás (a nézett csatorna eltűnésekor az átállás megkerülte a visszatartást), és a HLS-lejátszás 4–10 mp-es főszál-leállásokat okozott. Mostantól a betöltés-figyelés alatt az átállás is félre van téve, az adás csak a betöltő bezárásakor indul.',
    ],
  },
  {
    version: '2.5.234',
    date: '2026-10-31',
    changes: [
      'A főoldali „TV” gomb a beküldött ezüst, kerek TV-ikont kapta (körformára kivágva, háttér nélkül).',
      'A takaróképen a „TV CSATORNÁK” feletti régi rajzolt tévé helyére is ugyanez az ezüst TV-ikon került.',
    ],
  },
  {
    version: '2.5.233',
    date: '2026-10-31',
    changes: [
      'A Beállítások menü Kedvencek fülének ikonja mostantól a FEKETE, kerek gomb a szívvel (körformára kivágva a beküldött képből) – nem a fehér szív.',
      'Import közben a „Folyamat megtekintése” választásnál a háttérben NEM indul el a TV-adás: minden erőforrás a letöltésé; az adás a betöltő bezárásakor indul el.',
      'A betöltési diagnosztika ELTELT IDŐ kijelzése perc:másodperc formátumú, másodpercenként frissül (kevesebb terhelés), és nagy terhelés utáni kihagyásnál is mindig a VALÓS eltelt időre ugrik.',
      'Gyorsabb frissítés: a friss indexlisták letöltése mostantól PÁRHUZAMOSAN fut a mentett katalógus beolvasásával (eddig egymás után futottak) – a kérések száma változatlan.',
      'A frissítés szakaszidői (kategóriák, tárolt katalógus beolvasása, indexletöltés, elemenkénti összevetés) bekerülnek a diagnosztikai naplóba – a következő lassú frissítésnél pontosan látszik majd, melyik lépés viszi az időt.',
    ],
  },
  {
    version: '2.5.232',
    date: '2026-10-31',
    changes: [
      'Új, harmadik kép ikonos kedvenc mappa: UK – a beküldött képből a hullámzó brit zászló, az „UK” felirat és a fehér pöttyökből kirakott országtérkép került az ikonra (az apró szöveg nélkül).',
      'Ugyanolyan nagy (96 px) és ugyanúgy működik, mint a Mr Bean és a HBO Max mappa; a három ikon egymás mellett is kényelmesen elfér a főoldali mappasávban.',
    ],
  },
  {
    version: '2.5.231',
    date: '2026-10-31',
    changes: [
      'Új: kép ikonos kedvenc mappák – a beküldött Mr Bean és HBO Max képekből egyforma, nagy (96 px) ikonok készültek.',
      'A kép ikonos mappa az „Új mappa” ablakban választható; ehhez nem kell nevet írni, a kép magáért beszél (a név automatikus).',
      'A főoldali mappasávban a kép ikonos mappák sokkal nagyobb, felirat nélküli képpel jelennek meg, és ugyanúgy működnek, mint a többi kedvenc mappa (csatornák bele rakhatók a ⭐ gombbal).',
      'Mindkét képből csak egy mappa hozható létre; a méretezés úgy készült, hogy egy harmadik, ugyanilyen méretű kép is elférjen mellettük.',
    ],
  },
  {
    version: '2.5.230',
    date: '2026-10-31',
    changes: [
      'A Beállítások menü három füle nagy, egyforma (56 px) ikont kapott, alattuk a felirattal: Listák = 3D jel-pajzs (a beküldött képből), Kedvencek = fényes szív (a beküldött képből), Rendszer = 3D fogaskerék (a takaróképről).',
      'Az új ikonok beágyazott, tömörített PNG-k (~6 KB összesen), az IPK mérete gyakorlatilag változatlan.',
    ],
  },
  {
    version: '2.5.229',
    date: '2026-10-31',
    changes: [
      'Új ikonok a felhasználó képeiből: a fejléc Mozi gombja a filmtekercs+csapó, a Sorozatok gomb a rendezői szék, a Menü gomb a 3D fogaskerék ikont kapta (átlátszó háttérrel, a takarókép kivágásaiból).',
      'A TV Doktor ikonja mostantól a beküldött kör alakú embléma (a doktor a fejével együtt, körbevágva); a zöld/ezüst állapotgyűrű és a kikapcsolt halvány megjelenés megmaradt.',
      'A takarókép (splash) bal oldali üres területére felkerült a TV Doktor emblémája – a kép mérete nem nőtt (tömörítve: 596 KB a korábbi 606 KB helyett).',
      'Az új ikonok beágyazott, tömörített PNG-k (összesen ~23 KB), így az IPK mérete gyakorlatilag változatlan.',
    ],
  },
  {
    version: '2.5.228',
    date: '2026-10-31',
    changes: [
      'A kézzel törölt csatornák tartós jegyzékbe kerülnek: a Frissítés gomb (és az újraindítás) többé nem hozza vissza őket. A jegyzék a lista újbóli hozzáadásakor ürül.',
      'A kézi csatornasorrend frissítéskor is megmarad (a meglévő csatornák a felhasználó sorrendjében, az újak a lista végén).',
      'Az alkalmazás mindig élő TV nézettel és az utoljára nézett csatornával indul – akkor is, ha kilépéskor a Mozi vagy a Sorozatok nézet volt nyitva. Ha az utolsó adó nem volt az induló magyar készletben, a teljes lista megérkezésekor magától visszaáll (ha a néző közben nem váltott).',
      'Szakaszolt indulás: előbb a főoldal (magyar induló készlet + utolsó csatorna), a felfedés után a teljes élő lista, majd a Mozi és a Sorozat 25-25 plakátjának előmelegítése, végül a műsorújság – egyszerre csak egy nagy munka fut.',
      'Mozi/Sorozat rács: kilépéskor a nézet az elejére áll vissza, és csak az első 25 poszter marad a memóriában; film/epizód indításakor a böngészési pozíció visszatéréskor megmarad. Görgetésnél az adag 15. poszterénél már töltődik a következő 25.',
    ],
  },
  {
    version: '2.5.227',
    date: '2026-10-31',
    changes: [
      'MINDEN automatikus letöltés megszűnt: az alkalmazás magától SOHA nem tölt le semmit – sem induláskor, sem napi/heti időzítéssel. A csatorna-, film- és sorozatlista kizárólag a Frissítés gomb megnyomásakor frissül.',
      'A 45 másodperces indulás utáni háttér-ellenőrzés és a hiányzó szakaszok automatikus letöltése kikerült: hiányzó tartalomnál a felület jelzi, hogy a Frissítés gombbal lehet letölteni.',
      'A Frissítés gomb mostantól MINDIG teljes, elemenkénti összevetést futtat (a napi egyszeri mélyösszevetési ablak megszűnt): a friss listák letöltése csak az összehasonlításhoz kell, a változatlan szakaszok nem íródnak újra a tárolóba.',
      'A Mozi poszterkártyák pontosan a Sorozatok kártyáinak elrendezését kapták: cím, év + játékidő egy sorban, hangsáv + feliratnyelvek egy sorban – más szöveg nincs a poszter alatt.',
    ],
  },
  {
    version: '2.5.226',
    date: '2026-10-31',
    changes: [
      'Napló kitisztítva: a tisztán mérési sorok (TÁVIRÁNYÍTÓ, SEBESSÉG, HOSSZÚ FELADAT, VOD-DIAG válasz-dumpok, IMPORT-API minták) kikerültek a hibajavító naplóból, és az előállításuk sem terheli a TV-t – a hibák, a TV Doktor és az import mérföldkövei továbbra is naplózva vannak.',
      'Első letöltés gyorsítása: a nagy listák tartós mentése átlapolt IndexedDB-írással és gyorsabb főszál-lélegzéssel fut (az 1-es naplóban a filmmentés 68,9 mp volt), a 20 elemes részletkör pedig időkeretet kapott.',
      'Indulás utáni visszatöltés gyorsítása: a tárolt film-/sorozatlista adagjai előreolvasással töltődnek (eddig a filmlista visszaolvasása ~1 perc volt) – ez NEM letöltés, a katalógus a TV tárolójából jön.',
      'Frissítés gomb: a gyors ellenőrzés mostantól a tárolt katalógus beolvasása NÉLKÜL fut le – változatlan szolgáltatónál pár másodperc alatt végez; a napi mély összevetés letöltése csak összehasonlításra szolgál, a tárolt lista nem íródik újra feleslegesen.',
    ],
  },
  {
    version: '2.5.225',
    date: '2026-10-30',
    changes: [
      'Első letöltés gyorsítása: a filmek és sorozatok tömeges listáinak feldolgozása új, egy menetes gyors úton fut (bitre azonos eredménnyel), így a 103 ezres filmlista feldolgozása a töredékére csökken.',
      'A filmlista tartós mentése (~25 mp a TV-n) mostantól a sorozatok letöltésével párhuzamosan, a háttérben fut – a 100% csak akkor jelenik meg, ha minden szakasz ténylegesen a tartós tárban van.',
      'IPK építés javítása: a webos/appinfo.json verziója szinkronban marad a web verzióval, és az újrapróbálkozó ág magától helyreigazítja az eltérést.',
    ],
  },
  {
    version: '2.5.224',
    date: '2026-10-30',
    changes: [
      'Frissítés gomb: már letöltött listánál először csak a ~44 kB-os kategória-ellenőrzés fut – ha nincs változás, a frissítés pár másodperc alatt végez, a több tíz MB-os listák nem töltődnek le újra (a teljes, elemenkénti összevetés naponta legfeljebb egyszer fut).',
      'Fagyásjavítás: az indulás utáni tárhely-tömörítés nem írja újra a teljes élő listát az IndexedDB-be (ez eddig 8-12 másodperces megakadást okozott), és a nagy mentések minden adag után visszaadják a vezérlést a felületnek.',
      'A betöltési diagnosztika ablakot a távirányító VISSZA gombja mostantól mindig bezárja – akkor is, ha a fókusz a Beállítások ablakban ragadt; a háttérben futó frissítés közben is.',
    ],
  },
  {
    version: '2.5.223',
    date: '2026-10-30',
    changes: [
      'VOD (Mozi és Sorozatok) memória-mentés nélküli TV Doktor üzemmód: valós idejű lejátszássegítés és pufferoptimalizálás akadásnál anélkül, hogy elmentené, melyik film vagy sorozat és hol akadt el.',
      '0-ás távirányító gomb (kizárólag a főoldalon és teljes képernyőn, élő TV lejátszásakor): nagy, olvasható 2 oszlopos TV Doktor ablak — bal oldalon a lefelé görgetve végigolvasható Legutóbbi TV Doktor naplóval, jobb oldalon az állandó állapot- és memóriaadatokkal, a jobb felső sarokban elérhető piros Memória: 0 törlés gombbal.',
      'Beállítások → Rendszer → TV Doktor doboz egyszerűsítése: kizárólag a Ki/Be kapcsoló és a feliratok jelennek meg.',
    ],
  },
  {
    version: '2.5.203',
    date: '2026-10-29',
    changes: [
      'Rendszer menü átrendezése: a TV Doktor első helyre került 3D zöld TV Doktor ikonnal, nagyobb és jobban olvasható feliratokkal, távirányítóval fókuszálható és lenyitható állapot-/naplópanellel, valamint a jobb sarokba helyezett Memória: 0 gombbal.',
      'Különálló, távirányítóval kezelhető Supabase-párosítás menüpont a TV Doktor alatt egyszeri 6 jegyű számkódos hitelesítéssel a védett TV Doktor adatok eléréséhez.',
    ],
  },
  {
    version: '2.5.195',
    date: '2026-10-29',
    changes: [
      '3D TV Doktor ikon (televíziót tartó kis doktor) a csatornasorokban a kedvenc csillag alatt és teljes képernyőn a jobb felső sarokban az óra előtt.',
      'TV Doktor működés kiterjesztése a VOD tartalmakra (filmek és sorozatok), valamint teljes képernyős, automatikusan eltűnő állapotablak aktív betöltés, pufferelés, hiba és újrapróbálkozás közben.',
    ],
  },
];
