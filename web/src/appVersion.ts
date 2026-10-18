export const WEB_VERSION = '2.3.1';

export const WEB_VERSION_HISTORY = [
  {
    version: '2.3.1',
    date: '2026-10-18',
    changes: [
      "Kizárólag LG webOS TV-re készült alkalmazás",
      "Kisebb TV lejátszó webOS-re: 1280x720 alap, 1920x1080-ra skálázódik, kevesebb erőforrás, gyorsabb indulás",
      "Gyors betöltés webOS-en: csak élő TV először (1 kérés), VOD kategóriák gyorsan, film/sorozat tartalom lusta (Mozi/Sorozat menüre töltődik)",
      "Fekvő indítóképernyő LG TV-re: 1920x1080 intro_landscape.mp4 + splash.png",
      "webOS Magic Remote támogatás: Back (461) → Escape, Channel Up/Down, színes gombok, média gombok, Relaunch",
      "IPK csomag: ar archive (debian-binary 2.0, control.tar.gz, data.tar.gz) → /usr/palm/applications/hu.rt.iptv.webos/",
      "IPK-kimenet kizárólag ebben a repóban: webos/IPTV-RT-webOS-2.3.1.ipk",
      "GitHub Release verzióellenőrzés LG webOS-en; az IPK telepítése webOS fejlesztői eszközzel történik.",
    ],
  },
  {
    version: '1.24.0',
    date: '2026-10-17',
    changes: [
      "Gyorsított betöltés a teszt alapján (20k csatorna, 40k film, 15k sorozat 102s volt): most ~40-50% gyorsabb, router és szolgáltató kímélésével",
      "Filmek/sorozatok: először egyben próbálja lekérni (get_vod_streams / get_series kategória nélkül) – 23 kérés helyett 1, ~9s nyereség",
      "Ha egyben nem megy, kategóriánként 2 concurrent kéréssel (korábban 1), gap 120ms->80ms, továbbra is circuit breaker 4 hiba után 60s cooldown",
      "Feldolgozás ritkítva: PROGRESS_UPDATE 250->500, UI_YIELD 100->500, requestIdleCallback használattal – 86s feldolgozás jelentősen csökkent, nem fagy le a telefon",
      "Incremental UI frissítés: 2000 filmenként / sorozatonként már mutatja a részeredményt, nem kell a végéig várni",
      "Élő TV továbbra is 1 kérés, gyors marad – nem változott",
    ],
  },
  {
    version: '1.23.0',
    date: '2026-10-17',
    changes: [
      "Élő TV főoldal dupla kattintás -> álló teljes képernyő 16:9 keret, kép nem fekete – javítva natív bounds szinkron 8x újrapróbálással",
      "Élő TV álló fullscreen: egy kattintás OSD fel és eltűnik beállítás szerint, dupla gyors kattintás vissza főoldalra",
      "Élő TV álló fullscreenből elforgatva fekvőbe van kép (korábban fekete volt) – javítva orientáció váltás szinkron",
      "Élő TV fekvő fullscreen: egy kattintásra semmi, dupla kattintás vissza főoldalra",
      "Mozi/sorozat álló: egy kattintás OSD fel és beállítás szerint eltűnik, semmi más érintés nem működik",
      "Mozi/sorozat fekvő: semmilyen kattintásra semmilyen funkció nem aktiválódik",
      "Beállítások Rendszer alól kivéve képernyő méretezés és utolsó csatorna indításkor – mindig fill nyújtás és mindig autoPlay utolsó csatorna",
      "Főoldal jobb felső piros X gomb: csak piros X, nincs kerek piros háttér",
    ],
  },
  {
    version: '1.22.0',
    date: '2026-10-17',
    changes: [
      "Teljesen reszponzív felület: telefon, tablet, laptop, TV (1920px+) – minden képernyőméreten alkalmazkodik a kinézet",
      "Egér támogatás: kattintás, dupla kattintás teljes képernyő, egér mozgásra OSD megjelenés, görgő, hover effektek laptopon és TV-n",
      "TV távirányító és billentyűzet: nyilak csatornaváltás, bal/jobb hangerő és tekerés VOD-nál, Enter lejátszás, Esc/Back kilépés modálból és teljes képernyőből, F teljes képernyő, M némítás",
      "Csatornalista billentyűzettel navigálható (fel/le nyíl, Enter/Space választás), fókusz gyűrű, görgetősáv látható desktopon",
      "Mozi/sorozat rács: 2 oszlop telefonon, 3-8 oszlop tablet/laptop/TV-n, kártyák billentyűzettel elérhetők",
      "Minden modal reszponzív: telefonon teljes, tableten és laptopon szélesebb, TV-n extra széles, egérrel görgethető",
      "Fejléc és beállítások reszponzív: nagyobb gombok tableten/laptopon/TV-n, fókusz gyűrű, egér hover",
    ],
  },
  {
    version: '1.21.2',
    date: '2026-10-17',
    changes: [
      "Élő TV hiba esetén az Újrapróbálás gomb a mostani pufferelési beállítás (Stabil) logikája alapján tölti újra a csatornát – többszöri újra pufferelés segít betölteni",
    ],
  },
  {
    version: '1.21.1',
    date: '2026-10-17',
    changes: [
      "Mozi/sorozat álló teljes képernyő: 16:9 kép keret ugyanúgy mint élő TV-nél állóban, csak abban játszik a film – nem tölti ki az egész álló képernyőt; fekvőben továbbra is teljes képernyő jó",
    ],
  },
  {
    version: '1.21.0',
    date: '2026-10-17',
    changes: [
      "Élő TV hangsáv váltás azonnali: VOD logika átvéve, automatikus egyszeri újratöltés a kiválasztott hanggal (nem kell buffer módot váltani)",
      "Bejelentkező videó nem változtatja a rendszer hangerőt, végig a telefon beállított hangján játszik; TV-nél sem változik hangerő csatornánként",
      "OSD-kből Kép menü gomb eltávolítva mindenhol",
      "Fekvő teljes képernyő élő TV-nél érintésre teljesen inaktív – nem jelenik meg kép átméretezés",
      "Mozi/sorozat felirat olvasható stílus: vastag fekete körvonal, árnyék, nagyobb betű",
      "Natív lejátszó hiba napló csak Másolás gombbal kerül vágólapra, megnyitáskor nem",
      "Főablakban csak kiválasztott ország/kategória csatornái jelennek meg, pl. Magyarország 105 csak; Angolnál kategóriára kattintva csak annak csatornái",
      "Teljes képernyőről vissza a főoldalra nem ugrik tetejére, marad a kiválasztott csatornánál",
      "Mozi/sorozat CC gomb görgethető, réteg hiba javítva",
      "Mozi/sorozat működés összekötve a menü Rendszer mozi és sorozat beállításaival (tekerés, auto következő rész, preferált hang/felirat, felirat méret)",
    ],
  },
  {
    version: '1.20.0',
    date: '2026-10-16',
    changes: [
      "Élő TV hangsávváltás: a hang azonnal átvált (a lejátszó a kért hangsávhoz igazítja az élő gyorsítótárat, és ha kell, a streamet is újratölti a kért hangsávval) – korábban a buffelt 20+ másodperc lejátszása után váltott csak át",
      "Film/sorozat indításakor nem marad a képernyőn az élő adás utolsó, mozdulatlan képe",
      "Fekvő teljes képernyő: a kép mindenütt a Beállításokban választott képmódot követi (Illesztés / Kitöltés / Nyújtás) – élő TV-nél sem vágja le a csatorna logót, és film/sorozat közben is a teljes képernyőt használja",
      "Csatornalista: csak a látható sorok rajzolódnak ki (ugyanaz a kinézet és görgetés), így 20 000+ csatornánál sem fagy le a telefon",
      "A film/sorozat lista szűrése és a hangsáv-keresés gyorsítótárazva; az EPG-gyorsítótár mérete korlátozva – a nagy szolgáltatói listák utáni akadozás megszűnt",
      "Forráskód tisztítás: nem használt fájlok és függvények eltávolítva, a felesleges háttérmunkák (másodpercenkénti teljes lista-keresés, folyamatos tárolóírás) megszüntetve",
    ],
  },
  {
    version: '1.19.1',
    date: '2026-10-13',
    changes: [
      "Indulási hiba javítva: „Cannot access 'ot' before initialization” – a teljes képernyős OSD magasságát mérő kód a változója deklarációja előtt futott, ezért az app nem indult el",
      "A füstteszt (kiadás előtti ellenőrzés) mostantól kifejezetten figyeli a hibahatár-képernyőt: ilyen hiba nem mehet ki többé a telefonra",
      "Új „TV-re küldés teszt” a Beállítások → Hibakeresési napló ablakban: kilistázza a wifi hálózaton látható Cast-képes TV-ket és a Cast állapotát",
      "A hibakeresési napló érintésre/görgetésre nem másol semmit a vágólapra – csak a „Napló másolása” gomb, és csak a látható szöveget",
    ],
  },
  {
    version: '1.19.0',
    date: '2026-10-13',
    changes: [
      "Google Cast javítás: a „TV-re küldés” gomb többé nem lépteti ki az alkalmazást, és megmutatja az ugyanazon a wifi hálózaton elérhető TV-ket (az LG beépített Chromecastjával is)",
      "Teljes képernyőn is a főoldali kék vezérlőpanel jelenik meg – élő TV-nél és film/sorozat közben is –, a Beállításokban megadott automatikus elrejtéssel (Ki = nem tűnik el)",
      "Film/sorozat OSD: csúsztatható idővonal, tekerés, hang- és feliratválasztás, TV-re küldés, kép a képben",
      "Gyorsabb web lejátszó: gyorsabb indítás, az élő késés ledolgozása, automatikus újracsatlakozás megállt lejátszásnál",
      "A natív kép nem méreteződik újra feleslegesen (nincs „össze-vissza” ugrálás)",
      "A Beállítások gombja a Rendszer fület nyitja (korábban üres panel jelent meg)",
    ],
  },
  {
    version: '1.18.6',
    date: '2026-10-04',
    changes: [
      "Publikálható webfrissítés: a jóváhagyott 1.18.3-as csomag archiválható, az új csomag külön verzióként ellenőrizhető és publikálható",
    ],
  },
  {
    version: '1.18.5',
    date: '2026-10-04',
    changes: [
      "Publikálható webfrissítés: a jóváhagyott 1.18.3-as csomag archiválható, az új csomag külön verzióként ellenőrizhető és publikálható",
    ],
  },
  {
    version: '1.18.4',
    date: '2026-10-04',
    changes: [
      "OSD láthatóság javítása",
      "A csatornaválasztás kezelése elkülönítve az OSD-től",
    ],
  },
  {
    version: '1.18.3',
    date: '2026-10-04',
    changes: [
      "A kézi „ÚJRAPRÓBÁLKOZÁS MOST” gomb nullázza az automatikus újrapróbálkozások számlálóját, így azután ismét próbálkozik magától",
    ],
  },
  {
    version: '1.18.2',
    date: '2026-10-04',
    changes: [
      "Ha a szolgáltató szervere nem válaszol (a kapcsolat létrejön, de válasz nem érkezik), a program ezt érthetően megmondja – és jelzi, hogy nem a telefon vagy a router a hibás",
      "Automatikus újrapróbálkozás: szolgáltatói hiba esetén percenként egyszer magától újrapróbálja (legfeljebb háromszor), így magától helyreáll, amikor a szerver visszatér",
      "Újrapróbálkozás gomb a hibaüzenetnél (azonnali próba)",
      "Az alkalmazás a WebView pontos hálózati hibakódját is átadja (net::ERR_…), amiből a program megkülönbözteti a DNS-hibát, a nem válaszoló szervert és a blokkolt kapcsolatot",
      "Ha a http:// port nem válaszol gyorsan, a program egyszer a https (titkosított) portot is megpróbálja",
      "Rövidebb időtúllépések: 10 s (bejelentkezés, EPG), 30 s (nagy listák) – egy elakadt kérés nem foglalja sokáig a kapcsolatot",
    ],
  },
  {
    version: '1.18.1',
    date: '2026-10-04',
    changes: [
      "Hálózatkímélő üzemmód: a szolgáltatói kérések SORBAN, egymás után futnak (egyszerre egy kapcsolat), kis szünettel – így nem terheli túl az otthoni routert",
      "Megszakító (circuit breaker): ha a szerver néhányszor nem válaszol, a program egy percig nem indít új kapcsolatot, hanem azonnal hibaüzenetet ad (nem pörög, nem fagyasztja le a routert)",
      "Legfeljebb 2 próbálkozás kérésenként, csak 429/szerverhiba esetén; hálózati elakadásnál nincs ismételt próba",
      "Rövidebb időtúllépések (12–45 s a korábbi 15–120 s helyett), hogy egy elakadt kérés ne foglalja a kapcsolatot",
      "Ha egymás után 4 kategória sem jön be, a betöltés leáll, és a korábban letöltött lista marad érvényben",
      "Hálózati hiba esetén a program megvizsgálja, hogy az internet maga működik-e, és megmondja, ha valószínűleg az internetszolgáltató (Wi-Fi) blokkolja a szervert",
      "A webes felület frissítése egy futáson belül csak egyszer tölti újra az oldalt, és legfeljebb két alkalommal próbálkozik újra",
    ],
  },
  {
    version: '1.18',
    date: '2026-10-04',
    changes: [
      "Gyorsabb betöltés: a csatornalista azonnal megjelenik, a filmek és sorozatok utána töltődnek (szakaszonkénti frissítés)",
      "Párhuzamos letöltés a szolgáltató kapcsolatlimitjéig (induláskor 2, legfeljebb 4 kérés) – a 429-es válaszból automatikusan tanul",
      "A filmek/sorozatok letöltése megáll, amikor már megvan a maximális darabszám (nagy listáknál feleannyi adat)",
      "EPG műsorújság javítva: valódi műsorok, kereshető csatornaválasztó, most/következő műsor az aktív csatornánál",
      "Vágólap-védelem: a diagnosztika előnézete nem jelölhető ki, a vágólapra kizárólag a MÁSOLÁS gomb ír, az alkalmazás a natív kijelölést is tiltja",
      "M3U/M3U8: link, fájlválasztás és teljes lista beillesztése is importálható",
      "Csatornaváltás: ha a beépített lejátszó 6 másodperc alatt nem indul el, automatikusan a natív lejátszó veszi át",
      "Biztosabb web-frissítés: ha induláskor nincs internet, a program később újrapróbálja",
      "Keep diagnostic error progress accurate",
      "Fix series progress display syntax",
      "Fix diagnostic progress template strings",
      "Fix diagnostic progress interpolation",
      "Improve diagnostic loading progress accuracy",
      "Block native text selection in diagnostics",
      "Persist GitHub web update across app restarts",
    ],
  },
  {
    version: '1.17',
    date: '2026-10-04',
    changes: [
      "Keep diagnostic error progress accurate",
      "Fix series progress display syntax",
      "Fix diagnostic progress template strings",
      "Fix diagnostic progress interpolation",
      "Keep diagnostic progress accurate on errors",
      "Improve diagnostic loading progress accuracy",
      "Block native text selection in diagnostics",
    ],
  },
  {
    version: '1.16',
    date: '2026-10-04',
    changes: [
      "Prevent native clipboard selection in diagnostics",
    ],
  },
  {
    version: '1.15',
    date: '2026-10-04',
    changes: [
      "Betöltés javítása: a filmek és sorozatok teljes listája letöltődik (a szolgáltató kapcsolatkorlátja miatt korábban hiányos/üres maradt)",
      "Kéréssor + automatikus újrapróbálkozás a szolgáltatói kapcsolathoz (egyszerre egy kérés, 429/5xx esetén újra)",
      "A betöltés szigorúan soros: élő csatornák → filmek → sorozatok",
      "A hiányos betöltés mostantól figyelmeztetést ad a betöltés végén",
      "M3U: egyedi film-azonosítók, gyorsabb kategóriafeldolgozás, hiányjelzés",
    ],
  },
  {
    version: '1.14',
    date: '2026-10-04',
    changes: [
      "Prevent incidental clipboard copies in diagnostics",
      "Restore 1.1.1 live channel loading order",
    ],
  },
  {
    version: '1.13',
    date: '2026-10-04',
    changes: [
      "Restore network diagnostic sink compatibility",
      "Fix build compatibility for network diagnostics",
      "Restore exact Xtream network logic from IPTV-RT-1.1.1",
    ],
  },
  {
    version: '1.12',
    date: '2026-10-04',
    changes: [
      "Restore Xtream channel loading from IPTV-RT-1.1.1",
    ],
  },
  {
    version: '1.11',
    date: '2026-10-04',
    changes: [
      "Fix proxy endpoint URL construction",
    ],
  },
  {
    version: '1.10',
    date: '2026-10-04',
    changes: [
      "Restore proven Xtream network connection logic",
    ],
  },
  {
    version: '1.9',
    date: '2026-10-04',
    changes: [
      "Fix HTTP fallback order for Xtream and tests",
      "Fix HTTP IPTV proxy fallback and keep native direct requests",
      "Try IPTV HTTP proxies before direct WebView connection",
    ],
  },
  {
    version: '1.8',
    date: '2026-10-04',
    changes: [
      "Fix configured CORS proxy URL handling",
    ],
  },
  {
    version: '1.7',
    date: '2026-10-04',
    changes: [
      "Fix Xtream HTTP fallback for LG webOS TV",
    ],
  },
  {
    version: '1.6',
    date: '2026-10-04',
    changes: [
      "Reset web release history before real channel fix",
      "Use fetch when XMLHttpRequest is unavailable",
      "Use XHR for Xtream requests on LG webOS TV",
      "Restore Xtream network fallback from known working state",
    ],
  },
  {
    version: '1.5',
    date: '2026-10-04',
    changes: [
      'EPG megjelenítés és előtöltés',
      'Betöltési diagnosztika és Xtream betöltési javítások',
      'GitHub webfrissítés és lejátszó stabilitási javítások',
    ],
  },
] as const;
