/**
 * A TELJES MŰSORÚJSÁG (XMLTV) PRÓBÁJA.
 *
 * A TV-s panasz: „az EPG nem töltődik be a főoldalon”. A 19-es napló
 * (16:27:15) megmutatta, hogy a szolgáltató `get_short_epg` végpontja minden
 * kérésre 19 bájtos, üres választ ad (`{"epg_listings":[]}`) – vagyis a rövid
 * EPG-re épülő logika ezen a panelen soha nem tudott műsort mutatni.
 *
 * A javítás a szolgáltató teljes műsorújságját (xmltv.php) használja. Ez a
 * próba VALÓDI HTTP-kiszolgálóról, folyamatosan (darabolva) érkező XML-lel
 * ellenőrzi, hogy
 *   1. a `epg_channel_id` alapján megtalálja a most futó és a következő műsort,
 *   2. az azonosító nélküli csatornát név alapján is felismeri,
 *   3. a lejárt műsorokat és a 24 órán túliakat kidobja (memória-védelem),
 *   4. az ékezetes/entitásos címek helyesen jelennek meg, akkor is, ha a
 *      UTF-8 karakter ketté esik a hálózati darabok határán,
 *   5. a 30 perces gyorsítótár miatt nem tölti le újra ugyanazt,
 *   6. hiba esetén nem dob kivételt, hanem a naplóba írja az okot,
 *   7. a „következő” lista időrendben, ismétlés nélkül jön.
 *
 * Futtatás: node tools/test-epg-guide.mjs
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { channelNowNext, clearGuide, ensureGuide, guideNowNext, guideStatus, guideUpcoming }
  from '../web/src/services/epgGuide';

// A próba a build/tests mappából fut, ezért két szintet kell feljebb lépni.
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

let failures = 0;
const check = (condition: boolean, label: string, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ✗ ${label}${detail ? ` – ${detail}` : ''}`);
};

const pad = (value: number) => String(value).padStart(2, '0');

/** Unix másodperc → XMLTV idő (`20261027181500 +0000`). */
function xmltv(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`;
}

const now = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const started = now - 20 * 60; // 20 perce kezdődött
const ends = now + 40 * 60;    // 40 perc múlva ér véget
const nextStart = ends;
const nextEnd = ends + 45 * 60;

const GUIDE = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="test">
  <channel id="hbo.hu"><display-name>HBO HD</display-name></channel>
  <channel id="m1.hu"><display-name lang="hu">M1</display-name></channel>
  <programme start="${xmltv(now - 5 * HOUR)}" stop="${xmltv(started)}" channel="hbo.hu">
    <title>Korábbi műsor</title>
  </programme>
  <programme start="${xmltv(started)}" stop="${xmltv(ends)}" channel="hbo.hu">
    <title>Trónok harca &amp; társai</title>
  </programme>
  <programme start="${xmltv(nextStart)}" stop="${xmltv(nextEnd)}" channel="hbo.hu">
    <title>Sárkányok háza – 2. rész</title>
  </programme>
  <programme start="${xmltv(now + 30 * HOUR)}" stop="${xmltv(now + 31 * HOUR)}" channel="hbo.hu">
    <title>Túl késői műsor</title>
  </programme>
  <programme start="${xmltv(started)}" stop="${xmltv(ends)}" channel="m1.hu">
    <title>Híradó</title>
  </programme>
</tv>`;

let guideRequests = 0;
let failNext = false;
let server;
let base = '';

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname.endsWith('/xmltv.php')) {
        guideRequests += 1;
        /*
         * 2.5.166: MEGSZAKÍTOTT letöltés. A TV-naplókban (#32, #37) ez volt a
         * valóság: a fájl fele megérkezett, majd `AbortError`. Ilyenkor a MÁR
         * beolvasott csatornák nem veszhetnek el.
         */
        if (url.searchParams.get('username') === 'partial') {
          res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
          // A válasz a két csatornát és az ELSŐ három műsort tartalmazza,
          // utána elszakad a kapcsolat (mint a TV-n a megszakadt letöltés).
          let cut = GUIDE.indexOf('<programme');
          for (let step = 0; step < 2; step += 1) cut = GUIDE.indexOf('<programme', cut + 1);
          const half = Buffer.from(GUIDE.slice(0, GUIDE.indexOf('</programme>', cut) + '</programme>'.length), 'utf8');
          res.write(half);
          setTimeout(() => { res.destroy(); }, 20);
          return;
        }
        if (failNext) {
          failNext = false;
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('hiba');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
        // A választ SZÁNDÉKOSAN 7 bájtos darabokban küldjük: így a magyar
        // ékezetes betű (2 bájt) biztosan ketté esik a darabok határán.
        const buffer = Buffer.from(GUIDE, 'utf8');
        let offset = 0;
        const tick = () => {
          if (offset >= buffer.length) {
            res.end();
            return;
          }
          res.write(buffer.subarray(offset, offset + 7));
          offset += 7;
          setTimeout(tick, 0);
        };
        tick();
        return;
      }
      res.writeHead(404);
      res.end('nincs');
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      base = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}


await startServer();

// A szolgáltató címe csak a kiszolgáló elindulása után ismert (véletlen port).
const provider = {
  id: 'prov-1',
  type: 'xtream' as const,
  serverUrl: base,
  username: 'user',
  password: 'pass',
};

