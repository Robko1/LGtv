import { normalizeLogoUrl } from './logoUrl';
import { logMemory, logPhase } from './appLog';
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
import { parseSeriesMetadata, parseVodMetadata, UNKNOWN_LANGUAGE } from './vodMetadata';
import { storageService } from './storageService';
import { isNetworkRequestCancelled } from './net';

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
  /**
   * Előnézet: a lista MÉG NEM teljes, csak hogy a néző már választhasson
   * csatornát. Ilyenkor a felület NEM menti a tárolóba (nincs félkész
   * mentés, nincs adatvesztés), csak megjeleníti.
   */
  preview?: boolean;
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
/**
 * Hosszú feldolgozás közben időnként visszaadjuk a vezérlést a böngészőnek.
 *
 * KORÁBBAN 500 elemenként adtuk vissza, és a visszaadás `requestIdleCallback`
 * volt 50 ms-os felső korláttal. A TV-n a böngésző szinte soha nem volt
 * „üresjáratban” (folyamatos a videó és az óra), ezért a callback rendszerint
 * a TELJES 50 ms-ot kivárta: 20 000 csatornánál 40 × 50 ms = 2 másodperc,
 * 60 000-nél 6 másodperc ment el pusztán várakozással – a feldolgozás
 * mellett. Most 3000 elemenként egyszer adunk át egy valódi, azonnali
 * macrotaszkot (MessageChannel), ami a festésnek is elég, de nem vár.
 */
const UI_YIELD_EVERY = 3000;

/**
 * Ennyi csatorna feldolgozása után jelenik meg az első használható adag.
 * 1500 csatorna már bőven elég a nézéshez, és a feldolgozása gyors.
 */
const FIRST_BATCH_CHANNELS = 1500;

/**
 * Azonnali „lélegzés” a főszálnak.
 *
 * A MessageChannel macrotaszkja a lehető leghamarabb (következő eseményhurok)
 * fut le, és közben a böngészőnek módja van kirajzolni – ellentétben a
 * requestIdleCallback-kel, ami a TV-n 50 ms-ot várt minden egyes adagnál.
 * Régi webOS motoron (Chrome 38) a MessageChannel létezik; ha mégsem,
 * a setTimeout(0) a tartalék.
 */
const yieldPorts: { send: MessagePort; receive: MessagePort } | null = (() => {
  try {
    if (typeof MessageChannel === 'function') {
      const channel = new MessageChannel();
      return { send: channel.port1, receive: channel.port2 };
    }
  } catch {
    /* régi motor: MessageChannel nélkül */
  }
  return null;
})();
let pendingYields: Array<() => void> = [];
if (yieldPorts) {
  yieldPorts.receive.onmessage = () => {
    const queue = pendingYields;
    pendingYields = [];
    for (const resolve of queue) resolve();
  };
  // Node (tesztek): az onmessage hozzárendelése életben tartaná a folyamatot.
  (yieldPorts.receive as MessagePort & { unref?: () => void }).unref?.();
  (yieldPorts.send as MessagePort & { unref?: () => void }).unref?.();
}

