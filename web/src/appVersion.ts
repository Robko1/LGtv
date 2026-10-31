export const WEB_VERSION = '2.5.240';

// A webOS kezelő (webos.js) innen olvassa a verziót a SÁRGA gombos
// kézi diagnosztikához - így az mindig a valóban futó kiadást mutatja.
try { (window as unknown as { IPTV_RT_WEB_VERSION?: string }).IPTV_RT_WEB_VERSION = WEB_VERSION; } catch { /* SSR/teszt környezetben nincs window */ }

// A build a legfrissebb bejegyzés verzióját is szinkronizálja. A régi történet a Gitben marad.
export const WEB_VERSION_HISTORY = [
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
