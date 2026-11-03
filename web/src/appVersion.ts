export const WEB_VERSION = '2.5.275';

// A webOS kezelő (webos.js) innen olvassa a verziót a SÁRGA gombos
// kézi diagnosztikához - így az mindig a valóban futó kiadást mutatja.
try { (window as unknown as { IPTV_RT_WEB_VERSION?: string }).IPTV_RT_WEB_VERSION = WEB_VERSION; } catch { /* SSR/teszt környezetben nincs window */ }

// A build a legfrissebb bejegyzés verzióját is szinkronizálja. A régi történet a Gitben marad.
export const WEB_VERSION_HISTORY = [
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