function yieldToUi(): Promise<void> {
  return new Promise<void>((resolve) => {
    const ports = yieldPorts;
    if (!ports) {
      setTimeout(resolve, 0);
      return;
    }
    pendingYields.push(resolve);
    // postMessage: az eseményhurok következő körében fut le, a festés előtt –
    // a requestIdleCallback-kel ellentétben NEM vár 50 ms-ot.
    ports.send.postMessage(0);
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

/** A diagnosztikai naplóban csak a szolgáltató hostja jelenhet meg. */
function diagnosticServerLabel(serverUrl: string): string {
  try {
    return new URL(xtreamService.baseUrl(serverUrl)).host || 'ismeretlen szolgáltató';
  } catch {
    return 'ismeretlen szolgáltató';
  }
}

/**
 * A panel által visszaadott hiba szövege is lehet URL vagy query-részlet.
 * A figyelmeztetés és a kézi napló ugyanazt a rövid, credential-mentes okot
 * kapja, így a szolgáltatói hiba diagnosztizálható, de belépési adat nem kerül
 * a felületre vagy a megosztott naplóba.
 */
function safeErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/([?&](?:username|user|password|pass|token|api_key|apikey|key|auth|secret|access_token|signature)=)[^&\s]*/gi, '$1[redacted]')
    .replace(/\/(live|movie|series|subtitle)\/[^\/\s]+\/[^\/\s]+/gi, '/$1/[redacted]/[redacted]')
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const parsed = new URL(raw.replace(/[),.;!?]+$/, ''));
        return `${parsed.protocol}//${parsed.host}/…`;
      } catch {
        return 'http(s)://[redacted]';
      }
    })
    .replace(/\s+/g, ' ')
    .slice(0, 240);
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
      if (isNetworkRequestCancelled(error)) throw error;
      lastError = error;
      if (!isRetryable(error) || attempt === RETRY_MAX_ATTEMPTS) break;
      // 0,8-1,2 s: a panel közben kiüríti a kapcsolatait.
      await sleep(RETRY_BASE_DELAY_MS + Math.floor(Math.random() * 400));
    }
  }
  if (isNetworkRequestCancelled(lastError)) throw lastError;
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
      let cancelled = false;
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
        if (isNetworkRequestCancelled(error)) {
          cancelled = true;
          throw error;
        }
        failedCategoryIds.push(String(category.category_id));
        consecutiveFailures++;
        console.warn('Kategória betöltése sikertelen:', category.category_id, error);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          aborted = true;
          break;
        }
      } finally {
        if (!cancelled) {
          done++;
          options.onProgress?.(done, usable.length);
        }
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

const MAX_DETAILED_VOD = 20;

/**
 * Csak a részletes VOD-adag kap API-info kérést. A lista-végpontokból kapott
 * több tízezer elemhez nem indítunk egyenkénti get_*_info kört.
 */
function applyMovieMetadata(movie: Movie, metadata: ReturnType<typeof parseVodMetadata>): Movie {
  return {
    ...movie,
    durationMinutes: metadata.durationMinutes || 0,
    poster: metadata.poster || movie.poster,
    backdrop: metadata.backdrop || movie.backdrop,
    plot: metadata.plot || movie.plot,
    genres: metadata.genres?.length ? metadata.genres : movie.genres,
    director: metadata.director || movie.director,
    cast: metadata.cast?.length ? metadata.cast : movie.cast,
    rating: metadata.rating || movie.rating,
    year: metadata.year || movie.year,
    audioTracks: metadata.audioTracks,
    subtitleTracks: metadata.subtitleTracks,
    audioLanguages: metadata.audioLanguages?.length ? metadata.audioLanguages : [UNKNOWN_LANGUAGE],
    subtitleLanguages: metadata.subtitleLanguages?.length ? metadata.subtitleLanguages : [UNKNOWN_LANGUAGE],
  };
}

function applySeriesMetadata(series: Series, metadata: ReturnType<typeof parseSeriesMetadata>): Series {
  return {
    ...series,
    durationMinutes: metadata.durationMinutes || 0,
    poster: metadata.poster || series.poster,
    backdrop: metadata.backdrop || series.backdrop,
    plot: metadata.plot || series.plot,
    genres: metadata.genres?.length ? metadata.genres : series.genres,
    director: metadata.director || series.director,
    cast: metadata.cast?.length ? metadata.cast : series.cast,
    rating: metadata.rating || series.rating,
    year: metadata.year || series.year,
    audioTracks: metadata.audioTracks,
    subtitleTracks: metadata.subtitleTracks,
    audioLanguages: metadata.audioLanguages?.length ? metadata.audioLanguages : [UNKNOWN_LANGUAGE],
    subtitleLanguages: metadata.subtitleLanguages?.length ? metadata.subtitleLanguages : [UNKNOWN_LANGUAGE],
  };
}

/**
 * A részletezés globális kerete az első 20 VOD-elemre vonatkozik (film +
 * sorozat együtt). Így egy nagy szolgáltatói listán sem lesz több száz vagy
 * több ezer rejtett API-kérés, és a két VOD-típus ugyanazt a korlátot használja.
 */
async function enrichFirstVodMetadata(
  movies: Movie[],
  series: Series[],
  server: string,
  user: string,
  pass: string
): Promise<{ movies: Movie[]; series: Series[]; requested: number; failed: number }> {
  const targets: Array<{ kind: 'movie' | 'series'; index: number; id: number | string }> = [];
  for (const [index, movie] of movies.slice(0, MAX_DETAILED_VOD).entries()) {
    if (movie.streamId !== undefined && movie.streamId !== null) targets.push({ kind: 'movie', index, id: movie.streamId });
  }
  for (const [index, item] of series.slice(0, MAX_DETAILED_VOD).entries()) {
    if (item.seriesId !== undefined && item.seriesId !== null) targets.push({ kind: 'series', index, id: item.seriesId });
  }
  const limitedTargets = targets.slice(0, MAX_DETAILED_VOD);
  const enrichedMovies = movies.slice();
  const enrichedSeries = series.slice();
  let cursor = 0;
  let requested = 0;
  let failed = 0;

  async function worker(): Promise<void> {
    while (true) {
      const target = limitedTargets[cursor++];
      if (!target) return;
      requested++;
      try {
        if (target.kind === 'movie') {
          const detail = await xtreamService.vodInfo(server, user, pass, target.id);
          enrichedMovies[target.index] = applyMovieMetadata(enrichedMovies[target.index], parseVodMetadata(detail));
        } else {
          const detail = await xtreamService.seriesInfo(server, user, pass, target.id);
          enrichedSeries[target.index] = applySeriesMetadata(enrichedSeries[target.index], parseSeriesMetadata(detail));
        }
      } catch {
        failed++;
        // A részletes végpont hibája nem teheti használhatatlanná a teljes listát.
        // Az apply* fallbackjei a hiányzó értékeket 0/Ismeretlenre normalizálják.
        if (target.kind === 'movie') {
          enrichedMovies[target.index] = applyMovieMetadata(enrichedMovies[target.index], parseVodMetadata({}));
        } else {
          enrichedSeries[target.index] = applySeriesMetadata(enrichedSeries[target.index], parseSeriesMetadata({}));
        }
      }
    }
  }

  // A net.ts saját kétkapcsolatos sora mellett ez a két worker sem nyit új
  // kapcsolatot; csak a részletek feldolgozásának sorrendjét korlátozza.
  await Promise.all([worker(), worker()]);
  return { movies: enrichedMovies, series: enrichedSeries, requested, failed };
}

/* --------------------------------------------------------------- Xtream */

export async function importXtreamProvider(
  input: { name: string; serverUrl: string; username: string; password: string },
  onProgress: ProgressFn = () => {},
  onPartial: PartialFn = () => {}
): Promise<ImportedProvider> {
  const startedAt = performance.now();
  // A mentett provider-cím csak a szolgáltató gyökere lehet: az API-fájl,
  // query és esetleges URL-be ágyazott credential ne maradjon benne. A
  // séma nélküli régi beállításokat séma nélkül őrizzük meg; a request-builder
  // minden használatkor http://-t tesz elé.
  const server = xtreamService.cleanUrl(input.serverUrl);
  const user = input.username.trim();
  const pass = input.password.trim();
  // Diagnosztika: az ELSŐ indítás legnehezebb lépése az import – minden
  // szakasz elejét/végét naplózzuk, hogy egy fagyás után látszódjon, hol állt meg.
  logPhase(`Xtream import indul; szerver-host=${diagnosticServerLabel(server)}`);
  logMemory('import előtt');

  /**
   * A figyelmeztetések (hiányos kategóriák) a betöltés végén a felületre
   * kerülnek, hogy a hiány ne maradjon észrevétlen.
   */
  const warnings: string[] = [];

  /*
   * A BEJELENTKEZÉS NEM BLOKKOLJA A CSATORNÁK BETÖLTÉSÉT.
   *
   * A panel csatorna-végpontja (player_api.php?action=get_live_streams)
   * csak a felhasználónevet és a jelszót kéri, ugyanúgy, mint a
   * hitelesítő végpont. Ezért az első kérés maga lehet a csatornakérés:
   * a bejelentkezés-probe feleslegesen egy teljes hálózati kört töltött
   * (a lassú kódú paneleken ez másodpercek).
   *
   * A REFERENCIA MŰKÖDÉSI LOGIKÁJA: a bejelentkezés-probe csak akkor
   * fut, ha a csatornák üresek voltak – és akkor megmondja, hogy "rossz
   * a jelszó" vagy "nem érhető el a szerver": a kettő nem ugyanaz a
   * hiba, és a néző másképp érti őket.
   *
   * Itt a probe a háttérben, PÁRHUZAMOSAN fut a csatornákkal: a
   * fiókadatok (lejárathoz, kapcsolatszámhoz) csak a végén kellnek, és
   * addigra jóval hamarabb megjönnek, mint egy külön körút.
   */
  const authPromise = providerRequest(
    () => xtreamService.authenticate(server, user, pass),
    'Bejelentkezés'
  ).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );

  /*
   * A hitelesítési probe csak a fiókkártya lejárat-/kapcsolatadataihoz kell.
   * Nem szakíthatja meg a tartalomkéréseket: egyes Xtream-panelek a listákat
   * kiszolgálják, miközben a bejelentkezési végpontjuk lassú vagy letiltott.
   * A korábbi globális `cancelNetworkRequests()` itt a már betöltött élő
   * csatornákat is használhatatlanná tette, amikor csak a film/sorozat ág
   * hibázott. A tartalomimport külön kezeli a saját, tényleges hibáit; az
   * auth-hiba legfeljebb az opcionális fiókadatokat hagyja üresen.
   */

  onProgress({ phase: 'Csatornák letöltése…', percent: 6 });

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
    /*
     * A KÉT ALAPLISTA PÁRHUZAMOSAN, de a csatornák NEM VÁRNAK a kategóriákra.
     *
     * A csatornavégpont a nagy válasz (20 000 csatorna), a kategóriavégpont
     * kicsi. Korábban a Promise.all a LASSABBAT várta meg mindkettőnél, és a
     * csatornák feldolgozása csak utána indulhatott. Most a kategóriák külön
     * ígéretként futnak; a kategórianeveket csak a sorok összeállításakor
     * használjuk, addigra rendszerint megjönnek. Ha nem, a csatorna
     * kategórianeve a stream saját category_id-jából képződik – nem lesz
     * hiányos lista.
     */
    const liveCatsPromise = providerRequest(
      () => xtreamService.liveCategories(server, user, pass),
      'Élő kategóriák'
    ).catch((error) => {
      if (isNetworkRequestCancelled(error)) throw error;
      return [] as XtreamCategory[];
    });
    const liveStreams = await Promise.all([
      providerRequest(
        () => xtreamService.liveStreams(server, user, pass),
        'Élő csatornalista'
      ),
      liveCatsPromise.then(() => null),
    ]).then(([streams]) => streams).catch(async (error: unknown) => {
      // Nem jött a csatornalista: ha a bejelentkezés is elbukott, annak
      // a hibája sokkal érthetőbb ("rossz a jelszó" / "a szerver nem
      // érhető el"), mint a csatornakérésé. Ez a referencia viselkedése.
      const probe = await authPromise;
      if (!probe.ok) throw probe.error;
      throw error;
    });
    const liveCats = await liveCatsPromise;
    const liveCategoryMap = makeCategoryMap(liveCats);
    const liveRows: Array<Array<string | number>> = [];
    const liveCounts = new Map<string, number>();
    const seenLiveStreamIds = new Set<string>();
    const liveStreamTotal = liveStreams.length;
    liveStreamCount = liveStreamTotal;
    const liveProcessTotal = Math.min(liveStreamTotal, MAX_CHANNELS);
    let liveProcessed = 0;

    for (const stream of liveStreams) {
      if (liveRows.length >= MAX_CHANNELS) break;
      if (!stream || stream.stream_id === undefined || stream.stream_id === null) continue;
      const liveStreamId = String(stream.stream_id);
      if (seenLiveStreamIds.has(liveStreamId)) continue;
      seenLiveStreamIds.add(liveStreamId);
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

      /*
       * ELSŐ HASZNÁLHATÓ ADAG.
       *
       * A csatornalista feldolgozása 20 000 csatornánál másodpercekig tart,
       * és eddig a néző csak a folyamatjelzőt látta. Most az első 1500
       * csatorna feldolgozása után AZONNAL megjelenik egy előnézet: a TV
       * már nézhető, miközben a többi csatorna, majd a filmek és sorozatok
       * a háttérben tovább töltődnek. Az előnézetet a felület nem menti
       * (preview: true), és a végleges, teljes lista felülírja – nem
       * maradhat hiányos lista.
       */
      if (liveProcessed === FIRST_BATCH_CHANNELS) {
        await onPartial({
          preview: true,
          channels: decodeChannelsForImport(liveRows.slice(), provider),
          liveCategories: buildCategories(liveCats, 'lc-', 'live', liveCounts),
          totals: { live: liveRows.length },
        });
      }

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
    liveStreamCount = liveChannels.length;
    liveRows.length = 0;
    liveCategories = buildCategories(liveCats, 'lc-', 'live', liveCounts);
  }
  const liveReadyMs = Math.round(performance.now() - startedAt);

  // Az élő lista AZONNAL a felületre kerül (nem várunk a filmekre).
  await onPartial({
    channels: liveChannels,
    liveCategories,
    totals: { live: liveStreamCount },
    preview: true,
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

  /* webOS MEGJEGYZÉS: korábban itt egy "gyors mód" volt, ami a TV-n csak az
   * élő csatornákat töltötte be, a filmeket/sorozatokat pedig egy soha meg
   * nem valósult "lusta betöltésre" hagyta - ezért maradt ÜRES a Mozi és a
   * Sorozat a TV-n. A teljes betöltés fut mindenhol; az élő csatornák így is
   * elsőként, azonnal a felületre kerülnek (onPartial), a filmek/sorozatok a
   * háttérben töltődnek tovább. */
  const loadMoviesPhase = async (): Promise<void> => {
  try {
    onProgress({ phase: 'Film kategóriák letöltése…', percent: 45 });
    let vodCategories: XtreamCategory[] = [];
    try {
      vodCategories = await providerRequest(
        () => xtreamService.vodCategories(server, user, pass),
        'Film kategóriák'
      );
    } catch (categoryError) {
      if (isNetworkRequestCancelled(categoryError)) throw categoryError;
      // A kategória-végpont több panelen hibás vagy tiltott, miközben a
      // kategória nélküli get_vod_streams működik. Ez nem ok az élő lista
      // vagy a teljes VOD-szakasz eldobására: a bulk választ még megpróbáljuk,
      // az ismeretlen kategóriájú elemek „Egyéb” alá kerülnek.
      const detail = safeErrorDetail(categoryError);
      warnings.push(`A film kategórialistája nem tölthető le (${detail}); a filmek bulk-végpontja és az „Egyéb” kategória következik.`);
      logPhase(`Film kategóriák hiba; ok=${detail}`);
    }
    const vodCategoryMap = makeCategoryMap(vodCategories);
    const decodedMovies: Movie[] = [];
    const vodCounts = new Map<string, number>();
    const seenMovieIds = new Set<string>();
    let vodProcessed = 0;
    let bulkUsed = false;
    let bulkFallbackReason = '';

    // Próbáljuk meg egyben – ez a leggyorsabb út. Ha a panel ezt a végpontot
    // nem támogatja, a kategóriánkénti ág ugyanebben a menetben következik.
    try {
      onProgress({ phase: 'Filmek letöltése egyben…', detail: 'Gyorsított mód (1 kérés)', percent: 48 });
      const allVod = await providerRequest(
        () => xtreamService.vodStreams(server, user, pass),
        'Filmek egyben'
      );
      if (Array.isArray(allVod) && allVod.length > 0 && allVod.length <= MAX_MOVIES * 1.2) {
        const rows: Array<Array<string | number>> = [];
        for (const movie of allVod) {
          if (decodedMovies.length + rows.length >= MAX_MOVIES) break;
          if (!movie || movie.stream_id === undefined || movie.stream_id === null) continue;
          const movieStreamId = String(movie.stream_id);
          if (seenMovieIds.has(movieStreamId)) continue;
          seenMovieIds.add(movieStreamId);
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
        // Csak a valóban dekódolt, használható filmek számítanak sikeres importnak.
        bulkUsed = decodedMovies.length > 0;
        if (bulkUsed) {
          onProgress({ phase: 'Filmek feldolgozva egyben', detail: `${decodedMovies.length} film`, percent: 70 });
        } else {
          bulkFallbackReason = 'a bulk-válaszban nem volt használható film';
          vodCounts.clear();
          seenMovieIds.clear();
          vodProcessed = 0;
        }
      } else if (Array.isArray(allVod) && allVod.length === 0) {
        bulkFallbackReason = 'a bulk-végpont üres választ adott';
      } else {
        bulkFallbackReason = `a bulk-válasz túllépte a ${MAX_MOVIES.toLocaleString('hu-HU')} elemes korlátot`;
      }
    } catch (bulkError) {
      const detail = safeErrorDetail(bulkError);
      bulkFallbackReason = detail;
      console.warn('Filmek egyben nem sikerült, visszaesés kategóriákra:', bulkError);
      // Ha a bulk feldolgozás közben történt hiba, a kategória-fallback ne
      // dolgozza fel újra a már részben látott elemeket.
      decodedMovies.length = 0;
      vodCounts.clear();
      seenMovieIds.clear();
      vodProcessed = 0;
    }

    if (!bulkUsed && bulkFallbackReason) {
      warnings.push(`A filmek bulk-letöltése nem használható (${bulkFallbackReason}); kategória-fallback indul.`);
      logPhase(`Filmek bulk hiba; ok=${bulkFallbackReason}`);
    }

    if (!bulkUsed) {
      if (vodCategories.length === 0) {
        warnings.push('A filmek kategória-fallbackje nem indítható, mert a szolgáltató nem adott használható kategórialistát; tényleges film-darabszám=0.');
      }
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
              const movieStreamId = String(movie.stream_id);
              if (seenMovieIds.has(movieStreamId)) continue;
              seenMovieIds.add(movieStreamId);
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
                await onPartial({ preview: true, movies: decodedMovies.slice(), vodCategories: partialCats, totals: { vod: decodedMovies.length } });
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
      // A kategóriaválaszok nyers darabszáma tartalmazhat hibás/duplikált sort;
      // a UI és a provider-kártya ugyanazt a sikeresen dekódolt listát használja.
    }

    onProgress({ phase: 'Filmek feldolgozása…', percent: 86 });
    movies = decodedMovies;
    vodCats = buildCategories(vodCategories, 'vc-', 'movie', vodCounts);

    await onPartial({ preview: true, movies, vodCategories: vodCats, totals: { vod: movies.length } });
  } catch (error) {
    if (isNetworkRequestCancelled(error)) throw error;
    const detail = safeErrorDetail(error);
    console.warn('A filmek letöltése nem sikerült:', error);
    warnings.push(`A filmek listája nem töltődött le: ${detail}`);
    logPhase(`Filmek import hiba; ok=${detail.slice(0, 240)}`);
  }
  };

  /* ---- 3. szakasz: sorozatok --------------------------------------
   * Gyorsítás: először megpróbáljuk egyben lekérni az összes sorozatot.
   * Ha sikerül, 15-20 kérés helyett 1 kérés.
   */

  let series: Series[] = [];
  let seriesCats: Category[] = [];
  const loadSeriesPhase = async (): Promise<void> => {
  try {
    onProgress({ phase: 'Sorozat kategóriák letöltése…', percent: 74 });
    let seriesCategories: XtreamCategory[] = [];
    try {
      seriesCategories = await providerRequest(
        () => xtreamService.seriesCategories(server, user, pass),
        'Sorozat kategóriák'
      );
    } catch (categoryError) {
      if (isNetworkRequestCancelled(categoryError)) throw categoryError;
      const detail = safeErrorDetail(categoryError);
      warnings.push(`A sorozat kategórialistája nem tölthető le (${detail}); a sorozatok bulk-végpontja és az „Egyéb” kategória következik.`);
      logPhase(`Sorozat kategóriák hiba; ok=${detail}`);
    }
    const seriesCategoryMap = makeCategoryMap(seriesCategories);
    const decodedSeries: Series[] = [];
    const seriesCounts = new Map<string, number>();
    const seenSeriesIds = new Set<string>();
    let seriesProcessed = 0;
    let bulkSeriesUsed = false;
    let bulkSeriesFallbackReason = '';

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
          const seriesId = String(item.series_id);
          if (seenSeriesIds.has(seriesId)) continue;
          seenSeriesIds.add(seriesId);
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
        bulkSeriesUsed = decodedSeries.length > 0;
        if (bulkSeriesUsed) {
          onProgress({ phase: 'Sorozatok feldolgozva egyben', detail: `${decodedSeries.length} sorozat`, percent: 90 });
        } else {
          bulkSeriesFallbackReason = 'a bulk-válaszban nem volt használható sorozat';
          seriesCounts.clear();
          seenSeriesIds.clear();
          seriesProcessed = 0;
        }
      } else if (Array.isArray(allSeries) && allSeries.length === 0) {
        bulkSeriesFallbackReason = 'a bulk-végpont üres választ adott';
      } else {
        bulkSeriesFallbackReason = `a bulk-válasz túllépte a ${MAX_SERIES.toLocaleString('hu-HU')} elemes korlátot`;
      }
    } catch (bulkError) {
      const detail = safeErrorDetail(bulkError);
      bulkSeriesFallbackReason = detail;
      console.warn('Sorozatok egyben nem sikerült, visszaesés kategóriákra:', bulkError);
      decodedSeries.length = 0;
      seriesCounts.clear();
      seenSeriesIds.clear();
      seriesProcessed = 0;
    }

    if (!bulkSeriesUsed && bulkSeriesFallbackReason) {
      warnings.push(`A sorozatok bulk-letöltése nem használható (${bulkSeriesFallbackReason}); kategória-fallback indul.`);
      logPhase(`Sorozatok bulk hiba; ok=${bulkSeriesFallbackReason}`);
    }

    if (!bulkSeriesUsed) {
      if (seriesCategories.length === 0) {
        warnings.push('A sorozatok kategória-fallbackje nem indítható, mert a szolgáltató nem adott használható kategórialistát; tényleges sorozat-darabszám=0.');
      }
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
              const seriesId = String(item.series_id);
              if (seenSeriesIds.has(seriesId)) continue;
              seenSeriesIds.add(seriesId);
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
                await onPartial({ preview: true, series: decodedSeries.slice(), seriesCategories: partialCats, totals: { series: decodedSeries.length } });
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
    }

    onProgress({ phase: 'Sorozatok feldolgozása…', percent: 96 });
    series = decodedSeries;
    seriesCats = buildCategories(seriesCategories, 'sc-', 'series', seriesCounts);

    await onPartial({ preview: true, series, seriesCategories: seriesCats, totals: { series: series.length } });
  } catch (error) {
    if (isNetworkRequestCancelled(error)) throw error;
    const detail = safeErrorDetail(error);
    console.warn('A sorozatok letöltése nem sikerült:', error);
    warnings.push(`A sorozatok listája nem töltődött le: ${detail}`);
    logPhase(`Sorozatok import hiba; ok=${detail.slice(0, 240)}`);
  }
  };

  /*
   * A FILM- ÉS SOROZATLISTA PÁRHUZAMOSAN TÖLTŐDIK.
   *
   * Korábban a sorozatok csak a TELJES filmkatalógus letöltése és feldolgozása
   * után indultak: 40 000 film letöltése (több MB letöltés + JSON-feldolgozás)
   * után jött a sorozat, így a „Sorozat” menü akár fél percig üres maradt.
   * A két lista egymástól független (külön végpont, külön kategóriák), ezért
   * egyszerre indulnak; a net.ts továbbra is legfeljebb 2 párhuzamos
   * kapcsolatot enged, tehát a szolgáltató/ router terhelése nem nő.
   * A hibakezelés külön-külön marad: az egyik lista hibája nem viszi magával
   * a másikat, és a figyelmeztetések is a végén jelennek meg.
   */
  await Promise.all([loadMoviesPhase(), loadSeriesPhase()]);

  // A részletes végpontok csak az első 20 (film + sorozat) VOD-elemet érintik.
  // A két lista alapbetöltése már párhuzamosan megtörtént, ezért ez a kis,
  // korlátozott kör nem tarthatja fel az élő csatorna első használható adagját.
  if (movies.length || series.length) {
    const detailed = await enrichFirstVodMetadata(movies, series, server, user, pass);
    movies = detailed.movies;
    series = detailed.series;
    if (detailed.failed > 0) {
      const detail = `${detailed.failed}/${detailed.requested} részletes VOD-kérés nem sikerült; alapadatokkal folytatjuk.`;
      warnings.push(detail);
      logPhase(`VOD részletes metaadat hiba; ok=${detail}`);
    }
    onProgress({
      phase: 'VOD metaadatok feldolgozása…',
      detail: `${detailed.requested} részletes kérés (legfeljebb ${MAX_DETAILED_VOD})` +
        (detailed.failed > 0 ? ` • ${detailed.failed} hiba, alapadatok megmaradtak` : ''),
      percent: 98,
    });
    // A preview callback-ek nem kapnak részletes metaadatot: így nincs újabb
    // VOD-lista- és mentéskör, a végleges enriched tartalom a visszatérő
    // ImportedContent-ban érkezik meg az App-hoz.
  }

  /*
   * A fiókadatok (lejárat, kapcsolatszám, státusz) a végén: a bejelentkezés
   * a háttérben futott a csatornák mellett, és a csatornák már a felületen
   * vannak, amikor ez ideér. Ha a probe hibázott, a csatornák ettől még
   * hibátlanok – a lejárathoz ekkor a korábbi érték (nincs/„Korlátlan") marad.
   */
  const authResult = await authPromise;
  const auth = authResult.ok ? authResult.value : null;
  if (!authResult.ok) {
    const safeDetail = safeErrorDetail(authResult.error);
    warnings.push(`A bejelentkezési próba nem sikerült (${safeDetail}); a tartalomlisták ettől még megmaradtak.`);
    logPhase(`Bejelentkezési probe hiba; ok=${safeDetail}`);
  }
  const info = auth?.user_info;
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

  const content: ImportedContent = {
    provider,
    savedAt: new Date().toISOString(),
    channels: liveChannels,
    movies,
    series,
    liveCategories,
    vodCategories: vodCats,
    seriesCategories: seriesCats,
    totals: { live: liveChannels.length, vod: movies.length, series: series.length },
    warnings,
  };

  const totalMs = Math.round(performance.now() - startedAt);
  logPhase(
    `Xtream import kész: ${content.channels.length} csatorna, ${content.movies.length} film, ` +
    `${content.series.length} sorozat, ${totalMs} ms`
  );
  logMemory('import után');
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
  logPhase('M3U import indul');
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
        audioLanguages: [UNKNOWN_LANGUAGE],
        subtitleLanguages: [UNKNOWN_LANGUAGE],
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

  await onPartial({ preview: true, channels: live, liveCategories: liveCats, totals: { live: live.length } });
  await onPartial({ preview: true, movies: content.movies, vodCategories: vodCats, totals: { vod: movies.length } });

  const totalMs = Math.round(performance.now() - startedAt);
  logPhase(`M3U import kész: ${totalMs} ms`);
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
