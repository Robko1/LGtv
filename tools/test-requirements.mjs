#!/usr/bin/env node
/*
 * A hét követelmény tesztje.
 *
 * Futtatás:  node --test tools/test-requirements.mjs     (vagy: npm test)
 *
 * Kétféle ellenőrzés van itt:
 *
 *   1. VISELKEDÉSI teszt – jsdom-ban valódi DOM-ot építünk, és a tényleges
 *      HTML-ben futó kódot hívjuk (pl. a webOS indítókép eltüntetése).
 *   2. SZERKEZETI teszt – a forrás adott részletét ellenőrzi ott, ahol a
 *      viselkedés csak egy egész TV-n mérhető (pl. a kép kitöltése). Ezek
 *      nem stílus-őrök: mindegyik egy KONKRÉT hibát zár ki, ami egyszer
 *      már előfordult (a hibaüzenet meg is mondja, melyiket).
 *
 * Minden teszt a követelmény számát viseli a nevében.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PAGE = read('web/index.html');
const MAIN = read('web/src/main.tsx');
const APP = read('web/src/App.tsx');
const LIST = read('web/src/components/ChannelList.tsx');
const PLAYER = read('web/src/components/VideoPlayer.tsx');
const IMPORT = read('web/src/services/providerImport.ts');

/* ─────────────────────────── 1. Indítókép ────────────────────────── */

function bootPage({ notifyAppLoaded } = {}) {
  const calls = [];
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(PAGE, {
    url: 'https://tv.local/index.html',
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      // A webOS platform hídja: csak a notifyAppLoaded számít.
      window.webOSSystem = {
        notifyAppLoaded: () => {
          calls.push(Date.now());
          if (notifyAppLoaded) notifyAppLoaded();
        },
      };
    },
  });
  return { window: dom.window, dom, calls };
}

test('1. a webOS indítókép pontosan akkor tűnik el, amikor a kész felület megjelenik', () => {
  const { window, dom, calls } = bootPage();
  try {
    assert.equal(window.__IPTV_REVEALED__, false, 'induláskor a felület rejtve van');
    assert.equal(calls.length, 0, 'a kész felület előtt nem szabad eltüntetni az indítóképet');
    assert.match(window.document.documentElement.className, /iptv-booting/);

    window.__IPTV_REVEAL__('teszt');

    assert.equal(calls.length, 1, 'a notifyAppLoaded pontosan egyszer fut');
    assert.equal(window.__IPTV_REVEALED__, true);
    assert.doesNotMatch(window.document.documentElement.className, /iptv-booting/);
    assert.match(window.document.documentElement.className, /iptv-revealed/);
  } finally {
    dom.window.close();
  }
});

test('1. a megjelenítés egyszeri: ismételt hívásra nincs második váltás (nincs villogás)', () => {
  const { window, dom, calls } = bootPage();
  try {
    window.__IPTV_REVEAL__('első');
    window.__IPTV_REVEAL__('második');
    window.__IPTV_REVEAL__('harmadik');
    assert.equal(calls.length, 1, 'a takarékép csak egyszer tűnik el');
  } finally {
    dom.window.close();
  }
});

test('1. a megjelenítés két animációs kép után történik (a kész kép már a képernyőn)', () => {
  // A main.tsx a reveal-t két requestAnimationFrame után hívja: az első
  // képben a rejtett felület már a DOM-ban van, a másodikra kirajzolódott.
  assert.match(MAIN, /const afterPaint = \(fn: \(\) => void\) => \{[\s\S]{0,220}requestAnimationFrame/);
  const afterPaint = MAIN.slice(MAIN.indexOf('const afterPaint'));
  const body = afterPaint.slice(0, afterPaint.indexOf('};'));
  assert.equal((body.match(/requestAnimationFrame/g) || []).length, 2, 'két kép kell a festés biztosításához');
  assert.match(MAIN, /revealNow\(/);
});

test('1. a takarékép-réteg eltűnik a megjelenéskor, és nincs beúszás (nincs villogás)', () => {
  const { window, dom, calls } = bootPage();
  try {
    const curtain = window.document.getElementById('tv-curtain');
    assert.ok(curtain, 'a saját takarékép-réteg létezik');
    assert.equal(window.getComputedStyle(curtain).display !== 'none', true);
    window.__IPTV_REVEAL__('teszt');
    assert.equal(window.document.getElementById('tv-curtain'), null, 'a réteg a váltáskor eltűnik');
    assert.equal(calls.length, 1, 'a webOS indítóképét ugyanekkor emeljük le');
    // A korábbi 140 ms-os áttűnés volt a "villogás": nem maradhat.
    assert.doesNotMatch(PAGE, /animation:\s*iptvReveal/);
    assert.doesNotMatch(PAGE, /@keyframes iptvReveal/);
  } finally {
    dom.window.close();
  }
});

test('1. nincs "2 másodperc után elég a fejléc" korai megjelenés (ez okozta a fokozatos felépülést)', () => {
  assert.doesNotMatch(MAIN, /elapsed > 2000/, 'a korai megjelenés nem létezhet');
  assert.match(MAIN, /const chromeReady = \(\) =>/, 'a fejléc ÉS a mappasáv kell a megjelenéshez');
  assert.match(MAIN, /const logosSettled = \(\) =>/, 'a logók betöltésére is várunk');
  assert.match(MAIN, /const videoSettled = \(\) =>/, 'az első képkockára is várunk (nincs fekete TV-terület)');
});

test('1. a lejátszó jelzi az első képkockát, és addig nem fekete a TV-terület', () => {
  assert.match(PLAYER, /__IPTV_VIDEO_READY__ = true/);
  assert.match(PLAYER, /data-player-poster=""/);
  assert.match(PLAYER, /!isVod && !firstFrameShown/);
});

/* ───────────────────────── 2. A kép méretezése ───────────────────── */

test('2. az élő kép kitölti a területet és megtartja az arányát (cover, nem contain)', () => {
  assert.match(PLAYER, /objectFit: isVod \? \(isFullscreen \? 'fill' : 'contain'\) : 'cover'/);
  // A főoldali (nem teljes képernyős) kényszerített újramérés is cover.
  assert.match(PLAYER, /objectFit: 'cover',[\s\S]{0,80}?\}\);/);
  // A `contain` üres sávot hagyna: ÉLŐ képnél nem lehet (a VOD maradhat).
  const liveStyle = PLAYER.match(/objectFit: isVod \?[^\n]*\n/)[0];
  assert.match(liveStyle, /: 'cover' \}\}/);
});

