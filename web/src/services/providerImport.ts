import { normalizeLogoUrl } from './logoUrl';
/**
 * Szolgáltatói lista betöltése: Xtream Codes API vagy M3U/M3U8.
 *
 * A betöltés három szakaszban fut, és minden szakasz RÖGTÖN a felületre kerül
 * (onPartial), hogy a csatornalista ne várjon a filmekre és a sorozatokra.
 *
 *   1. élő csatornák   (1 kérés – ez a leggyorsabb, ezért ez az első)
 *   2. filmek          (kategóriánként)
 *   3. sorozatok
 *
 * KÍMÉLŐ HÁLÓZATI ÜZEMMÓD
 * ----------------------
 * A független alaplisták párhuzamosan, a kategóriánkénti VOD-kérések
 * legfeljebb két workerrel futnak. A net.ts globális korlátja továbbra is
 * legfeljebb két aktív kapcsolatot enged, időtúllépéssel és megszakítóval:
 * így gyorsabb a betöltés, de nem indulhat korlátlan kapcsolatözön.
 *
 * Ezért ezen kívül:
 *   - egy kérést legfeljebb 2 alkalommal indítunk,
 *   - csak 429 / szerverhiba esetén próbálkozunk újra (hálózati elakadásnál nem),
 *   - ha egymás után 4 kategória sem jön be, a betöltés LEÁLL (nem pörög tovább),
 *   - az elérhetetlen szerver esetén a net.ts megszakítója minden további
 *     kapcsolatot letilt egy percre.
 */

import { Category, Channel, Movie, ProviderAccount, Series } from '../types/iptv';
import { flagFor } from '../utils/flags';
import {
  ImportedContent,
  ProviderRef,
  decodeChannelsForImport,
  decodeMoviesForImport,
  decodeSeriesForImport,
  loadRawPlaylist,
  saveRawPlaylist,
} from './contentStore';
import { xtreamService, XtreamCategory, XtreamSeriesItem, XtreamVodStream } from './xtreamService';
import { storageService } from './storageService';

// webOS TV gyors betöltés detektálás
export interface ImportProgress {
  phase: string;
  detail?: string;
  percent: number;
}

export type ProgressFn = (progress: ImportProgress) => void;

/**
 * Részleges tartalom: a betöltés egy-egy szakasza után azonnal a felületre
 * kerül, így a felhasználó nem vár a teljes (több perces) betöltés végére.
 */
export interface PartialContent {
  channels?: Channel[];
  liveCategories?: Category[];
  movies?: Movie[];
  vodCategories?: Category[];
  series?: Series[];
  seriesCategories?: Category[];
  totals?: { live?: number; vod?: number; series?: number };
}

export type PartialFn = (partial: PartialContent) => void | Promise<void>;

/** Biztonsági korlátok: ennyi elemet töltünk be egy listából. */
const MAX_CHANNELS = 60000;
const MAX_MOVIES = 40000;
const MAX_SERIES = 15000;

/**
 * A felületfrissítéseket ritkítjuk: a sok callback lassíthatja a böngészőfelület-t.
 * Korábban 250/100 volt, ami 40k filmnél 160 progress + 400 yield = ~100s összidőből 86s feldolgozás.
 * Most 500/500: fele annyi callback, kevesebb főszál blokkolás, de még mindig nem fagy le.
 */
const PROGRESS_UPDATE_EVERY = 500;
/** Hosszú feldolgozás közben időnként visszaadjuk a vezérlést a böngészőfelület-nak. */
const UI_YIELD_EVERY = 500;

