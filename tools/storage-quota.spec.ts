/*
 * TÁROLÓ-KVÓTA PRÓBA.
 *
 * A 2.5.110-es TV-napló (#2) pontosan megmutatta a hibát:
 *
 *   SZOLGÁLTATÓ [filmek], OK, 9133 ms, korlát=60000 ms, HTTP 200, 40.4 MB
 *   SZOLGÁLTATÓ FÁZIS [filmek] kész – 40000 film, 140 kategória (út=bulk); 20.9 s
 *   TÁROLÓ HIBA: content-live-chunk-v1-…-1-15 mentése végleg sikertelen;
 *                csökkentések=2; takarított kulcsok=0
 *   Élő csatornák adagolt mentése nem sikerült (16/51)
 *   Filmlista mentése sikertelen → a lista egy része nem menthető el (16/100)
 *   HOSSZÚ FELADAT: 3025 ms … LEÁLLÁS: a fő szál 4566 ms-ig nem futott
 *
 * A letöltés tehát SIKERES volt – a MENTÉS hasalt el. Két ok miatt:
 *
 *   1. A mentés alatt a lista KÉT példányban volt a tárolóban (a régi adagok
 *      csak a teljes, sikeres mentés után törlődtek), a TV kicsi kvótája
 *      ennek a felét sem bírta.
 *   2. Ha egy adag nem fért el, az EGÉSZ mentés elhasalt, így semmi nem
 *      került a tárolóba, és minden indulás 76 MB letöltéssel kezdődött.
 *
 * Ez a próba egy szándékosan kicsi kvótájú localStorage-t ad, és ellenőrzi,
 * hogy a mentés így is használható listát hagy maga után.
 */
import assert from 'node:assert/strict';

type AnyRecord = Record<string, unknown>;

/* ── Kvótás localStorage ─────────────────────────────────────────────── */

const QUOTA_CHARS = 220_000; // a TV-n mért nagyságrend (a napló ~1,1 MB-nál fogyott el)

const store = new Map<string, string>();
let peakChars = 0;
let rejectedWrites = 0;

function totalChars(): number {
  let sum = 0;
  for (const value of store.values()) sum += value.length;
  return sum;
}

function installStorage(): void {
  const api = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      const next = totalChars() - (store.get(key)?.length ?? 0) + String(value).length;
      if (next > QUOTA_CHARS) {
        rejectedWrites += 1;
        const error = new Error('QuotaExceededError');
        error.name = 'QuotaExceededError';
        throw error;
      }
      store.set(key, String(value));
      peakChars = Math.max(peakChars, totalChars());
    },
    removeItem: (key: string) => { store.delete(key); },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
    clear: () => store.clear(),
  };
  const anyGlobal = globalThis as unknown as AnyRecord;
  anyGlobal.localStorage = api;
  if (!anyGlobal.window) anyGlobal.window = anyGlobal;
}

function chunkKeys(prefix: string): string[] {
  return Array.from(store.keys()).filter((key) => key.includes(prefix));
}

/* ── Próbaadatok ─────────────────────────────────────────────────────── */

function makeMovies(count: number, tag: string, streamBase: number): AnyRecord[] {
  const out: AnyRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    out.push({
      id: `${tag}-${index}`,
      title: `${tag} film ${index} – hosszú cím, hogy a sor reális méretű legyen`,
      name: `${tag} film ${index} – hosszú cím, hogy a sor reális méretű legyen`,
      providerId: 'p1',
      categoryId: `vc-${index % 40}`,
      streamId: streamBase + index,
      containerExtension: 'mkv',
      streamIcon: `https://pelda.hu/borito/${index}.jpg`,
      rating: 7.5,
      added: '1690000000',
      plot: 'Rövid leírás a filmhez, ami a valódi listában is benne van.',
      genres: ['akció', 'dráma'],
    });
  }
  return out;
}

function makeContent(count: number, tag: string, streamBase: number): AnyRecord {
  const categories = [];
  for (let index = 0; index < 40; index += 1) {
    categories.push({ id: `vc-${index}`, name: `Kategória ${index}`, type: 'movie' });
  }
  return {
    provider: { id: 'p1', name: 'Próba', serverUrl: 'http://127.0.0.1', username: 'u', password: 'p' },
    channels: [],
    categories: [],
    movies: makeMovies(count, tag, streamBase),
    series: [],
    vodCategories: categories,
    seriesCategories: [],
    totals: { live: 0, vod: count, series: 0 },
  };
}

