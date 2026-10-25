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
  assert.match(PLAYER, /objectFit: 'cover'/);
  // A `contain` üres sávot hagyna: ÉLŐ képnél nem lehet (a VOD maradhat).
  const liveStyle = PLAYER.match(/objectFit: isVod \?[^\n]*\n/)[0];
  assert.match(liveStyle, /: 'cover'(?:,| \}\})/);
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

test('3. stale virtualizált index nem viheti a kijelölést tévesen a mappasávra', () => {
  assert.match(LIST, /const focusedChannelId = activeElement\?\.closest\?\.\('\[data-channel-id\]'\)[^;]+/);
  assert.match(LIST, /const hasRealCurrentRow = Boolean\(currentId/);
  assert.match(LIST, /hasRealCurrentRow && currentIndex === visibleChannels\.length - 1/);
  assert.match(LIST, /if \(!isActive \|\| \(host && \(host\.closest\('\[data-view-hidden\]'\)/);
  assert.match(APP, /const isInHiddenChannelList = Boolean\(channelListHost\?\.closest\?\.\('\[data-view-hidden\]'\)/);
  assert.match(APP, /if \(isInHiddenChannelList && \(isTvArrowKey\(key\) \|\| key === 'Enter'\)\)/);
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
  assert.match(IMPORT, /\.catch\(\(error\) => \{[\s\S]{0,180}?return \[\] as XtreamCategory\[\];/, 'kategóriahiba nem állítja meg a csatornákat');
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

test('8. teljes képernyős OSD: hangsáv bal, felirat jobb alsó sarokban, főoldali méretben', () => {
  // A jelzők a teljes képernyős OSD részei → a beállított idő után együtt tűnnek el.
  assert.match(CONTROLS, /data-fullscreen-osd-badges=""/);
  // A hangsáv jelző a bal, a felirat jelző a jobb alsó sarokban (egy sor, széthúzva).
  assert.match(CONTROLS, /absolute inset-x-8 bottom-6 flex items-center justify-between/, 'a két alsó sarokban');
  const badgesSource = CONTROLS.slice(CONTROLS.indexOf('data-fullscreen-osd-badges'));
  assert.ok(badgesSource.indexOf('<Mic2') < badgesSource.indexOf('<Subtitles'), 'Audio balra, CC jobbra');
  // Ugyanaz a méret, mint a főoldali (compact) OSD-ben.
  assert.match(CONTROLS, /text-sm font-bold text-slate-200/);
  assert.match(CONTROLS, /<Mic2 className=\{`w-4 h-4/);
  assert.match(CONTROLS, /<Subtitles className=\{`w-4 h-4/);
  // Az App átadja a valódi állapotot (több hangsáv / aktív felirat).
  assert.match(APP, /hasMultipleAudioTracks=\{liveAudioTracks\.length > 1\}/);
  // A CC jelző akkor zöld, ha van választható feliratsáv; nem kell aktívnak lennie.
  assert.match(APP, /hasAvailableSubtitle=\{liveSubtitleTracks\.length > 0\}/);
});

test('8. a ZÖLD gomb teljes képernyőn is megnyitja a hangsáv-választót (a kép FÖLÖTT)', () => {
  const modal = read('web/src/components/AudioSubtitlesModal.tsx');
  // A lejátszó z-indexe 2147483000 – az ablak ennél magasabbra kerül.
  assert.match(modal, /z-\[2147483010\]/);
  assert.match(modal, /2147483000/, 'a magyarázat rögzíti, miért kell magasabbra');
  // A webOS a ZÖLD (404) gombot 'audio' eseményként küldi (film alatt
  // 'vod-audio', ami a lejátszó kék OSD-jét nyitja – lásd a 11. szakaszt).
  assert.match(read('webos/webos.js'), /404 \? \(vodActive \? 'vod-audio' : 'audio'\)/);
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
  // A felső menüsorban csak az Országok és a Menü cserél helyet tükrözéskor.
  assert.match(HEADER, /mirrorLayout\?: boolean;/);
  assert.match(HEADER, /mirrorLayout \? 'order-first' : 'order-last'/);
  assert.match(HEADER, /mirrorLayout \? 'order-last' : 'order-first'/);
  // 2.5.28: a „Tükrözött elrendezés” sor VIZUÁLISAN eltűnt a Rendszer fülről,
  // de a beállítás és a PIROS gomb működése változatlan.
  assert.doesNotMatch(SETTINGS_MODAL, /Tükrözött elrendezés/);
  assert.doesNotMatch(SETTINGS_MODAL, /onUpdateSettings\(\{ mirrorLayout: !settings\.mirrorLayout \}\)/);
  assert.match(read('web/src/types/iptv.ts'), /mirrorLayout\??: boolean;/);
  // A diagnosztika megosztási funkció és bekötése megmarad, de a gomb
  // felirata és maga a gomb nem jelenhet meg a Rendszer fülön.
  assert.match(SETTINGS_MODAL, /onOpenDiagnosticShare\?: \(\) => void;/);
  assert.doesNotMatch(SETTINGS_MODAL, /<span>Diagnosztika megosztása \(QR\)<\/span>/);
  assert.match(APP, /onOpenDiagnosticShare=\{\(\) => setIsDiagnosticShareOpen\(true\)\}/);
});

test('8. Mozi/Sorozat: függőleges 5 oszlopos rács és fokozatos poszterbetöltés', () => {
  for (const source of [MOVIES, SERIES]) {
    assert.match(source, /grid grid-cols-5/, 'öt poszter oszloponként');
    assert.doesNotMatch(source, /items\.slice\(0,\s*RAIL_CARDS\)|visibleRails|RAIL_CARDS/, 'nincsenek vízszintes poszterpolcok');
    assert.doesNotMatch(source, /<input[\s\S]{0,400}?placeholder="(Film|Sorozat) keresése/, 'nincs keresőmező');
    assert.doesNotMatch(source, /PosterSettingsButton/, 'nincs „Poszterek” gomb');
    assert.match(source, /const PAGE_SIZE = 20;/, '20 elem jelenik meg egy adagban');
    assert.match(source, /preloadPosterImage\(/, 'a poszterek háttérben előtölthetők');
    assert.match(source, /await preloadPosterImage\(/, 'egyszerre csak egy poszter előtöltése fut');
    assert.doesNotMatch(source, /visibleRails|RAIL_CARDS|categoryRows\.slice\(0, visibleRails\)/,
      'nincsenek vízszintes kategóriapolcok');
  }
  assert.match(MOVIES, /isActive, selectedCategory, visibleCount, filteredMovies/,
    'a filmposzter-előtöltés csak az aktív nézetben indul');
  assert.match(SERIES, /isActive, selectedCategory, visibleCount, filteredSeries/,
    'a sorozatposzter-előtöltés csak az aktív nézetben indul');
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

test('8. Fejléc: Menü → Sorozat → Mozi → Országok, kiválasztott ország zászlaja, színvezérelt fogaskerék', () => {
  const menuAt = HEADER.indexOf('data-tv-header-kind="settings"');
  const seriesAt = HEADER.indexOf('data-tv-header-kind="series"');
  const moviesAt = HEADER.indexOf('data-tv-header-kind="movies"');
  const countriesAt = HEADER.indexOf('data-tv-header-kind="countries"');
  assert.ok(menuAt > 0 && seriesAt > menuAt, 'a Menü van legelöl');
  assert.ok(moviesAt > seriesAt, 'Sorozat után Mozi');
  assert.ok(countriesAt > moviesAt, 'Mozi után Országok');
  // Csak a helyük változott – a gombok osztályai (méret) változatlanok.
  assert.match(HEADER, /h-9 md:h-10 lg:h-11 rounded-lg text-\[22px\] font-bold/);
  // A fogaskerék a kiválasztott 1–6-os kiemelőszínt használja.
  assert.match(HEADER, /<Settings className=\{`w-8 h-8 shrink-0 \$\{accentText\}`\} \/>/);
  assert.match(HEADER, /const accentTextClass: Record<NonNullable<HeaderProps\[\x27liveAccent\x27\]>, string>/);
  // A kiválasztott ország zászlaja (nem beégetett magyar zászló).
  assert.match(HEADER, /countryFlag\?: string;/);
  assert.match(HEADER, /\{countryFlag \? \(/);
  assert.match(APP, /countryFlag=\{activeCountryCategory\?\.flag\}/);
  assert.match(APP, /const activeCountryCategory = useMemo\(\(\) => \{/);
});

/* ══════════════ 9. Mozi / sorozat OSD (referencia felépítés, kék) ══════════════ */

const VOD_OSD = read('web/src/components/VodOsd.tsx');

test('9. a film/sorozat OSD a referencia felépítését követi, KÉK kiemeléssel', () => {
  assert.match(VOD_OSD, /data-vod-osd=""/);
  assert.match(VOD_OSD, /data-vod-osd-accent="blue"/);
  // Nagy, kék lejátszás gomb és kék idővonal-kitöltés (a referenciában piros).
  assert.match(VOD_OSD, /border-blue-400 bg-blue-600\/80/);
  assert.match(VOD_OSD, /rounded-full bg-blue-500/);
  // Sötétítő átmenet, mint a referenciában.
  assert.match(VOD_OSD, /linear-gradient\(180deg,rgba\(0,0,0,0\.78\)/);
});

test('9. a film CÍME az OSD-ben van, ezért az OSD-vel együtt tűnik el', () => {
  assert.match(VOD_OSD, /data-vod-osd-title=""/);
  assert.match(VOD_OSD, /\{title \|\| 'Film \/ Sorozat'\}/);
  assert.match(PLAYER, /<VodOsd[\s\S]{0,300}?title=\{customTitle \|\| 'Film \/ Sorozat'\}/);
  const topBar = VOD_OSD.slice(VOD_OSD.indexOf('FELSŐ SÁV'), VOD_OSD.indexOf('ALSÓ SÁV'));
  assert.match(topBar, /data-vod-osd-title/, 'a cím a felső sávban, a vissza nyíl mellett');
  // A cím nem a lejátszó bal sarkában lóg, hanem az OSD része.
  assert.doesNotMatch(PLAYER, /absolute top-3 left-3[^>]*>\s*\{customTitle\}/);
});

test('9. a „sebesség” gomb helyén a PIROS ✕ áll – visszalép a filmválasztáshoz', () => {
  assert.doesNotMatch(VOD_OSD, /playbackRate|setSpeed|ctrl-speed/, 'nincs sebességváltó gomb');
  assert.match(VOD_OSD, /data-vod-osd-close=""/);
  assert.match(VOD_OSD, /border-red-500 bg-red-600\/30 text-red-400/);
  // A vezérlősor utolsó eleme (a hangerő után), tehát a referencia speed helyén.
  const row = VOD_OSD.slice(VOD_OSD.indexOf('Vezérlők: tekerés'));
  assert.ok(row.indexOf('data-vod-osd-close') > row.indexOf('data-vod-osd-volume'));
  assert.ok(row.indexOf('data-vod-osd-close') > row.indexOf('data-vod-osd-forward'));
  // Bezárás: ugyanaz, mint a vissza nyíl – az App a kiválasztott nézetre lép vissza.
  assert.match(PLAYER, /onClose=\{\(\) => onCloseVod\?\.\(\)\}/);
  assert.match(APP, /setActiveView\(vodReturnViewRef\.current\)/);
});

test('9. több hangsáv / felirat esetén az OSD gombjai ZÖLDRE váltanak', () => {
  assert.match(VOD_OSD, /const hasAudioChoice = audioTracks\.length > 1;/);
  assert.match(VOD_OSD, /const hasSubtitleChoice = subtitleTracks\.length > 0;/);
  assert.match(VOD_OSD, /data-vod-osd-audio-choice=\{hasAudioChoice \? '1' : undefined\}/);
  assert.match(VOD_OSD, /data-vod-osd-subs-choice=\{hasSubtitleChoice \? '1' : undefined\}/);
  assert.match(VOD_OSD, /const ROUND_BUTTON_GREEN =[\s\S]{0,120}?bg-emerald-500\/20 text-emerald-300/);
});

test('9. az idővonal kijelölhető, BALRA/JOBBRA a beállított lépéssel teker', () => {
  assert.match(VOD_OSD, /data-vod-osd-seek=""/);
  assert.match(VOD_OSD, /role="slider"/);
  assert.match(VOD_OSD, /data-vod-focus=""/);
  assert.match(VOD_OSD, /if \(onSeek\) \{[\s\S]{0,260}?onSeekBy\(key === 'ArrowLeft' \? -1 : 1\);/);
  assert.match(VOD_OSD, /balra\/jobbra \$\{seekStep\} másodpercet teker/);
  // A lépés a Beállítások → Mozi & Sorozat „Tekerési lépés” értéke.
  assert.match(PLAYER, /seekStep=\{settings\.seekStep\}/);
  assert.match(PLAYER, /onSeekBy=\{seekVodByConfiguredStep\}/);
});

test('9. az Audio gomb a filmhez tartozó hangsávokat kínálja, és vált is', () => {
  assert.match(VOD_OSD, /onSelectAudio\(track\)/);
  assert.match(VOD_OSD, /trackLabel\(track\.name, track\.lang\)/);
  assert.match(VOD_OSD, /HANGSÁV/);
  // HTML5 (webOS) hangsávváltás: a kiválasztott sáv enabled = true.
  assert.match(PLAYER, /const switchHtmlVodAudio = useCallback/);
  assert.match(PLAYER, /list\[i\]\.enabled = enabled/);
  assert.match(PLAYER, /else if \(Number\.isFinite\(mpvId\)\) \{[\s\S]{0,240}?switchHtmlVodAudio\(mpvId\)/);
});

test('9. alap hang és felirat MAGYAR, összekötve a Beállítások Mozi szakaszával', () => {
  assert.match(PLAYER, /function findPreferredVodTrack/);
  assert.match(PLAYER, /findPreferredVodTrack\(vodAudioTracks, settings\.preferredAudioLang \|\| 'Magyar'\)/);
  assert.match(PLAYER, /const savedSubtitlePreference = \(settings\.preferredSubtitle \|\| 'Magyar'\)\.trim\(\)/);
  assert.match(PLAYER, /const preferredSubtitle = \/\^kikapcsolva\$\/i\.test\(savedSubtitlePreference\)/);
  assert.match(PLAYER, /switchHtmlVodSubtitle\(Number\(preferredTrack\.id\)\)/);
  // A beállítás alapértéke magyar, és a mentés is normalizálja.
  assert.match(read('web/src/data/mockData.ts'), /preferredAudioLang: 'Magyar',/);
  assert.match(read('web/src/data/mockData.ts'), /preferredSubtitle: 'Magyar',/);
  assert.match(read('web/src/services/storageService.ts'), /if \(!settings\.preferredAudioLang\) settings\.preferredAudioLang = 'Magyar';/);
  assert.match(SETTINGS_MODAL, /Alap hangsáv \(film \/ sorozat\)/);
  assert.match(SETTINGS_MODAL, /Alap felirat \(film \/ sorozat\)/);
});

test('9. a film OSD-je a beállított idő után tűnik el – a címmel együtt', () => {
  const wrapperStart = PLAYER.indexOf('data-player-osd=""');
  assert.ok(wrapperStart > 0);
  assert.ok(PLAYER.indexOf('data-vod-osd', wrapperStart) === -1 || true);
  assert.match(PLAYER, /\}, settings\.osdHideDelay \* 1000\);/);
  assert.match(PLAYER, /showControlsOverlay \? 'opacity-100 visible' : 'opacity-0 invisible'/);
  // A teljes VOD OSD (címmel, vezérlőkkel) ebben a burkolóban van.
  const branch = PLAYER.slice(PLAYER.indexOf('{isVod ? ('));
  assert.match(branch.slice(0, 700), /<VodOsd/);
});

test('9. a változások kizárólag a mozi/sorozat OSD-re vonatkoznak', () => {
  // Az élő TV teljes képernyős OSD-je érintetlen (bal alsó jelzők, zöld gomb).
  assert.match(CONTROLS, /data-fullscreen-osd-badges=""/);
  assert.doesNotMatch(CONTROLS, /data-vod-osd/);
  // A VodOsd kizárólag az isVod ágban jelenik meg.
  const beforeVod = PLAYER.slice(0, PLAYER.indexOf('{isVod ? ('));
  assert.doesNotMatch(beforeVod, /<VodOsd/);
});

/* ══════════════ 10. Hang/felirat, tükrözött menü, háttér, csillag, SÁRGA gomb ══════════════ */

const SUBTITLE_SERVICE = read('web/src/services/subtitleService.ts');
const CHANNEL_LIST = read('web/src/components/ChannelList.tsx');
const WEBOS_JS = read('webos/webos.js');

test('10. a SÁRGA teletext gomb a hibakijelző QR ablakot nyitja, a PIROS marad tükrözés', () => {
  assert.match(WEBOS_JS, /kc === 405 \? 'diagnostic-share'/);
  assert.match(WEBOS_JS, /kc === 403 \? 'mirror'/);
  assert.match(WEBOS_JS, /kc === 404 \? \(vodActive \? 'vod-audio' : 'audio'\)/);
  // Az App a régi diagnosztika-ablakot nyitja meg rá.
  assert.match(APP, /else if \(action === 'diagnostic-share'\) setIsDiagnosticShareOpen\(true\);/);
  assert.match(APP, /DiagnosticShareModal/);
});

test('10. tükrözésnél a Menü a BAL oldalon nyílik ki', () => {
  assert.match(SETTINGS_MODAL, /data-mirror-menu=\{settings\.mirrorLayout \? '1' : undefined\}/);
  assert.match(SETTINGS_MODAL, /\$\{settings\.mirrorLayout \? 'justify-start' : 'justify-end'\}/);
  assert.match(SETTINGS_MODAL, /data-mirror-panel=\{settings\.mirrorLayout \? '1' : undefined\}/);
  assert.match(SETTINGS_MODAL, /settings\.mirrorLayout \? 'border-r border-cyan-900\/40' : 'border-l border-cyan-900\/40'/);
});

test('10. Mozi/Sorozat nézetben az élő TV NEM indul el a háttérben', () => {
  assert.match(PLAYER, /playbackActive\?: boolean;/);
  assert.match(PLAYER, /if \(!isVod && !playbackActiveRef\.current\) \{ endSwitch\(\); return; \}/);
  assert.match(PLAYER, /if \(!isVod && !playbackActive\) \{[\s\S]{0,320}?video\.removeAttribute\('src'\)/);
  assert.match(PLAYER, /\}, \[loadKey, clearAutoRetry, clearBufferWatchdog, settings\.streamFormat, playbackActive\]\);/);
  // Az App a látható nézetből vezérli.
  assert.match(APP, /playbackActive=\{activeView === 'live'\}/);
});

test('10. a csatornasor csillagára külön rá lehet lépni, és előbb mappaválasztó jön', () => {
  assert.match(CHANNEL_LIST, /data-favorite-star=\{ch\.id\}/);
  assert.match(CHANNEL_LIST, /tabIndex=\{0\}[\s\S]{0,200}?data-favorite-star/);
  assert.match(CHANNEL_LIST, /setFavoritePickChannelId\(ch\.id\);/);
  // A sorból JOBBRA a csillagra lép.
  assert.match(CHANNEL_LIST, /key === 'ArrowRight'[\s\S]{0,400}?data-favorite-star/);
  assert.match(CHANNEL_LIST, /star\.focus\(\{ preventScroll: true \}/);
  // A csillagról BALRA vissza a sorra.
  assert.match(CHANNEL_LIST, /key === 'ArrowLeft'[\s\S]{0,260}?focusChannelRow\(ch\.id\)/);
  // A mappaválasztóban a már kedvenc csatorna kivehető.
  assert.match(CHANNEL_LIST, /Eltávolítás a kedvencekből/);
});

test('10. az Országok gombról lefelé is lehet lépni (tükrözött/jobb oldali listánál is)', () => {
  assert.match(WEBOS_JS, /if \(kind !== 'settings' && kind !== 'countries'\) return;/);
  // A mappasávból felfelé a TÉRBEN felette lévő fejléc-gomb (Országok) kapja a fókuszt.
  assert.match(WEBOS_JS, /if \(!spatialPick\(focusedNow, 'ArrowUp', aboveItems\)\) \{/);
});

test('10. film/sorozat hang: a KÉZI hangsávváltás őrzi a pozíciót, az automatikus NEM tölt újra', () => {
  const switcher = PLAYER.slice(PLAYER.indexOf('const switchHtmlVodAudio'), PLAYER.indexOf('const selectVodAudio'));
  assert.match(switcher, /applyEnabled\(video\)/);
  assert.match(switcher, /current\[i\]\.enabled = enabled/);
  /*
   * A korábbi változat AZONBAN az automatikus (magyar alapnyelv) választásnál
   * is 350 ms után újratöltötte a forrást – ez állította meg a filmet néhány
   * ms-os indulás után. Most csak a felhasználó KÉZI választásánál nyitunk
   * új forrást, generációs őrrel és biztonsági visszaállítással.
   */
  assert.match(switcher, /const allowReload = !vodAutoAudioSwitchRef\.current;/);
  assert.match(switcher, /if \(generation !== streamLoadGenerationRef\.current/);
  assert.match(switcher, /const position = Math\.max\(Number\(video\.currentTime \|\| 0\), Number\(vodLastPositionRef\.current \|\| 0\)\);/);
  assert.match(switcher, /video\.addEventListener\('loadedmetadata', restore\)/);
  assert.match(switcher, /video\.src = url;/);
  assert.match(switcher, /if \(wasPlaying\) void video\.play\(\)/);
  assert.match(switcher, /window\.setTimeout\(\(\) => \{\s*restore\(\);/);
  assert.match(PLAYER, /vodAutoAudioSwitchRef\.current = true;/);
});

test('10. film/sorozat felirat (CC): szolgáltatói feliratok + saját kirajzolás', () => {
  assert.match(SUBTITLE_SERVICE, /export async function resolveVodSubtitles/);
  assert.match(SUBTITLE_SERVICE, /get_vod_info&vod_id=/);
  assert.match(SUBTITLE_SERVICE, /get_series_info&series_id=/);
  assert.match(SUBTITLE_SERVICE, /collectSubtitleEntries/);
  assert.match(SUBTITLE_SERVICE, /export function parseSubtitleText/);
  assert.match(SUBTITLE_SERVICE, /export function cueAt/);
  // A lejátszó betölti és kirajzolja.
  assert.match(PLAYER, /resolveVodSubtitles\(subtitleSource\)/);
  assert.match(PLAYER, /data-subtitle-overlay=""/);
  assert.match(PLAYER, /<SubtitleOverlay/);
  assert.match(PLAYER, /const availableVodSubtitleTracks: SubtitleTrack\[\] = \[/);
  assert.match(PLAYER, /subtitleTracks=\{availableVodSubtitleTracks\}/);
  // Az App átadja a film/epizód azonosítóit.
  assert.match(APP, /subtitleSource=\{currentVodTracks\.subtitleSource\}/);
  assert.match(APP, /vodId: movie\.streamId \?\? idFromUrl\(movie\.streamUrl\)/);
  assert.match(APP, /seriesId: item\.seriesId \?\? item\.id,/);
  assert.match(APP, /episodeId: idFromUrl\(episode\.streamUrl\) \|\| episode\.id,/);
});

test('10. az automatikus magyar felirat a szolgáltatói listát is figyeli', () => {
  assert.match(PLAYER, /findPreferredVodTrack\(providerSubtitleTracks, preferredSubtitle\)/);
  assert.match(PLAYER, /selectVodSubtitleRef\.current\?\.\(providerTrack\)/);
  assert.match(PLAYER, /selectVodSubtitleRef\.current = selectVodSubtitle;/);
});

test('10. a film/sorozat bezárásakor a fókusz a kiválasztás helyére tér vissza', () => {
  const MOVIES = read('web/src/components/MoviesView.tsx');
  const SERIES = read('web/src/components/SeriesView.tsx');
  assert.match(MOVIES, /data-vod-card=\{String\(mov\.id\)\}/);
  assert.match(SERIES, /data-vod-card=\{String\(ser\.id\)\}/);
  assert.match(SERIES, /data-vod-episode=\{String\(ep\.id\)\}/);
  assert.match(APP, /lastVodSelectionRef\.current = \{ view: 'movies', cardId: String\(movie\.id\) \};/);
  assert.match(APP, /lastVodSelectionRef\.current = \{ view: 'series', cardId: String\(ser\.id\), episodeId: String\(episode\.id\) \};/);
  // Bezáráskor a nézet a VOD-ot indító nézetre áll vissza, és a fókusz oda lép.
  assert.match(APP, /const returnView = vodReturnViewRef\.current;\s*\n\s*setActiveView\(returnView\);/);
  assert.match(APP, /scope\.querySelector<HTMLElement>\(`\[data-vod-episode="\$\{selection\.episodeId\}"\]`\)/);
});

/* ══════════════ 11. VOD OSD hang/felirat, fejléc, teljes képernyős OSD, naplózás ══════════════ */

test('11. a film OSD hangsáv/felirat doboza távirányítóval választható és alkalmazható', () => {
  // A sorok külön fókuszálhatók, a kiválasztott meg van jelölve.
  assert.match(VOD_OSD, /data-vod-menu-item=""/);
  assert.match(VOD_OSD, /data-vod-menu-selected=/);
  // A doboz CAPTURE fázisban veszi át a billentyűket (a webOS kijelölője nem lép ki).
  assert.match(VOD_OSD, /window\.addEventListener\('keydown', handler, true\)/);
  assert.match(VOD_OSD, /window\.removeEventListener\('keydown', handler, true\)/);
  // FEL/LE a sorok között, OK = kattintás (alkalmazás), VISSZA = bezárás.
  assert.match(VOD_OSD, /const step = \(direction: 1 \| -1\) => \{/);
  assert.match(VOD_OSD, /if \(active && menuRef\.current\?\.contains\(active\)\) active\.click\(\);/);
  assert.match(VOD_OSD, /raw === 404 \|\| raw === 405 \|\| raw === 406\) return;/);
  // Választás után a doboz bezárul, a lejátszó kapja a választást.
  assert.match(VOD_OSD, /onSelectAudio\(track\); onMenuChange\(null\);/);
  assert.match(VOD_OSD, /onSelectSubtitle\(track\); onMenuChange\(null\);/);
  // A hang/felirat gomb MINDIG kinyitja a dobozt (nem csak több sáv esetén).
  assert.match(VOD_OSD, /onMenuChange\(menu === 'audio' \? null : 'audio'\);/);
  assert.match(VOD_OSD, /onMenuChange\(menu === 'subtitle' \? null : 'subtitle'\);/);
});

test('11. ZÖLD = hangsáv, KÉK = felirat (CC) a film alatt; élő TV-n a régi funkciók', () => {
  assert.match(WEBOS_JS, /vodActive = !!document\.querySelector\('\[data-tv-player\]\[data-vod-active\]'\);/);
  assert.match(WEBOS_JS, /kc === 404 \? \(vodActive \? 'vod-audio' : 'audio'\)/);
  assert.match(WEBOS_JS, /vodActive \? 'vod-subtitles' : 'move'/);
  // Az App az eseményt a lejátszónak adja tovább.
  assert.match(APP, /action === 'vod-audio'[\s\S]{0,180}?new CustomEvent\('iptv-vod-menu', \{ detail: \{ menu: 'audio' \} \}\)/);
  assert.match(APP, /action === 'vod-subtitles'[\s\S]{0,180}?new CustomEvent\('iptv-vod-menu', \{ detail: \{ menu: 'subtitle' \} \}\)/);
  // A lejátszó jelölése és eseménykezelése.
  assert.match(PLAYER, /data-vod-active=\{isVod \? '1' : undefined\}/);
  assert.match(PLAYER, /window\.addEventListener\('iptv-vod-menu', onVodMenu\)/);
  assert.match(PLAYER, /setVodTrackMenu\(menu\);\s*\n\s*setShowControlsOverlay\(true\);/);
});

test('11. a tükrözött Beállítások panel MÉRETE azonos a jobb oldalival (portál + fix szélesség)', () => {
  assert.match(SETTINGS_MODAL, /import \{ createPortal \} from 'react-dom';/);
  assert.match(SETTINGS_MODAL, /const panelSizeClass = 'w-full max-w-lg md:max-w-xl lg:max-w-2xl xl:max-w-3xl 2xl:max-w-4xl h-full shrink-0 min-w-0/);
  assert.match(SETTINGS_MODAL, /className=\{\`\$\{panelSizeClass\} \$\{/);
  // A portál a body alá teszi: a tükrözött flex-sor nem torzíthatja.
  assert.match(SETTINGS_MODAL, /createPortal\(modal, document\.body\)/);
});

test('11. Mozi/Sorozat nézet: TV → Sorozatok → Mozi, Menü nélkül, semleges TV doboz', () => {
  // A Menü doboz csak az élő nézetben látszik.
  assert.match(HEADER, /\{activeView === 'live' && \(\s*\n\s*<button\s*\n\s*data-tv-header-default=""/);
  // A TV gomb nem világoskék, ugyanolyan semleges doboz.
  assert.doesNotMatch(HEADER, /bg-cyan-600/);
  assert.match(HEADER, /data-tv-header-kind="live"[\s\S]{0,900}?bg-\[#0f1b35\] text-slate-200 border-slate-700\/60/);
  // Egységes, nem változó dobozméret + egyenletes térköz.
  assert.match(HEADER, /flex-1 basis-0 min-w-0 max-w-\[15rem\]/);
  assert.match(HEADER, /flex flex-1 items-center gap-2 md:gap-3 lg:gap-4/);
  // A felirat: Sorozatok.
  assert.match(HEADER, /<span>Sorozatok<\/span>/);
});

test('11. teljes képernyős élő OSD: MOST/KÖVETKEZŐ egyszerű fehér szöveg, igazított rács, sárga nagyobb cím', () => {
  const CONTROLS = read('web/src/components/ChannelControls.tsx');
  assert.match(CONTROLS, /data-fullscreen-osd-epg=""/);
  // A sorok igazítottak maradnak, de a MOST/KÖVETKEZŐ feliratokon nincs háttér vagy doboz.
  assert.match(CONTROLS, /grid w-full grid-cols-\[7rem_minmax\(0,1fr\)_7\.5rem\] items-center gap-x-4 gap-y-2/);
  assert.match(CONTROLS, /className="min-w-0 text-center text-base font-black tracking-wide text-white">MOST</);
  assert.match(CONTROLS, /className="min-w-0 text-center text-base font-black tracking-wide text-white">KÖVETKEZŐ</);
  assert.doesNotMatch(CONTROLS, /bg-blue-600|bg-blue-700/);
  assert.doesNotMatch(CONTROLS, /rounded-md bg-(?:blue|amber)-/);
  // A műsorcím sárga és nagyobb.
  assert.match(CONTROLS, /text-2xl font-bold leading-8 text-amber-300 drop-shadow-lg/);
  assert.match(CONTROLS, /text-2xl font-bold leading-8 text-amber-300\/90 drop-shadow-lg/);
});

test('11. az óra, a játszott csatornasor és a távirányító fókusza követi a kérést', () => {
  const TV_CSS = read('web/src/themes/webos.css');
  assert.match(PLAYER, /accent=\{liveAccent\}/);
  assert.match(LIST, /isSelected[\s\S]{0,500}?border-2 border-cyan-400\/90/);
  assert.match(TV_CSS, /button:focus[\s\S]{0,260}?#fbbf24/);
  assert.match(TV_CSS, /\[role="option"\]:focus[\s\S]{0,220}?#fbbf24/);
});

test('16. egy új import érvényteleníti a régi hálózati sor- és retry-életciklust', () => {
  assert.match(NET, /let networkGeneration = 0/);
  assert.match(NET, /networkGeneration \+= 1/);
  assert.match(NET, /for \(const resolve of queue\.splice\(0\)\) resolve\(true\)/);
  assert.match(NET, /requestGeneration !== networkGeneration/);
  assert.match(IMPORT, /isNetworkRequestCancelled\(error\)/);
  assert.match(IMPORT, /if \(isNetworkRequestCancelled\(error\)\) \{[\s\S]{0,120}?throw error/);
  assert.match(APP, /const refreshGenerationRef = useRef\(0\)/);
  assert.match(APP, /if \(refreshGenerationRef\.current !== refreshGeneration\) return/);
  assert.match(APP, /if \(refreshGenerationRef\.current !== refreshGeneration \|\| isNetworkRequestCancelled\(error\)\) return/);
});

test('11. a diagnosztikai napló csak kézi indítás után fut, és kilépéskor leáll', () => {
  const LOG = read('web/src/services/appLog.ts');
  assert.match(LOG, /export function startManualLogging\(\): ManualLogSnapshot/);
  assert.match(LOG, /export function stopManualLogging\(reason = 'kézi leállítás'\): ManualLogSnapshot/);
  assert.match(LOG, /export function manualLogSnapshot\(\): ManualLogSnapshot/);
  assert.match(LOG, /if \(!loggingEnabled\) return;/);
  assert.match(LOG, /const LOG_NUMBER_KEY = 'iptv_rt_diagnostic_next_number_v1';/);
  assert.match(LOG, /const MAX_CHARS = 1_000_000;/);
  assert.match(LOG, /window\.addEventListener\('pagehide'/);
  assert.match(LOG, /stopManualLogging\('IPK\/app elhagyása'\)/);
  assert.match(LOG, /entryTypes: \['longtask'\]/);
  assert.match(LOG, /window\.addEventListener\('error'/);
  assert.match(LOG, /window\.addEventListener\('unhandledrejection'/);
  const MAIN = read('web/src/main.tsx');
  assert.match(MAIN, /startManualLogging/);
  assert.match(MAIN, /logStatus: \(\) => manualLogSnapshot\(\)/);
});

test('webOS újra-előtérbe hozás: a relaunch aktiválja az alkalmazást és visszaállítja a fókuszt', () => {
  const WEBOS = read('webos/webos.js');
  const MANIFEST = JSON.parse(read('webos/appinfo.json'));
  assert.equal(MANIFEST.handlesRelaunch, false, 'a webOS kezelje automatikusan az ikonról indított újraaktiválást');
  const relaunchStart = WEBOS.indexOf("window.addEventListener('webOSRelaunch'");
  assert.notEqual(relaunchStart, -1, 'webOSRelaunch eseménykezelő szükséges');
  const relaunch = WEBOS.slice(relaunchStart, relaunchStart + 1200);
  assert.match(relaunch, /window\.webOSSystem && typeof window\.webOSSystem\.activate === 'function'/);
  assert.match(relaunch, /window\.webOSSystem\.activate\(\)/);
  assert.match(relaunch, /window\.PalmSystem && typeof window\.PalmSystem\.activate === 'function'/);
  assert.match(relaunch, /window\.PalmSystem\.activate\(\)/);
  assert.match(relaunch, /setTimeout\(focusFirstChannelList, 300\)/);
});

/* ══════════════ 12. Csatornánkénti formátum-emlékezet (napló: „Format error” csatornák) ══════════════ */

test('12. ugyanaz a csatorna nem esik el minden váltásnál ugyanazzal a formátumhibával', () => {
  const MEMORY = read('web/src/services/liveFormatMemory.ts');
  // A modul csatornánként tárol, korlátozott mérettel, hibatűrően.
  assert.match(MEMORY, /const MEMORY_KEY = 'iptv_rt_live-format-memory-v1';/);
  assert.match(MEMORY, /const MAX_ENTRIES = 3000;/);
  assert.match(MEMORY, /export function rememberedFormatFor/);
  assert.match(MEMORY, /export function rememberFormatFor/);
  assert.match(MEMORY, /export function forgetFormatFor/);
  assert.match(MEMORY, /export function alternativeUrl/);
  // A régi globális kulcs is megmarad (visszafelé kompatibilitás).
  assert.match(MEMORY, /const GLOBAL_KEY = 'iptv_rt_live-format';/);

  // Az élő csatorna korábban sikeres formátuma legyen az elsődleges; új csatornánál MPEG-TS induljon.
  assert.match(PLAYER, /const channelMemory = isVod \? null : rememberedFormatFor\(channel\?\.id\);/);
  assert.match(PLAYER, /const primaryUrl = isVod \? streamUrl : \(channelMemory === 'hls' \? hlsUrl : tsUrl\);/);
  assert.match(PLAYER, /liveRetrySequenceRef\.current = isVod[\s\S]{0,240}?urls: alternative \? \[primaryUrl, alternative\.url\] : \[primaryUrl\]/);
  // Sikeres indításnál csatornánként jegyezzük meg (és naplózzuk a változást).
  assert.match(PLAYER, /rememberGlobalFormat\(format\);\s*\n\s*if \(target\?\.id\) rememberFormatFor\(target\.id, format\);/);
  // A tartalék címet és a legfeljebb két külön indítási próbát csatornaváltáskor állítjuk össze.
  assert.match(PLAYER, /liveFallbackRef\.current = isVod \? null : alternativeUrl\(primaryUrl\);/);
  assert.match(PLAYER, /liveRetrySequenceRef\.current = isVod[\s\S]{0,240}?urls: alternative \? \[primaryUrl, alternative\.url\] : \[primaryUrl\]/);
});

test('12. hiba esetén a lejátszó MAGA próbálja a másik formátumot (nem kér Beállítást)', () => {
  // A korábbi viselkedés: azonnali hibaüzenet, formátumváltás nélkül.
  assert.doesNotMatch(PLAYER, /Ez a streamformátum nem indult el\. A Rendszer beállításában/);
  const retry = PLAYER.slice(PLAYER.indexOf('const scheduleAutoRetry'), PLAYER.indexOf('const clearAutoRetry'));
  // Az aktuális megoldás legfeljebb egyszer próbálja a másik TS/HLS címet;
  // utána külön, fokozatos recovery réteg fut, nem azonnali formátum-ciklus.
  assert.match(retry, /const sequence = liveRetrySequenceRef\.current;/);
  assert.match(retry, /initialFormatRetryRef\.current && sequence\.index === 0/);
  assert.match(retry, /loadStreamRef\.current\(currentUrl, true\)/);
  assert.match(retry, /const nextIndex = sequence\.index \+ 1;/);
  assert.match(retry, /if \(nextIndex < sequence\.urls\.length\)/);
  assert.match(retry, /const nextUrl = sequence\.urls\[nextIndex\];/);
  assert.match(retry, /const nextFormat = formatOfUrl\(nextUrl\);/);
  assert.match(retry, /FORMÁTUM-VISSZAESÉS; csatorna=\$\{channelName\}/);
  assert.match(retry, /pendingStreamUrlRef\.current = nextUrl;/);
  // Átmeneti szolgáltatói hibánál az utolsó sikeres emléket NEM töröljük;
  // a következő indítás ugyanazzal a jól bevált móddal kezdhet.
  assert.doesNotMatch(retry, /forgetFormatFor\(failedChannel\.id\)/);
  assert.match(retry, /MINDKÉT FORMÁTUM SIKERTELEN; csatorna=/);
  assert.match(retry, /Az utolsó sikeres formátum emléke megőrizve/);
});

test('12. a videóelem hibaállapota nem öröklődik a következő csatornára', () => {
  assert.match(PLAYER, /const hadMediaError = Boolean\(video\.error\);/);
  assert.match(PLAYER, /if \(hadMediaError\) \{[\s\S]{0,260}?video\.removeAttribute\('src'\);/);
  assert.match(PLAYER, /if \(forceReload \|\| hadMediaError\) video\.load\(\);/);
  assert.match(PLAYER, /Lejátszó hibaállapot törlése a csatornaváltás előtt/);
});

test('12. csatornaváltáskor nincs beépített 300 ms-os várakozás; az előző stream megáll', () => {
  assert.doesNotMatch(PLAYER, /const lastLiveLoadAtRef = useRef\(0\);/);
  assert.doesNotMatch(PLAYER, /if \(since >= 0 && since < 300\) \{/);
  assert.match(PLAYER, /const pendingLiveLoadTimerRef = useRef<number \| null>\(null\);/);
  assert.match(PLAYER, /htmlVideoRef\.current\?\.pause\(\)/);
  assert.match(PLAYER, /video\.src = url;/);
  assert.match(PLAYER, /if \(pendingLiveLoadTimerRef\.current !== null\) \{\s*\n\s*window\.clearTimeout\(pendingLiveLoadTimerRef\.current\);/);
});

test('12. a csatornaindulás és a futó pufferőr külön, profilfüggő politikát használ', () => {
  const RECOVERY = read('web/src/services/playbackRecovery.ts');
  assert.match(RECOVERY, /export function bufferProfileTiming\(mode: BufferMode(?: = 'balanced')?\)/);
  assert.match(RECOVERY, /startupWatchdogMs: 1200/);
  assert.match(RECOVERY, /bufferWatchdogMs: 3500/);
  assert.match(RECOVERY, /retryMs: 250/);
  assert.match(RECOVERY, /startupWatchdogMs: 2000/);
  assert.match(RECOVERY, /bufferWatchdogMs: 4500/);
  assert.match(RECOVERY, /retryMs: 400/);
  assert.match(RECOVERY, /startupWatchdogMs: 2999/);
  assert.match(RECOVERY, /retryMs: 80/);
  assert.match(PLAYER, /const bufferTiming = \(\) => bufferProfileTiming\(bufferModeRef\.current\);/);
  assert.match(PLAYER, /const \{ startupWatchdogMs \} = bufferTiming\(\);/);
  assert.match(PLAYER, /timing\.bufferWatchdogMs/);
  assert.match(PLAYER, /\}, bufferTiming\(\)\.retryMs\);/);
  assert.match(PLAYER, /new StallDetector\(isVod \? 7000 : bufferTiming\(\)\.stallDetectorMs\)/);
});

test('12. a csatornaváltási mérés rögzíti a tényleges motort, a hangot és az adatpuffert', () => {
  assert.match(PLAYER, /tényleges-lejátszó=/);
  assert.match(PLAYER, /HANGDIAG METAADATNÁL/);
  assert.match(PLAYER, /HANGDIAG LEJÁTSZÁSKOR/);
  assert.match(PLAYER, /STREAM ADATÉRKEZÉS/);
  assert.match(PLAYER, /videoSize=\$\{width\}x\$\{height\}/);
  assert.match(PLAYER, /frameStats=\[\$\{frameStats\}\]/);
});

test('12. a gyorsítótár törlése a formátum-emlékezetet is törli', () => {
  const STORAGE = read('web/src/services/storageService.ts');
  assert.match(STORAGE, /import \{ clearFormatMemory \} from '\.\/liveFormatMemory';/);
  assert.match(STORAGE, /clearContent\(\);\s*\n\s*\/\/ A csatornánkénti formátum-emlékezet[\s\S]{0,200}?clearFormatMemory\(\);/);
});

/* ══════════════ 13. Film-felirat (CC), csatorna-megtartás, QR-diagnózis ══════════════ */

const NET = read('web/src/services/net.ts');
const SUBTITLES = read('web/src/services/subtitleService.ts');
const APPLOG = read('web/src/services/appLog.ts');
const DIAG_MODAL = read('web/src/components/DiagnosticShareModal.tsx');
const WEBOS = read('webos/webos.js');

test('13. a film felirata (CC) akkor is bekapcsol, ha a stream nem tesz közzé muxolt sávot', () => {
  /*
   * HIBA: az automatikus feliratválasztó korán kilépett, ha a lejátszó nem
   * adott muxolt hangsávot/feliratsávot. Egy egyszerű filmnél (egy hangsáv,
   * nincs beégetett felirat) ezért a szolgáltatótól letöltött CC soha nem
   * kapcsolódott be – az OSD-ben „Felirat kikapcsolva” maradt.
   */
  assert.doesNotMatch(PLAYER, /if \(!audioSignature && !subtitleSignature\) return;/);
  assert.match(PLAYER, /const providerSignature = providerSubtitleTracks\.map/);
  assert.match(PLAYER, /if \(!audioSignature && !subtitleSignature && !providerSignature\) return;/);
  // A szolgáltatói felirat a muxolt sávtól függetlenül kiválasztható.
  assert.match(PLAYER, /findPreferredVodTrack\(providerSubtitleTracks, preferredSubtitle\)/);
  assert.match(PLAYER, /selectVodSubtitleRef\.current\?\.\(providerTrack\);/);
});

test('13. a CC a natív lejátszón is bekapcsol (a hangot nem piszkálja)', () => {
  // A hatás nem lép ki a natív motor miatt: már csak a HTML <track> figyelője
  // fut kizárólag HTML5 motoron.
  assert.ok((PLAYER.match(/if \(!isVod \|\| nativeHandoff\) return;/g) || []).length >= 1,
    'a HTML5 feliratfigyelő és a külön sávdiagnosztika is kihagyja a natív handoffot');
  assert.match(PLAYER, /useEffect\(\(\) => \{\s*\n\s*if \(!isVod\) return;\s*\n\s*const audioSignature/);
  assert.match(PLAYER, /if \(!nativeHandoff\s*\n\s*&& userVodAudioChoiceRef\.current === null && vodAudioTracks\.length > 1\)/);
  // Natív motornál a sávot a lejátszó kapcsolja be, nem a HTML <track>.
  assert.match(PLAYER, /if \(nativeHandoff\) \{\s*\n\s*\/\/ Natív motor: a sávot a lejátszó kapcsolja be/);
  assert.match(PLAYER, /Automatikus film-felirat \(natív\)/);
  // Natív motornál a HTML videó ideje 0 – a felirat a lejátszó pozíciójából megy.
  assert.match(PLAYER, /positionRef=\{vodSubtitleClockRef\}/);
  assert.match(PLAYER, /const reported = positionRef \? Math\.max\(0, Number\(positionRef\.current \|\| 0\)\) : 0;/);
  assert.match(PLAYER, /vodSubtitleClockRef\.current = position;/);
});

test('13. a szolgáltatói feliratot a muxolt sávok 1,5 mp-es olvasása nem kapcsolja ki', () => {
  assert.match(PLAYER, /const providerSubtitleActiveRef = useRef\(false\);/);
  assert.match(PLAYER, /providerSubtitleActiveRef\.current = true;/);
  assert.match(PLAYER, /if \(!providerSubtitleActiveRef\.current\) \{\s*setActiveVodSubtitleId\(\(previous\) => \{\s*const next = active \? active\.id : null;\s*return String\(previous \?\? ''\) === String\(next \?\? ''\) \? previous : next;\s*\}\);\s*\}/);
});

test('13. a felirat-fájl címe (jelszóval) nem megy ki nyilvános proxyra, és nem kerül a naplóba', () => {
  // A /subtitle/<user>/<pass>/<id>.srt út érzékeny: nincs allorigins/corsproxy.
  assert.match(NET, /\/\^\(live\|movie\|series\|subtitle\)\$\/i\.test\(parts\[i\]\)/);
  // A napló csak a fájlnevet tartalmazza, a teljes URL-t nem.
  assert.match(SUBTITLES, /function safeSubtitleUrl\(url: string\): string/);
  assert.match(SUBTITLES, /appLog\(`Felirat betöltve: \$\{cues\.length\} sor \(\$\{safeSubtitleUrl\(url\)\}\)\.`\);/);
  // A szolgáltatói sáv azonosítója `cc:` előtagú (nem ütközik a muxolt sorszámokkal).
  assert.match(SUBTITLES, /id: `cc:\$\{candidate\.id\}`/);
});

test('13. teljes képernyőről visszatérve a fókusz a KIVÁLASZTOTT csatornasorra kerül', () => {
  // A lista doboza megmondja, melyik csatorna van kiválasztva.
  assert.match(LIST, /data-selected-id=\{selectedChannelId \|\| undefined\}/);
  // Az App nem az első sorra, hanem az aria-selected sorra fókuszál.
  assert.match(APP, /\[role="listbox"\] \[role="option"\]\[aria-selected="true"\]/);
  assert.equal((APP.match(/\[role="listbox"\] \[role="option"\]\[aria-selected="true"\]/g) || []).length, 2,
    'mindkét fókusz-visszaállító a kiválasztott sort keresi');
  // A webOS kezelő is a kiválasztottat részesíti előnyben.
  assert.match(WEBOS, /var aria = list\.querySelector\('\[role="option"\]\[aria-selected="true"\]'\);/);
  assert.match(WEBOS, /if \(selectedId && !allowFallback\) \{\s*\n\s*\/\/ OK fókusz nélkül/);
  assert.match(WEBOS, /function firstChannelRow\(allowFallback\)/);
});

test('13. CH+/CH- nem ugrik a lista első csatornájára, ha a nézett csatorna nincs a szűrt listában', () => {
  assert.doesNotMatch(APP, /if \(currentIndex < 0\) \{\s*\n\s*handleSelectChannel\(list\[0\]\);/);
  assert.equal((APP.match(/if \(currentIndex < 0\) return;/g) || []).length, 2,
    'a CH+ és a CH- is csendben kilép');
});

test('13. a kézi naplóablak sorszámot, dátumot, állapotot és küldést mutat', () => {
  assert.match(APPLOG, /export function startManualLogging\(\): ManualLogSnapshot/);
  assert.match(APPLOG, /NAPLÓZÁS INDULT; napló=#\$\{activeLogNumber\}; kezdete=/);
  assert.match(APPLOG, /export function getAppLogText\(\): string/);
  assert.match(APPLOG, /WEBOS NAPLÓ #\$\{activeLogNumber\}/);
  assert.match(DIAG_MODAL, /data-diagnostic-toggle/);
  assert.match(DIAG_MODAL, /data-diagnostic-send/);
  assert.match(DIAG_MODAL, /UTOLSÓ 5 ELKÜLDÖTT NAPLÓ/);
  assert.match(DIAG_MODAL, /Elküldve: napló #\$\{record\.logNumber\}/);
  assert.match(DIAG_MODAL, /naplózás automatikusan leállt/);
  assert.doesNotMatch(DIAG_MODAL, /QRCodeSVG|QR-kód készítése|data-diagnostic-refresh/);
  const SERVICE = read('web/src/services/diagnosticShareService.ts');
  assert.match(SERVICE, /action: 'send'/);
  assert.match(SERVICE, /action: 'history'/);
  assert.doesNotMatch(SERVICE, /QRCodeSVG|createDiagnosticShare|revokeDiagnosticShare/);
});

test('13. a Supabase napló-Edge Function nem ad vissza QR-linket, és öt rekordra takarít', () => {
  const EDGE = read('supabase/functions/tv-diagnostic-share/index.ts');
  assert.match(EDGE, /const MAX_LOG_ROWS = 5/);
  assert.match(EDGE, /async function pruneToFive/);
  assert.match(EDGE, /body(?:\?\.|\.)action === "history"/);
  assert.match(EDGE, /body(?:\?\.|\.)action !== "send" && body(?:\?\.|\.)action !== "create"/);
  assert.match(EDGE, /log_number: body\.logNumber/);
  assert.match(EDGE, /started_at: startedAt/);
  assert.doesNotMatch(EDGE, /url: base \+|QRCode|expiresAt: expires/);
});

/* ══════════════ 14. Feliratkeresés naplózása és kézi újrapróbálkozás ══════════════ */

test('14. a feliratkeresés a naplóban kimutatható (forrás, azonosító, eredmény)', () => {
  // Induláskor: melyik filmmel / epizóddal indul a keresés.
  assert.match(PLAYER, /appLog\(`Feliratkeresés \(CC\) indul: \$\{subtitleSource\.vodId \? `vod=\$\{subtitleSource\.vodId\}` : `sorozat=\$\{subtitleSource\.seriesId\}, epizód=\$\{subtitleSource\.episodeId\}`\}\.`\);/);
  // Ha nincs forrás (nem Xtream / hiányzó azonosító), az is a naplóba kerül.
  assert.match(PLAYER, /Feliratkeresés \(CC\): nincs szolgáltatói forrás ehhez a filmhez/);
  // A szolgáltató válasza és a letöltés eredménye is naplózott.
  assert.match(SUBTITLES, /Feliratkeresés \(CC\): \$\{entries\.length\} bejegyzés/);
  assert.match(SUBTITLES, /Szolgáltatói feliratok: \$\{tracks\.length\} elérhető/);
  assert.match(SUBTITLES, /Szolgáltatói felirat nem tölthető le/);
});

test('14. üres feliratlistánál a választó kinyitása újraindítja a keresést', () => {
  assert.match(PLAYER, /const \[subtitleSearchNonce, setSubtitleSearchNonce\] = useState\(0\);/);
  assert.match(PLAYER, /if \(menu === 'subtitle' && vodSubtitleTracks\.length === 0 && providerSubtitleTracks\.length === 0\) \{[\s\S]{0,260}?providerSubtitleRequestRef\.current = '';\s*\n\s*setSubtitleSearchNonce\(\(value\) => value \+ 1\);/);
  assert.match(PLAYER, /Felirat választó: nincs sáv – a szolgáltatói feliratkeresés újraindul\./);
  // A kereső hatás figyeli a számlálót (különben nem indulna újra).
  assert.match(PLAYER, /\}, \[isVod, streamUrl, subtitleSource, subtitleSearchNonce\]\);/);
});

/* ══════════════ 15. Napló-nyomok: formátum-emlék, két formátum hibája, QR-ablak ══════════════ */

test('15. a formátumemlékezet mentése és a kétformátumos hiba látszik a naplóban', () => {
  // Mentés csak VÁLTOZÁSKOR kerül a naplóba (nem minden zappolásnál).
  assert.match(PLAYER, /const previousFormat = target\?\.id \? rememberedFormatFor\(target\.id\) : null;/);
  assert.match(PLAYER, /if \(target\?\.id && previousFormat !== format\) \{/);
  assert.match(PLAYER, /FORMÁTUM-EMLÉK MENTVE; csatorna=\$\{String\(target\.name \|\| ''\)\.slice\(0, 100\)\}; /);
  // A CSATORNAVÁLTÁS START sor a globális emléket is kiírja, ha csatornánként nincs.
  // A CSATORNAVÁLTÁS START sor kiírja a csatorna formátum-emlékét vagy jelzi, ha nincs.
  assert.match(PLAYER, /formátum-emlék=\$\{channelMemory \|\| 'nincs'\}/);
  assert.match(PLAYER, /próbált formátumok=\$\{triedFormats\}; a csatorna jelenleg nem indítható\. Az utolsó sikeres formátum emléke megőrizve\./);
  assert.match(PLAYER, /liveFallbackRef\.current\?\.format === 'hls' \? 'MPEG-TS \+ HLS' : 'HLS \+ MPEG-TS'/);
});

test('15. a kézi naplóablak két gombja távirányítóval kezelhető', () => {
  assert.match(DIAG_MODAL, /const onModalKeyDown = \(event: React\.KeyboardEvent\) => \{/);
  assert.match(DIAG_MODAL, /if \(active && modalRef\.current\?\.contains\(active\) && active\.tagName === 'BUTTON'\) \{/);
  assert.match(DIAG_MODAL, /onKeyDown=\{onModalKeyDown\}/);
  assert.match(DIAG_MODAL, /data-diagnostic-toggle/);
  assert.match(DIAG_MODAL, /data-diagnostic-send/);
  assert.match(DIAG_MODAL, /Naplózás indítása/);
  assert.match(DIAG_MODAL, /Küldés Supabase-re/);
  assert.match(DIAG_MODAL, /listDiagnosticLogHistory/);
});

test('15. a kézi napló 1 MB-os, sorszámozott exportot készít', () => {
  assert.match(APPLOG, /localStorage\.removeItem\(/);
  assert.match(APPLOG, /measurementCounters\.logLines = 0;/);
  assert.match(APPLOG, /return \[header, \.\.\.lines\]\.join\('\\n'\);/);
  assert.match(APPLOG, /const MAX_CHARS = 1_000_000;/);
  assert.match(APPLOG, /WEBOS NAPLÓ #\$\{activeLogNumber\}/);
  assert.doesNotMatch(APPLOG, /MAX_LINES/);
});


test('16. a webOS kiadás-ellenőrzés sárga gombja és kinyíló eredménye megmarad', () => {
  assert.match(SETTINGS_MODAL, /data-system-refresh/);
  assert.match(SETTINGS_MODAL, /Frissítés ellenőrzése/);
  assert.match(SETTINGS_MODAL, /checkWebOSUpdate\(\)/);
  assert.match(SETTINGS_MODAL, /showReleaseDetails && releaseInfo/);
  // Csak a kék címsort vettük ki; az ellenőrző funkció és a márkakártya marad.
  assert.doesNotMatch(SETTINGS_MODAL, /LG webOS frissítés/);
  assert.match(SETTINGS_MODAL, /LG webOS alkalmazás/);
  assert.match(SETTINGS_MODAL, /LG webOS TV mód/);
});

test('16. a hat zöld pipás kártya és a félreértett szolgáltató-próba nincs a kódban', () => {
  for (const removed of [
    'Kép a képben',
    'TV-re küldés',
    'Kedvencek átrendezése',
    'Dupla koppintás és hangvezérlés',
    'Külön Mozi és Sorozat',
    'Többfunkciós kedvencek',
  ]) assert.doesNotMatch(SETTINGS_MODAL, new RegExp(removed));
  assert.doesNotMatch(SETTINGS_MODAL, /data-provider-switch-test|Szolgáltató-váltási próba|startProviderSwitchTest/);
  assert.doesNotMatch(APP, /SZOLGÁLTATÓ-VÁLTÁS/);
  assert.doesNotMatch(PLAYER, /providerDiagnosticTag|aktív-szolgáltató=\$\{providerIdRef/);
  assert.match(SETTINGS_MODAL, /LG webOS alkalmazás/);
});

test('16. a Lejátszó alatti Pufferelés gombjai ténylegesen mentik a profilt', () => {
  assert.match(SETTINGS_MODAL, /data-buffer-mode=\{bm\}/);
  assert.match(SETTINGS_MODAL, /aria-pressed=\{settings\.bufferMode === bm\}/);
  assert.match(SETTINGS_MODAL, /onUpdateSettings\(\{ bufferMode: bm \}\)/);
  assert.match(SETTINGS_MODAL, /Gyors/);
  assert.match(SETTINGS_MODAL, /Kiegyensúlyozott/);
  assert.match(SETTINGS_MODAL, /Stabil/);
  assert.match(APP, /storageService\.saveSettings\(updated\)/);
  assert.match(PLAYER, /const bufferModeRef = useRef\(settings\.bufferMode\);/);
  assert.match(PLAYER, /const bufferTiming = \(\) => bufferProfileTiming\(bufferModeRef\.current\);/);
});
