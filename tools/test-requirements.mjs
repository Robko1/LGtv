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