/* ── Futtatás ────────────────────────────────────────────────────────── */

let failures = 0;
function check(ok: boolean, message: string, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${message}${detail ? ` (${detail})` : ''}`);
}

async function main(): Promise<void> {
  installStorage();

  const store2 = await import('../web/src/services/contentStore.ts');

  console.log('\nTároló: a mentés nem tartja a lista két példányát:');

  const first = makeContent(4000, 'első', 10_000);
  await store2.saveVodContent(first as never);
  const afterFirst = chunkKeys('content-vod-chunk-v2-').length;
  const firstLoad = store2.loadVod({ id: 'p1' } as never);
  check(firstLoad.movies.length > 0, 'az első mentés után a lista visszaolvasható', `${firstLoad.movies.length} film`);
  check(peakChars <= QUOTA_CHARS, 'a mentés közben nem lépte túl a kvótát', `csúcs=${peakChars} karakter`);

  console.log('\nTároló: a második (frissítő) mentés is belefér a kvótába:');
  rejectedWrites = 0;
  peakChars = 0;
  const second = makeContent(4000, 'második', 90_000);
  let threw = '';
  try {
    await store2.saveVodContent(second as never);
  } catch (error) {
    threw = String((error as Error)?.message ?? error);
  }
  check(threw === '', 'a frissítő mentés nem hasal el a kvóta miatt', threw || 'nincs hiba');

  const secondLoad = store2.loadVod({ id: 'p1' } as never);
  check(secondLoad.movies.length > 0, 'a frissítés után is van visszaolvasható lista', `${secondLoad.movies.length} film`);
  check(
    String(secondLoad.movies[0]?.id ?? '').includes('9') && secondLoad.movies[0]?.title?.includes('második'),
    'a visszaolvasott lista az ÚJ generáció (nem a régi maradványa)',
    JSON.stringify(secondLoad.movies[0]).slice(0, 160)
  );

  const liveKeysAfter = chunkKeys('content-vod-chunk-v2-').length;
  check(
    liveKeysAfter <= afterFirst + 1,
    'a régi generáció adagjai nem halmozódnak fel a tárolóban',
    `első=${afterFirst}, most=${liveKeysAfter}`
  );
  check(peakChars <= QUOTA_CHARS, 'a frissítés csúcshasználata a kvótán belül maradt', `csúcs=${peakChars} karakter`);

  console.log('\nTároló: az üres lista mentése nem hiba:');
  let emptyThrew = '';
  try {
    await store2.saveVodContent(makeContent(0, 'üres', 1) as never);
  } catch (error) {
    emptyThrew = String((error as Error)?.message ?? error);
  }
  check(emptyThrew === '', 'a 0 elemű lista mentése nem dob hibát', emptyThrew || 'nincs hiba');

  console.log('\nTároló: ha mégsem fér el minden, a mentett rész használó marad:');
  // Durvább próba: akkora lista, ami biztosan nem fér el egészen.
  const huge = makeContent(40_000, 'nagy', 500_000);
  let hugeThrew = '';
  try {
    await store2.saveVodContent(huge as never);
  } catch (error) {
    hugeThrew = String((error as Error)?.message ?? error);
  }
  const hugeLoad = store2.loadVod({ id: 'p1' } as never);
  check(
    hugeThrew === '' && hugeLoad.movies.length > 0,
    'a kvótán túli lista is hagy maga után használó cache-t (nincs 76 MB-os újratöltés)',
    hugeThrew ? `hiba: ${hugeThrew.slice(0, 60)}; mentve: ${hugeLoad.movies.length} film` : `${hugeLoad.movies.length} film mentve`
  );


  console.log('\nTároló: a FEJLÉCNEK mindig marad hely (a 3-as TV-napló hibája):');
  /*
   * A 3-as napló (2.5.111) pont ezt produkálta: `foglaltság=67 kulcs /
   * 5060 kB`, 16 adag belement, de a content-vod-meta már nem fért el – és
   * fejléc nélkül a 16 bent lévő adag használhatatlan. Korábban a mentés
   * ilyenkor hibával állt le; most addig enged vissza adagokat, amíg a
   * fejléc belefér.
   */
  check(hugeThrew === '', 'a megtelt tárolónál is létrejön a mentés (a fejléc belefér)', hugeThrew || 'nincs hiba');
  const rawMeta = store.get('iptv_rt_content-vod-meta') ?? store.get('content-vod-meta');
  const metaChunks = rawMeta ? (JSON.parse(rawMeta) as { chunks?: number }).chunks : undefined;
  check(
    !!rawMeta && typeof metaChunks === 'number' && metaChunks > 0,
    'a filmlista fejléce bent van, és nem nulla adagra mutat',
    rawMeta ? `chunks=${metaChunks}` : 'nincs content-vod-meta kulcs'
  );
  const hugeIds = hugeLoad.movies.map((m) => (m as { streamId?: number }).streamId ?? -1);
  const fromHuge = hugeIds.filter((id) => id >= 500_000).length;
  check(
    fromHuge > 0 && fromHuge === hugeLoad.movies.length,
    'a kvótán túli mentés után a cache a MOSTANI generációt adja vissza',
    `új=${fromHuge} / összes=${hugeLoad.movies.length}`
  );
  check(
    hugeLoad.movies.length > 0 && hugeLoad.movies.length <= huge.movies.length,
    'a betöltött filmek száma a fejléc által jelzett adagokból jön',
    `betöltve: ${hugeLoad.movies.length} / ${huge.movies.length} film`
  );


  console.log('\nTároló: megtelt kvótánál is belefér a FEJLÉC (a 3-as TV-napló esete):');
  /*
   * A valós TV-n a kvótát nem csak a mi adagjaink töltik ki: a 3-as napló
   * `foglaltság=67 kulcs / 5060 kB` sora azt mutatja, hogy a ~5 MB teljesen
   * tele volt, és már az 5469 karakteres content-vod-meta sem fért el:
   *
   *   TÁROLÓ HIBA: content-vod-meta mentése végleg sikertelen; méret=5469
   *   Filmlista mentése sikertelen → a lista fejléce nem menthető el
   *
   * Fejléc nélkül a bent maradt adagok használhatatlanok. Ezt itt egy
   * "ballaszt" kulccsal állítjuk elő: olyan adat, amit a takarítás nem töröl
   * (nem tartalom-adag), így pont a valós helyzetet adja vissza.
   */
  store.clear();
  await store2.saveVodContent(makeContent(800, 'mérő', 700_000) as never);
  const chunkChars = Math.max(...chunkKeys('content-vod-chunk-v2-').map((k) => store.get(k)!.length));
  const metaChars = (store.get('iptv_rt_content-vod-meta') ?? '').length;
  store.clear();
  // Pont annyi hely marad, amennyibe KÉT adag belefér – a fejléc már nem.
  store.set('iptv_rt_ballast', 'x'.repeat(QUOTA_CHARS - 2 * chunkChars - Math.floor(metaChars / 2)));
  const tight = makeContent(1_200, 'szűk', 800_000);
  let tightThrew = '';
  try {
    await store2.saveVodContent(tight as never);
  } catch (error) {
    tightThrew = String((error as Error)?.message ?? error);
  }
  const tightLoad = store2.loadVod({ id: 'p1' } as never);
  const tightIds = tightLoad.movies.map((m) => (m as { streamId?: number }).streamId ?? -1);
  const tightFresh = tightIds.filter((id) => id >= 800_000).length;
  check(
    tightThrew === '',
    'a megtelt kvótán sem áll le a mentés hibával',
    tightThrew || `adag=${Math.round(chunkChars / 1000)} kB, fejléc=${metaChars} karakter`
  );
  check(
    tightFresh > 0 && tightFresh === tightLoad.movies.length,
    'a betöltőtt lista a most mentett generáció (nincs elárvult cache)',
    `új=${tightFresh} / összes=${tightLoad.movies.length}`
  );
  store.delete('iptv_rt_ballast');

  console.log('');
  assert.equal(failures, 0, `${failures} tároló-próba nem sikerült`);
  console.log('Minden tároló-kvóta próba sikeres. ✅');
}

await main();