test('2. a kép nem `transform`-mel méreteződik (az újraépítené a dekódolót)', () => {
  assert.doesNotMatch(PLAYER, /transform: `?scale\(/);
  assert.doesNotMatch(PLAYER, /style\.transform\s*=\s*['"]scale/);
});

/* ────────────────────────── 3. A navigáció ───────────────────────── */

test('3. a csatornalista doboza soha nem fókuszolható', () => {
  const listbox = LIST.slice(LIST.indexOf('role="listbox"') - 600, LIST.indexOf('role="listbox"'));
  assert.doesNotMatch(listbox, /tabIndex=\{0\}/, 'a listbox konténer nem kaphat tabindexet');
  assert.doesNotMatch(LIST, /channelScrollRef\.current\?\.focus\(/, 'semmi nem fókuszolhatja a dobozt');
  assert.doesNotMatch(APP, /list\.focus\(/, 'az App sem fókuszolhatja a dobozt');
  // A mappasáv maga sem fókuszálható – csak a benne lévő mappák gombjai.
  assert.doesNotMatch(LIST, /focusFolderBar[\s\S]{0,400}?bar\.focus\(/);
});

test('3. a fókusz mindig a csatornasorra kerül (a doboz helyett)', () => {
  assert.match(LIST, /const focusChannelRow = \(channelId: string\): boolean => \{/);
  assert.match(LIST, /const focusFirstChannelRow/);
  // A mappasávból lefelé az ELSŐ SOR kapja a fókuszt. A mappasáv saját
  // kezelője a data-tv-folders blokk: ott kell lennie a lefelé ágnak.
  const bar = LIST.slice(LIST.indexOf('data-tv-folders=""'));
  const barDown = bar.slice(bar.indexOf("} else if (key === 'ArrowDown') {"));
  assert.match(barDown.slice(0, 900), /focusChannelRow\(first\.id\)/);
});

test('3. a fejlécből lefelé a mappasáv következik, abból az első csatorna', () => {
  // A header → mappasáv lépés a App.tsx-ben:
  const headerDown = APP.slice(APP.indexOf("target.closest('header')) {"));
  assert.match(headerDown.slice(0, 600), /\[data-tv-folders\] \[data-tv-folder\]/);
  // A mappasáv → első sor lépés a ChannelList.tsx-ben:
  assert.match(LIST, /A kedvenc mappák alól mindig az első csatornaszámra lépünk/);
  // A kért útvonal: Beállítások → lefelé → Kedvencek → lefelé → első csatorna.
  // A három elem mindegyike létezik és külön fókuszcél:
  assert.match(read('web/src/components/Header.tsx'), /data-tv-header-default/);
  assert.match(LIST, /data-tv-folders/);
  assert.match(LIST, /role="option"/);
});

/* ─────────────────────── 4. Teljes képernyős OSD ─────────────────── */

test('4. teljes képernyőn az OSD akkor is megjelenik, ha az eltűnés 0 másodpercre van állítva', () => {
  // A hiba: `if (!isVideoFullscreen || ... || settings.osdHideDelay <= 0) { false }`
  // – nulla értéknél az OSD egyáltalán nem jelent meg.
  assert.doesNotMatch(APP, /osdHideDelay <= 0\)\s*\{\s*setIsFullscreenLiveOsdVisible\(false\)/);
  const effect = APP.slice(APP.indexOf('const fullscreenOsdTimerRef'));
  assert.match(effect.slice(0, 1400), /showFullscreenLiveOsd\(\);/);
  // A 0 mostantól "soha ne tűnjön el", nem "soha ne jelenjen meg".
  assert.match(APP, /if \(settings\.osdHideDelay > 0\) \{[\s\S]{0,200}?setIsFullscreenLiveOsdVisible\(false\)/);
});

test('4. a teljes képernyős OSD a kép FÖLÖTT van (nem a lejátszó mögött)', () => {
  const OSD = read('web/src/components/ChannelControls.tsx');
  // A webOS TV CSS a teljes képernyős lejátszót 2147483000-re teszi; az OSD
  // korábbi z-10000 értéke ezért MINDIG a kép mögé került.
  const osdSource = OSD.slice(OSD.indexOf('FullscreenLiveOsd'), OSD.indexOf('export const ChannelControls'));
  assert.match(osdSource, /data-fullscreen-osd=""/);
  assert.match(osdSource, /zIndex: 2147483001/);
  // A régi, kép mögötti Tailwind z-index osztály nem maradhat a JSX-ben.
  assert.doesNotMatch(osdSource, /className="[^"]*z-\[10000\]/, 'a régi, kép mögötti z-index nem maradhat');
});

test('4. teljes képernyőn bármely gomb visszahozza az OSD-t', () => {
  const keys = APP.slice(APP.indexOf('const handleKeyDown = (e: KeyboardEvent) => {'));
  assert.match(keys.slice(0, 1600), /if \(isVideoFullscreen && !customStreamUrl\) \{\s*showFullscreenLiveOsd\(\);/);
});

/* ────────────────────── 5. A teljes képernyős váltás ─────────────── */

test('5. a teljes képernyő CSS-átfedés: nincs Fullscreen API, nincs új oldal/stream', () => {
  // A váltást végző függvény törzse: ebben nem lehet Fullscreen API.
  const toggle = PLAYER.slice(PLAYER.indexOf('const toggleFullscreen = () => {'));
  const toggleBody = toggle.slice(0, toggle.indexOf('\n  };'));
  assert.doesNotMatch(toggleBody, /requestFullscreen/, 'a natív Fullscreen API nullázza a webOS dekódolót');
  assert.doesNotMatch(toggleBody, /document\.exitFullscreen/);
  // A váltás csak állapot és CSS-osztály.
  assert.match(PLAYER, /setIsFullscreen\(\(previous\) => !previous\)/);
  assert.match(PLAYER, /document\.body\.classList\.toggle\('iptv-tv-fullscreen', isFullscreen\)/);
});

test('5. a teljes képernyőre lépés nem indít új lejátszást (ugyanaz a <video> elem)', () => {
  // A stream URL kizárólag a videó effektjében változik, a fullscreen
  // állapotváltás nem szerepel a függőségei között.
  const loadEffect = PLAYER.slice(PLAYER.indexOf('const streamUrl ='));
  assert.ok(loadEffect.length > 0);
  assert.doesNotMatch(
    PLAYER,
    /useEffect\([\s\S]{0,200}?\[isFullscreen\][\s\S]{0,200}?\.load\(\)/,
    'a teljes képernyő váltása nem töltheti újra a videót'
  );
});

/* ──────────────────── 6. Teljesítmény / újrarajzolás ─────────────── */

test('6. a főoldali kép méretezése nem kényszerít kilenc újraelrendezést csatornaváltáskor', () => {
  // Korábban: 4 időzítő + 3 egymásba ágyazott animációs kép + 2
  // kényszerített mérés futott minden váltáskor.
  assert.doesNotMatch(PLAYER, /\[80, 180, 350, 600\]\.forEach\(\(delay\) => \{\s*settleTimers\.push\(window\.setTimeout\(syncMainPageLayout/);
  assert.doesNotMatch(PLAYER, /frame2|frame3/);
  assert.match(PLAYER, /settleTimers\.push\(window\.setTimeout\(syncMainPageLayout, 250\)/);
});

test('6. a csatornakeresés térképen fut, nem lineáris kereséssel', () => {
  assert.match(APP, /const channelsById = useMemo\(\(\) => \{/);
  assert.match(LIST, /channelIndexById\.get\(/);
});

/* ──────────────────── 7. A letöltés felgyorsítása ────────────────── */

test('7. a bejelentkezés nem blokkolja a csatornalistát (a probe a háttérben fut)', () => {
  const authIndex = IMPORT.indexOf('const authPromise = providerRequest(');
  const liveIndex = IMPORT.indexOf('const liveStreams = await Promise.all(');
  const awaitIndex = IMPORT.indexOf('const authResult = await authPromise;');
  assert.ok(authIndex > 0 && liveIndex > 0 && awaitIndex > 0);
  assert.ok(authIndex < liveIndex, 'a probe a csatornakérés előtt INDUL, de nem várunk rá');
  assert.ok(awaitIndex > liveIndex, 'a fiókadatokra csak a csatornák után várunk');
});

test('7. a csatornák nem várnak a kategóriákra (a kategóriavégpont külön ígéret)', () => {
  const catsIndex = IMPORT.indexOf('const liveCatsPromise = providerRequest(');
  const streamsIndex = IMPORT.indexOf('const liveStreams = await Promise.all(');
  assert.ok(catsIndex > 0, 'a kategóriák külön ígéretként indulnak');
  assert.ok(catsIndex < streamsIndex, 'a kategórialetöltés a csatornák ELŐTT indul');
  // A kategóriákra csak a feldolgozás után várunk, és hiba esetén üres lista.
  assert.match(IMPORT, /const liveCats = await liveCatsPromise;/);
  assert.match(IMPORT, /\.catch\(\(\) => \[\] as XtreamCategory\[\]\)/, 'kategóriahiba nem állítja meg a csatornákat');
});

test('7. az első használható csatornaadag azonnal megjelenik (előnézet)', () => {
  assert.match(IMPORT, /const FIRST_BATCH_CHANNELS = \d+;/);
  assert.match(IMPORT, /if \(liveProcessed === FIRST_BATCH_CHANNELS\) \{[\s\S]{0,400}?preview: true/);
  // Az előnézet NEM íródik a tárolóba (nincs félkész mentés, nincs adatvesztés).
  assert.match(APP, /if \(!partial\.preview\) \{[\s\S]{0,200}?saveLiveContent\(draft\)/);
});

test('7. ha a csatornák nem jönnek, a bejelentkezés hibája a hasznosabb üzenet', () => {
  assert.match(IMPORT, /\.catch\(async \(error: unknown\) => \{[\s\S]{0,400}?if \(!probe\.ok\) throw probe\.error;/);
});

test('7. a csatornák a filmek előtt, önállóan kerülnek a felületre', () => {
  const partialIndex = IMPORT.indexOf('await onPartial({\n    channels: liveChannels,');
  const vodIndex = IMPORT.indexOf('/* ---- 2. szakasz: filmek');
  assert.ok(partialIndex > 0 && vodIndex > 0);
  assert.ok(partialIndex < vodIndex, 'a csatornák azonnal publikálódnak, a filmek utána jönnek');
  // A film- és sorozatlista egymástól függetlenül töltődik (nem Promise.all mindenre).
  assert.doesNotMatch(IMPORT, /await Promise\.all\(\[[^\]]*importXtreamProvider/);
});

/*
 * ── Kiadás előtti verzió-egyezés (a 2026-10-22-i buildhiba) ────────────
 *
 * Az „IPK építés” workflow a web/src/appVersion.ts WEB_VERSION-jét tekinti
 * igazságforrásnak, és az appinfo.json verziójából indul ki. Amikor a webes
 * verzió kézzel 2.5.13-ra lépett, de az appinfo.json 2.5.12 maradt, a build
 * a 2. lépésben azonnal elhalt („appinfo.json verziója eltér a forrásétól”),
 * és nem készült IPK. Ezt a két fájlt mostantól teszt őrzi.
 */
test('8. az appinfo.json verziója pontosan a webes verzió (a build nem áll meg)', () => {
  const source = read('web/src/appVersion.ts');
  const match = source.match(/WEB_VERSION\s*=\s*'([0-9]+\.[0-9]+\.[0-9]+)'/);
  assert.ok(match, 'a WEB_VERSION olvasható');
  const manifest = JSON.parse(read('webos/appinfo.json'));
  assert.equal(
    manifest.version,
    match[1],
    `az appinfo.json (${manifest.version}) és a WEB_VERSION (${match[1]}) eltér – a build ezen elhasal`
  );
});

test('8. a build verzióeltérésnél szinkronizál, nem áll le hibával', () => {
  const workflow = read('.github/workflows/webos-build.yml');
  assert.doesNotMatch(
    workflow,
    /eltér a forrásétól/,
    'a workflow nem állhat meg verzióeltérésnél (szinkronizálnia kell)'
  );
  assert.match(workflow, /appinfo\.json szinkron a webes verzióhoz/);
  // Az appinfo.json a szinkron után is ugyanarra a verzióra lép, mint a forrás.
  assert.match(workflow, /manifest\["version"\] = old[\s\S]{0,80}manifest\["version"\] = new/);
});

/* ────────── Teljes képernyő: kitöltés és csatornaváltás (2.5.15) ────────── */

/*
 * A 2.5.13/2.5.14-ben a teljes képernyő elromlott: a főoldali 16:9-es keret
 * mérése INLINE `position: relative`-t írt a lejátszó dobozára, ami erősebb a
 * `fixed` osztálynál – így a doboz a fejléc alatt maradt, és a kép nem
 * töltötte ki a kijelzőt. A régi webOS Chrome a `dvh`/`inset` értékeket sem
 * ismeri. Ezek a próbák a javítást rögzítik.
 */
test('5. teljes képernyőn a doboz INLINE is fixed, 100vh-val (régi webOS Chrome)', () => {
  // A stílus-objektumban közvetlenül ott kell lennie a fix tájolásnak.
  assert.match(PLAYER, /position: 'fixed'/, 'a teljes képernyős geometria inline position: fixed');
  assert.match(PLAYER, /height: '100vh'/, 'a magasság vh-ban (a dvh-t a régi webOS nem ismeri)');
  // A dvh-t a régi webOS Chrome (3.x/4.x/5.x) nem ismeri – csak kommentben maradhat.
  assert.doesNotMatch(PLAYER, /'100dvh'|h-\[100dvh\]/, 'nem maradhat dvh a teljes képernyős méretekben');
  assert.match(PLAYER, /zIndex: 2147483000/, 'a lejátszó a legfelső réteg');
  // A 16:9-es keret mérése teljes képernyőn NEM futhat.
  assert.match(PLAYER, /if \(isVod \|\| isFullscreen\) return;/);
});

test('5. kilépéskor visszaáll a 16:9-es keret (a teljes képernyős geometria nem ragad be)', () => {
  // A body-osztály a teljes képernyő igazsága: belépéskor felkerül, kilépéskor le.
  assert.match(PLAYER, /document\.body\.classList\.toggle\('iptv-tv-fullscreen', isFullscreen\)/);
  // A 16:9-es mérés teljes képernyőn (és késedelmes híváskor is) nem futhat le.
  assert.match(PLAYER, /document\.body\.classList\.contains\('iptv-tv-fullscreen'\)/);
  // A 16:9-es mérés a teljes képernyő és a VOD állapotára is figyel.
  assert.match(PLAYER, /\}, \[isFullscreen, isVod, streamUrl\]\);/);
});

test('5. teljes képernyőn a fókusz a lejátszón marad (nem a rejtett listán)', () => {
  assert.match(PLAYER, /const assertFocus = \(\) => \{/);
  assert.match(PLAYER, /if \(active && active !== container && container\.contains\(active\)\) return;/);
  // Több időpontban is ellenőrzünk, hogy egy késői újrarajzolás ne vigye el.
  assert.match(PLAYER, /\[0, 80, 260, 600\]\.map\(\(delay\) => window\.setTimeout\(assertFocus, delay\)\)/);
});

test('5. a webOS gombkezelő csak a LÁTHATÓ csatornalistát használja', () => {
  const webos = read('webos/webos.js');
  assert.match(webos, /function isHiddenEl\(el\) \{/, 'van láthatóság-ellenőrzés');
  assert.match(webos, /function channelsListBox\(\) \{[\s\S]{0,300}?isHiddenEl\(list\) \? null : list/, 'a rejtett lista "nincs"');
  // Sehol nem lehet nyers listbox-keresés (az mindig a rejtett listát is megtalálná).
  const rawLookups = webos.match(/document\.querySelector\('\[role="listbox"\]'\)/g) || [];
  assert.equal(rawLookups.length, 1, 'csak a channelsListBox() kereshet listát');
});

test('5. teljes képernyőn a gomb a lejátszóhoz megy (CH+/CH- = FEL/LE)', () => {
  const webos = read('webos/webos.js');
  assert.match(webos, /var fsPlayer = null;[\s\S]{0,200}?\[data-tv-player\]\.fixed/, 'megkeresi a teljes képernyős lejátszót');
  assert.match(webos, /var fsKey = key === 'PageUp' \? 'ArrowUp' : \(key === 'PageDown' \? 'ArrowDown' : key\);/);
  assert.match(webos, /fsPlayer\.dispatchEvent\(evFs\);/);
});

test('5. a rejtett csatornalista nem dolgozza fel a gombokat', () => {
  const list = read('web/src/components/ChannelList.tsx');
  assert.match(list, /host\.closest\('\[data-view-hidden\]'\)/, 'a rejtett lista kilép a gombkezelésből');
});

/* ────────── webOS ES5 őr (a CI 6. lépésének szabálya) ────────── */

/*
 * A `webos/webos.js` a régi LG TV-ken (Chrome 38–53) fut, ezért TILOS benne
 * modern szintaxis: nyíl-függvény, template string (backtick), `catch {`,
 * `let`/`const`. A CI 6. lépése pontosan ezt greppeli – és a 2.5.16 build
 * el is hasalt rajta, mert egy MAGYARÁZÓ megjegyzésbe backtick került.
 *
 * A szabály most itt is fut, hogy a hiba már a `npm test` alatt kiderüljön
 * (a CI-ban ez az 5b lépés), ne a csomagolásnál.
 */
test('6. a webos.js szigorúan ES5 (nincs =>, backtick, catch {, let/const)', () => {
  const lines = read('webos/webos.js').split('\n');
  const bad = [];
  lines.forEach((line, index) => {
    if (/=>|`|catch \{|catch\{|^[ \t]*(let|const) |[;{(=] ?(let|const) /.test(line)) {
      bad.push(`  ${index + 1}. sor: ${line.trim()}`);
    }
  });
  assert.deepEqual(bad, [], `modern JS szintaxis a webos.js-ben:\n${bad.join('\n')}`);
});

test('6. a CI 6. lépésének minden forrás-őre teljesül', () => {
  const webos = read('webos/webos.js');
  assert.match(read('web/src/services/webosUpdateService.ts'),
    /https:\/\/api\.github\.com\/repos\/Robko1\/LGtv\/releases\/latest/);
  for (const marker of ['normalizeKey', 'focusSpatially', 'KEYCODE_TO_KEY', 'makeKeyEvent']) {
    assert.ok(webos.includes(marker), `hiányzó jelölő a webos.js-ben: ${marker}`);
  }
  // Más platformra utaló kód nem lehet a webOS forrásban.
  const platform = [];
  for (const rel of ['web/src', 'web/index.html']) {
    const full = path.join(ROOT, rel);
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|jsx|css|html)$/.test(entry.name)) platform.push(p);
      }
    };
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full); else platform.push(full);
  }
  const offenders = platform.filter((file) => /IPTVNative|Android|WebView|\.apk/i.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(ROOT, file));
  assert.deepEqual(offenders, [], `más platformra utaló kód: ${offenders.join(', ')}`);
});

