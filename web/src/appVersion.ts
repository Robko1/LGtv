export const WEB_VERSION = '2.5.406';

// A webOS kezelő (webos.js) innen olvassa a verziót a SÁRGA gombos
// kézi diagnosztikához - így az mindig a valóban futó kiadást mutatja.
try { (window as unknown as { IPTV_RT_WEB_VERSION?: string }).IPTV_RT_WEB_VERSION = WEB_VERSION; } catch { /* SSR/teszt környezetben nincs window */ }

// A build a legfrissebb bejegyzés verzióját is szinkronizálja. A régi történet a Gitben marad.
export const WEB_VERSION_HISTORY = [
  {
    version: '2.5.406',
    date: '2026-11-09',
    changes: [
      'AZ UTOLSÓ KÉRÉS: CSAK KÉZI NAPLÓ, CSAK A NATÍV TAKARÓKÉP, GYORS IPK-INDULÁS — A felhasználó élő TV-mérése szerint a 2.5.405 / #49 „kétszer annyi idő” alatt indította az IPK-t, és „már van takaró kép, nem kell még egy”. Ezért a 2.5.406 NEM építi újra a programot, hanem CÉLZOTTAN visszaállítja a bevált gyors boot útvonalat: `TEST_STARTUP_DIAGNOSTICS = false` (az automatikus kézi hiba naplózás KIKAPCSOLVA, csak a SÁRGA gomb / kézi indítás gyűjt), a `diagnosticsBootstrap` nem indít naplót, csak passzív crash-handlereket telepít; a `web/index.html` második `#tv-curtain` rétege, a hozzá másolt `splash-screen.png` háttér és a 14 s vészfogó ELTÁVOLÍTVA (a webOS natív `splash-screen.png` változatlanul megmarad); `App.tsx` / `epgGuide.ts` `bootDataReady` / `restoreHuGuideForBoot` / `__IPTV_BOOT_DATA_READY__` boot-kapui kikerültek; `main.tsx` újra `VIDEO_WAIT_MS=0`, `LOGO_WAIT_MS=0`, 1,5 s gyors háló, 3,5 s tároló-háló, 9 s kemény korlát, az első React gyermeknél PONTOSAN EGYSZER `notifyAppLoaded` (webOSSystem + PalmSystem), és az `iptv-app-ready` ismét a felfedés UTÁN megy ki, hogy a háttérmunka ne versenyezzen az első kifestéssel. A hangzár (`__IPTV_AUDIO_GATE__` → `iptv-audio-open`), az `iptv-revealed` / `__IPTV_APP_READY__` kész-jelzők, a #50 TV-helyi kártyaóra, a #46 / 16 variáns, az EPG, a feliratok, a kézi SÁRGA / Dublin napló, a 8 tanulási doboz, az 1-es ALAP, a `Memória: 0`, a `notifyCount===1`, a `lastSyncText` és a teljes 2.5.406 #51/#52 élőadás-védelem VÁLTOZATLANUL megmaradtak.',
      'A #51 / #52 SUPABASE-NAPLÓK PONTOS OKA — MI ALAPJÁN GONDOLTA HIBÁNAK A MŰKÖDŐ ADÁST? A két TV Doktor napló (`public.tv_doctor_log_shares`, #51 `d9a800c4…` 14 963 char / #52 `f047f578…` 12 617 char, mindkettő 2.5.404, TS + balanced) ugyanazt mutatja: 55 s / 30 s BIZONYÍTOTT lejátszás után a webOS raw-TS demuxer hirtelen `currentTime=duration=55.72 s / 31.65 s; paused=true; ended=true` állapotot adott, miközben `media_error=-`, `readyState=4`, `networkState=1` és `buffered_tartományok=[0.00-Infinitys]` volt. A `playbackRecovery.ts: isUnexpectedLiveEnd()` eddig PUSZTÁN az `ended` flagből ítélt, a `VideoPlayer.tsx` `durationchange` (azonnali + 1500 ms tartós), `pause` és `ended` kezelői pedig a `notifyTvDoctorIncident()` „BIZONYÍTOTTAN MŰKÖDŐ CSATORNA – nincs javítási létra, csak újracsatlakozás” korai return-ja UTÁN is KÜLÖN hívták a `requestRecoveryRef`-et: a létra elmaradt, de a RELOAD nem. Ezért jött ~100 ms múlva `MEDIA_EMPTIED → WAITING → LOADSTART → LOADEDMETADATA → CANPLAY → PLAYING` 0.00 s-ről, `döntések=0; javítási_lépések=0` mellett, és ezért maradt a képen az „Újracsatlakozás / Adás frissítése (1. próba)…” felirat. A #51-ben ráadásul a `MEDIA_STALLED` 25,30 s puffer-előre mellett jött, közben a `currentTime` 6,70 → 32,17 → 54,44 s-ig haladt, mégis 47 746 ms-es „pufferelési epizódot” írt a mérés, mert nem érkezett új `playing` esemény: a pufferelést is egy LETÖLTÉSI eseményből, nem a tényleges lejátszás megállásából következtettük.',
      'A JAVÍTÁS: BIZONYÍTÉK KELL, NEM CSAK AZ `ended` FLAG — Új, DOM-független `playbackRecovery.ts: isWebOsLiveEndArtifact()` / `LiveEndEvidence`: a véges élő idővonal csak akkor számít adatfolyam-hibának, ha nincs hozzá friss (<2,5 s) idővonal-haladás, ≥15 s bizonyított lejátszás, `readyState>=3`, nem üres puffer (a webOS `Infinity` puffer-végét külön, `unboundedBuffer` jelzővel kezeljük) ÉS nincs `video.error` / `NETWORK_NO_SOURCE`. A #51/#52 összes mért értéke mellett ez a feltétel teljesül, ezért a 4 médiaesemény-kezelő a közös `suppressLiveEndArtifact()` segédfüggvénnyel NEM tölti újra a forrást; ehelyett 1500 ms-ig HELYBEN próbálja folytatni ugyanazt a médiaelemet (`currentTime` a jelenlegi pozíción, `play()`), és csak akkor engedi a megszokott `notifyTvDoctorIncident` + `requestRecovery` útvonalat, ha az adás MEGERŐSÍTETTEN leállt. A döntés generációval védett, így a felhasználói csatornaváltás, a VOD, a kikapcsolt TV Doktor, a valódi `buffer_stall` / `playback_stall` / `media_error` és a 2.5.403-as 16 variánsos javítás VÁLTOZATLANUL a régi úton fut. A napló most pontosan megmondja: „WEBOS ÉLŐ IDŐVONAL-ARTEFAKT – NINCS ÚJRACSATLAKOZÁS” / „ÉLŐ ADÁS HELYBEN FOLYTATÓDOTT – nincs újratöltés, nincs visszatekerés”.',
      'A ~10 MP VISSZATEKERÉS ÉS A KÉPELTŰNÉS–VISSZATEKERÉS CIKLUS ELLEN — A felesleges reload volt a visszatekerés oka: az új TS-kapcsolat a szolgáltató utolsó ~10 s-ét 0.00 s-ről játszotta újra (#51: `MEDIA_PLAYING currentTime=0.00`, majd 0,88 → 6,70 → 32,17 → 54,44 s). Most a megerősítés külön ellenőrzi, hogy a folytatás NEM ugrott vissza (`noRewind`), és a ténylegesen szükséges újracsatlakozásnál az eddig csak HLS-re futó élő-él ugrást általánosítottuk: az új `liveEdgeTarget()` a `seekable` / `buffered` VÉGES tartományából az élő élre áll, a `Infinity` véget (#51/#52) pedig ELVETI, mert az nem seekelhető – ilyenkor nem erőltetünk visszaugrást/nullázást. Három próbálkozás / `playing` után a figyelőket levesszük, nincs ismétlődő seek-ciklus.',
      'NINCS TÖBBÉ OTT MARADÓ FELIRAT, SEM HAMIS „PUFFERELÉSI PROBLÉMA” — A `showDoctorStatus()` minden átmeneti fázisához (buffering / retry / repair / verifying) 12 s-es legfelső élettartam tartozik, a tényleges `playing` a `retry` („Adás frissítése (1. próba)…”) feliratot is AZONNAL elrejti, az „Újracsatlakozás…” pörgőnek is van saját lezáró ideje. A `scheduleDoctorBufferingStatus()` 8 s-nél nagyobb puffer-előre + `readyState>=3` mellett nem is indítja el a sárga feliratot (a #51 25,30 s-es `stalled`-je ilyen volt); a haladás nélküli VALÓDI fagyást továbbra is a puffer-őr és a `buffer_stall` riasztás jelzi. A `tvDoctor.ts` kézi TV Doktor mérése most a `timeupdate` eseményből, a rögzített `currentTime` / dekódolt képkockaszám alapján zárja le a pufferelési epizódot (`idővonal haladt (nincs lejátszási szünet)`), nem vár egy esetleg soha be nem jövő `playing`-re: a #51 47 746 ms-es hamis epizódja megszűnik, a valódi, haladás nélküli megakadás változatlanul a `playing` eseménynél zárul. A 8 tanulási doboz, az 1-es ALAP, a feliratok, a kézi SÁRGA / Dublin napló, `Memória: 0`, `notifyCount===1`, `lastSyncText`, `__IPTV_AUDIO_GATE__=true`, a 16 variáns NEM változott; a 2.5.405 8/12/14 s boot kapuit viszont a jelen kiadás utolsó, felhasználói kérése CÉLZOTTAN visszaállította a gyors 0/1,5/9 s útvonalra (lásd az első bejegyzést).',
      'TESZTEK — Új `tools/test-tv-doctor-live-end-406.mjs` (47. tesztcsoport): valódi esbuild futásidejű ellenőrzés a #51/#52 mért bizonyítékaira és az összes ellenpéldára (`video.error`, `NETWORK_NO_SOURCE`, `readyState=2`, üres puffer, 4 s-nél régebbi haladás, nem bizonyított csatorna, `Infinity` puffer-előre), az élő-él seekre (12 s-es ablak → 11,25 s, több tartomány, `Infinity`/`NaN`/üres/idegen tartomány elvetése), VALÓDI TV Doktor telemetria futtatása (25,30 s puffer melletti `stalled` → `timeupdate` 6,70 → 32,17 s → epizód azonnal zárul; változatlan idővonalú valódi megakadás → `playing`-nél zárul), valamint forrásszinten mind a 4 eseménykezelő, az overlay-életciklus, a generációs védelem, a `noRewind` őr, a TS/HLS élő-él és a nem-regressziós útak. Érvényesítés: az új teszt 72/72, `npm test` 47/47 (TV Doktor 171/0) – a gyors boot / kézi napló / #50 óra / 16 variáns / VOD / Supabase kör tesztjeit is a végleges forrásra frissítettük –, `npm run smoke` OK (`notifyAppLoaded: 1x`, `appReady=igen`, `audioGate=nyitva`), `npx tsc --noEmit` 21 ismert baseline hiba / 0 új (a korábbi 2.5.406 futtatással soronként egyezik, csak az App.tsx sorszámai tolódtak), `git diff --check` tiszta, Vite 1 906,90 kB / gzip 757,32 kB, `tools/build-webos.sh` → 2.5.406 IPK 1573 KB. A `tv-doctor` Edge Function forrása és a deployed v19 változatlan; a v19 → v20 deploy, a 2.5.406 IPK TV-re telepítése és a #51/#52-höz hasonló élő visszamérés továbbra is a felhasználónál történik (a ~10 mp-es visszatekerésről nem készült napló, azt a mostani reload-megszüntetés és az élő-él guard fedi le).',
    ],
  },

  {
    version: '2.5.405',
    date: '2026-11-09',
    changes: [
      'A #49 RENDSZERNAPLÓ SORONKÉNTI BIZONYÍTÉKA — A 2.5.404 / 505 soros diagnosztikai naplóban a `TAKARÓKÉP ÖSSZEGZÉS [+805 ms]` még `videó-kész=nem; teljes lista=igen; iptv-app-ready következik` állapotban engedte el a natív splash-t (`INDULÁS [1159 ms] … webOS notifyAppLoaded: #root gyermekek=1; híd=nincs`). A `HTML JELZÉS +1502 ms REVEAL` után az első videó-képkocka csak `+7833 ms`-nél jött meg (`kész=4`), a `FAST BOOT EPG` `00:05:29.946`-kor, a 70/80-as `EPG-ÁLLAPOT` `00:05:44.715`-kor, a `TÁROLÓ-JELENTÉS (a felfedés után)` `00:05:24.718`-kor futott; az első 8 s-ben 29 képkocka-kihagyás / max 1017 ms. Ezért látszott a takarókép után fokozatosan összeállni a főoldal. A hiba NEM a 9 s-es korlát volt, hanem a `VIDEO_WAIT_MS=0`, a `prepaintSettled()=>true`, az 1,5 s-es gyors háló, a korai `notifyAppLoaded` és az `iptv-app-ready` felfedés UTÁNI kiküldése.',
      'A #49 JAVÍTÁS: HOSSZABB TAKARÓKÉP, UTÁNA EGYETLEN VILLÁMGYORS VÁLTÁS — A `main.tsx` most a VALÓDI kész-kapukra vár: `bootDataReady` (csatornák, kedvencek, mentett HU EPG), `listOk`, `logosSettled` és az első KIRAJZOLT videó-képkocka (`VIDEO_WAIT_MS=8000`, a #49 mért +7,8 s-e alapján); a kemény korlát 9 s → 12 s, az 1,5 s-es gyors háló pedig CSAK akkor enged, ha a videó és az adatok is készek. A `notifyAppLoaded` (webOSSystem + PalmSystem) most PONTOSAN EGYSZER, a felfedés pillanatában fut, nem az első React gyermeknél. Az `iptv-app-ready` a felfedés ELŐTT megy ki. Az `index.html` új `#tv-curtain` rétege ugyanazt a `splash-screen.png`-et mutatja tovább, ha a platform korábban levenné a natív PNG-t; a `reveal()` egyetlen DOM-eltávolítással, fade nélkül fed fel. A 3,5 s-es tároló-próba háló sem engedhet többé félkész főoldalt (ugyanazok a kapuk kellenek), és az `index.html` 14 s-es ES5 vészfogója akkor is leveszi a takarót, ha a bundle teljesen elakadna. A #24 óta kikapcsolt indulási hangzárat visszaállítottuk (`__IPTV_AUDIO_GATE__` → `iptv-audio-open`), hogy a hosszabb takaró alatt ne szóljon hang kép nélkül; a `webos.js` 15 s-es diagnosztikai őre és a stale 9 s / 12 s kommentek is a tényleges 12 s + 14 s korlátokra lettek frissítve.',
      'A MENTETT HU MŰSORÚJSÁG IS A TAKARÓKÉP ALATT KÉSZÜL EL — Új `epgGuide.restoreHuGuideForBoot()` csak a HELYI, mentett HU EPG-t olvassa vissza (nincs 1,9 MB letöltés / 10 MB feldolgozás az induláskor), az `App.tsx` ezt a boot-próba végén, a felfedés ELŐTT futtatja és frissíti az EPG-nézetet; a hálózati HU-frissítés változatlanul késleltetve, a már látható műsorok megtartásával fut. A `finally` ágban beálló `__IPTV_BOOT_DATA_READY__` adja a `main.tsx` új kapuját. A kézi SÁRGA napló fejléce a 13. ellenőrzési pontként sorolja fel az új kapukat és a 12 s korlátot.',
      'A #50 IDŐELTÉRÉSÉNEK OKA ÉS JAVÍTÁSA — A #50 TV Doktor napló (`00:05:33…+00:00`) és a fejléc sárga órája (`01:05`) közötti 1 óra NEM Supabase-hiba: a napló fixen `Europe/Dublin` (`appLog.ts dateTimeText`), a fejléc pedig a TV rendszer-helyi `getHours()` idejét mutatja. A bal felső 4 kártya `Mikor:` sora viszont ugyanazt a Dublin-formázót használta, ezért mutatott 1 órával kevesebbet. Új `clock.ts` `formatDeviceClock()` / `formatDeviceDateTime()` (TV helyi, nincs kézi eltolás) adja a 4 kártya és a tooltip idejét; a NAPLÓLISTA `formatLogClock()` és az `Utolsó szinkron` SZÁNDÉKOSAN marad `dateTimeText()` (a #50 `serverTime=01:05:31Z` pont a TV órájával egyezik), a globális `localFormatter()` nem változott. A #33/#34 elutasított +1 órás napló-„javítása” nem tért vissza.',
      'A #50 SUPABASE ÁTVIZSGÁLÁSA — Élő adatok: `tv_doctor_channel_profiles` 80/80 profil, mind a 80 nem üres `routes`-szal; `tv_doctor_channel_baselines` 0 (`Memória: 0` utáni teljes törlés rendben); 1 párosított eszköz; a vizsgálat elején 268 esemény (ebből 62 a #49/#50 mérés alatt), a záró ellenőrzéskor már 337 / 131 (`2.5.404`). A VARIÁNS-JELZŐ TELJES, BEÁGYAZOTT SZÁMLÁLÁSA: `details.details.recoveryVariant = true` (SQL: beágyazott JSON-kulcs) 2 sor (`step=3` és `step=4`, mindkettő `maxSteps=16`, `hu:m2-uhd`, `recovery_buffer_profile` / `recovery_alt_format_buffer`), míg a felső szintű `details.recoveryVariant` 0 sor – tehát a deployed v19 csak a NESTED alakot látja, és a `hu:m2-uhd` csoportban 8 `measurement` / 6 `diagnostic` / 4 `repair_attempt` / 3 `repair_verified` maradt: a régi 8-as `pruneDeviceDoctorEvents()` a 16 variánsból csak 2-t hagyott meg. A 2.5.403 / #46 16 variánsos javítás ÉLŐBEN MŰKÖDIK: a #50 napló `ÚJRACSATLAKOZÁSI VÁLTOZAT [1/16] … [4/16]` sorai (TS+balanced, HLS+balanced, TS+fast, HLS+fast), a `tv_doctor_events` `Próba 3 / 16: TS + fast • recovery_buffer_profile • recoveryVariant=true` sora, a `hu:m2-uhd` profil 7 útvonallal / `best_buffer_profile=adaptive-1` / `repair_success_count=14` és a `leállított_halott_csatorna=0` összegzés mind igazolják, hogy bizonyítottan működő csatornára NINCS „nem működik” ítélet. A 8 tanulási doboz, az 1-es ALAP, a feliratok, a kézi SÁRGA napló és a `Memória: 0` változatlanok.',
      'A #50-BAN TALÁLT TOVÁBBI HIBÁK JAVÍTVA — A `tvDoctor.ts mergeCloudDoctorLogs()` és a localStorage-visszaolvasás minden lépésszámot `Math.min(8, …)`-cal vágott, a panel rangsorolása is 8-as lépéskeretet használt: ezért a felhő 9..16. variánsai a TV-n 8/8-nál ragadtak. Új `MAX_DOCTOR_LOG_STEPS=16` és `clampDoctorLogMaxSteps/Step()` kezeli a `details.recoveryVariant=true` sorokat, a 8-as korlát továbbra is a 8 TANULÁSI DOBOZRA vonatkozik. A `supabase/functions/tv-doctor/index.ts` `pruneDeviceDoctorEvents()` csatornánként 8 eseményt, a `bootstrap` pedig kategóriánként 8-at tartott meg: most a variánsok KÜLÖN 16-os keretet kapnak (normál eseményeké marad 8). Találtunk még egy felhő-illesztési hibát is: `getTvDoctorChannelSnapshot()` helyi rekord hiányában üres `channelKey`-vel dolgozott, ezért a `Memória: 0` utáni első Supabase-visszaolvasás kanonikus `hu:…` naplósorai nem jelentek meg a 4 dobozban; most a `normalizeChannelDoctorKey()` adja a kulcsot, és a `mergeCloudDoctorLogs()` a `channelId`-t is megőrzi. A `handleBootstrap()` is elfogadja mind a beágyazott, mind a felső szintű `recoveryVariant` / `step` / `maxSteps` alakot, hogy a 16-os keret régebbi soroknál se vesszen el. A deployed `tv-doctor` Edge Function változatlanul v19 / ACTIVE; a forrás javításának ÉLŐ újratelepítése a felhasználónál történik (sandboxból a korábbi deploy-kísérletek nem sikerültek).',
      'TESZTEK — Új `tools/test-boot-reveal-and-doctor-clock-405.mjs` a 46. tesztcsoport, 55/55 ellenőrzéssel: forrás- és esbuild/Storage futásidejű ellenőrzés (#49 kapuk, 3,5 s háló, 14 s vészfogó, egyszeri `notifyAppLoaded`, hangzár-init, mentett HU EPG, `iptv-app-ready` sorrend; #50 `getHours()` vs `Europe/Dublin` 1 órás különbség, 16 felhős `repair_attempt` → `operationMaxSteps=16` → localStorage → friss import, Edge Function 16-os keret + nested bootstrap-jelző). A `test-vod-restore-tuning.mjs` és a `test-tv-supabase-tv-roundtrip.mjs` régi `VIDEO_WAIT_MS=0` elvárását a #49 új 8000 ms-es értékére frissítettük; Két ELAVULT tesztet is a jelenlegi szándékos működéshez igazítottunk: a `smoke-test.mjs` a 2.5.392 óta nem létező `__IPTV_BOOT__` híd helyett az `__IPTV_APP_READY__` / `iptv-revealed` / nyitott hangzár jeleket is elfogadja (a régi híd visszafelé továbbra is jó), az `applog-runtime` pedig a 2.5.397 óta élő automatikus tesztidőszaki naplózást és a 2.5.383-as teljes `YYYY-MM-DD HH:MM:SS` Dublin-időbélyeget. Érvényesítés: `npm test` 46/46 / 106,9 s (beépített IPK-val is), `npm run smoke` OK, `npx tsc --noEmit` 21 ismert baseline / 0 új, Vite `1 906,17 kB / gzip 758,38 kB`, `tools/build-webos.sh` → 2.5.405 IPK `1 574 KB`, `git diff --check` tiszta. A 2.5.399 / 2.5.401 / 2.5.403 tesztcsoportok változatlanul zöldek.',
      'NYITVA MARADT — A #49/#50 naplók a 2.5.404-es IPK-val készültek; ez a 2.5.405 kód még NEM futott élő TV-n (a sandboxban legyártott `webos/IPTV-RT.ipk` 2.5.405 már letölthető). Az új IPK telepítése, a #49-hez hasonló rendszernapló + #50-hez hasonló TV Doktor napló visszamérése (különösen: mennyi ideig marad fent a takaró, és a 4 kártya órája megegyezik-e a fejlécével), valamint a javított `tv-doctor` Edge Function v19 → v20 deployolása továbbra is a felhasználónál történik; sandboxból nem pótolható.',
    ],
  },

  {
    version: '2.5.404',
    date: '2026-11-09',
    changes: [
      'A #46 NAPLÓ ÉS A SUPABASE ADATAI SZERINT AZ [HU] M2 UHD BIZONYÍTHATÓAN MŰKÖDÖTT — A 115 kB-os rendszernapló (23:16–23:22) három `SIKERES` TS-indítást mutat (1614 / 4512 / 1432 ms), egy `t=39.75 s; duration=39.75 s` tényleges lejátszást, majd 5–6 azonos `stream=MPEG-TS; pufferprofil=balanced` újracsatlakozást. Mégis megjelent az `ÉLŐ ÚJRACSATLAKOZÁS LEÁLLÍTVA; próbák=5/6; ok=a csatorna nem működik, végtelen ciklus megelőzve` és a `A csatorna jelenleg nem működik` felirat. A Supabase `hu:m2-uhd` sorai ugyanezt igazolják: `repair_attempt` 3× (`ts/balanced` 2×, `hls/balanced` 1×, `ts/adaptive-3` 1×), `buffer_test` és `speed_test` 1–1, `diagnostic` 7×; a TV Doktor 5 beavatkozása MIND `1/8, puffer=balanced`, egyetlen `2/8` sem volt, és `TV DOKTOR JAVÍTÁSI DÖNTÉS` sem készült.',
      'BIZONYÍTOTTAN MŰKÖDŐ CSATORNA SOHA NEM KAP „NEM MŰKÖDIK” ÍTÉLETET — A `VideoPlayer.tsx` `requestRecoveryRef` generic `attempt >= 5` backoffja eddig NEM hívta meg a `canDeclareChannelDead()` védelmet (csak a javítási létra `proposal.exhausted` ága használta). Most az újracsatlakozás is megvizsgálja a `healthyPlaybackMs`-t: ha a csatorna ebben a nézési szakaszban már ≥15 s-t ténylegesen lejátszott, a végleges hiba, a `setHasError(true)` és a leállítás NEM fut le, helyette `TV DOKTOR: BIZONYÍTOTTAN MŰKÖDŐ CSATORNA – NINCS VÉGLEGES LEÁLLÍTÁS` naplósor készül és a próbálkozás folytatódik. A soha nem játszott csatorna 5 próbás végtelenciklus-védelme VÁLTOZATLAN. A felirat szövege sem változott, csak a feltétel szigorodott.',
      'A 16 KÜLÖNBÖZŰ HIBA-/ÚJRACSATLAKOZÁSI BEÁLLÍTÁS TÉNYLEGESEN LEFUT — A `DOCTOR_BUFFER_CONFIGS` 8 pufferprofiljából és a HLS/TS formátumpárból új `planLiveRecoveryVariant()` 8 × 2 = 16 variánst képez (`balanced`, `fast`, `stable`, `turbo`, `instant`, `adaptive-1/2/3` × TS/HLS), mindegyikhez VALÓDI indulási-őrrel, lejátszás-őrrel, puffer-céllal és fokozatos várakozással. A 2. újracsatlakozástól a `requestRecoveryRef` beállítja az `activeBufferProfile`-t / `activeBufferTiming`-ot, a `nextUrl`-t a másik formátumra cseréli, és a natív hídnak is az aktív profilt adja át. A 17. próba a 16 variáns lassabb 2. körét kezdi, soha nem adja fel. A `CSATORNAVÁLTÁS/ÚJRACSATLAKOZÁS START` sor most a TÉNYLEGES pufferprofilt írja, nem mindig `balanced`-et.',
      'A LÉTRA NEM RAGAD 1/8-NÁL — A #46-ben a `shouldSkipDoctorLadderForProvenChannel()` (2.5.386 TLC-védelem) minden `unexpected_end`/`unexpected_pause` eseménynél korai visszatérést adott, a 12 mp-es `armDoctorRepairWatch()` elavulás-őr és az `onPlaying` verify pedig 0-ra állította a `repairStep`-et. Most a TLC-védelem csak az első KÉT azonos próbára vonatkozik: 3+ egymás utáni hiba után a teljes 1→8 létra jogos, bizonyított csatornánál az elavulás-őr sem nullázza vissza a lépést, és a beavatkozási limit 8/percről 16/percre emelkedik (csak a bizonyított csatornánál). Külön, stabil `liveRecoveryVariantRef` számlálót vezettünk be, mert a régi `recoveryAttemptRef`-et minden rövid `playing` lenullázta – ez volt a „csak ts próbálkozások és semmi” másik oka. A 8 TANULÁSI DOBOZ (1 alap + 7 tanult) változatlan.',
      'A SUPABASE IS A 16 VARIÁNST MUTATJA — Új `recordDoctorRecoveryVariant()` minden próbát `repair_attempt` eseményként ír a `tv_doctor_events`-be, `details.step=1..16`, `details.maxSteps=16`, `details.strategyId` és `details.recoveryVariant=true` jelöléssel. A `tvDoctorCloud.ts` eddig a `maxSteps`-et 8-ra vágta és kategóriánként csak az utolsó 8 eseményt tartotta meg; most a variánsok KÜLÖN 16-os keretet kapnak, a hagyományos javítási próbák 8-as korlátja és a 8 dobozos panel változatlan marad. Így a #43/#44-hez hasonló következő élő naplóban már soronként ellenőrizhető, melyik formátum/puffer beállítás mit eredményezett.',
      'TESZTEK — Új, a javítás ELŐTT bukó `tools/test-tv-doctor-recovery-403.mjs`: 78 ellenőrzés valódi esbuild + Storage futásidejű modullal (16 különböző formátum/puffer páros, 8 HLS + 8 TS, `balanced` csak 2/16, 16 felhős `repair_attempt` `hu:m2-uhd` kanonikus kulccsal, a létra 1/8→8/8-ig legalább 6 különböző stratégiával, a 39.75 s lejátszás védelme, a változatlan feliratok / 8 doboz / kézi SÁRGA napló / `Memória: 0`). Regisztrálva a `tools/run-tests.mjs` 45. csoportjaként.',
      'NYITVA MARADT — A #46 mérése 23:16–23:22 között készült, még a 2.5.401 00:09-es merge-je ELŐTT, ezért önmagában nem igazol új IPK-futást. A mostani kód változásainak ÉLŐ TV-n, új IPK telepítése utáni, #43/#44-hez hasonló naplós visszamérése továbbra is a felhasználónál történik; sandboxból nem végezhető el. A deployed `tv-doctor` Edge Function változatlanul v19 / ACTIVE.',
    ],
  },

  {
    version: '2.5.402',
    date: '2026-11-08',
    changes: [
      'A #43 ÉS #44 NAPLÓKAT SORONKÉNT ÁTNÉZTÜK — A 23:44-es diagnosztikai napló 2276 sora (`1017 ms` képkocka-kihagyás, 29 kihagyás, `DIAGNOSZTIKA SZÜNETEL`) és a 805 kB-os TV Doktor napló 2148 sora (`tanult_csatornák=80/80`, 71 „Új tanult útvonal”, 69 „legjobb”, 151 SUPABASE-sor) alapján NEM a deployed v18 volt a fő ok: a #44 `TV DOKTOR ABLAK ... [HU] M2 UHD` sorai minden megnyitáskor `tanult_útvonalak=0/8; helyi=1; supabase=0; legjobb=még nincs`-et írtak, miközben ugyanazon napló `TV DOKTOR INDÍTÁS` sorai már 1/8, ~1269–1949 ms-es tanult útvonalat használtak.',
      'A PANEL MOST A VALÓSÁGOT MUTATJA — A „Tanulás 3 db → 0 összevont útvonal” három oka: (1) a `MAX_RECENT_LOGS = 8` GLOBÁLISAN, kategóriánként csak 8 tanulási eseményt tartott meg, így a 80 végigjárt csatorna korai bejegyzései eltűntek; (2) a pillanatkép a már kész `DoctorRoute`-okat még egyszer a nyers RPC-normalizálónak adta; (3) a `ok > 0` szűrő a 0 sikerű, de valódi próbákat eldobta. Most a korlát CSATORNÁNKÉNT 8 (külön 1200-as biztonsági puffer-korláttal), a tanulási naplósorokból a `learnedRouteFromDoctorLog()` valódi 2–8 dobozokat képez, és a legjobb mért útvonal kerül a csillagos első sorba. A `TV DOKTOR ABLAK` és az `INDÍTÁS` napló és a nyolc doboz feliratai VÁLTOZATLANOK; csak az adat kerül a meglévő kockába.',
      'LÁTSZIK, HOGYAN NYITOTTA MEG ÉS MIT TANULT — A tanulási bejegyzés most tételesen tartalmazza a `megnyitás=TS/HLS+puffer (mp)`, a mért indulási időt, az `eredmény=N ok/N hiba/N akadás` arányt és a `forrás=Supabase+helyi|helyi` értéket. A 2–8 dobozok minden megnyitást külön sorban, idővel, siker/hiba/akadás számmal jelenítenek meg; a „Még nincs tanult útvonal” helyőrző csak akkor látszik, ha tényleg nincs adat.',
      'MIND A 80 CSATORNA A SUPABASE-BEN — A felhasználó által jelzett 67 (később 72) tanult felhős profil oka: 13 mentett magyar adó neve NEM `[HU] …`, hanem `HU - …` (`hu - travel channel`, `hu - pax tv`, `hu - filmbox stars hd`, …). A deployed Edge Function `layoutChannelKey()` már felismerte a prefixet és `hu:travel-channel` kulcsot adott, de a kliens `normalizeSavedLayoutChannelKey()` `hu-travel-channel`-t képzett, ezért a 80-as hatókör kizárta őket a `collectDoctorRoutePayload()`-ból. A prefix-szabály, a `canonicalDoctorKey()` / `savedScopeCanonicalKeys()` kanonikus hatókör és a `fetchTvDoctorRoutesForChannelFromCloud()` kanonikus illesztése mindkét írásalakot ugyanannak a csatornának tekinti. A `20261108235500_tv_doctor_hu_prefix_13_channel_profiles.sql` migráció a #44 naplóban TÉNYLEGESEN MÉRT adatokkal, `ON CONFLICT DO NOTHING`-gal pótolja a hiányzó sorokat: az élő adatbázisban a 80 mentett magyar csatornából **80/80 lefedett, 0 hiányzó**.',
      'A „LEFAGY / FOLYAMATOS FRISSÍTÉS” JAVÍTÁSA — A `persistRecentDoctorLogs()` minden egyes eseménynél szinkron `JSON.stringify(recentDoctorLogs)` + `localStorage.setItem` írást végzett, miközben a 2276 soros kézi napló is futott. Most 350 ms-es, üresjáratban futó debounce, `flushRecentDoctorLogs()` és `pagehide`/életciklus-flush gondoskodik róla, hogy a kézi SÁRGA napló TELJES maradjon, de a fő szálat ne fogja. A pillanatkép a teljes napló `slice().reverse()` másolata helyett egyetlen, csatornánként korlátozott visszafelé bejárást végez. A „nem úgy indítsa” sorokat a `TV DOKTOR INDÍTÁS` napló továbbra is tételesen rögzíti (felhasznált tanult útvonal, várható ms, forrás, visszaesés, ok).',
      'A KORÁBBAN NYITOTT DEPLOY LEZÁRVA — Az élő `tv-doctor` Edge Function már **v19 / ACTIVE** (2026-11-08 23:31, `c62244fa-baba-4934-b05f-4dd4ceab5531`), a repo v19 forrása tehát fut; a 2.5.400 changelog „v18 / deploy hiányzik” tétele elavult. A 2.5.401 SQL-migráció szintén alkalmazva van az élő adatbázison. Az új IPK telepítése utáni, a #43/#44-hez hasonló ÉLŐ naplós validáció továbbra is a TV-n végzendő.',
      'TESZTEK — Új, a javítás ELŐTT bukó `tools/test-tv-doctor-learning-401.mjs`: 49 ellenőrzés valódi esbuild + Storage futásidővel (80 csatorna tanulási előzménye nem tűnik el, `HU - …` prefix → `hu:` kulcs, `Tanulás 3 db` mellé 7 valódi doboz, felhő 2 útvonala nem szűrődik ki, nincs kétszeres normalizálás, a feliratok és a pontosan 8 doboz változatlan). Regisztrálva a `tools/run-tests.mjs`-ben.',
    ],
  },

  {
    version: '2.5.400',
    date: '2026-11-08',
    changes: [
      'GYORS IPK-INDULÁS A #39 NAPLÓ BIZONYÍTÉKAI ALAPJÁN — A 19:43-as indításnál a takarókép 1838 ms-ig fent volt (first-paint 167 ms, bundle 355 ms, React +1285 ms, notifyAppLoaded +842 ms), egy 1017 ms-es főszál-fagyás és összesen 29 képkocka-kihagyás mellett, és 7 perc alatt 1180 naplósor keletkezett. A `main.tsx` most a `listReady() || (liveListReady() && vanCsatornaSor)` kaput használja: +847 ms-nél az élő lista már kész volt, csak a 3. csatornasor hiányzott, ezért nem várunk tovább. Új 1,5 s-es `BOOT_FAST_REVEAL_MS` gyors biztonsági háló felfedi a tartalmat akkor is, ha a fagyás miatt a 40 ms-os ellenőrző ciklus kiesik. A `TAKARÓKÉP ELLENŐRZÉS` és a `TAKARÓKÉP ÖSSZEGZÉS` sorok változatlanok. A #39 `BOOT-DIAG ÖSSZEGZÉS: felület megjelent=nem történt meg` hibáját is javítottuk: a HTML indítószkript `__IPTV_BOOT_MARK__` tömbjébe eddig SOHA nem került `REVEAL` jelzés, most a tényleges felfedéskor rögzül, és a 25 mp-es összegző időzítő a megfigyelők 12 mp-es lecsatlakozása után is lefut. A HU EPG-próba 5 s-ről 9 s-re tolódott, hogy az első adás (2775 ms) nyugodtan indulhasson.',
      'AZ AUTOMATA NAPLÓ NEM TERHELI A FOLYAMATOS TÉVÉZÉST — `appLog.ts` új `isBootDiagnosticWindow()` / `AUTO_BOOT_LOG_WINDOW_MS` ablaka az IPK indulása után 10 s-ig MINDEN sort megőriz (kell a takarókép méréséhez), utána a csatornánkénti, nagy gyakoriságú KÉPMINŐSÉG-sorokat elengedi. A `startupDiagnostics.ts` `BOOT_OBSERVER_WINDOW_MS` / `stopBootObservers()` 12 s után lecsatlakoztatja a képernyő-mintavételt, a képkocka-őrt és az elem-/PerformanceObserver-öket; a kézi hiba napló változatlanul minden eseményt gyűjt. A SÁRGA gombos kézi napló továbbra is teljes.',
      'A TANULÁS VALÓDI ADAT, NEM PUFFERELÉSI EPIZÓD — A #40 napló és az élő `tv_doctor_events` szerint „Új tanult útvonal: TS + adaptive-3 (27143 ms)”, „(60000 ms)”, „(14691 ms)” sorok keletkeztek: ezek nem indulási idők, hanem javítási/pufferelési epizódok, mégis `avgStartupMs`-ként tanultuk meg őket, így a „leggyorsabb útvonal” valójában a leglassabb lett. Az új `MAX_USEFUL_STARTUP_MS = 8000` és a `timingUsable` szűrő a javításból (`wasRepair`) vagy 8 mp feletti epizódból CSAK a siker tényét jegyzi; az EWMA-t, a `bestStartupMs`-t, a puffer-statisztikát és az útvonal-létrát kizárólag tiszta, 8 mp alatti indulás írja. A naplósorok őszintén jelzik, ha nincs időminta.',
      'A TV DOKTOR KIZÁRÓLAG A 80 ELMENETT MAGYAR CSATORNÁN TANUL, CSATORNÁNKÉNT KÜLÖN — A #40 `tanult_csatornák=87/80` hibáját az `isInSavedHungarianScope()` szüntette meg: ha a mentett magyar hatókör be van töltve, csak annak stabil `hu:` kulcsai (vagy a mentett 80 adó ID-je) tanulnak, tárolódnak és mennek a Supabase-be. A felhőből OLVASOTT adatot ezzel szemben nem szűrjük (`isCloudDoctorRecordAllowed`): a Supabase az elsődleges tudástár, a TV lekéri és megjeleníti. Egy csatorna mérése soha nem kerül egy másik csatorna rekordjába.',
      'LÁTHATÓ, HOGY MIT TANULT ÉS MELYIK A LEGJOBB — A `getTvDoctorChannelSnapshot()` új `bestRoute` mezője a leggyorsabb, legstabilabb, SIKERES tanult útvonalat adja, és a Tanult útvonalak lista ELÉ teszi (a csillagos 1. sor). A #40 napló ismételt `legjobb=—+undefined` sora megszűnt: a 0-ablak valódi formátumot, pufferprofilt, mért ms-t és ok/hiba számot ír. Ha egy régi/felhő-profilnak csak számlálói vannak, a kocka akkor is abból képez valódi sort, nem „NINCS ADAT”. A `selectChannelLaunchPlan` új `TV DOKTOR INDÍTÁS [...]` sora tételesen leírja, melyik tanult útvonalból, milyen várható idővel, hány útvonal közül és milyen visszaesési ponttal dolgozik. Az összes meglévő felirat, elnevezés és leírás VÁLTOZATLAN maradt; továbbra is pontosan 8 doboz (1 alap + 7 tanult).',
      'SUPABASE AZ ELSŐDLEGES: A #40 `0 csatorna mentve (payload=7)` VALÓDI OKA — Az élő `tv_doctor_routes_upsert` CSAK `UPDATE`-et végzett, ezért egy új csatorna tanult útvonalai soha nem kerültek be. Az új `20261108213252_tv_doctor_full_reset_true_upsert` migráció valódi `INSERT ... ON CONFLICT (channel_key) DO UPDATE` UPSERT-et ad, a legfeljebb 8 útvonal siker/hiba szerinti összefésülésével; az élő adatbázison is alkalmazva és ellenőrizve. A 0-ablak a felhőből letöltött tanult útvonalakat a HELYI rekordba is beépíti (`mergeCloudRoutesIntoLocal`), így a következő csatornaindítás tényleg a mentett legjobbat próbálja, nem egy üres helyi pillanatképet.',
      'TELJES MEMÓRIA-NULLÁZÁS (A 10. PONT VISSZAVONJA A 2.5.394/396 „1-ES ALAP HALHATATLAN” DÖNTÉSÉT) — A „Memória: 0” most az eredeti 1. helyen tárolt alapbeállítást is törli HELYBEN (`TV_DOCTOR_BASELINE_STORAGE_KEY`) ÉS a Supabase-ben (`tvDoctorCloud.ts` → `clearTvDoctorBaselinesInCloud()` → `tv_doctor_baselines_clear` RPC, amelyet a migráció a korábbi no-op helyett tényleges, párosított eszközre korlátozott `DELETE`-re állít vissza). A mentett csatornaelrendezés megmarad, de minden csatorna teljesen elölről, egy ÚJ első sikeres megnyitással indul. A korábbi ezt védő teszteket (`test-tv-supabase-tv-roundtrip.mjs`, `test-tv-doctor-cloud-v18-compat.mjs`, `test-tv-doctor.mjs`) a felhasználói döntés miatt tudatosan átírtuk.',
      'TESZTEK — Új, a javítások ELŐTT bukó `tools/test-tv-doctor-learning-399.mjs`: 53 ellenőrzés a #39/#40 naplókra, a változatlan feliratokra, a 8 dobozra, a Supabase-első működésre, a teljes nullázásra és VALÓDI JSDOM + esbuild futásidejű tanulásra (a 27143/60000 ms-es epizód kizárása, csatornánkénti külön rekord, `bestRoute`). Regisztrálva a `tools/run-tests.mjs`-ben. A frissített teljes tesztkészlet, TypeScript és Vite build rendben.',
      'NYITVA MARADT — A futó `tv-doctor` Edge Function továbbra is v18; a repo v19 forrásának deployja (`tools/deploy-tv-doctor.sh`) és a változások ÉLŐ IPK-n, a #39/#40-hez hasonló új naplóval történő validálása még NINCS kész. A mostani SQL-migrációk az élő adatbázison már élnek.',
    ],
  },
  {
    version: '2.5.398',
    date: '2026-11-08',
    changes: [
      'ÚJ (A KÉZI HIBA NAPLÓ AZ IPK INDÍTÁSAKOR AUTOMATIKUSAN GYŰJT) — A 2026-11-08 18:41-es TV-fotó után a SÁRGA gombos naplóhoz többé NEM kell előre megnyitni az ablakot: a `TEST_STARTUP_DIAGNOSTICS` bekapcsolásával a `diagnosticsBootstrap` már az App/modulok importja ELŐTT elindítja a naplózást és a crash-handlert, így a legelső milliszekundumok (HTML 1/7…7/7 jelek, bundle, React mount) is benne vannak. A napló ELEJÉN egy „MIT ELLENŐRIZ A TV” sor tételesen felsorolja mind a 12 ellenőrzési lépést: webOS Luna-híd / `notifyAppLoaded`, fejléc+mappasáv (`chromeReady`), élő csatornasorok, logók, első videó-képkocka (`requestVideoFrameCallback`), előfestés, üres IPK jelzés, IndexedDB/localStorage felmérés, FCP/LCP/long task, `bootScreenComplete`, `iptv-app-ready` és a natív splash elengedése.',
      'ÚJ (MÉRHETŐ, HOGY MI TARTJA FENT A TAKARÓKÉPET) — A `main.tsx` minden 40 ms-os ellenőrzési körben, de CSAK állapotváltozáskor `TAKARÓKÉP ELLENŐRZÉS [+N ms]` sorokat ír minden egyes kapu IGEN/NEM állapotával, plusz külön sort a webOS `notifyAppLoaded` hívásról, a felfedésről és egy `TAKARÓKÉP ÖSSZEGZÉS` sorról (meddig volt fent, melyik kapu nem engedett, hányszor kellett képkocka-helyettesítés). A kézi „Napló küldése” továbbra is lezárja a munkamenetet, és sikeres küldés után nem indul újra magától.',
      'JAVÍTÁS (A TV DOKTOR A VALÓDI TANULT ÚTVONALAT TÖLTI BE, NEM „NINCS ADAT + NINCS ADAT”) — A fotón a `hu:cinemax` Supabase-sora 2 sikeres, 1432 ms-es TS + balanced tanulást tartalmazott, mégis `NINCS ADAT + NINCS ADAT / Nincs mérési adat • ok / hiba` látszott. Az ok: a `sanitizeDoctorRoutes()` minden olyan útvonalat eldobott, amelyből hiányzott a `format`/`bufferProfile`, és a `tv_doctor_routes_fetch` csak a beágyazott `routes` tömböt adta tovább. Az új `normalizeDoctorRoutesForDisplay()` a TELJES RPC-sort értelmezi, elfogad camelCase és snake_case mezőket, a hiányzó formátumot/puffert az `id`-ből (`ts:balanced`) és a profil `best_format`/`best_buffer_profile` mezőiből, a siker/hiba/indulási számlálókat a `*_success_count`/`*_avg_startup_ms` aggregátumokból pótolja. A pillanatkép és a panel ezt használja: a valódi sor most „TS + Kiegyensúlyozott (3.0 mp) / 1432ms • 2 ok / 0 hiba”. A `NINCS ADAT` és `Nincs mérési adat` helyőrzők teljesen eltűntek.',
      'JAVÍTÁS (PONTOSAN 8 DOBOZ — NEM 9) — A korábbi „külön 1-es ALAP + tanult útvonalak (2–9)” 1 + 8 = 9 dobozt rajzolt. A felhasználó explicit visszavonta: most 1 alap + 7 tanult sor (2–8) = ÖSSZESEN 8 doboz, `data-tv-doctor-route-boxes="8"` attribútummal és a címkében is (2–8). A `MAX_CHANNEL_ROUTES = 8` TÁROLÁSI korlát változatlan marad (a felhő és a helyi tanulás továbbra is 8 útvonalat ment); csak a képernyőn látható dobozok száma lett 8.',
      'JAVÍTÁS (A BAL OLDALI KÖZPONTI PROFILOK DOBOZA ELTÁVOLÍTVA) — A „Központi profilok: 80 / 1-es alap: 0 • tanult útvonal: 8 / Mentett sorrend: …” sáv a jobb oldali Supabase-panelen már szerepelt, ezért a bal oldali párhuzamos összesítő megszűnt. A jobb oldal most PONTOSABBAN mutatja: `Központi profilok: 80 db` (a mentett magyar csatornák), külön `Tanult felhő profil: 8 db`, és `Várólista`.',
      'JAVÍTÁS („TANULÁS 3 DB” ↔ LÁTHATÓ TANULT SOROK) — A 3 tanulási ESEMÉNY ugyanabba a formátum+puffer útvonalba vonódik össze, ezért nem 3 külön doboz jelenik meg; eddig viszont semmi nem magyarázta a különbséget. Az új `Tanulás: 3 bejegyzés → 1 összevont útvonal; 8 doboz (1 alap + 7 tanult)` sor mindkét számot és a dobozok számát is kiírja, a valódi útvonal pedig a mért adataival együtt látszik.',
      'TESZTEK (MINDEN JAVÍTÁS ELŐTT BUKÓ TESZT) — Új `tools/test-boot-log-and-doctor-panel.mjs`: 29 ellenőrzés, köztük VALÓDI JSDOM React-renderelés a 8 dobozra, a bal doboz hiányára, a hiányos élő Supabase-sorból normalizált valódi útvonalra (1432 ms, 2 ok), az automata napló tényleges elindulására és a 3 bejegyzés → 1 útvonal magyarázatra. A 2.5.392/394 „9 doboz” és a „csak kézi naplóindítás” elvárásait a felhasználói döntés miatt tudatosan frissítettük (`test-vod-restore-tuning.mjs`, `test-applog-discard.mjs`). A teljes `npm test` 42/42, a TypeScript a HEAD-del megegyező 21 ismert diagnosztikával, a Vite build rendben.',
      'NYITVA MARADT — A futó `tv-doctor` Edge Function továbbra is v18 (a v19 forrás a repóban, a deploy a `tools/deploy-tv-doctor.sh`-sal végezhető el), és a most elkészült automata IPK-naplóval a TV-n mért takarókép-idő, FCP és a teljes `tv → Supabase → tv` kör ÉLŐ IPK-n még NINCS validálva; ezt csak egy új IPK telepítése és egy elküldött napló igazolhatja.',
    ],
  },
  {
    version: '2.5.396',
    date: '2026-11-08',
    changes: [
      'JAVÍTÁS (AZ 1-ES ALAP MOST TÉNYLEG HALHATATLAN, HELYBEN ÉS A SUPABASE-BEN IS) — A 2.5.394 ugyan már nem hívta a `tv_doctor_baselines_clear` RPC-t, de a `clearTvDoctorMemory()` HELYBEN mégis törölte az alap tárolóját; ha a felhőben még nem volt mentett alap (jelenleg 0 sor), a „Memória: 0” után nem volt hová visszatérni, csak egy újabb első lejátszás tudott új alapot rögzíteni. Most a nullázás kizárólag a TANULT profilokat, útvonalakat és naplókat törli; a slot-1 alap a TV-n akkor is megmarad, ha nincs internet. A Supabase-ben is zároltuk: a `20261108173312_tv_doctor_immutable_baseline_no_delete` migráció a törlő RPC-t kompatibilitási no-op-ra cserélte (a régi 2.5.392 IPK nullázása továbbra is sikerrel jelez vissza, de EGY SORT SEM TÖRÖL). Ezt a változást az élő adatbázison is ellenőriztük.',
      'ELLENŐRZÉS ÉLŐ SUPABASE-ADATON (LG-4ZYG-W5XP) — A mentett pillanatkép első öt magyar `nameKey`-e kisbetűs, `[hu] bbc earth uhd|lc-827` alakú, a TV viszont nagybetűs `[HU] BBC Earth UHD` nevet kap, ráadásul MÁS `live-qr_…` ID-prefixszel. A szerver `layoutChannelKey()` és a kliens `normalizeSavedLayoutChannelKey()` / `normalizeChannelDoctorKey()` mind az öt csatornára PONTOSAN ugyanazt a stabil `hu:` kulcsot adja (`hu:bbc-earth-uhd`, `hu:mozi-plus-uhd`, `hu:hbo-uhd`, `hu:hbo-2-uhd`, `hu:hbo-3-uhd`). Ez a teljes tv → Supabase → tv illesztés alapja; az öt élő minta bekerült a regressziós tesztbe. Az adatbázis jelenleg 1 elrendezés (80 magyar / 156 összesen), 0 tanult profil, 0 alap, 0 esemény, és a párosított eszköz él.',
      'EDGE FUNCTION DEPLOY SEGÉDESZKÖZ — A `tools/deploy-tv-doctor.sh` a saját `SUPABASE_ACCESS_TOKEN` és a Supabase CLI segítségével egy paranccsal élesíti a `tv-doctor` v19 forrását (`supabase functions deploy tv-doctor --project-ref hlklmcujvqsatwvdygqp --no-verify-jwt`). A futó függvény egyelőre v18; a kliens visszafelé kompatibilis, ezért az IPK már így is működik, de a szerveroldali névkulcsos hatókör, a `layoutChannels`/`baselines` bootstrap és a megőrző `reset_memory` csak a deploy után él. A script nem tartalmaz és nem naplóz tokent, és nem töröl adatot.',
      'TESZTEK — Új bukó-teszt-előre ellenőrzések: a helyi nullázás megőrzi a slot-1 alapot, a Supabase 1-es alapja nem írhatja felül, a destruktív RPC adatbázis-szinten is no-op, és az öt élő magyar nameKey/TV-név ugyanazt a stabil kulcsot adja. A `tools/test-tv-supabase-tv-roundtrip.mjs` 53/53, a teljes `npm test` 41/41 tesztcsoport.',
    ],
  },
  {
    version: '2.5.394',
    date: '2026-11-08',
    changes: [
      'JAVÍTÁS (TELJES tv → Supabase → tv KÖR — A #35–38 NAPLÓK 0/80-ÁNAK VALÓDI OKA) — A kézzel elmentett 80 magyar csatorna ID-je a mentés pillanatából származik (live-qr_1794124327752-…), a TV viszont újrajelentkezés/IPK-restart után MÁS prefixszel kapja ugyanazokat a csatornákat (live-qr_1794135505110-…). A Supabase tv-doctor Edge Function és a TV is KIZÁRÓLAG erre az elavult ID-re szűrt: a feltöltött tanult profilokat a sync eldobta, a bootstrap vissza sem adta őket, a TV pedig a következő bootstraptől kitörölte a saját friss tanulását — innen a „tanult_csatornák=0/80”, „központi_profilok=0” és az üres Supabase profiltábla. Mostantól a STABIL, NÉVBŐL KÉPZETT csatornakulcs (hu:bbc-earth-uhd) dönt, az ID csak kiegészítés: a TV pontosan azt tanulja és azt mutatja, ami a Supabase-ben el van mentve, a 80 csatorna a MENTETT SORRENDBEN. A bootstrap visszaadja a sorrendi központi profilokat, a zárolt 1-es alapokat és a tanult útvonalakat is.',
      'JAVÍTÁS (MEMÓRIA: 0 UTÁN AZONNAL VISSZATÖLT — AZ 1-ES ALAP NEM TÖRLŐDIK) — A 2.5.392 két dolgot rontott el: a nullázás a tv_doctor_baselines_clear RPC-vel a Supabase 1-es alapjait IS törölte, és a törlés után EGYÁLTALÁN NEM indított visszatöltést, így a TV 0/80-on ragadt. Most a nullázás csak a TANULT profilokat/eseményeket törli; az elmentett csatornaelrendezés és az 1-es, megváltoztathatatlan alap megmarad, majd a „restoreTvDoctorCloudState()” azonnal visszahúzza mindkettőt a TV-re. A TV Doktor napló „TV DOKTOR SUPABASE KÖR: tv -> Supabase -> tv” sorában tételesen látszik a mentett/visszaállított profilok, alapok és útvonalak száma. A 0-ablakban az 1-es HELY újra a ZÁROLT ALAP, a tanult alternatívák csak 2-estől jönnek; külön sáv mutatja a Supabase-ben mentett központi profilokat.',
      'JAVÍTÁS (MOZI PLAKÁT JÁTÉKIDEJE TÉNYLEG MEGJELENIK) — A bulk get_vod_streams lista NEM tartalmaz játékidőt, az „enrichMovieDurationsInBackground()” pedig sehonnan sem volt meghívva (halott kód volt), ezért a 2.5.392-ben elkészült plakátjelvény a 103 ezer poszter nagy részén üres maradt. Most a Mozi nézet megnyitása után, üresjáratban, legfeljebb 2 párhuzamos kéréssel csak a LÁTHATÓ, hiányos 25 film get_vod_info adatát kérjük le, tartósan elmentjük, és a plakátra visszatesszük; a már elmentett nyers adat továbbra is kérés nélkül jelenik meg.',
      'JAVÍTÁS (FILMBŐL VISSZATÉRVE A FÓKUSZ UGYANARRA A POSZTERRE KERÜL) — A lejátszás után a generikus nézetváltó hatás a Mozi panel első gombjára, a Kategóriák választóra tette a kijelölőt. Most a film indításakor a kiválasztott kártya azonosítóját is megjegyezzük, VOD-visszatéréskor a generikus fókusz nem fut rá, és három próbálkozással ugyanaz a poszter kapja vissza a fókuszt (a kategória gomb helyett).',
      'JAVÍTÁS (INDULÁS: A MARADÉK 400/250 ms VÁRAKOZÁS IS ELTŰNT) — A #37 naplóban a first-contentful-paint 3880 ms, a legnagyobb tartalom egy HÁLÓZATI csatornalogó kép volt; a #35-ben a Mozi nézetváltás 104 ms alatt készült el 103 153 filmmel. A felfedés eddig még mindig várt 400 ms-ot az első videókockára és 250 ms-ot a logókra, noha a lejátszó posztere már kész képet adott: mindkét küszöb 0, és a „waited >= küszöb” feltétel miatt az első ellenőrzés már enged. A tényleges hidegindítási költség (az 1,88 MB-os egyfájlos bundle értelmezése + a távoli logók betöltése) a napló FELFEDÉS sorából továbbra is pontosan mérhető; TV-n csak egy új IPK-naplóval igazolható.',
      'SUPABASE OLDAL (FORRÁS + VISSZAFELÉ KOMPATIBILITÁS) — A futó `tv-doctor` Edge Function jelenleg a v18-as verzió; a javított v19 forrás (stabil névkulcsos hatókör, `layoutChannels` + `baselines` a bootstrapben, az 1-es alapot megőrző `reset_memory`) a `supabase/functions/tv-doctor/index.ts`-ben van, és Edge Function újra-deploy után lép élesbe. A TV NEM VÁR erre: a kliens a jelenlegi v18-cal is végigviszi a kört, mert a `tv-channel-layout` pillanatképéből olvassa a mentett 80 csatornát, és a stabil névkulcshoz tartozó MENTETT ID-t mutatja be a feltöltésnél. Ezt külön futásidejű teszt igazolja (`tools/test-tv-doctor-cloud-v18-compat.mjs`). Az adatbázis jelenleg 1 elrendezés (80 magyar / 156 összesen), 0 tanult profil, 0 alap, 0 esemény.',
      'TESZTEK (MINDEN JAVÍTÁS ELŐTT BUKÓ TESZT) — Új „tools/test-tv-supabase-tv-roundtrip.mjs”: a VALÓDI Supabase Edge Function kezelőt hamis REST-tárral és a VALÓDI kliens modult futtatja, elavult layout-ID mellett végigviszi a tv → Supabase → tv kört, a nullázást, a központi profilokat, az 1-es alapot és a naplósorokat (43 ellenőrzés). Új „tools/test-vod-poster-runtime-focus.mjs”: valódi React/JSDOM-ban ellenőrzi a plakát játékidejét, a háttér-dúsítást és a visszatérő fókuszt. Mindkettő bekerült az „npm test” 40 csoportjába; a teljes szvit 40/40, a Vite build és a TypeScript ellenőrzés (a HEAD-del MEGEGYEZŐ 21 ismert diagnosztika) rendben.',
    ],
  },
  {
    version: '2.5.393',
    date: '2026-11-08',
    changes: [
      'JAVÍTÁS (TV DOKTOR 0-ABLAK ÉS A NAPLÓ UGYANAZT MUTATJA, AMI A SUPABASE-BEN VAN) — A „Memória: 0” után a bal felső doboz 4 tanulást írt, az alsó „Tanult útvonalak” lista mégis 0/7-et, a kézi napló pedig egy harmadik, GLOBÁLIS számlálót („kategóriák=(tanulás=4…)”). Az ok: a négy doboz a HELYI, csatornához tartozó friss naplóbejegyzéseket számolta, az útvonallista KIZÁRÓLAG a Supabase-ből olvasott és ok>0-ra szűrt sorokat, a napló pedig az összesített kumulált számlálót. Mostantól egyetlen pillanatkép („getTvDoctorChannelSnapshot”) adja mindhármat: a helyi tanulás az elsődleges, a felhő csak a hiányzó útvonalakat pótolja, így a frissen tanult, még fel nem töltött útvonal azonnal látszik. A nullázás után a képernyő AZONNAL 0-t mutat, újraolvassa a Supabase-t, és egy „TV DOKTOR NULLÁZÁS ELLENŐRZÉS” sorba kiírja a dobozok, a helyi/felhő útvonalak és a törlés tényleges állapotát. A kézi napló külön jelöli az ÖSSZESÍTETT kategóriákat és a „TV DOKTOR 0-ABLAK ELLENŐRZÉS” sorban a képernyőn látható négy számot; a korábbi fix „a 8 tanult útvonal/csatorna visszatöltődik” állítás is mért adatra lett cserélve. A Supabase-ben a nullázás után 35 profil, 5 alapbeállítás és 71 esemény él valós, újonnan tanult adatokkal.',
      'JAVÍTÁS (8 TANULT ÚTVONALDOBOZ, NINCS ALSÓ INSTRUKCIÓS SOR) — A 0-ablak fejléc addig „max. 8”-at írt, de csak 7 vízszintes dobozt és „0 / 7”-et rajzolt: a kliens MAX_CHANNEL_ROUTES = 7 volt, miközben a Supabase tv-doctor Edge Functionje 8 útvonalat tárol. Mostantól a kliens is 8-at tárol, a lista 8 dobozt és „/ 8” számlálót mutat. Mind a NÉGY bal kategóriadobozból TELJESEN eltávolítottuk az alsó „OK / Enter: minden mentett részlet … lapozható” sort; a felszabaduló helyen a 8. útvonaldoboz is elfér, a panel továbbra sem görgethető.',
      'JAVÍTÁS (IPK GYORS INDULÁS — MÉRHETŐEN KEVESEBB VÁRAKOZÁS) — Hiába került ki az indulásból a Mozi/film és az országlista betöltése, három rejtett lassító maradt: (1) a felfedés MINDENKÉPP várt 1200 ms-ot az első videókockára és 600 ms-ot a logókra, noha a lejátszó posztere már kész képet ad (most 400 / 250 ms); (2) a saját HTML-es betöltőképernyő már nincs az index.html-ben, mégis minden indulásnál lejárt egy 400 ms-os biztonsági időzítő – híd hiányában most AZONNAL felfedünk; (3) 3,5 mp-pel a boot után a 2.5.319-es VOD-migrálás elindította a TELJES 103 092 filmes visszatöltést és újraírást (pont azt a Mozi-munkát, amit kivettünk) – ez megszűnt, a mentés és a Mozi nézet eleve év szerint csökkenően rendez. Végül a boot kritikus útjáról lekerült a teljes localStorage-bejárás (a kézi napló akár 1 MB + a beágyazott logótérkép több MB-jának végigolvasása); a pontos karakterösszeget a felfedés UTÁN, üresjáratban mérjük és naplózzuk.',
      'ÚJ (MOZI-VISSZATÖLTÉS BENCHMARK — 103 092 FILM, 0 SOROZAT) — A „tools/bench-vod-restore.mjs” a VALÓDI loadVodAsync() ciklust futtatja a valódi katalógusmérettel, KIZÁRÓLAG Mozi adatokkal (a Sorozatok azért gyorsabbak, mert kevesebb van belőlük). 30 beállítást mért össze: a korábbi 4 blokkos olvasás / 2500 soros dekód-adag 54 IndexedDB-tranzakcióval 757–791 ms, a kérdéses 12 blokkos / 2500-as 20 tranzakcióval 582–615 ms, a GYŐZTES 16 blokkos / 2500-as 15 tranzakcióval 563–613 ms volt. A 16/2500 beállítást alkalmaztuk: a dekód-adag marad 2500 sor, tehát a legnagyobb szinkron blokk nem nő a #33-as naplóban kockázatos 6000 sor fölé (a readChunks két blokkonként úgyis visszaadja a fő szálat), csak a tranzakciók száma esik 54-ről 15-re. A két paraméter most mérhető RESTORE_TUNING objektumban él, és egy determinisztikus regressziós teszt („tools/test-vod-restore-tuning.mjs”) őrzi a győztes értékét.',
      'JAVÍTÁS (MOZI-PLAKÁTON A JÁTÉKIDŐ A JOBB FELSŐ SAROKBAN) — A szolgáltatótól már lekérdezett és a tartós tárba elmentett játékidő eddig csak a kártya alsó sorában volt olvasható. Mostantól a PLAKÁT jobb felső sarkában egy kis, sötét, óra ikonos doboz is mutatja („100 perc”). Ha a lista-válasz nem adott játékidőt, a MÁR elmentett get_vod_info nyers adatból olvassuk ki – NINCS új szolgáltatói kérés. A plakátjelvényt és az alsó sort ugyanaz a „movieRuntimeLabel” táplálja, böngészős regressziós teszt ellenőrzi a megjelenést és azt is, hogy közben nem indul vodInfo/fetch.',
    ],
  },
  {
    version: '2.5.391',
    date: '2026-11-07',
    changes: [
      'JAVÍTÁS (KÉZI NAPLÓ IDEJE — VISSZA EGY ÓRÁVAL) — A korábbi „bónusz” órajavítás a TV rendszerének +01:00-ás időzónájára állította a kézi naplót, ezért a 33. napló fejlécében a „NAPLÓ KEZDETE: 08:30:57” és a „MÉRÉS KEZDETE: 07:30:57” egy órával eltért, és minden sor 08:xx-et mutatott a dublini falióra 07:xx-e helyett. Mostantól a napló fejléce, a sorok időbélyege és a kézi napló ablaka ÚJRA Europe/Dublin időt ír (télen GMT, nyáron automatikusan +01:00): pontosan egy órával kevesebbet mutat, és a fejléc két időpontja megegyezik.',
      'JAVÍTÁS (TV DOKTOR — NEM RAGAD RÁ A CINEMAXRA / VIASAT 3-RA) — A 34. TV DR naplóban a [HU] CINEMAX, [HU] CINEMAX 2 és [HU] VIASAT 3 esetén a Doktor tanult, ~1,4–1,6 s alatt működő TS gyorsprofilját a „szebb kép” választó MÉRETlen HLS-próbával írta felül: MEDIA_ERR_4 → 8 lépéses javítási létra → 3,6–3,8 s puffer → újra tanulás → újra HLS-próba. Mostantól a TV Doktor által igazoltan megtanult formátumot egy még nem mért formátum NEM írhatja felül (két MÉRT felbontás összehasonlítása változatlanul működik), és minden médiahiba bekerül a képmínőség-emlékezetbe: a [HU] VIASAT 6-on látott kilenc azonos „kipróbálás a jobb képért” többé nem ismétlődik.',
      'JAVÍTÁS (TV DR NAPLÓ — NINCS EGYFOLYTABAN ÍRÁS) — A 34. napló 1970 sorából 1809 azonos „PUFFER MÉRÉS” volt: a webOS progress eseménye ~350 ms-onként, plusz egy 2 mp-es időzítő akkor is írt, amikor a csatorna hibátlanul ment. Mostantól a rutinmintákat 30 mp-enként írjuk, az azonos eseményeket 250 ms-on belül összevonjuk, a hibák / pufferelés kezdete-vége / csatornaváltás pedig azonnal, ritkítás nélkül kerülnek a naplóba (a kihagyott minták száma a záró összesítőben látszik). JAVÍTÁS: minden indítási sor eddig PONTOSAN KÉTSZER szerepelt (az appLog maga is a TV DR naplóba irányítja a „TV DOKTOR …” sorokat, és a felhő-modul még egyszer külön is beírta őket) – a dupla sorokat egy rövid azonossági kapu kiszűri, és a hibás /\\s+/ regex miatt keletkező üres sorok is eltűnnek.',
      'JAVÍTÁS (MOZI BETÖLTÉSE NEM AKAD) — A 33. naplóban a filmlista első, hideg visszatöltése 23,1 s volt: egy IndexedDB-tranzakció 12 db 500 soros blokkot (6000 sort) dekódolt egyetlen szinkron lépésben (tár-művelet=1780 ms), közben a fő szál 2,7–4,2 mp-re is leállt. Mostantól négy blokkot olvasunk egyszerre, a JSON-fejtés közben visszaadjuk a fő szálat, és az „adagok=52/42” típusú hibás számlálót a valódi csoportosításból számoljuk. A második Mozi-megnyitás már a 2.5.388 gyorsítótárából 115 ms alatt kész volt. A filmek lassúságának MÁSIK oka nem a lejátszó: a 33. napló „VOD ELÉRHETŐSÉG-ELLENŐRZÉS” sora szerint a szolgáltató HTTP 206-tal, video/x-matroska tartalommal kiszolgálja a fájlt, de a TV dekódolója MEDIA_ERR_4-gyel elutasítja (más .mkv filmek gond nélkül mennek).',
      'JAVÍTÁS (KÉPMINŐSÉG-ÖSSZESÍTÉS NEM KEVERI A NÉZETEKET) — A 33. naplóban volt „mód=VOD … formátum=HLS (.m3u8)” és „mód=élő; cím=STORY 4 HD; formátum=Matroska (.mkv)” sor is: a záró összesítés a RÉGI stream adatai mellé az ÚJ nézet címét/módját írta, mert a váltáskor a ref-ek már átálltak. A mód, a cím és a formátum most a stream INDULÁSAKOR rögzül.',
      'VISSZAJELZÉS (ÉLŐ KÉPMINŐSÉG TOVÁBBRA IS LÁTHATÓ) — A 33. napló 396 „KÉPMINŐSÉG” sora tartalmazza a ténylegesen dekódolt képet, a megjelenített videóterületet, a képkockákat és a puffert; a 2.5.383 „legszebb képű formátum” választó 27 „marad” és 17 „VÁLTÁS” döntéssel aktívan fut. Ahol a kép 1024×576 (SD+) vagy 720×405 (SD), az a SZOLGÁLTATÓ streamje, nem a lejátszó beállítása – ezt a napló külön figyelmeztetésben is jelzi. A felbontás-jelző a film OSD-jén látszik; élő TV-nél egyelőre csak a naplóban.',
    ],
  },
  {
    version: '2.5.389',
    date: '2026-11-07',
    changes: [
      'JAVÍTÁS (FILMEK NEM INDULNAK EL — EGY KAPCSOLATOS SZOLGÁLTATÓ) — A 31. naplóban a Mandalorian, a Mike & Nick és a The Wizard of the Kremlin megnyitásakor a videóelem `kész=0` (egy bájt sem érkezett) médiahibát adott, a lejátszó pedig 180/360/720/1440/… ms-onként újra és újra ugyanazt a címet nyitotta meg; a TV Doktor 8 lépéses puffer-létrája közben elölről indult, így ~40 mp-ig tartott a hiba. Mostantól: (1) aki egyszer sem indult el, legfeljebb 4, egymástól 2/4/6 mp-re eső próbát kap, utána tiszta „film nem érhető el” képernyő és kézi Újrapróbálás jelenik meg (nincs végtelen kör); (2) a VOD indulási őr nem ad többé 3,5 mp türelmet a `readyState=0` + üres puffer állapotra; (3) a már játszott film megszakadásánál marad a folyamatos, gyors visszaállítás. Nem beállítási hiba: a filmek címe és a szolgáltató válasza rendben volt, a saját újracsatlakozási és próba-kapcsolataink ütötték el a lejátszást.',
      'JAVÍTÁS (NINCS MÁSODIK HÁTTÉRKAPCSOLAT) — A képminőség-mérés és a beágyazott felirat (CC) felderítése XHR GET-et nyitott a LEJÁTSZOTT filmmel azonos címre, mindössze 0,9–1,2 mp-pel az indítás után; a kérésnek nem volt Range fejléce, így a több GB-os filmfájlt kezdte húzni, és 20 mp-ig is foghatta a kapcsolatot. A 31. naplóban 41 ilyen, 1–2 mp-ig tartó, 0,0 kB-os xmlhttprequest szerepel (film .mkv és élő .ts címekre), és a CC-próba 1,2 mp-pel a film megnyitása után, közvetlenül a videóelem `kész=0` hibája előtt sikeresen kiolvasta a fájl fejlécét. Mostantól a próbák csak 15 mp (CC: 4 mp) bizonyítottan stabil lejátszás után indulhatnak, címenként CSAK EGY, legfeljebb 1,5 MB-os Range-kérést nyitnak 8 mp-es időkorláttal, és forrásváltáskor / újracsatlakozáskor azonnal megszakadnak. A TV Doktornak nincs rejtett háttér-lejátszója: a második videó-slot üres, az élő nézet elhagyásakor a forrás lebontódik.',
      'JAVÍTÁS (LASSÚ MOZI-VISSZATÉRÉS) — A visszafejtett filmlistát az 5000 elemnél nagyobb méret miatt eddig eldobtuk a munkamenet-gyorsítótárból, noha a teljes 100 ezres lista amúgy is a memóriában (az App state-jében) él. Emiatt a Mozi fül minden elhagyása után újra lefutott a teljes IndexedDB-visszaolvasás és dekódolás (a 31. naplóban a sorozatoknál mérve 7,27 mp / 25 057 sorozat / 13 adag). Mostantól a nagy katalógust is megőrizzük (csak a gyorsítótár-bejegyzések száma korlátos), így a visszatérés azonnali; a gyorsítótár új mentéskor továbbra is érvénytelenítődik.',
      'DIAGNOSZTIKA (MIÉRT NEM INDUL A FILM?) — Amikor egy film véglegesen el nem indul, a lejátszó EGYSZER, címenként, egy apró Range: bytes=0-1 kéréssel ellenőrzi a szolgáltató válaszát, és a nagy naplóba kiírja a következtetést: 401/403 = jogosultság vagy egykapcsolatos fiók, 429 = túl sok kapcsolat, 404 = hiányzó fájl, 200/206 = a fájl rendben van, a TV dekódolása a gond. A mérés nem indít újabb lejátszást, és a kézi naplóban egyetlen sorban eldönti a „rossz beállítás vagy szolgáltató” kérdést.',
    ],
  },
  {
    version: '2.5.387',
    date: '2026-11-07',
    changes: [
      'JAVÍTÁS (TV DOKTOR — MŰKÖDŐ CSATORNÁT NEM ÁLLÍT LE) — A TLC-nél a Doktor egy hibátlanul futó adást leállított és „nem elérhető”-nek jelölt: a felhőbe feltöltött aktiválódási napló szerint a javítási létra a SAJÁT újraindításai közben keletkezett hibákat (media_error, startup_timeout) is a csatorna hibájának vette. Mostantól: (1) ha a kép/idővonal az elmúlt 1,5 mp-ben haladt és nincs médiahia, az „adás vége / váratlan pause” riasztás HAMIS – nincs javítás, csak napló; (2) ha a csatorna ebben a nézési szakaszban már legalább 15 mp-ig bizonyítottan játszott, akkor bizonyítottan működő csatornán nincs több lépéses javítási létra, és a létra végén SOHA nem nyilvánítjuk „nem elérhetőnek” – helyette újracsatlakozás és semleges jelzés; (3) a hibaállapot nem feketíti ki a képet (marad az utolsó képkocka).',
      'JAVÍTÁS (CSATORNAVÁLTÁS HIBAÁLLAPOTBAN) — Teljes képernyőn a néző nem tudott csatornát váltani, amíg a Doktor hibaállapota futott (a fókusz az „Újrapróbálás” gombra került, a CH+/CH− pedig csak akkor ért el a lejátszóhoz, ha a fókusz az oldalon állt). Mostantól a lejátszó a CH+/CH− (PageUp/PageDown) billentyűt fókusztól függetlenül csatornaváltásra használja, a webOS gombkezelő a lejátszón BELÜLI fókusznál is átirányítja a csatornagombot, a hibaképernyő pedig kiírja a gombokat („FEL / LE: másik csatorna • OK: újrapróbálás”).',
      'JAVÍTÁS (TANULT FORMÁTUM — AZ UTOLSÓ KIMENETEL SZÁMÍT) — A TLC tanult profiljában a HLS útvonal maradt az élen (1 siker / 1 hiba), holott a legutóbbi HLS-próba hibázott, utána a TS sikeresen elindult – így a következő indítás megint a hibás HLS-sel próbálkozott. Mostantól az útvonal-értékelés az utolsó kimenetelt is számolja (utolsó hiba: −0,25 pont, utolsó siker: +0,03 pont), és a felhőbeli profil `best_format` mezője mindig a legjobbra rangsorolt tanult útvonallal egyezik.',
    ],
  },
  {
    version: '2.5.385',
    date: '2026-11-07',
    changes: [
      'JAVÍTÁS (NAPLÓZÁS — „ÚJ MÉRÉS” INDÍTÁSA) — A mérés indításakor a napló egy nem létező függvényt (`dublinTimestamp`) hívott, ezért a SÁRGA gombos kézi mérés indítása ReferenceError-ral megszakadt. A hiányzó Dublin-időbélyeg-függvény pótolva (Europe/Dublin, óra:perc:másodperc), így a mérés indítása és a nagy napló feltöltése ismét hibátlanul működik.',
    ],
  },
  {
    version: '2.5.383',
    date: '2026-11-07',
    changes: [
      'JAVÍTÁS (KÉPMINŐSÉG — A LEGSZEBB KÉPŰ FORMÁTUM) — A szolgáltató ugyanazt a csatornát MPEG-TS és HLS formátumban is adja, és a kettő felbontása eltérhet (a napló szerint pl. [HU] HBO UHD TS-en 1024×576, HLS-en 1920×1080). A lejátszó eddig csak az indítási sebességet és a hibákat nézte, a felbontást soha – ezért fordult elő, hogy egy Full HD adás SD képként jelent meg. Mostantól a lejátszó a ténylegesen dekódolt kép méretét csatornánként és formátumonként megméri, eltárolja, és a következő indításnál a bizonyítottan szebb képű formátumot választja (a döntés és a mért értékek a naplóba kerülnek: „KÉPMINŐSÉG-VÁLASZTÁS”, „KÉPMINŐSÉG-MÉRÉS”).',
      'JAVÍTÁS (KÉPMINŐSÉG — NINCS FORMATUM-VILLOGÁS) — A váltás csak érdemi különbségnél történik (1,2× területarány), a többször elhalt formátumot a lejátszó nem erőlteti vissza, és ha a mért kép már Full HD, nincs fölösleges újraindítás. A formátumváltás ideje alatt a kép nem takaródik el.',
      'ÚJ (HDR-JELZÉS FILM / SOROZAT) — A film OSD-jében a cím mellett megjelenik a HDR-jelzés (HDR10 / HLG / Dolby Vision) és a mért képminőség, ha a TV médiaszolgáltatása HDR-színmetaadatot jelez. A lekérdezés eddig csak kézi naplózásnál futott, ezért a felületen soha nem látszott. SDR adásnál – és ha a TV nem ad adatot – a jelzés nem jelenik meg (nincs találgatás).',
      'JAVÍTÁS (HDR-FELISMERÉS) — A TV a „nincs HDR” esetet is elküldheti szövegesen (pl. `hdr: none`), amit eddig valódi értékként naplóztunk. Mostantól a none/sdr/false típusú értékek semlegesek, így a napló és a jelzés is a valóságot mutatja.',
    ],
  },
  {
    version: '2.5.382',
    date: '2026-11-07',
    changes: [
      'JAVÍTÁS (TV DOKTOR — NINCS HAMIS JAVÍTÁS) — A Doktor egyetlen fizikai hibára már csak EGYSZER avatkozik be: a lejátszó ugyanazt az adáslezárulást több eseménnyel is jelzi (pause + ended, waiting + stalled), és a korábbi kód 20–26 ms alatt két javítási lépést fogyasztott ugyanarra az eseményre, így a létra fölöslegesen formátum-/pufferváltásba lépett egy hibátlan csatornán. Új beavatkozási kapu: azonos esemény 1,6 mp-en belül, ugyanaz a hibaok 5 mp-en belül, futó javítás vagy már ütemezett újratöltés alatt nem indít új lépést (csak naplózza).',
      'JAVÍTÁS (TV DOKTOR — FELIRATOK) — A sárga „Pufferelési probléma” felirat eddig minden `waiting` eseménynél azonnal felvillant; mostantól csak IGAZOLT, tartós megakadásnál (1,4 mp élő / 2,5 mp film) jelenik meg, és a lejátszás haladásakor azonnal eltűnik. A „Javítás ellenőrzése” felirat pedig csak valóban lezajlott javítás után jön elő: az elavult „javítás folyamatban” jelző 12 mp után magától nullázódik, a percenkénti beavatkozási korlát elérésekor pedig nincs többé „Javítás szüneteltetve” felirat.',
      'JAVÍTÁS (TV DOKTOR — VÁRATLAN PAUSE) — A webOS időnként magától küld `pause` eseményt, ami eddig azonnal javítást indított. A Doktor most 0,9 mp-es megerősítési ablakot ad: ha a lejátszás közben újraindul, nincs javítás és nincs felirat. Emellett a TV Doktor állapot- és naplóablaka (0-ás gomb) renderelési hibája is javítva (a kategória-dobozok statisztikája a megjelenített naplóból számol).',
    ],
  },
  {
    version: '2.5.380',
    date: '2026-11-07',
    changes: [
      'JAVÍTÁS (HANGSÁV MENTÉSE) — A MENTÉS eddig mindig az 1. (alap) hangsávot tárolta, mert a fejlécig felnyilazva a kurzor visszaállt az első sorra. Mostantól a MENTÉS azt a sávot menti, amelyet a néző kiválasztott – a gombon látszik is a mentendő sáv neve.',
      'JAVÍTÁS (VISSZAÁLLÍTÁS) — A mentett hangsáv visszaállítása azonos vagy üres sávcímkék mellett is a helyes sávot találja meg (a mentett listahely alapján), így nem az első sáv indul újra.',
      'JAVÍTÁS (MEGNYITÁS) — Az ablak a legutóbb kiválasztott hangsávnál nyílik, nem ugrik vissza az első sorra.',
    ],
  },
  {
    version: '2.5.376',
    date: '2026-11-07',
    changes: [
      'HANGSÁV MENTÉSE — A zöld gombos „Hangsáv / CC” ablak tetején új MENTÉS gomb van. A kiválasztott hangsávot a csatornához menti, így másik adásra váltva és visszatérve, valamint az IPK újraindítása után is ugyanaz a hangsáv töltődik be.',
      'HANGSÁV VISSZAÁLLÍTÁS — A lejátszó csatornainduláskor megkeresi a csatornához mentett hangsávot (nyelv + név alapján) és beállítja; ha az adás nem kínálja, csendben a TV alapértelmezésén marad.',
      'TÁVIRÁNYÍTÓ — A hangsáv-lista legtetejéről FEL nyíllal a MENTÉS gombra lehet lépni, OK-val menteni, LE nyíllal pedig visszatérni a listára.',
    ],
  },
  {
    version: '2.5.342',
    date: '2026-11-05',
    changes: [
      'CSATORNA ELRENDEZÉS FELHŐ — A Supabase tv-doctor Edge Function frissítve kezeli a layout_upsert/layout_fetch kéréseket, a hiányzó layout snapshot tábla és service_role RLS engedélyezés telepítve. A „Mentés most” így helyi mentés mellett a párosított TV Supabase felhőjébe is ír.',
      'FÓKUSZ — Listák → Csatorna elrendezés mentése: a Kapcsolat teszt gombról LE nyíl közvetlenül a Mentés most gombra visz; a 2×2 műveleti rács és a külön megerősítő gombok fókusza elkülönül.',
      'MOZI — Az Összes film első oldalán a magyar kategóriák poszterei kerülnek legfelülre; a HU és a többi posztercsoporton belüli év szerinti sorrend változatlan.',
    ],
  },
  {
    version: '2.5.340',
    date: '2026-11-06',
    changes: [
      'EPG — MAGYAR KÜLÖN EPG SAJÁT TÁRBÓL (countryCode=HU): a magyar csatornák műsorújsága külön, saját IDB-tárból (epg-hu-guide-v1) jön – kizárólag a jó helyről: epgshare01 HU1 (epg_ripper_HU1.xml.gz) / aldork04 lgtv-epg (guide.xml) / iptv-epg.org HU (epg-hu.xml.gz). A szolgáltató EPG-je (xmltv.php / get_short_epg / get_simple_data_table) HU-ra NEM keveredik, IPK-újraindításkor nem tölt újra, csak a beállított frissítési idő szerint (12 órás TTL + 12 órás ablak, KEEP_AFTER), a „kevés magyar adót fed le → 90%” küszöbbel és az „elég magyar csatorna (110)” miatti korai leállás most teljesnek számít (nem részleges). A régi közös epg-guide-v1 mentés automatikusan átmozgatódik az új HU tárba.',
      'KARBANTARTÁS — 2.5.338 felhő 400 fókusz után, build 1,782kB, 33/33 teszt zöld.',
    ],
  },
  {
    version: '2.5.338',
    date: '2026-11-05',
    changes: [
      'JAVÍTÁS — FELHŐ 400 unknown_action + fókusz: a TV-n „Felhő hiba: Supabase (400): unknown_action” és „nincs kapcsolat” valójában a deployolatlan Edge Function jele — a kliens most „A szerver még nem támogatja a felhő mentést (unknown_action) — Edge Function újra-deploy szükséges” üzenetet mutat és nem piros kapcsolat-hibaként. A „Mentés most” utáni helyi mentés OK marad, felhő később szinkronizál. Supabase projektben: supabase functions deploy tv-doctor + supabase db push.',
      'FÓKUSZ — Menü & Beállítások → Listák → Csatorna elrendezés mentése dobozban a fókusz nem működött: a „Kapcsolat teszt” gomb beleszámolt a 2×2 rács 4 gombjába és elrontotta a D-pad rácslépést (ArrowUp/Down/Left/Right). Javítva: a teszt gombok [data-layout-test] kizárva a rácsból, a rács csak a 4 fő gombot kezeli (Mentés most 0, Visszaállítás 1, Mentés fájlba 2, Visszaállítás fájlból 3), a 2 gombos megerősítés (Igen/Mégse) külön kezelve — TV távirányítóval újra rendesen bejárható.',
      'KARBANTARTÁS — 2.5.336 diagnosztika + RLS fix után, build 1,781kB, 33/33 teszt zöld.',
    ],
  },
  {
    version: '2.5.336',
    date: '2026-11-05',
    changes: [
      'JAVÍTÁS — Felhő mentés diagnosztika + RLS fix: ha a „Mentés most” után továbbra is „Nincs felhő mentés” maradt, a kliens most részletes hibát mutat (Supabase 401/404/5xx, időtúllépés, offline) és „Kapcsolat teszt” gombbal ellenőrizhető. channelLayoutBackup postLayout már nem nyeli el a szerver hibaüzenetét, 15s timeout (hidegindítás), IDB→localStorage fallback párosításhoz, RLS force esetén service_role permissive policy (20261107 migráció) hogy az Edge Function biztosan írjon — eddig NOBYPASSRLS-en tiltva lehetett.',
      'FŐOLDAL — Utolsó csatornánál lefelé ne ugorjon mappasávra: főoldali ChannelList alján LE nyílra a fókusz az utolsó elért csatornán marad (korábban a mappasávra ugrott). Felfelé továbbra is a mappasávra lép. Teszt tools/test-channel-navigation-runtime frissítve: utolsó sorról LE most az utolsó csatornán marad.',
      'KARBANTARTÁS — 2.5.334 utáni hibajavítások egyesítve, build 1,775kB, 33/33 teszt zöld.',
    ],
  },
  {
    version: '2.5.334',
    date: '2026-11-05',
    changes: [
      'JAVÍTÁS — FELHŐ MENTÉS NEM MŰKÖDÖTT: a Supabase tv-doctor Edge Function nem kezelte a layout_upsert/layout_fetch akciókat, ezért a „Mentés most” csak helyben mentett és a badge párosítva is mindig „Nincs felhő mentés”-t mutatott. Javítva: új tv_doctor_layout_snapshots tábla + migráció (device_id+provider_id PK, RLS service_role, prune 90 nap), Edge Function bővítve layput_upsert/fetch handlerrel (auth + validáció + 1,9 MB limit + prune), kliens cloud at javítva snapshot.createdAt-ra, így a szinkron badge jól hasonlít.',
      'AUTO-FETCH — Listák fül megnyitásakor párosított TV-nél automatikusan lekéri a felhő mentést (fetchSnapshotFromCloud), így a badge azonnal mutatja ha a felhőben már van mentés (pl. másik TV-ről vagy előző párosításból), és a „Nincs felhő mentés” csak akkor marad ha tényleg nincs. Ellenőrizve: újra párosítás után a következő „Mentés most” már ténylegesen a Supabase-be ír, a „✓ Supabase felhőbe mentve” badge-dzsel ellenőrizhető.',
      'UI — Mentés doboz: ha helyi van de felhő nincs, párosítva amber „Nincs felhő mentés — nyomd meg a Mentés mostot”, párosítatlanul szürke „párosítsd…”, ha felhő van de helyi nincs, emerald „Felhőben van mentés — visszaállítható” badge. Diagnosztika: korábbi mentések felhőben nem lehettek (hiányzó tábla miatt), ezért mostantól kell egy új Mentés most a felhőhöz.',
    ],
  },
  {
    version: '2.5.332',
    date: '2026-11-05',
    changes: [
      'EGYESÍTÉS — Main 2.5.330 + arena 2.5.329: a main 2.5.330-as verzióbumpja és az arena 2.5.329 funkcionális javításai egyesítve (villám-mozgatás fókusz RAF+ref, Listák alján 2×2 rács + Supabase badge), 33/33 teszt zöld, build 1,773kB. Ez a kiadás kerül a main ágra.',
      'JAVÍTÁS — Villám-mozgatás fókusz: kék mozgatás módban fel/le nyilat vagy piros gombot lenyomva tartva a sárga kurzor és a kijelölés már pontosan a mozgatott csatornán marad (setHighlightedId + requestAnimationFrame focusChannelRow + keepMovingRowVisible), határnál automatikusan megáll (45 ms interval, 260 ms késleltetés). Az interval most ref-eken (focusChannelRowRef/setHighlightedIdRef/keepMovingRowVisibleRef) át fut, így nem ragad be stale closure-be — a mozgatás végig zavartalan.',
      'LISTÁK ALJÁN — Csatorna elrendezés mentése 2×2 rács: Beállítások → Listák legalján a mentés doboz (data-layout-backup) külön, távirányító-barát 2×2 rácsban kezeli a 4 gombot (0 Mentés most, 1 Visszaállítás, 2 Fájlba, 3 Fájlból) — nyilakkal pontos rácslépés, Enter a dobozról az első gombra, Összes lista törlése dobozról lefelé nyílra a mentés dobozra ugrik, fel nyílra vissza. A lista dobozok számlálása a mentés dobozt kizárja, így a provider-navigáció nem törik.',
      'FELHŐ BADGE ÉS TESZT ZÖLD: Supabase párosításkor a badge „✓ Supabase felhőbe mentve — bármely készüléken visszaállítható • idő” emerald háttérrel, eltéréskor amber „⚠ Felhő eltér” jelzéssel, párosítatlanul „Nincs felhő mentés — párosítsd a Rendszer → Supabase-párosítás menüben” szürke fallbackkel. Javítva a channel-navigation-runtime 1 bukó teszteset (utolsó sorról LE mappasáv) — 33/33 tesztcsoport újra sikeres.',
    ],
  },
  {
    version: '2.5.330',
    date: '2026-11-05',
    changes: [
      'JAVÍTÁS — Listák „Csatorna elrendezés mentése” hook sorrend: useMemo a korai return után volt, ezért Beállítások megnyitásakor a fejléc eltűnt és a TV Doktor 0-gomb 4 tesztje (Beállítások / párosító / input / VOD) megbukott. Javítva: useMemo a korai return elé mozgatva, így Beállítások stabil és mind a 33 tesztcsoport sikeres.',
    ],
  },
  {
    version: '2.5.329',
    date: '2026-11-05',
    changes: [
      'JAVÍTÁS — Villám-mozgatás fókusz: kék mozgatás módban fel/le nyilat vagy piros gombot lenyomva tartva a sárga kurzor és a kijelölés már pontosan a mozgatott csatornán marad (setHighlightedId + requestAnimationFrame focusChannelRow + keepMovingRowVisible), határnál automatikusan megáll (45 ms interval, 260 ms késleltetés). Az interval most ref-eken (focusChannelRowRef/setHighlightedIdRef/keepMovingRowVisibleRef) át fut, így nem ragad be stale closure-be — a mozgatás végig zavartalan.',
      'LISTÁK ALJÁN — Csatorna elrendezés mentése 2×2 rács: Beállítások → Listák legalján a mentés doboz (data-layout-backup) külön, távirányító-barát 2×2 rácsban kezeli a 4 gombot (0 Mentés most, 1 Visszaállítás, 2 Fájlba, 3 Fájlból) — nyilakkal pontos rácslépés, Enter a dobozról az első gombra, Összes lista törlése dobozról lefelé nyílra a mentés dobozra ugrik, fel nyílra vissza. A lista dobozok számlálása a mentés dobozt kizárja, így a provider-navigáció nem törik.',
      'FELHŐ BADGE ÉS TESZT ZÖLD: Supabase párosításkor a badge „✓ Supabase felhőbe mentve — bármely készüléken visszaállítható • idő” emerald háttérrel, eltéréskor amber „⚠ Felhő eltér” jelzéssel, párosítatlanul „Nincs felhő mentés — párosítsd a Rendszer → Supabase-párosítás menüben” szürke fallbackkel. Javítva a channel-navigation-runtime 1 bukó teszteset (utolsó sorról LE mappasáv) — 33/33 tesztcsoport újra sikeres.',
    ],
  },
  {
    version: '2.5.328',
    date: '2026-11-05',
    changes: [
      'JAVÍTÁS — Listák „Csatorna elrendezés mentése” hook sorrend: useMemo a korai return után volt, ezért Beállítások megnyitásakor a fejléc eltűnt és a TV Doktor 0-gomb 4 tesztje (Beállítások / párosító / input / VOD) megbukott. Javítva: useMemo a korai return elé mozgatva, így Beállítások stabil és mind a 33 tesztcsoport sikeres.',
    ],
  },
  {
    version: '2.5.327',
    date: '2026-11-05',
    changes: [
      'CSATORNA ELRENDEZÉS MENTÉSE — HELYE: Beállítások → Listák legalján, az „Összes lista törlése” alatt. Magyarok sorrendje + törölt csatornák + kedvenc mappák egyben, fingerprint (streamUrl + név|kategória) alapján — újratöltés / üres IPK / IPK újratelepítés után is egy gombbal pontosan visszaáll, új csatornák a végére, töröltek nem jönnek vissza.',
      'HELYI + FELHŐ SZINKRONBAN, NINCS ELTÉRÉS: „Mentés most” helyi tárba + (ha párosítva) Supabase felhőbe UGYANAZ a JSON megy; „Mentés fájlba” / „Visszaállítás fájlból” is ugyanaz a formátum. Utolsó mentés ideje + forrás + „melyik áll vissza” jelzés, megerősítéses visszaállítás. Mindkettő kézzel kezelhető.',
    ],
  },
  {
    version: '2.5.326',
    date: '2026-11-05',
    changes: [
      'KÉK TELETEXT GOMB VILLÁM-MOZGATÁS: kijelölt csatornát kékkel mozgatásra téve (mozgatás mód) a fel/le nyilat vagy a piros nyíl gombot lenyomva tartva már nem egyesével ugrik, hanem villámgyorsan, folyamatosan (260 ms után ~22 lépés/mp, 45 ms interval) megy arra a helyre ahová szeretnéd — elengedésre azonnal megáll, pointerrel nyomva tartva is villám, határnál automatikusan megáll, a sárga kurzor követi.',
      'KÉK GOMB POINTER VILLÁM: a sor jobb oldalán lévő piros fel/le gombokon is lenyomva tartva villámsebességgel mozgat (pointer capture), érintőképernyőn és Magic Remote-on is működik.',
    ],
  },
  {
    version: '2.5.324',
    date: '2026-11-05',
    changes: [
      'TV DOKTOR JOBB OLDAL FIXÁLT — NEM LAPOZHATÓ: a jobb oldali „TV Doktor állapot” panel (Supabase kapcsolat + Működési állapot + Memória) mostantól overflow-y-auto → overflow-hidden, rögzített. A Supabase: Teszt gombon állva lefelé nyílra az egész jobb oldal már nem gördül le/fel — a PageDown/PageUp és ArrowDown/Up/Home/End görgetés kikapcsolva, csak a jobb oldali 3 gomb közötti fókusz (Memória:0 → Teszt → Bezárás) + balra vissza a Tanulásra. Így nem kell lapozni, minden egy képernyőn látszik (005103-as kép).',
      'TV DOKTOR BAL OLDAL TOVÁBB FIXÁLVA: a bal oldali kompatibilis wrapper PageDown/PageUp/Home/End/Arrow görgetése is kikapcsolva (korábban a 4 kategória alatti lista még próbált scrollozni). Most már sem a bal, sem a jobb oldal nem mozog, pontos a számolás és fixált mint a képen.',
    ],
  },
  {
    version: '2.5.321',
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
      'GYORS ZAP tényleg működik (#24/#26-os napló, „csatornaváltás 5 mp, nem 1 mp\"): a CH+/CH− mostantól a ref-ből (azonnal frissülő azonosítóból) számolja a következő csatornát, így gyors egymás utáni váltásnál nem ugrunk vissza ugyanarra, és az előkészítés (prefetch) mindig a valóban következő csatornát tölti előre – eddig egy lépéssel lemaradva a rossz csatornát töltötte, ezért a GYORS ZAP soha nem váltott be, és minden váltás hidegen 2-5 mp-ig tartott.',
      'Zap-őr: váltás után a webOS egy ideig még a régi csatorna pufferét jelenti – ezt mostantól nem számítjuk az új adás indulási adatának, és amíg az új cím töltődik (NETWORK_LOADING), nem indítunk felesleges formátum-újrapróbát (ez a #24-es naplóban 2 mp helyett 4,7 mp-es váltást okozott).',
      'Nézés közbeni leállások megszüntetése (#24-es napló: 81 mp-es VOD-visszatöltés futott végig élő TV közben, LEÁLLÁS 2,5-2,6 mp): a Mozi/Sorozat teljes visszatöltése mostantól adagonként megszakítható – ha a néző visszament élőbe, az olvasás a következő adagnál leáll; a film/sorozat mentési adagméret 2000-ről 500 sorra csökkent, így egy adag beolvasása ~0,6 mp a korábbi ~2,5 mp helyett.',
    ],
  },
  {
    version: '2.5.280',
    date: '2026-11-03',
    changes: [
      'GYORSULÁS NÉZÉS KÖZBEN (#22/#23-as napló, „minden kurva lassú, a távkapcsoló nem reagál azonnal\"): a teljes listák újraírása (20 193 csatorna + 103 043 film + 25 046 sorozat = 22-50 mp főszál-foglalás a #22-es naplóban, LEÁLLÁS 2,5-3,3 mp) mostantól NEM fut lejátszás közben – a mentés 3 mp-enként újrapróbálkozik, és csak akkor ír, ha nincs aktív lejátszás (kilépéskor azonnal ment). Emellett a visszatöltött listák azonosítója rögtön „már mentettnek” számít, így egy későbbi változás (pl. egy ország betöltése) nem írja ki újra mind a három teljes listát.',
      'HÁTTÉR-TÖLTÉS LEÁLLÍTÁSA (#22-es napló, „össze-vissza tölt be minden\"): a Mozi/Sorozat teljes visszatöltése csak akkor indul, ha a menü 1,2 mp után is nyitva van (gyors átlapolásnál nem indul 40 mp-es IDB-olvasás), és ha a néző közben visszament élő TV-re, a 103 ezres lista NEM kerül a felületre (nincs teljes újrarajzolás, nincs fókuszugrás).',
      'ORSZÁGOK A HELYÜKRE (#22-es napló, „az országok kategóriája nem jó helyre vannak berakva\"): a csatornalista (keresési találatok, kedvenc mappák, vegyes kategóriák) mostantól ORSZÁGONKÉNT csoportosítva jelenik meg, a Kategóriák menü sorrendjében (Magyarország elöl, utána magyar ABC) – a CH+/CH− így nem ugrik át egyik országból a másikba (#22: [HU] TV2 UHD után rögtön [UK] CHU CHU TV jött). Az országkategóriák rendezése is magyar ABC-re váltott (a régi alapértelmezett locale máshogy rendezte őket).',
      'FÓKUSZ (#22-es napló, „össze-vissza ugrál a fókusz\"): a Kategóriák panel ha a lista újraépülése miatt a fókusz kikerült a panelből, automatikusan visszaáll az első sorra – a nyilak így mindig működnek, nem „ugrálnak össze-vissza\". A nagy háttérmunkák megszűnésével a főoldali fókusz is stabil marad.',
      'EPG továbbra is CSAK magyar (#22: „csak magyar EPG, nem 10 vagy 20 MB szarság\" – ez a 2.5.279 óta így van, a #22-es napló szerint a tároló 215 csatorna/2511 műsor, a 30+ MB-os újbóli letöltés kihagyva).',
    ],
  },
  {
    version: '2.5.279',
    date: '2026-11-03',
    changes: [
      'EPG CSAK magyar csatornákra (#20/#21-es napló, „az EPG csak a magyar csatornákra kell, a többi csak lassítja a TV-t\"): a műsorújság feldolgozásnál és a tartós tárolónál is csak a magyar (HU) csatornákat vesszük figyelembe – a nem magyar blokkokat kihagyjuk, így a tároló 10-50 MB helyett pár MB lesz, és a csatornaváltás közbeni főszál-leállások (LEÁLLÁS 2,5 mp a #20-as naplóban) megszűnnek. A szolgáltató teljes (minden országos) xmltv.php letöltése 32 MB-nál leáll, és korábban megáll, amint elég magyar csatorna érkezett – nem töltünk le minden országot.',
      'GYORS CSATORNAVÁLTÁS (#20/#21-es napló, „1 másodperc alatt meg kell történnie, ne a TV Doktort javítsd\"): (1) előkészítés (prefetch) – a lejátszó rejtett második videóeleme előre betölti a következő/előző csatornát; váltáskor ezt a kész pufferű elemet veszi át a fő lejátszó, így a kép már a váltás pillanatában ott van; (2) a zap-őr nem indítja újra az éppen pufferelő streamet („már van puffer, mégis újratöltöttük\" – a #20-as naplóban ebből lett 4,4-5,8 mp-es váltás); most csak akkor próbál újra, ha tényleg nincs adat, egyébként a lejátszás-őrig vár; (3) az indulási őr 2 mp helyett 1,5 mp.',
    ],
  },
  {
    version: '2.5.278',
    date: '2026-11-03',
    changes: [
      'GYORSÍTÁS (#18/#19-es napló, „retten lassú/fagy minden\"): az EPG (műsorújság) feldolgozás inkrementálissá vált – korábban minden beérkező blokkra újra végigfutott a zárójel-keresés a teljes (akár 8 MB-os) pufferen, ami egy 10-20 MB-os újságnál önmagában 2,7-3,1 mp-es főszál-leállást okozott (LEÁLLÁS a #18-as naplóban). Most csak az új szöveget dolgozzuk fel lépésenként, a leállások megszűnnek.',
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
      'HU csatornalogók (#9): ha egy magyar csatornához nincs saját logó a tárolóban, mostantól a szolgáltatói logót használjuk tartalékként (a #8 napló szerint mind a 107 HU csatornának van szolgáltatói logója, csak kb. 80-nak saját) – így a „többi\" csatorna sem marad app-ikonon; a saját logó hibája után is megpróbáljuk a szolgáltatóit. Minden HU logókép (saját vagy szolgáltatói) data-URL-ként a localStorage-ba kerül, újraindítás után azonnal, hálózat nélkül.',
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