function yieldToUi(): Promise<void> {
  // requestIdleCallback ha van, különben setTimeout 0 – kíméli a UI szálat
  return new Promise<void>((resolve) => {
    if (typeof (window as any).requestIdleCallback === 'function') {
      (window as any).requestIdleCallback(() => resolve(), { timeout: 50 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export interface ImportedProvider {
  content: ImportedContent;
  user: {
    expireDate: string;
    maxConnections: number;
    status: string;
  };
}

function makeCategoryMap(categories: XtreamCategory[]): Map<string, XtreamCategory> {
  const map = new Map<string, XtreamCategory>();
  for (const category of categories) {
    if (category?.category_id !== undefined && category?.category_id !== null) {
      map.set(String(category.category_id), category);
    }
  }
  return map;
}

function findCategory(categoryMap: Map<string, XtreamCategory>, id: string | number | undefined): XtreamCategory | null {
  if (id === undefined || id === null) return null;
  return categoryMap.get(String(id)) || null;
}

/* --------------------------------------------------- szolgáltatói kérés */

/** Egy kérést legfeljebb ennyiszer indítunk (a hálózat kímélése miatt). */
const RETRY_MAX_ATTEMPTS = 2;
/** Első újrapróbálkozás előtti várakozás (ehhez jön egy kis véletlen szórás). */
const RETRY_BASE_DELAY_MS = 800;
/** Ennyi egymás utáni sikertelen kategória után leáll a betöltés. */
const MAX_CONSECUTIVE_FAILURES = 4;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Csak a kapcsolatkorlát (429) és a szerverhiba (5xx) érdemel újrapróbálkozást. */
function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP 429|Too many connections|HTTP 5\d\d/i.test(message);
}

/**
 * Egy szolgáltatói kérés. A tényleges hálózati munkát a net.ts végzi
 * (legfeljebb két párhuzamos kéréssel, kis szünettel és időtúllépéssel).
 */
async function providerRequest<T>(task: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === RETRY_MAX_ATTEMPTS) break;
      // 0,8-1,2 s: a panel közben kiüríti a kapcsolatait.
      await sleep(RETRY_BASE_DELAY_MS + Math.floor(Math.random() * 400));
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label}: ${message}`);
}

export interface CategoryLoadResult<T> {
  items: T[];
  /** A kategóriákból összesen kapott elemek száma. */
  collected: number;
  /** Azok a kategóriák, amelyeket a szolgáltató nem adott ki. */
  failedCategoryIds: string[];
  /** Igaz, ha a darabszám-korlát miatt nem töltöttük le az összes kategóriát. */
  truncated: boolean;
  /** Igaz, ha a betöltést hálózati hiba miatt le kellett állítani. */
  aborted: boolean;
}

/**
 * Kategóriánkénti letöltés – most 2 concurrent kéréssel (korábban szigorúan sorban).
 * A teszt alapján 23 VOD kategória 15.5s hálózat + 86s feldolgozás = 102s volt.
 * 2 concurrent + 80ms gap + bulk gyorsítás + ritkább yield 500/500 kb 40-50% gyorsulás,
 * miközben a router terhelése továbbra is minimális (2 kapcsolat) és a circuit breaker
 * (4 hiba után 60s cooldown) véd a túlterheléstől.
 */
async function loadCategoryFiltered<T>(
  categories: XtreamCategory[],
  loadCategory: (categoryId: string) => Promise<T[]>,
  options: {
    onProgress?: (done: number, total: number) => void;
    shouldStop?: (collected: number) => boolean;
    /** Opcionális adagfeldolgozás: ne kelljen minden nyers választ memóriában tartani. */
    onItems?: (rows: T[]) => void | Promise<void>;
  } = {}
): Promise<CategoryLoadResult<T>> {
  const items: T[] = [];
  const failedCategoryIds: string[] = [];
  const safeCategories = Array.isArray(categories) ? categories : [];
  const usable = safeCategories.filter(
    (category) => category?.category_id !== undefined && category?.category_id !== null
  );

  let done = 0;
  let collected = 0;
  let truncated = false;
  let aborted = false;
  let consecutiveFailures = 0;
  let nextIndex = 0;
  const CONCURRENCY = 2; // kímélő, de gyorsabb mint 1

  // Ha a limitet elérjük, leállunk
  const shouldStop = () => options.shouldStop && options.shouldStop(collected);

  async function worker(): Promise<void> {
    while (true) {
      if (aborted || truncated) break;
      if (shouldStop()) {
        truncated = true;
        break;
      }
      const currentIndex = nextIndex++;
      if (currentIndex >= usable.length) break;
      const category = usable[currentIndex];
      try {
        const rows = await providerRequest(
          () => loadCategory(String(category.category_id)),
          `Kategória (${category.category_name || category.category_id})`
        );
        collected += rows.length;
        if (options.onItems) {
          await options.onItems(rows);
        } else {
          for (const row of rows) items.push(row);
        }
        consecutiveFailures = 0;
      } catch (error) {
        failedCategoryIds.push(String(category.category_id));
        consecutiveFailures++;
        console.warn('Kategória betöltése sikertelen:', category.category_id, error);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          aborted = true;
          break;
        }
      } finally {
        done++;
        options.onProgress?.(done, usable.length);
      }
    }
  }

  // Indítjuk a worker-öket
  const workers = Array.from({ length: Math.min(CONCURRENCY, usable.length) }, () => worker());
  await Promise.all(workers);

  return { items, collected, failedCategoryIds, truncated, aborted };
}

function describeAbort(label: string): string {
  return (
    `A ${label} betöltését leállítottuk, mert a szolgáltató szervere nem válaszol ezen a hálózaton. ` +
    `Ellenőrizd az internetkapcsolatot (Wi-Fi), majd nyomd meg újra a Frissítést – addig a korábban ` +
    `letöltött lista marad érvényben.`
  );
}

function describeFailures(label: string, failed: string[], total: number): string | null {
  if (failed.length === 0) return null;
  if (failed.length >= total) {
    throw new Error(
      `A ${label} egyetlen kategóriája sem töltődött le. Valószínűleg a szolgáltató ` +
        `elutasítja a kéréseket (túl sok kapcsolat vagy átmeneti hiba). Próbáld újra később.`
    );
  }
  return `A ${label} ${failed.length}/${total} kategóriája nem töltődött le (a szolgáltató átmenetileg elutasította). Frissítsd újra.`;
}

function resolveCategory(
  categoryMap: Map<string, XtreamCategory>,
  id: string | number | undefined,
  prefix: string
): { id: string; name: string } {
  const found = findCategory(categoryMap, id);
  const name = found?.category_name?.trim();
  if (found && name) {
    return { id: `${prefix}${found.category_id}`, name };
  }
  return { id: `${prefix}other`, name: 'Egyéb' };
}

function buildCategories(
  source: XtreamCategory[],
  prefix: string,
  type: 'live' | 'movie' | 'series',
  counts: Map<string, number>
): Category[] {
  // Egyes szolgáltatók hibás vagy hiányzó kategória-választ adhatnak.
  // A listaimport ne omoljon össze ilyenkor a .filter() hívásnál.
  const safeSource = Array.isArray(source) ? source : [];
  const list: Category[] = safeSource
    .filter((cat) => cat && cat.category_id !== undefined && cat.category_id !== null)
    .map((cat) => {
      const id = `${prefix}${cat.category_id}`;
      return {
        id,
        name: (cat.category_name || 'Névtelen kategória').trim(),
        flag: type === 'live' ? flagFor(cat.category_name || '').flag : type === 'movie' ? '🎬' : '📺',
        channelCount: counts.get(id) || 0,
        subCategoryCount: 0,
        type,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'hu'));

  // Ami egyetlen kategóriába sem került (a szolgáltató néha nem sorolja be).
  const extra = counts.get(`${prefix}other`) || 0;
  if (extra > 0) {
    list.unshift({
      id: `${prefix}other`,
      name: 'Egyéb',
      flag: type === 'live' ? '📺' : type === 'movie' ? '🎬' : '📺',
      channelCount: extra,
      subCategoryCount: 0,
      type,
    });
  }
  return list;
}

/* --------------------------------------------------------------- Xtream */

export async function importXtreamProvider(
  input: { name: string; serverUrl: string; username: string; password: string },
  onProgress: ProgressFn = () => {},
  onPartial: PartialFn = () => {}
): Promise<ImportedProvider> {
  const startedAt = performance.now();
  const server = xtreamService.cleanUrl(input.serverUrl);
  const user = input.username.trim();
  const pass = input.password.trim();

  /**
   * A figyelmeztetések (hiányos kategóriák) a betöltés végén a felületre
   * kerülnek, hogy a hiány ne maradjon észrevétlen.
   */
  const warnings: string[] = [];

  onProgress({ phase: 'Bejelentkezés a szerverre…', percent: 4 });
  const auth = await providerRequest(
    () => xtreamService.authenticate(server, user, pass),
    'Bejelentkezés'
  );
  const info = auth.user_info;
  const expTimestamp = info?.exp_date ? parseInt(String(info.exp_date), 10) : 0;
  const expireDate = expTimestamp > 0
    ? new Date(expTimestamp * 1000).toLocaleString('hu-HU', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : 'Korlátlan';

  const provider: ProviderRef = {
    id: `prov-${Date.now()}`,
    type: 'xtream',
    serverUrl: server,
    username: user,
    password: pass,
  };

  /* ---- 1. szakasz: élő csatornák ---------------------------------- */

  /* ---------------------------------------------------------------
   * CSATORNABETÖLTÉS MÓD (Beállítások → Rendszer → Csatornabetöltés)
   *
   *  'api' : Xtream player_api.php?action=get_live_streams  (JSON)
   *          – kevesebb adatforgalom, azonnal kész kategóriák
   *  'm3u' : a szolgáltató M3U listája (get.php?type=m3u_plus)
   *          – akkor kell, ha az API nem adja vissza a csatornákat
   *            (egyes szolgáltatók csak a listát engedik), vagy ha a
   *            listában több csatorna van, mint az API-ban
   *
   * A beállítás a localStorage-ban él, ezért minden import és frissítés
   * ugyanazt a módot használja.
   * --------------------------------------------------------------- */
  const channelLoadMode: 'api' | 'm3u' =
    storageService.getSettings().channelLoadMode === 'm3u' ? 'm3u' : 'api';

  let liveChannels: Channel[] = [];
  let liveCategories: Category[] = [];
  let liveStreamCount = 0;

  if (channelLoadMode === 'm3u') {
    onProgress({
      phase: 'Csatornalista letöltése (M3U)…',
      detail: 'A szolgáltató M3U listája töltődik',
      percent: 10,
    });
    const playlistUrl = xtreamService.buildPlaylistUrl(server, user, pass);
    const playlistText = await providerRequest(
      () => xtreamService.loadM3U(playlistUrl),
      'M3U csatornalista'
    );
    const parsed = await xtreamService.parseM3U(
      playlistText,
      (percent) => onProgress({ phase: 'Csatornák feldolgozása…', percent: 12 + Math.round(percent * 0.26) }),
      playlistUrl
    );

    const rows: Array<Array<string | number>> = [];
    const counts = new Map<string, number>();
    const categoryNames = new Map<string, string>();
    const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'other';

    for (const channel of parsed.channels) {
      if (rows.length >= MAX_CHANNELS) break;
      const name = (channel.name || 'Csatorna').trim();
      const categoryName = (channel.categoryName || 'Egyéb csatornák').trim();
      const slug = slugify(categoryName);
      const catId = `lc-${slug}`;
      categoryNames.set(slug, categoryName);
      counts.set(catId, (counts.get(catId) || 0) + 1);
      const info = flagFor(categoryName || name);
      rows.push([
        channel.num ?? rows.length + 1,
        name,
        channel.logo || '',
        catId,
        categoryName,
        // Nem számszerű azonosító (teljes stream URL) esetén a contentStore
        // kész címként kezeli - ezért az M3U-ból kapott URL megy tovább.
        channel.streamUrl || '',
        info.flag,
        info.countryCode,
        '',
      ]);
    }

    liveStreamCount = rows.length;
    liveChannels = decodeChannelsForImport(rows, provider);
    rows.length = 0;

    const categorySource: XtreamCategory[] = [];
    categoryNames.forEach((categoryName, slug) => {
      categorySource.push({ category_id: slug, category_name: categoryName });
    });
    liveCategories = buildCategories(categorySource, 'lc-', 'live', counts);

    onProgress({
      phase: 'Csatornák kész (M3U)',
      detail: `${liveChannels.length.toLocaleString('hu-HU')} csatorna a listából`,
      percent: 40,
    });
  } else {
    onProgress({
      phase: 'Élő csatornák és kategóriák letöltése…',
      detail: 'A két alaplista párhuzamosan töltődik',
      percent: 12,
    });
    // A referencia is egyszerre kéri le a csatornákat és a kategóriákat.
    // Ezek egymástól független API-végpontok: a soros várakozás csak növelte
    // a hidegindítás idejét, miközben nem adott plusz biztonságot.
    const [liveCats, liveStreams] = await Promise.all([
      providerRequest(
        () => xtreamService.liveCategories(server, user, pass),
        'Élő kategóriák'
      ),
      providerRequest(
        () => xtreamService.liveStreams(server, user, pass),
        'Élő csatornalista'
      ),
    ]);
    const liveCategoryMap = makeCategoryMap(liveCats);
    const liveRows: Array<Array<string | number>> = [];
    const liveCounts = new Map<string, number>();
    liveStreamCount = liveStreams.length;
    const liveProcessTotal = Math.min(liveStreamCount, MAX_CHANNELS);
    let liveProcessed = 0;

    for (const stream of liveStreams) {
      if (liveRows.length >= MAX_CHANNELS) break;
      if (!stream || stream.stream_id === undefined || stream.stream_id === null) continue;
      const category = resolveCategory(liveCategoryMap, stream.category_id, 'lc-');
      const catId = category.id;
      const catName = category.name;
      liveCounts.set(catId, (liveCounts.get(catId) || 0) + 1);
      const name = (stream.name || 'Csatorna').trim();
      const info2 = flagFor(catName || name);
      liveRows.push([
        stream.num ?? liveRows.length + 1,
        name,
        // A logóbázis a bejelentkezéshez hasonló képzéssel készül: a séma
        // nélküli szervercímet is a playerApiBase() egészíti ki http://-vel,
        // a nyers cím (pl. `127.0.0.1:8080`) érvénytelen URL-bázis lenne.
        normalizeLogoUrl(stream.stream_icon, xtreamService.playerApiBase(server, '', '')),
        catId,
        catName,
        stream.stream_id,
        info2.flag,
        info2.countryCode,
        // A 9. elem az EPG azonosító (epg_channel_id): ebből tudja az EPG nézet,
        // melyik műsor melyik csatornához tartozik.
        stream.epg_channel_id || '',
      ]);
      liveProcessed++;
      if (liveProcessed % PROGRESS_UPDATE_EVERY === 0 || liveProcessed === liveProcessTotal) {
        onProgress({
          phase: 'Élő csatornák feldolgozása…',
          detail: liveProcessed + '/' + Math.max(liveProcessTotal, 1) + ' csatorna',
          percent: 18 + Math.round((liveProcessed / Math.max(liveProcessTotal, 1)) * 32),
        });
      }
      if (liveProcessed % UI_YIELD_EVERY === 0) await yieldToUi();
    }

    // A már feldolgozott nyers API-objektumokat engedjük el, mielőtt a teljes
    // megjelenítési lista létrejön: ez csökkenti a memória csúcsterhelését.
    liveStreams.length = 0;
    liveChannels = decodeChannelsForImport(liveRows, provider);
    liveRows.length = 0;
    liveCategories = buildCategories(liveCats, 'lc-', 'live', liveCounts);
  }
  const liveReadyMs = Math.round(performance.now() - startedAt);

  // Az élő lista AZONNAL a felületre kerül (nem várunk a filmekre).
  await onPartial({
    channels: liveChannels,
    liveCategories,
    totals: { live: liveStreamCount },
  });
  onProgress({
    phase: 'Élő csatornák kész',
    detail: `${liveChannels.length.toLocaleString('hu-HU')} csatorna • ${(liveReadyMs / 1000).toFixed(1)} s • most már nézhető`,
    percent: 40,
  });

  /* ---- 2. szakasz: filmek -----------------------------------------
   * Gyorsítás: először megpróbáljuk egyben lekérni az összes filmet (get_vod_streams
   * kategória nélkül). Ez 23 kérés helyett 1 kérés, ~9s nyereség a teszt alapján.
   * Ha nem sikerül vagy túl nagy/üres, visszaesünk a kategóriánkénti betöltésre.
   * A kategóriánkénti ág most 2 concurrent kérést enged (net.ts MAX_CONCURRENT=2),
   * és 500-as yield ritkítással dolgozik, így nem fagy le a telefon és nem terheli a routert.
   *
   * webOS TV gyors mód: csak élő TV először, VOD lusta betöltés később
   * A TV-n a gyors indulás a legfontosabb, a filmek/sorozatok csak akkor töltődnek
   * ha a felhasználó a Mozi/Sorozat menübe lép.
   */

  let movies: Movie[] = [];
  let vodCats: Category[] = [];
  let vodTotal = 0;

  /* webOS MEGJEGYZÉS: korábban itt egy "gyors mód" volt, ami a TV-n csak az
   * élő csatornákat töltötte be, a filmeket/sorozatokat pedig egy soha meg
   * nem valósult "lusta betöltésre" hagyta - ezért maradt ÜRES a Mozi és a
   * Sorozat a TV-n. A teljes betöltés fut mindenhol; az élő csatornák így is
   * elsőként, azonnal a felületre kerülnek (onPartial), a filmek/sorozatok a
   * háttérben töltődnek tovább. */
  try {
    onProgress({ phase: 'Film kategóriák letöltése…', percent: 45 });
    const vodCategories = await providerRequest(
      () => xtreamService.vodCategories(server, user, pass),
      'Film kategóriák'
    );
    const vodCategoryMap = makeCategoryMap(vodCategories);
    const decodedMovies: Movie[] = [];
    const vodCounts = new Map<string, number>();
    let vodProcessed = 0;
    let bulkUsed = false;

    // Próbáljuk meg egyben – ez a leggyorsabb út
    try {
      onProgress({ phase: 'Filmek letöltése egyben…', detail: 'Gyorsított mód (1 kérés)', percent: 48 });
      const allVod = await providerRequest(
        () => xtreamService.vodStreams(server, user, pass),
        'Filmek egyben'
      );
      if (Array.isArray(allVod) && allVod.length > 0 && allVod.length <= MAX_MOVIES * 1.2) {
        // Sikerült egyben, feldolgozzuk
        const rows: Array<Array<string | number>> = [];
        for (const movie of allVod) {
          if (decodedMovies.length + rows.length >= MAX_MOVIES) break;
          if (!movie || movie.stream_id === undefined || movie.stream_id === null) continue;
          const category = resolveCategory(vodCategoryMap, movie.category_id, 'vc-');
          const catId = category.id;
          const catName = category.name;
          vodCounts.set(catId, (vodCounts.get(catId) || 0) + 1);
          rows.push([
            movie.stream_id,
            (movie.name || 'Film').trim(),
            catId,
            catName,
            movie.stream_icon || '',
            Number(movie.rating ?? movie.rating_5based ?? 0) || 0,
            Number((String(movie.added || '').match(/\d{4}/) || [0])[0]) || 0,
            movie.container_extension || 'mp4',
            (movie.plot || '').replace(/\s+/g, ' ').slice(0, 200),
          ]);
          vodProcessed++;
          if (vodProcessed % PROGRESS_UPDATE_EVERY === 0) {
            onProgress({
              phase: 'Filmek feldolgozása…',
              detail: vodProcessed + ' film feldolgozva (gyors)',
              percent: 50 + Math.round((vodProcessed / Math.max(allVod.length, 1)) * 20),
            });
          }
          if (vodProcessed % UI_YIELD_EVERY === 0) await yieldToUi();
        }
        if (rows.length) {
          for (const movie of decodeMoviesForImport(rows, provider, 0)) decodedMovies.push(movie);
        }
        vodTotal = allVod.length;
        bulkUsed = true;
        onProgress({ phase: 'Filmek feldolgozva egyben', detail: `${decodedMovies.length} film`, percent: 70 });
      }
    } catch (bulkError) {
      console.warn('Filmek egyben nem sikerült, visszaesés kategóriákra:', bulkError);
      // Nem baj, megyünk tovább kategóriánként
    }

    if (!bulkUsed) {
      // Kategóriánkénti betöltés – most 2 concurrent, és incremental onPartial
      const vodResult = await loadCategoryFiltered(
        vodCategories,
        (categoryId) => xtreamService.vodStreams(server, user, pass, categoryId),
        {
          onProgress: (done, total) => {
            onProgress({
              phase: 'Filmek letöltése…',
              detail: done + '/' + total + ' film kategória',
              percent: 45 + Math.round((done / Math.max(total, 1)) * 20),
            });
          },
          shouldStop: (collected) => collected >= MAX_MOVIES,
          onItems: async (batch: XtreamVodStream[]) => {
            const rows: Array<Array<string | number>> = [];
            for (const movie of batch) {
              if (decodedMovies.length + rows.length >= MAX_MOVIES) break;
              if (!movie || movie.stream_id === undefined || movie.stream_id === null) continue;
              const category = resolveCategory(vodCategoryMap, movie.category_id, 'vc-');
              const catId = category.id;
              const catName = category.name;
              vodCounts.set(catId, (vodCounts.get(catId) || 0) + 1);
              rows.push([
                movie.stream_id,
                (movie.name || 'Film').trim(),
                catId,
                catName,
                movie.stream_icon || '',
                Number(movie.rating ?? movie.rating_5based ?? 0) || 0,
                Number((String(movie.added || '').match(/\d{4}/) || [0])[0]) || 0,
                movie.container_extension || 'mp4',
                (movie.plot || '').replace(/\s+/g, ' ').slice(0, 200),
              ]);
              vodProcessed++;
              if (vodProcessed % PROGRESS_UPDATE_EVERY === 0) {
                onProgress({
                  phase: 'Filmek feldolgozása…',
                  detail: vodProcessed + ' film feldolgozva',
                  percent: 65 + Math.round((vodProcessed / MAX_MOVIES) * 5),
                });
              }
              if (vodProcessed % UI_YIELD_EVERY === 0) await yieldToUi();
            }
            if (rows.length) {
              for (const movie of decodeMoviesForImport(rows, provider, decodedMovies.length)) {
                decodedMovies.push(movie);
              }
              rows.length = 0;
              // Incremental UI frissítés 2000 filmenként, hogy ne várjon a végéig
              if (decodedMovies.length % 2000 < 500) {
                const partialCats = buildCategories(vodCategories, 'vc-', 'movie', vodCounts);
                await onPartial({ movies: decodedMovies.slice(), vodCategories: partialCats, totals: { vod: vodProcessed } });
              }
            }
          },
        }
      );
      if (vodResult.aborted) warnings.push(describeAbort('filmek'));
      const vodWarning = vodResult.aborted
        ? null
        : describeFailures('film', vodResult.failedCategoryIds, vodCategories.length);
      if (vodWarning) warnings.push(vodWarning);
      if (vodResult.truncated) {
        warnings.push(
          'A filmek listája a beépített korlát miatt az első ' + MAX_MOVIES.toLocaleString('hu-HU') + ' elemet tartalmazza (a többi kategória letöltését kihagytuk a gyorsabb betöltés érdekében).'
        );
      }
      vodTotal = vodResult.collected;
    }

    onProgress({ phase: 'Filmek feldolgozása…', percent: 86 });
    movies = decodedMovies;
    vodCats = buildCategories(vodCategories, 'vc-', 'movie', vodCounts);

    await onPartial({ movies, vodCategories: vodCats, totals: { vod: vodTotal } });
  } catch (error) {
    console.warn('A filmek letöltése nem sikerült:', error);
    warnings.push(
      `A filmek listája nem töltődött le: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  /* ---- 3. szakasz: sorozatok --------------------------------------
   * Gyorsítás: először megpróbáljuk egyben lekérni az összes sorozatot.
   * Ha sikerül, 15-20 kérés helyett 1 kérés.
   */

  let series: Series[] = [];
  let seriesCats: Category[] = [];
  let seriesTotal = 0;
  try {
    onProgress({ phase: 'Sorozat kategóriák letöltése…', percent: 74 });
    const seriesCategories = await providerRequest(
      () => xtreamService.seriesCategories(server, user, pass),
      'Sorozat kategóriák'
    );
    const seriesCategoryMap = makeCategoryMap(seriesCategories);
    const decodedSeries: Series[] = [];
    const seriesCounts = new Map<string, number>();
    let seriesProcessed = 0;
    let bulkSeriesUsed = false;

    try {
      onProgress({ phase: 'Sorozatok letöltése egyben…', detail: 'Gyorsított mód (1 kérés)', percent: 76 });
      const allSeries = await providerRequest(
        () => xtreamService.seriesList(server, user, pass),
        'Sorozatok egyben'
      );
      if (Array.isArray(allSeries) && allSeries.length > 0 && allSeries.length <= MAX_SERIES * 1.2) {
        const rows: Array<Array<string | number>> = [];
        for (const item of allSeries) {
          if (decodedSeries.length + rows.length >= MAX_SERIES) break;
          if (!item || item.series_id === undefined || item.series_id === null) continue;
          const category = resolveCategory(seriesCategoryMap, item.category_id, 'sc-');
          const catId = category.id;
          const catName = category.name;
          seriesCounts.set(catId, (seriesCounts.get(catId) || 0) + 1);
          rows.push([
            item.series_id,
            (item.name || 'Sorozat').trim(),
            catId,
            catName,
            item.cover || '',
            Number(item.rating ?? item.rating_5based ?? 0) || 0,
            Number((String(item.releaseDate || '').match(/\d{4}/) || [0])[0]) || 0,
          ]);
          seriesProcessed++;
          if (seriesProcessed % PROGRESS_UPDATE_EVERY === 0) {
            onProgress({
              phase: 'Sorozatok feldolgozása…',
              detail: seriesProcessed + ' sorozat feldolgozva (gyors)',
              percent: 78 + Math.round((seriesProcessed / Math.max(allSeries.length, 1)) * 12),
            });
          }
          if (seriesProcessed % UI_YIELD_EVERY === 0) await yieldToUi();
        }
        if (rows.length) {
          for (const item of decodeSeriesForImport(rows, provider, 0)) decodedSeries.push(item);
        }
        seriesTotal = allSeries.length;
        bulkSeriesUsed = true;
        onProgress({ phase: 'Sorozatok feldolgozva egyben', detail: `${decodedSeries.length} sorozat`, percent: 90 });
      }
    } catch (bulkError) {
      console.warn('Sorozatok egyben nem sikerült, visszaesés kategóriákra:', bulkError);
    }

    if (!bulkSeriesUsed) {
      const seriesResult = await loadCategoryFiltered(
        seriesCategories,
        (categoryId) => xtreamService.seriesList(server, user, pass, categoryId),
        {
          onProgress: (done, total) => {
            onProgress({
              phase: 'Sorozatok letöltése…',
              detail: done + '/' + total + ' sorozat kategória',
              percent: 74 + Math.round((done / Math.max(total, 1)) * 18),
            });
          },
          shouldStop: (collected) => collected >= MAX_SERIES,
          onItems: async (batch: XtreamSeriesItem[]) => {
            const rows: Array<Array<string | number>> = [];
            for (const item of batch) {
              if (decodedSeries.length + rows.length >= MAX_SERIES) break;
              if (!item || item.series_id === undefined || item.series_id === null) continue;
              const category = resolveCategory(seriesCategoryMap, item.category_id, 'sc-');
              const catId = category.id;
              const catName = category.name;
              seriesCounts.set(catId, (seriesCounts.get(catId) || 0) + 1);
              rows.push([
                item.series_id,
                (item.name || 'Sorozat').trim(),
                catId,
                catName,
                item.cover || '',
                Number(item.rating ?? item.rating_5based ?? 0) || 0,
                Number((String(item.releaseDate || '').match(/\d{4}/) || [0])[0]) || 0,
              ]);
              seriesProcessed++;
              if (seriesProcessed % PROGRESS_UPDATE_EVERY === 0) {
                onProgress({
                  phase: 'Sorozatok feldolgozása…',
                  detail: seriesProcessed + ' sorozat feldolgozva',
                  percent: 90 + Math.round((seriesProcessed / MAX_SERIES) * 4),
                });
              }
              if (seriesProcessed % UI_YIELD_EVERY === 0) await yieldToUi();
            }
            if (rows.length) {
              for (const item of decodeSeriesForImport(rows, provider, decodedSeries.length)) {
                decodedSeries.push(item);
              }
              rows.length = 0;
              if (decodedSeries.length % 2000 < 500) {
                const partialCats = buildCategories(seriesCategories, 'sc-', 'series', seriesCounts);
                await onPartial({ series: decodedSeries.slice(), seriesCategories: partialCats, totals: { series: seriesProcessed } });
              }
            }
          },
        }
      );
      if (seriesResult.aborted) warnings.push(describeAbort('sorozatok'));
      const seriesWarning = seriesResult.aborted
        ? null
        : describeFailures('sorozat', seriesResult.failedCategoryIds, seriesCategories.length);
      if (seriesWarning) warnings.push(seriesWarning);
      if (seriesResult.truncated) {
        warnings.push(
          'A sorozatok listája a beépített korlát miatt az első ' + MAX_SERIES.toLocaleString('hu-HU') + ' elemet tartalmazza.'
        );
      }
      seriesTotal = seriesResult.collected;
    }

    onProgress({ phase: 'Sorozatok feldolgozása…', percent: 96 });
    series = decodedSeries;
    seriesCats = buildCategories(seriesCategories, 'sc-', 'series', seriesCounts);

    await onPartial({ series, seriesCategories: seriesCats, totals: { series: seriesTotal } });
  } catch (error) {
    console.warn('A sorozatok letöltése nem sikerült:', error);
    warnings.push(
      `A sorozatok listája nem töltődött le: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const content: ImportedContent = {
    provider,
    savedAt: new Date().toISOString(),
    channels: liveChannels,
    movies,
    series,
    liveCategories,
    vodCategories: vodCats,
    seriesCategories: seriesCats,
    totals: { live: liveStreamCount, vod: vodTotal, series: seriesTotal },
    warnings,
  };

  const totalMs = Math.round(performance.now() - startedAt);
  onProgress({
    phase: warnings.length ? 'Részben kész' : 'Kész',
    detail:
      `${content.channels.length.toLocaleString('hu-HU')} csatorna • ` +
      `${content.movies.length.toLocaleString('hu-HU')} film • ` +
      `${content.series.length.toLocaleString('hu-HU')} sorozat • ` +
      `⏱ ${(totalMs / 1000).toFixed(1)} s` +
      (warnings.length ? ` • FIGYELEM: ${warnings.join(' ')}` : ''),
    percent: 100,
  });

  return {
    content,
    user: {
      expireDate,
      maxConnections: parseInt(String(info?.max_connections || '1'), 10) || 1,
      status: String(info?.status || 'Active'),
    },
  };
}

/* ----------------------------------------------------------------- M3U */

const MOVIE_GROUP = /(vod|film|mozi|movie|pelicula|kino)/i;

/**
 * M3U / M3U8 lista betöltése.
 *
 * Három forrásból jöhet:
 *   - m3uUrl:  letöltjük a linkről (a szolgáltató M3U/M3U8 címe),
 *   - m3uText: a felhasználó beillesztett fájlból vagy teljes listaként adta meg.
 *
 * A nyers lista szövegét eltároljuk (ha belefér), hogy később a „Frissítés”
 * gomb ugyanezt a listát újra fel tudja dolgozni.
 */
export async function importM3UProvider(
  input: { name: string; m3uUrl?: string; m3uText?: string; providerId?: string },
  onProgress: ProgressFn = () => {},
  onPartial: PartialFn = () => {}
): Promise<ImportedContent> {
  const startedAt = performance.now();
  let text = (input.m3uText || '').trim();

  if (!text) {
    if (!input.m3uUrl) throw new Error('Nincs M3U link vagy lista szöveg.');
    onProgress({ phase: 'M3U lista letöltése…', percent: 5 });
    text = await xtreamService.loadM3U(input.m3uUrl.trim());
  }

  if (!/#EXTM3U|#EXTINF/i.test(text)) {
    throw new Error(
      'A megadott tartalom nem M3U/M3U8 lejátszási lista (nem található benne #EXTM3U vagy #EXTINF sor).'
    );
  }

  onProgress({ phase: 'M3U lista feldolgozása…', percent: 15 });
  const { channels } = await xtreamService.parseM3U(text, (percent) => {
    onProgress({
      phase: 'M3U lista feldolgozása…',
      detail: 'A lista feldolgozása folyamatban van',
      percent: 15 + Math.round(percent * 0.65),
    });
  }, input.m3uUrl?.trim());
  if (channels.length === 0) {
    throw new Error('A lista nem tartalmazott egyetlen csatornát sem. Ellenőrizd az M3U linket.');
  }

  const provider: ProviderRef = { id: input.providerId || `prov-${Date.now()}`, type: 'm3u' };

  const live: Channel[] = [];
  const movies: Movie[] = [];
  const liveCounts = new Map<string, number>();
  const movieCounts = new Map<string, number>();

  let movieIndex = 0;
  for (const channel of channels) {
    const isMovie = MOVIE_GROUP.test(channel.categoryName || '');
    const counts = isMovie ? movieCounts : liveCounts;
    counts.set(channel.categoryId, (counts.get(channel.categoryId) || 0) + 1);

    if (isMovie) {
      movies.push({
        id: `vod-${provider.id}-${movieIndex++}`,
        title: channel.name,
        categoryId: channel.categoryId,
        categoryName: channel.categoryName,
        poster: channel.logo || '',
        rating: 0,
        year: 0,
        durationMinutes: 0,
        plot: '',
        genres: [],
        streamUrl: channel.streamUrl,
        containerExtension: 'mp4',
        isFavorite: false,
      });
    } else {
      live.push(channel);
    }
  }

  const categoryNames = new Map<string, string>();
  for (const channel of channels) {
    if (channel.categoryId && channel.categoryName && !categoryNames.has(channel.categoryId)) {
      categoryNames.set(channel.categoryId, channel.categoryName);
    }
  }

  const liveCats: Category[] = Array.from(liveCounts.entries()).map(([id, count]) => ({
    id,
    name: categoryNames.get(id) || 'Egyéb',
    flag: flagFor(categoryNames.get(id) || '').flag,
    channelCount: count,
    subCategoryCount: 0,
    type: 'live' as const,
  }));

  const vodCats: Category[] = Array.from(movieCounts.entries()).map(([id, count]) => ({
    id,
    name: categoryNames.get(id) || 'Filmek',
    flag: '🎬',
    channelCount: count,
    subCategoryCount: 0,
    type: 'movie' as const,
  }));

  const m3uWarnings: string[] = [];
  if (live.length === 0) {
    m3uWarnings.push('A listában nem volt egyetlen élő csatorna sem (minden elem filmként került be).');
  }
  if (movies.length === 0) {
    m3uWarnings.push('A listában nem volt film (a "Filmek"/"VOD" csoport egyik eleménél sem volt találat).');
  }

  // A nyers lista eltárolása (legfeljebb 4 MB), hogy a későbbi frissítés működjön.
  if (text.length <= 4 * 1024 * 1024) {
    const stored = saveRawPlaylist(provider.id, text);
    if (!stored) {
      m3uWarnings.push(
        'A lista szövegét nem sikerült eltárolni, ezért a „Frissítés” gomb később nem tudja újra feldolgozni – ilyenkor importáld újra a fájlt.'
      );
    }
  } else {
    m3uWarnings.push('A lista nagyon nagy, ezért a szövegét nem tároltuk el; a frissítéshez importáld újra.');
  }

  const content: ImportedContent = {
    provider,
    savedAt: new Date().toISOString(),
    channels: live,
    movies: movies.slice(0, MAX_MOVIES),
    series: [],
    liveCategories: liveCats,
    vodCategories: vodCats,
    seriesCategories: [],
    totals: { live: live.length, vod: movies.length, series: 0 },
    warnings: m3uWarnings,
  };

  await onPartial({ channels: live, liveCategories: liveCats, totals: { live: live.length } });
  await onPartial({ movies: content.movies, vodCategories: vodCats, totals: { vod: movies.length } });

  const totalMs = Math.round(performance.now() - startedAt);
  onProgress({
    phase: m3uWarnings.length ? 'Részben kész' : 'Kész',
    detail:
      `${live.length.toLocaleString('hu-HU')} csatorna • ${movies.length.toLocaleString('hu-HU')} film • ` +
      `⏱ ${(totalMs / 1000).toFixed(1)} s` +
      (m3uWarnings.length ? ` • FIGYELEM: ${m3uWarnings.join(' ')}` : ''),
    percent: 100,
  });
  return content;
}

/** Újratöltés a mentett szolgáltatói adatokból. */
export async function refreshProviderContent(
  provider: ProviderAccount,
  onProgress: ProgressFn = () => {},
  onPartial: PartialFn = () => {}
): Promise<ImportedProvider | ImportedContent> {
  if (provider.type === 'xtream') {
    if (!provider.serverUrl || !provider.username || !provider.password) {
      throw new Error('A szolgáltatóhoz nincs eltárolva szerver, felhasználó vagy jelszó.');
    }
    const result = await importXtreamProvider(
      {
        name: provider.name,
        serverUrl: provider.serverUrl,
        username: provider.username,
        password: provider.password,
      },
      onProgress,
      onPartial
    );
    result.content.provider.id = provider.id;
    return result;
  }

  // M3U: linkről, vagy a korábban eltárolt lista szövegéből.
  if (provider.m3uUrl) {
    const content = await importM3UProvider(
      { name: provider.name, m3uUrl: provider.m3uUrl, providerId: provider.id },
      onProgress,
      onPartial
    );
    content.provider.id = provider.id;
    return content;
  }

  const stored = loadRawPlaylist(provider.id);
  if (!stored) {
    throw new Error(
      'Ehhez a listához nincs eltárolva M3U link vagy lista szöveg. Importáld újra a fájlt/listát.'
    );
  }
  const content = await importM3UProvider(
    { name: provider.name, m3uText: stored, providerId: provider.id },
    onProgress,
    onPartial
  );
  content.provider.id = provider.id;
  return content;
}