/* ────────── 7. Mozi/Sorozat navigáció, mappatörlés, gyors visszalépés ────────── */

test('7. a rejtett nézet display:none (nincs beégett maradék kép a háttérben)', () => {
  assert.match(APP, /display: isActive \? undefined : 'none'/, 'a nem aktív nézet kikerül a kirajzolásból');
  assert.doesNotMatch(APP, /visibility: isActive \? 'visible' : 'hidden'/,
    'a visibility-kapcsolás maradék (beégett) képkockákat hagyott a Mozi nézet hátterében');
});

test('7. nézetváltáskor a görgetési pozíció megmarad (display:none mellett is)', () => {
  assert.match(APP, /const capturePaneScroll = useCallback\(\(view: string\)/, 'van görgetés-mentés');
  assert.match(APP, /const restorePaneScroll = useCallback\(\(view: string\)/, 'van görgetés-visszaállítás');
  assert.match(APP, /capturePaneScroll\(activeView\);/, 'váltás ELŐTT mentünk');
  assert.match(APP, /restorePaneScroll\(activeView\);/, 'a megnyitott nézetben visszaállítunk');
  assert.match(read('web/src/components/ChannelList.tsx'), /data-scroll-keep=""/);
  assert.match(read('web/src/components/MoviesView.tsx'), /data-scroll-keep=""/);
  assert.match(read('web/src/components/SeriesView.tsx'), /data-scroll-keep=""/);
});

test('7. nézetváltáskor a fókusz a megnyitott nézetbe kerül', () => {
  assert.match(APP, /const first = pane\.querySelector<HTMLElement>\(/, 'a nézet első vezérlője kapja a fókuszt');
  assert.match(APP, /\[data-view-pane="\$\{activeView\}"\]/, 'a LÁTHATÓ nézetet keressük');
});

test('7. a VISSZA gomb a Mozi/Sorozat nézetből az élő nézetbe tér vissza', () => {
  assert.match(APP, /if \(activeView !== 'live'\) \{\s*e\.preventDefault\(\);\s*handleViewChange\('live'\);/,
    'a nézetből eddig nem lehetett kijutni a távirányítóval');
});

test('7. a háttérben lévő csatornalista nem lopja el a fókuszt', () => {
  const guards = APP.match(/data-view-pane\]:not\(\[data-view-hidden\]\)[^\n]*!== 'live'/g) || [];
  assert.ok(guards.length >= 2, 'mindkét fókusz-visszaállító effekt ellenőrzi a nézetet');
});

test('7. kedvenc mappa törlése távirányítóval (nincs window.confirm)', () => {
  const settings = read('web/src/components/MenuSettingsModal.tsx');
  // Csak a KÓD számít: a magyarázó megjegyzésekben szerepelhet a confirm szó.
  const settingsCode = settings
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '') // JSX komment
    .replace(/\/\*[\s\S]*?\*\//g, '')      // blokk-komment
    .replace(/^\s*\/\/.*$/gm, '');           // sor-komment
  assert.doesNotMatch(settingsCode, /window\.confirm|(?<![.\w])confirm\(/, 'a TV nem jelenít meg natív confirm ablakot');
  assert.match(settings, /const \[pendingDeleteFolderId, setPendingDeleteFolderId\]/);
  assert.match(settings, /Igen, törlés/, 'van megerősítő gomb');
  assert.match(settings, /Mégse/, 'van visszavonó gomb');
  assert.match(settings, /onDeleteFolder\(f\.id\);/, 'a megerősítés valóban töröl');
  // A törlés-megerősítés a saját kérdésen belül kap fókuszt (TV-n is elérhető).
  assert.match(settings, /if \(pendingDeleteFolderId\) \{[\s\S]{0,220}?setPendingDeleteFolderId\(null\);/, 'VISSZA: a kérdés visszavonása');
});

test('7. teljes képernyőről visszatérve nincs újraépítés', () => {
  // Az oldalsáv nem tűnik el (nincs visibility-kapcsolás): a lejátszó fedi.
  assert.match(APP, /data-live-sidebar=""/);
  assert.doesNotMatch(APP, /visibility: isVideoFullscreen \|\| customStreamUrl \? 'hidden' : 'visible'/,
    'a visibility eldobta a csatornalista kirajzolt rétegét = lassú visszatérés');
  // Az OSD mountolva marad (nincs feltételes mount/unmount).
  assert.doesNotMatch(APP, /\{!customStreamUrl && !isVideoFullscreen && isOsdVisible && <ChannelControls/,
    'az OSD minden váltáskor újraépült');
  assert.match(APP, /display: isVideoFullscreen \|\| !isOsdVisible \? 'none' : undefined/);
  // A csatornalista memoizált (nem rajzolódik újra a teljes képernyő miatt).
  assert.match(read('web/src/components/ChannelList.tsx'), /export const ChannelList = React\.memo\(/);
  assert.match(read('web/src/components/MoviesView.tsx'), /React\.memo\(MoviesViewComponent\)/);
  assert.match(read('web/src/components/SeriesView.tsx'), /React\.memo\(SeriesViewComponent\)/);
});

test('7. Mozi/Sorozat nézetben a nyilak nem váltanak élő csatornát', () => {
  // A főoldali gyorsgombok (FEL/LE, CH+/CH-) csak az élő nézetben zárnak:
  // böngészés közben nem indulhat el a háttérben egy másik adás.
  const arrows = APP.match(/if \(activeView !== 'live'\) break;/g) || [];
  assert.ok(arrows.length >= 4, `a négy gombkezelő (FEL, LE, CH+, CH-) ellenőrizze a nézetet (talált: ${arrows.length})`);
});

test('7. a sorozat epizódjai távirányítóval is elindíthatók', () => {
  const seriesView = read('web/src/components/SeriesView.tsx');
  assert.match(seriesView, /role="button"\s*\n\s*tabIndex=\{0\}/, 'az epizódsor fókuszálható');
  assert.match(seriesView, /if \(key === 'Enter' \|\| key === ' '\)/, 'az OK/Enter elindítja az epizódot');
  assert.match(seriesView, /data-dialog-primary=\{epIndex === 0 \? '' : undefined\}/,
    'a részletek-ablakban az első epizód kapja a fókuszt');
  // A mozi részletek-ablakában a „Film Indítása” gomb az elsődleges cél.
  assert.match(read('web/src/components/MoviesView.tsx'), /data-dialog-primary=""/);
});

/* ══════════════ 8. Teljes képernyős OSD, tükrözés, Mozi/Sorozat, fejléc ══════════════ */

const CONTROLS = read('web/src/components/ChannelControls.tsx');
const HEADER = read('web/src/components/Header.tsx');
const CATEGORIES = read('web/src/components/CategoriesModal.tsx');
const MOVIES = read('web/src/components/MoviesView.tsx');
const SERIES = read('web/src/components/SeriesView.tsx');
const SETTINGS_MODAL = read('web/src/components/MenuSettingsModal.tsx');

test('8. teljes képernyős OSD: hangsáv + felirat jelző a BAL ALSÓ sarokban, főoldali méretben', () => {
  // A jelzők a teljes képernyős OSD részei → a beállított idő után együtt tűnnek el.
  assert.match(CONTROLS, /data-fullscreen-osd-badges=""/);
  assert.match(CONTROLS, /absolute bottom-6 left-8/, 'a bal alsó sarokban');
  // Ugyanaz a méret, mint a főoldali (compact) OSD-ben.
  assert.match(CONTROLS, /text-sm font-bold text-slate-200/);
  assert.match(CONTROLS, /<Mic2 className=\{`w-4 h-4/);
  assert.match(CONTROLS, /<Subtitles className=\{`w-4 h-4/);
  // Az App átadja a valódi állapotot (több hangsáv / aktív felirat).
  assert.match(APP, /hasMultipleAudioTracks=\{liveAudioTracks\.length > 1\}/);
  assert.match(APP, /hasActiveSubtitle=\{liveSubtitleTracks\.some\(\(track\) => track\.selected === true\)\}/);
});

test('8. a ZÖLD gomb teljes képernyőn is megnyitja a hangsáv-választót (a kép FÖLÖTT)', () => {
  const modal = read('web/src/components/AudioSubtitlesModal.tsx');
  // A lejátszó z-indexe 2147483000 – az ablak ennél magasabbra kerül.
  assert.match(modal, /z-\[2147483010\]/);
  assert.match(modal, /2147483000/, 'a magyarázat rögzíti, miért kell magasabbra');
  // A webOS a ZÖLD (404) gombot 'audio' eseményként küldi.
  assert.match(read('webos/webos.js'), /404 \? 'audio'/);
});

test('8. OSD eltűnés: 6 / 8 / 10 / 12 másodperc választható, és a teljes képernyő ezt használja', () => {
  assert.match(SETTINGS_MODAL, /\{\[6, 8, 10, 12\]\.map\(\(seconds\) => \(/);
  assert.match(SETTINGS_MODAL, /grid grid-cols-4 gap-1\.5 pt-1/);
  // A teljes képernyős OSD időzítője ugyanazt a beállítást használja.
  assert.match(APP, /fullscreenOsdTimerRef\.current = window\.setTimeout\(\(\) => \{[\s\S]{0,200}?\}, settings\.osdHideDelay \* 1000\)/);
  // Régi (2–5 mp) mentett érték a legközelebbi engedélyezett értékre kerekedik.
  const storage = read('web/src/services/storageService.ts');
  assert.match(storage, /const OSD_CHOICES = \[6, 8, 10, 12\];/);
  assert.match(read('web/src/data/mockData.ts'), /osdHideDelay: 8,/);
});

test('8. PIROS (Record) gomb: tükrözött elrendezés be/ki', () => {
  assert.match(read('webos/webos.js'), /kc === 403 \? 'mirror'/);
  assert.match(APP, /else if \(action === 'mirror'\) handleToggleMirrorLayout\(\);/);
  assert.match(APP, /const handleToggleMirrorLayout = useCallback\(\(\) => \{/);
  // A főoldali sor iránya fordul meg: csatornalista balra, lejátszó + OSD jobbra.
  assert.match(APP, /data-live-main-row=""/);
  assert.match(APP, /\$\{settings\.mirrorLayout \? 'md:flex-row-reverse' : 'md:flex-row'\}/);
  // A felső menüsor NEM változik (nincs mirror a Headerben).
  assert.doesNotMatch(HEADER, /mirrorLayout|flex-row-reverse/);
  // A beállításokban is kapcsolható.
  assert.match(SETTINGS_MODAL, /Tükrözött elrendezés/);
  assert.match(SETTINGS_MODAL, /onUpdateSettings\(\{ mirrorLayout: !settings\.mirrorLayout \}\)/);
  // A PIROS gomb korábbi funkciója (diagnosztika QR) NEM veszett el: a
  // Rendszer fülre került át.
  assert.match(SETTINGS_MODAL, /onOpenDiagnosticShare\?: \(\) => void;/);
  assert.match(SETTINGS_MODAL, /Diagnosztika megosztása \(QR\)/);
  assert.match(APP, /onOpenDiagnosticShare=\{\(\) => setIsDiagnosticShareOpen\(true\)\}/);
});

test('8. Mozi/Sorozat: 5 nagy poszter, nincs kereső és nincs „Poszterek” gomb', () => {
  for (const source of [MOVIES, SERIES]) {
    assert.match(source, /grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-5 2xl:grid-cols-5/,
      'egyszerre 5 poszter (a korábbi 8 kicsi helyett)');
    // Pontosan 5 kártya fér el egy sorban (4 db 12 px-es hézag = 3rem).
    assert.match(source, /w-\[calc\(\(100%-3rem\)\/5\)\]/, 'nagy polckártya, 5 egy sorban');
    assert.doesNotMatch(source, /<input[\s\S]{0,400}?placeholder="(Film|Sorozat) keresése/, 'nincs keresőmező');
    assert.doesNotMatch(source, /PosterSettingsButton/, 'nincs „Poszterek” gomb');
    assert.match(source, /const PAGE_SIZE = 50;/, 'kisebb első köteg → gyorsabb nézetváltás');
    assert.match(source, /categoryRows\.slice\(0, visibleRails\)/, 'a polcok lépcsősen épülnek');
    assert.match(source, /setVisibleRails\(\(count\) => \(count < categoryRows\.length \? count \+ RAIL_STEP : count\)\)/);
  }
  // Az üres szűrőnél nincs végigszűrés (a nézetváltás azonnali).
  assert.match(MOVIES, /\(\) => \(selectedCategory === 'all'\s*\? movies/);
  assert.match(SERIES, /\(\) => \(selectedCategory === 'all'\s*\? series/);
});

test('8. Kategóriák: nagy országnév, nagy zászló, a darabszámok a név MELLETT', () => {
  assert.match(CATEGORIES, /w-14 h-14 sm:w-16 sm:h-16 rounded-2xl[\s\S]{0,120}?text-3xl sm:text-4xl/);
  assert.match(CATEGORIES, /text-lg sm:text-xl lg:text-2xl group-hover:text-cyan-300/, 'nagy országnév');
  assert.match(CATEGORIES, /truncate text-white font-black/, 'a név nem lóghat ki a dobozból');
  // A számok a név mellett (flex-wrap sorban), nem alatta.
  assert.match(CATEGORIES, /flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1/);
  assert.match(CATEGORIES, /\{cat\.channelCount\} csatorna/);
  assert.match(CATEGORIES, /\{cat\.subCategoryCount\} kategória/);
  // A lenyíló alkategóriák is nagyobbak.
  assert.match(CATEGORIES, /px-4 py-3 text-left text-base sm:text-lg font-black text-amber-200/);
  assert.match(CATEGORIES, /px-4 py-3 text-left text-base sm:text-lg font-bold text-slate-100/);
});

test('8. Fejléc: Menü → Sorozat → Mozi → Országok, kiválasztott ország zászlaja, sárga fogaskerék', () => {
  const menuAt = HEADER.indexOf('data-tv-header-kind="settings"');
  const seriesAt = HEADER.indexOf('data-tv-header-kind="series"');
  const moviesAt = HEADER.indexOf('data-tv-header-kind="movies"');
  const countriesAt = HEADER.indexOf('data-tv-header-kind="countries"');
  assert.ok(menuAt > 0 && seriesAt > menuAt, 'a Menü van legelöl');
  assert.ok(moviesAt > seriesAt, 'Sorozat után Mozi');
  assert.ok(countriesAt > moviesAt, 'Mozi után Országok');
  // Csak a helyük változott – a gombok osztályai (méret) változatlanok.
  assert.match(HEADER, /h-9 md:h-10 lg:h-11 rounded-lg text-\[22px\] font-bold/);
  // Sárga fogaskerék.
  assert.match(HEADER, /<Settings className="w-8 h-8 shrink-0 text-amber-400" \/>/);
  // A kiválasztott ország zászlaja (nem beégetett magyar zászló).
  assert.match(HEADER, /countryFlag\?: string;/);
  assert.match(HEADER, /\{countryFlag \? \(/);
  assert.match(APP, /countryFlag=\{activeCountryCategory\?\.flag\}/);
  assert.match(APP, /const activeCountryCategory = useMemo\(\(\) => \{/);
});