console.log('EPG műsorújság (XMLTV)');
await ensureGuide(provider);
const status = guideStatus();
check(status.channels >= 2, 'két csatorna bekerült a műsorújságból', `kapott: ${status.channels}`);

const hbo = guideNowNext({ epgChannelId: 'hbo.hu' });
check(!!hbo?.now, 'az epg_channel_id alapján megtalálja a most futó műsort');
check(hbo?.now?.title === 'Trónok harca & társai', 'az XML entitás (&amp;) helyesen dekódolódik',
  String(hbo?.now?.title));
check(hbo?.now?.startTimestamp === started && hbo?.now?.endTimestamp === ends,
  'a kezdés/vége időbélyeg pontos (UTC-eltolással együtt)');
check(hbo?.next?.title === 'Sárkányok háza – 2. rész', 'a következő műsor helyes',
  String(hbo?.next?.title));
check(!String(hbo?.now?.title).includes('Korábbi'), 'a lejárt műsor nem kerül a „most fut” helyre');
check(!JSON.stringify(hbo).includes('Túl késői'), 'a 24 órán túli műsor nem foglal memóriát');

const byName = guideNowNext({ name: 'M1 HD' });
check(byName?.now?.title === 'Híradó', 'azonosító nélkül, név alapján is felismeri (M1 HD → M1)',
  String(byName?.now?.title));

const unknown = guideNowNext({ epgChannelId: 'nincs.ilyen' });
check(unknown === null, 'ismeretlen csatornára nincs találgatás (nincs hamis műsor)');

const upcoming = guideUpcoming({ epgChannelId: 'hbo.hu' }, Date.now(), 3);
check(upcoming.length >= 1 && upcoming[0].title === 'Sárkányok háza – 2. rész',
  'a „következő” lista a soron lévő műsorral kezdődik');
check(/^\d\d:\d\d - \d\d:\d\d$/.test(upcoming[0]?.time || ''),
  'az időpont 24 órás, nyelvfüggetlen formátumú', String(upcoming[0]?.time));

const requestsAfterFirst = guideRequests;
await ensureGuide(provider);
check(guideRequests === requestsAfterFirst,
  'a 30 perces gyorsítótár miatt nincs újabb letöltés', `kérések: ${guideRequests}`);

// A rövid EPG gyorsítótára üres ebben a próbában – a tartalék helyesen null.
const fallback = channelNowNext(provider, { id: 'x', name: 'HBO HD' });
check(fallback?.now?.title === 'Trónok harca & társai',
  'a közös lekérdezés (channelNowNext) a műsorújságból ad adatot');

// Hibaág: a következő letöltés HTTP 500-at kap, a program nem áll meg.
clearGuide();
failNext = true;
await ensureGuide(provider);
const failed = guideStatus();
check(failed.channels === 0, 'hibás letöltésnél nem lesz félkész műsorújság');
check(/HTTP 500/.test(failed.error), 'a hiba VALÓDI oka a naplóba kerül', failed.error);

/* ─────────── 2.5.166: a letöltés nem halhat meg a korláton ─────────── */

const SOURCE = readFileSync(resolve(projectDir, 'web/src/services/epgGuide.ts'), 'utf8');
check(!/REQUEST_TIMEOUT_MS/.test(SOURCE),
  'nincs 90 mp-es TELJES időkorlát (ez szakította meg a 62 MB-os fájlt)');
check(/IDLE_TIMEOUT_MS = 60_000/.test(SOURCE),
  'van adathiány-figyelő (csak akkor szakít, ha nem jön adat)');
check(/MAX_DOWNLOAD_MS = 8 \* 60_000/.test(SOURCE),
  'van biztonsági felső korlát, de az nem a normál letöltést vágja el');
check(/MAX_BYTES = 192 \* 1024 \* 1024/.test(SOURCE),
  'a méretkorlát a 62 MB-os fájl fölé került');
check(/if \(index\.size > 0\) finishParsing\(\);/.test(SOURCE),
  'megszakítás után a részleges index nem mentődik');
check(/GUIDE_IDB_PREFIX/.test(SOURCE) && /restorePersistedGuide/.test(SOURCE),
  'nincs tartós gyorsítótár (minden indulásnál újra 4 percet töltene)');
check(/skipRestore = true/.test(SOURCE),
  'a clearGuide után a régi mentés jelenne meg');
check(/abortReason/.test(SOURCE) && /megszakadt/.test(SOURCE),
  'a megszakítás OKA nem kerül a naplóba');

// Részleges letöltés: a kapcsolat elszakad, a már beolvasott csatorna marad.
clearGuide();
const partialProvider = { ...provider, username: 'partial' };
await ensureGuide(partialProvider);
const partialStatus = guideStatus();
check(partialStatus.channels >= 1,
  'megszakított letöltésnél a már beolvasott csatornák megmaradnak',
  `kapott: ${partialStatus.channels}`);
check(!!guideNowNext({ epgChannelId: 'hbo.hu' })?.now,
  'a részleges műsorújságból is van most futó műsor (sárga csík)');

server.close();
if (failures > 0) {
  console.error(`\n${failures} próba nem sikerült.`);
  process.exit(1);
}
console.log('\nMinden műsorújság-próba sikeres. ✅');
