/**
 * A SZOLGÁLTATÓ-BEOLVASÁS JAVÍTÁSAINAK PRÓBÁJA.
 *
 * A TV-n jelentkező panasz: „a csatornák letöltődnek, de a filmek és a
 * sorozatok hibával elakadnak / túl lassan töltődnek”. A próbák azokat a
 * konkrét okokat zárják ki, amelyek ezt okozták:
 *
 *   1. A hálózati réteg a kért időtúllépést CSENDBEN 30 mp-re vágta vissza,
 *      pedig a bulk film-/sorozatlista (több tízezer elem egyetlen JSON-ban)
 *      60 mp-et kért. A nagy lista ezért soha nem fért bele az időkeretbe,
 *      és a program a jóval lassúbb kategóriánkénti letöltésre esett vissza.
 *
 *   2. Az időtúllépés ugyanúgy „halott szervernek” számított, mint egy
 *      kapcsolati hiba: 4 lassú kérés után a megszakító 60 mp-re MINDENT
 *      letiltott, így a már sikeresen letöltött élő csatornák után a filmek
 *      és a sorozatok üresen maradtak.
 *
 *   3. A válasz méretét `new TextEncoder().encode(text).byteLength` adta:
 *      ez a teljes (akár 30-40 MB-os) választ még egyszer bájttömbbé
 *      alakította csak egy diagnosztikai szám kedvéért.
 *
 * Futtatás: node tools/test-provider-load.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

let failures = 0;

function check(name: string, condition: boolean, extra = ''): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

/** Hamis szolgáltató: a `slow` végpont késik, a `fast` azonnal válaszol. */
function startPanel(slowDelayMs: number): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const body = JSON.stringify([{ category_id: '1', category_name: 'Teszt' }]);
      const send = () => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
        res.end(body);
      };
      if (url.searchParams.get('slow')) setTimeout(send, slowDelayMs);
      else send();
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        server,
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * VÉGIGMENETEL: kézi naplózás + valódi szolgáltató-import.
 *
 * Ez az ellenőrzés azt igazolja, amit a felhasználó a TV-n csinál: elindítja a
 * naplózást, elindítja a betöltést a szolgáltatótól, és a naplóban ott vannak a
 * szolgáltató-beolvasás sorai – ezek mennek ki a Supabase-re, és ezekből
 * lehet a hibát javítani.
 */
async function runManualLogCheck(): Promise<void> {
  // Minimális böngésző-környezet a naplónak (a TV-n ezek adottak).
  const store = new Map<string, string>();
  const anyGlobal = globalThis as unknown as Record<string, unknown>;
  anyGlobal.localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
  };
  if (!anyGlobal.window) anyGlobal.window = anyGlobal;

  const log = await import('../web/src/services/appLog.ts');
  const { importXtreamProvider } = await import('../web/src/services/providerImport.ts');
  const net = await import('../web/src/services/net.ts');

  const panel = await startMiniProvider();
  try {
    log.startManualLogging();
    net.resetNetworkBreaker();
    await importXtreamProvider(
      {
        name: 'Napló próba',
        serverUrl: `http://127.0.0.1:${panel.port}`,
        username: 'teszt',
        password: 'titok',
      },
      () => {},
      () => {}
    );
    const text = log.getAppLogText();
    const lines = text.split('\n').filter((line) => line.includes('SZOLGÁLTATÓ'));
    check('a napló tartalmaz szolgáltató-beolvasási sorokat', lines.length > 0, `(${lines.length} sor)`);
    check(
      'a naplóban látszik az élő csatornalista kérése és az eredménye',
      lines.some((line) => line.includes('[élő csatornalista]') && line.includes('OK'))
    );
    check(
      'a naplóban látszik a filmek és a sorozatok szakasza is',
      lines.some((line) => line.includes('FÁZIS [filmek]')) &&
        lines.some((line) => line.includes('FÁZIS [sorozatok]'))
    );
    check(
      'a naplóban látszik a végső darabszám és az eltelt idő',
      /FÁZIS \[élő csatornák\] kész/.test(text) && /\d+(\.\d+)? s/.test(text)
    );
    check(
      'a napló nem tartalmaz belépési adatot',
      !/password=titok/.test(text) && !/username=teszt/.test(text)
    );
    if (process.env.SHOW_PROVIDER_LOG) {
      console.log('\n----- MINTA A KÉZI NAPLÓBÓL -----');
      for (const line of lines) console.log(line.replace(/^\S+ \S+ /, ''));
      console.log('---------------------------------\n');
    }
    log.stopManualLogging('próba vége');
  } finally {
    await panel.close();
    net.resetNetworkBreaker();
  }
}

/** Kicsi, teljes Xtream-panel a napló próbájához. */
function startMiniProvider(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const send = (res: http.ServerResponse, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(text);
    };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      switch (url.searchParams.get('action')) {
        case null:
          send(res, { user_info: { username: 'teszt', auth: 1, status: 'Active', exp_date: '1893456000', max_connections: '2' } });
          break;
        case 'get_live_categories':
          send(res, [{ category_id: '10', category_name: 'Magyarország' }]);
          break;
        case 'get_live_streams':
          send(res, [{ num: 1, name: 'M1 HD', stream_id: 101, stream_icon: '', category_id: '10' }]);
          break;
        case 'get_vod_categories':
          send(res, [{ category_id: '20', category_name: 'Filmek' }]);
          break;
        case 'get_vod_streams':
          send(res, [{ name: 'Dűne', stream_id: 501, container_extension: 'mkv', category_id: '20', rating: '7.9', added: '1690000000' }]);
          break;
        case 'get_series_categories':
          send(res, [{ category_id: '30', category_name: 'Sorozatok' }]);
          break;
        case 'get_series':
          send(res, [{ name: 'A Sógun', series_id: 901, category_id: '30', rating: '9.1', releaseDate: '2024-02-27' }]);
          break;
        default:
          send(res, {});
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function main(): Promise<void> {
  const net = await import('../web/src/services/net.ts');
  const projectDir = path.resolve('.');
  const netSource = fs.readFileSync(path.join(projectDir, 'web/src/services/net.ts'), 'utf8');
  const importSource = fs.readFileSync(path.join(projectDir, 'web/src/services/providerImport.ts'), 'utf8');
  const xtreamSource = fs.readFileSync(path.join(projectDir, 'web/src/services/xtreamService.ts'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(projectDir, 'web/index.html'), 'utf8');
  const mainSource = fs.readFileSync(path.join(projectDir, 'web/src/main.tsx'), 'utf8');
  const appSource = fs.readFileSync(path.join(projectDir, 'web/src/App.tsx'), 'utf8');

  /* ── 1. A nagy lista-végpont megkapja a kért időkeretet ─────────────── */
  console.log('\nIdőtúllépés: a nagy film-/sorozatlista nem fut ki az időből:');
  check(
    'a szokásos kérés felső korlátja 30 mp marad',
    net.effectiveTimeoutMs({ timeoutMs: 60000 }) === 30000,
    `(${net.effectiveTimeoutMs({ timeoutMs: 60000 })})`
  );
  check(
    'a bulk lista-végpont megkapja a kért 60 mp-et (korábban 30 mp-re csonkolódott)',
    net.effectiveTimeoutMs({ timeoutMs: 60000, bulkList: true }) === 60000,
    `(${net.effectiveTimeoutMs({ timeoutMs: 60000, bulkList: true })})`
  );
  check(
    'a bulk lista-végpont felső korlátja 90 mp (nem korlátlan)',
    net.effectiveTimeoutMs({ timeoutMs: 600000, bulkList: true }) === 90000,
    `(${net.effectiveTimeoutMs({ timeoutMs: 600000, bulkList: true })})`
  );
  check(
    'a xtreamService a bulk film-/sorozatkérést bulkList jelzéssel indítja',
    /bulkList: !category/.test(xtreamSource)
  );
  check(
    'a csendben maradt időtúllépés-csökkentés most a naplóba kerül',
    /a felső korlát miatt/.test(netSource)
  );

  /* ── 2. Időtúllépés ≠ halott szerver ────────────────────────────────── */
  console.log('\nMegszakító: a lassú válasz nem tiltja le a film-/sorozatbetöltést:');
  const panel = await startPanel(900);
  /*
   * A cím szándékosan tartalmaz belépési adatot: az IPTV-credentialt a
   * hálózati réteg soha nem küldi nyilvános CORS-proxynak, így a próba
   * egyetlen kérést vizsgál, és nem indul külső (a TV-n is felesleges) próbálkozás.
   */
  const base = `http://127.0.0.1:${panel.port}/player_api.php?username=teszt&password=titok`;
  const slowUrl = `${base}&slow=1`;
  const fastUrl = `${base}&fast=1`;
  try {
    net.resetNetworkBreaker();

    // Egy gyors, sikeres válasz: a szerver él.
    const okText = await net.httpGetText(fastUrl, { timeoutMs: 5000 });
    check('a gyors kérés sikerül', okText.includes('category_id'));
    check('sikeres válasz után a megszakító zárva van', net.breakerOpen() === false);

    // Egy lassú válasz kifut az időből → érthető, naplózható hiba.
    let timeoutMessage = '';
    try {
      await net.httpGetText(slowUrl, { timeoutMs: 150 });
    } catch (error) {
      timeoutMessage = error instanceof Error ? error.message : String(error);
    }
    check(
      'a lassú kérés IDŐTÚLLÉPÉSKÉNT jelenik meg (nem „elérhetetlen szerverként”)',
      /időtúllépés|timeout|nem küldte meg a választ/i.test(timeoutMessage),
      `(${timeoutMessage})`
    );
    check(
      'az időtúllépés üzenete megkülönböztethető a kapcsolati hibától',
      !/^Nem sikerült elérni a szervert/.test(timeoutMessage),
      `(${timeoutMessage})`
    );
    check(
      'egyetlen időtúllépés után a megszakító még zárva',
      net.breakerOpen() === false
    );

    // Sorozatos időtúllépések: a szerver közben ÉL (nemrég válaszolt), ezért a
    // betöltésnek folytatódnia kell – korábban itt tiltott le mindent 60 mp-re.
    for (let index = 0; index < 5; index++) {
      try {
        await net.httpGetText(slowUrl, { timeoutMs: 120 });
      } catch {
        /* az időtúllépés a vár viselkedés */
      }
    }
    check(
      '5 egymás utáni időtúllépés után is folytatódik a betöltés (a megszakító zárva)',
      net.breakerOpen() === false,
      `(maradék: ${net.breakerRemainingMs()} ms)`
    );
    const stillWorks = await net.httpGetText(fastUrl, { timeoutMs: 5000 });
    check('a megszakító után a következő kérés azonnal indul', stillWorks.includes('category_id'));
  } finally {
    await panel.close();
    net.resetNetworkBreaker();
  }

  /* ── 3. Nincs második, felesleges másolat a nagy válaszról ──────────── */
  console.log('\nMemória: a nagy JSON válasz nem másolódik le még egyszer:');
  check(
    'a diagnosztika nem TextEncoderrel méri a válasz méretét',
    !/new TextEncoder\(\)\.encode\(text\)/.test(netSource)
  );
  check(
    'a válasz mérete a Content-Length fejlécből (vagy a szöveghosszból) jön',
    /content-length/.test(netSource)
  );

  /* ── 3/b. A már letöltött nagy lista nem kerül a kukába ─────────────── */
  console.log('\nGyorsítás: a letöltött nagy lista nem töltődik le még egyszer:');
  check(
    'a túl nagy bulk film-válasz nem indul újra kategóriánként',
    !/MAX_MOVIES \* 1\.2/.test(importSource)
  );
  check(
    'a túl nagy bulk sorozat-válasz nem indul újra kategóriánként',
    !/MAX_SERIES \* 1\.2/.test(importSource)
  );
  check(
    'a korlát miatti csonkolás figyelmeztetést kap a néző',
    /a beépített korlát miatt az első/.test(importSource)
  );
  check(
    'a betöltés minden szakasza időbélyeggel kerül a naplóba',
    /logProviderPhaseEnd\(/.test(importSource) && /logProviderPhaseStart\(/.test(importSource)
  );

  /* ── 4. A takarókép addig marad, amíg a főoldal készen áll ──────────── */
  console.log('\nIndulás: a takarókép nem tűnik el a kész főoldal előtt:');
  const safetyNet = Number((htmlSource.match(/window\.__IPTV_REVEAL__\('biztonsági háló'\);\s*\},\s*(\d+)\)/) || [])[1] || 0);
  const appLimit = Number((mainSource.match(/if \(elapsed > (\d+)\)/) || [])[1] || 0);
  check('a HTML biztonsági hálója létezik', safetyNet > 0, `(${safetyNet})`);
  check('a főoldal saját korlátja létezik', appLimit > 0, `(${appLimit})`);
  check(
    'a biztonsági háló a főoldal saját korlátja FELETT van (így mindig az alkalmazás dönt)',
    safetyNet > appLimit,
    `(háló=${safetyNet} ms, alkalmazás=${appLimit} ms)`
  );
  check(
    'az első festés előre rajzolt, fix főoldali váz (nincs képvillanás)',
    htmlSource.includes('id="iptv-skeleton"')
  );
  check(
    'a build külön app.js-be emeli a nagy JS-t (kicsi marad a HTML)',
    fs.readFileSync(path.join(projectDir, 'tools/build-webos.sh'), 'utf8').includes('def externalize_scripts')
  );
  /*
   * A webOS kezelő piros „a felület nem töltődött be” doboza csak a takarókép
   * felengedése UTÁN jelenhet meg – különben pont abban a pillanatban villan
   * a néző szeme elé, amikor a felület készen áll.
   */
  const webosSource = fs.readFileSync(path.join(projectDir, 'webos/webos.js'), 'utf8');
  const diagFailMs = Number((webosSource.match(/diagUiFail\(\);\s*},\s*(\d+)\);/) || [])[1] || 0);
  check('a képernyős hibaüzenet időzítője létezik', diagFailMs > 0, `(${diagFailMs} ms)`);
  check(
    'a képernyős hibaüzenet a takarókép felengedése UTÁN jön (nincs rávillanás)',
    diagFailMs > safetyNet,
    `(hibaüzenet=${diagFailMs} ms, takarókép=${safetyNet} ms, főoldal=${appLimit} ms)`
  );

  /* ── 5. A betöltés nem ugrik másik csatornára ───────────────────────── */
  console.log('\nCsatornaváltás: a betöltés nem viszi el a kijelölést:');
  check(
    'a kijelölés a pillanatnyi állapotból indul (nem a lezárt renderből)',
    /activeChannelIdRef\.current/.test(appSource)
  );
  check(
    'a tartalék csatorna a MAGYAR sorrend első eleme (nem a nyers lista első)',
    // A frissítés végén a MEGJELENÍTETT lista dönt (amely a nézett csatornát is
    // megtartja), és a tartalék mindig a magyar sorrend első lejátszható adója.
    /keepOrMoveActiveChannel\(hungaryFirst\(persistedChannels\), true\)/.test(appSource)
      && /const fallback = firstPlayableHungarianChannel\(candidateList\);/.test(appSource)
  );
  check(
    'a nyers `refreshedContent.channels[0]` kijelölés-csere megszűnt',
    !/setActiveChannelId\(nextActiveChannel\.id\)/.test(appSource)
  );
  check(
    'az első (1500 csatornás) előnézet nem dönt a kijelölésről',
    /if \(partial\.preview\)/.test(appSource)
  );
  check(
    'a háttérbetöltés alatt nem fut aktív csatorna-EPG kérés',
    /if \(providerRefreshActiveRef\.current\) return;/.test(appSource)
  );

  /* ── 6. A figyelő valóban a kézi naplóba ír (Supabase-re ez megy ki) ── */
  console.log('\nKézi napló: a szolgáltató-beolvasás sorai megjelennek a naplóban:');
  await runManualLogCheck();

  console.log('');
  if (failures === 0) {
    console.log('Minden szolgáltató-beolvasási próba sikeres. ✅');
  } else {
    console.log(`${failures} próba nem sikerült. ❌`);
    process.exit(1);
  }
}

void main();
