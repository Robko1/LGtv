import { normalizeLogoUrl } from './logoUrl';
import {
  logMemory,
  logPhase,
  logProviderEvent,
  logProviderPhaseEnd,
  logProviderPhaseStart,
} from './appLog';
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
  loadSyncState,
  saveRawPlaylist,
  saveSyncState,
} from './contentStore';
import { xtreamService, XtreamCategory, XtreamLiveStream, XtreamSeriesItem, XtreamVodStream } from './xtreamService';
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
  /**
   * A SZAKASZ VÉGLEGES ÉS TARTÓSÍTANDÓ.
   *
   * A teljes import 60–70 mp. Ha a mentést csak a LEGVÉGÉRE tesszük (a régi
   * kód így működött), akkor egy bezárás az import utáni másodpercekben
   * mindhárom listát elveszíti – a következő indulás pedig újra letölt
   * mindent. A `durable` jelző azt mondja a felületnek, hogy ez a lista
   * KÉSZ: azonnal, külön szakaszként írja a tartós tárba, miközben a többi
   * szakasz még letöltés alatt áll.
   */
  durable?: boolean;
  /**
   * AZ ÉLŐ LISTA ELKÉSZÜLT.
   *
   * Az élő szakasz a teljes csatornalistát egyszerre tölti le, de amíg a filmek
   * és sorozatok készülnek, a részleges tartalom továbbra is `preview: true`.
   * Ezért külön jelző kell: a felület CSAK ekkor dönthet a nézett csatornáról.
   * Az első 1500 csatornás előnézetnél a jelző hamarabb NEM lehet igaz – a
   * hiányos listából választott csatorna a betöltés végére másra váltana, vagy
   * (ha az első adagban nincs magyar adó) egy külföldi csatornát indítana.
   */
  liveComplete?: boolean;
  channels?: Channel[];
  liveCategories?: Category[];
  movies?: Movie[];
  vodCategories?: Category[];
  series?: Series[];
  seriesCategories?: Category[];
  totals?: { live?: number; vod?: number; series?: number };
}

export type PartialFn = (partial: PartialContent) => void | Promise<void>;

/**
 * Biztonsági korlátok – szelepek, NEM a valós katalógus mérete.
 *
 * Az 1-es TV-napló (2.5.116) szerint a szolgáltató 20 190 csatornát,
 * 102 815 filmet és 24 972 sorozatot ad. A régi 40 000 / 15 000-es korlát
 * ezért nem az egész katalógust dolgozta fel, és a felület emiatt
 * „Részben kész” állapotot mutatott egy FIGYELEM szöveggel – pedig a
 * letöltés és a mentés is sikerült.
 *
 * A korlátok csak elfajult válasz (több százezer elem) ellen védenek, és
 * jóval a valós katalógus felett vannak, hogy ne vágják le a tartalmat.
 */
const MAX_CHANNELS = 120000;
const MAX_MOVIES = 150000;
const MAX_SERIES = 60000;

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
const UI_YIELD_EVERY = 1200;

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
  /**
   * A szolgáltató NYERS kategórialistáinak ujjlenyomata.
   *
   * FONTOS: a kész tartalomból NEM lehet kiszámolni, mert abban már ott van a
   * szintetikus „Egyéb” kategória (lc-other) is, amit a program ad hozzá a
   * besorolatlan elemekhez. Az ujjlenyomatot ezért a letöltés pillanatában, a
   * nyers válaszból képezzük – így a következő ellenőrzés bitre ugyanazt kapja.
   */
  fingerprint?: string;
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
      const waitMs = RETRY_BASE_DELAY_MS + Math.floor(Math.random() * 400);
      // A kézi naplóban látszódjon, hogy a program újrapróbált, és miért:
      // a TV-n a néző csak annyit lát, hogy „lassan tölt”.
      logProviderEvent(
        `[${label}] ${safeErrorDetail(error)} – ${attempt}/${RETRY_MAX_ATTEMPTS}. próbálkozás sikertelen, ` +
        `újrapróbálkozás ${waitMs} ms múlva`
      );
      // 0,8-1,2 s: a panel közben kiüríti a kapcsolatait.
      await sleep(waitMs);
    }
  }
  if (isNetworkRequestCancelled(lastError)) throw lastError;
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  logProviderEvent(`[${label}] VÉGLEGES HIBA: ${safeErrorDetail(lastError)}`);
  throw new Error(`${label}: ${message}`);
}

/** Hány KÜLÖNBÖZŐ kategória szerepel valóban a letöltött elemekben? */
function countUsedCategories<T>(items: T[], getId: (item: T) => string): number {
  const ids = new Set<string>();
  for (const item of items) {
    const id = getId(item);
    if (id) ids.add(id);
  }
  return ids.size;
}

export interface CatalogSummary {
  /** „20 190 csatorna (340 kategória) • 102 815 film (140 kategória) • …” */
  counts: string;
  /** „Kész”, vagy „Figyelmeztetés”, ha VALÓDI adat hiányzik. */
  phase: string;
  /** Megjegyzések és valódi hiányok együtt (üres, ha nincs). */
  extra: string;
}

/**
 * A betöltés VÉGEREDMÉNYE a felületnek.
 *
 * A 2.5.116-os napló tanulsága: a letöltés és a mentés is sikerült
 * (20 190 csatorna, 40 000 film, 15 000 sorozat; IndexedDB-mentés), a felület
 * mégis „Részben kész”-t és egy hosszú FIGYELEM szöveget mutatott, mert a
 * biztonsági korlátot figyelmeztetésnek vette. Most:
 *
 *   – a darabszám a TÉNYLEGESEN feldolgozott elemeké, kategóriaszámokkal;
 *   – csak VALÓDI hiány (kimaradt kategória, le nem töltött szakasz) számít
 *     figyelmeztetésnek;
 *   – a korlát és a sikeres tartalék-út csak megjegyzés.
 */
export function describeCatalogSummary(content: ImportedContent): CatalogSummary {
  const nf = (value: number) => value.toLocaleString('hu-HU');
  const channels = Array.isArray(content.channels) ? content.channels : [];
  const movies = Array.isArray(content.movies) ? content.movies : [];
  const series = Array.isArray(content.series) ? content.series : [];
  const counts =
    `${nf(channels.length)} csatorna (${nf(countUsedCategories(channels, (item) => item.categoryId))} kategória) • ` +
    `${nf(movies.length)} film (${nf(countUsedCategories(movies, (item) => item.categoryId))} kategória) • ` +
    `${nf(series.length)} sorozat (${nf(countUsedCategories(series, (item) => item.categoryId))} kategória)`;
  const warnings = Array.isArray(content.warnings) ? content.warnings : [];
  const notes = Array.isArray(content.notes) ? content.notes : [];
  const extra = [...notes, ...warnings].filter((text) => text).join(' ');
  return { counts, phase: warnings.length ? 'Figyelmeztetés' : 'Kész', extra };
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
    /** A kézi naplóban megjelenő szakasznév (pl. „film kategória”). */
    logLabel?: string;
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
        // A kézi napló pontosan megmutatja, MELYIK kategória és MIÉRT nem jött
        // be – e nélkül a TV-n csak egy hiányos Mozi/Sorozat nézet látszik.
        logProviderEvent(
          `${options.logLabel || 'kategória'} „${category.category_name || category.category_id}” ` +
          `(azonosító=${category.category_id}) nem töltődött le: ${safeErrorDetail(error)} ` +
          `[${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} egymás utáni hiba]`
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          aborted = true;
          logProviderEvent(
            `${options.logLabel || 'kategória'} betöltése LEÁLLT: ${consecutiveFailures} egymás utáni hiba; ` +
            `eddigi elemszám=${collected}, hátralévő kategória=${Math.max(0, usable.length - done)}`
          );
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

/**
 * Az adott országba sorolt Élő kategóriák azonosítói (a kategórianév alapján).
 *
 * A szolgáltatók nem adnak országlistát: az országot a kategória nevéből
 * állapítjuk meg ugyanazzal a szabállyal, amivel a csatornáét is
 * (utils/flags.ts). Ezért tudjuk már a kicsi kategóriaválaszból eldönteni,
 * melyik kategóriát kell egyáltalán letölteni.
 */
/**
 * Hány KÜLÖNBÖZŐ ország (az „Nemzetközi” gyűjtőn kívül) olvasható ki az élő
 * kategórianevekből.
 *
 * Ez dönti el, hogy a szolgáltató ország szerint szervezi-e a kategóriákat.
 * Az 5-ös TV-napló (2.5.113) esete: 340 kategória, de csak 1 magyar nevű –
 * vagyis a nevek nem országok (pl. „Sport”, „News”), így a kategóriánkénti
 * szűrés megbízhatatlan, és inkább a teljes listát kell letölteni.
 */
export function countCountriesInCategories(categories: XtreamCategory[]): number {
  const safe = Array.isArray(categories) ? categories : [];
  const codes = new Set<string>();
  for (const category of safe) {
    if (!category) continue;
    const code = flagFor(String(category.category_name || '')).countryCode;
    if (code && code !== 'INT') codes.add(code);
  }
  return codes.size;
}


export function pickCategoryIdsByCountry(
  categories: XtreamCategory[],
  countryCode: string
): Array<string | number> {
  const safe = Array.isArray(categories) ? categories : [];
  const ids: Array<string | number> = [];
  for (const category of safe) {
    if (!category || category.category_id === undefined || category.category_id === null) continue;
    if (flagFor(String(category.category_name || '')).countryCode !== countryCode) continue;
    ids.push(category.category_id);
  }
  return ids;
}

/**
 * HÁROM KÉRÉS PÁRHUZAMOSAN. A kategóriánkénti lista kicsi, de sok kategória
 * lehet; a teljesen soros letöltés lassabb lenne, mint az egyben kért teljes
 * lista, a korlátlan párhuzamosság viszont szétszaggatná a panelt (a betöltő
 * szándékosan kímélő üzemű).
 */
const LIVE_CATEGORY_CONCURRENCY = 3;

async function fetchLiveStreamsForCategories(
  server: string,
  user: string,
  pass: string,
  categoryIds: Array<string | number>,
  wrap: (task: () => Promise<XtreamLiveStream[]>) => Promise<XtreamLiveStream[]>
): Promise<XtreamLiveStream[]> {
  const streams: XtreamLiveStream[] = [];
  for (let start = 0; start < categoryIds.length; start += LIVE_CATEGORY_CONCURRENCY) {
    const batch = categoryIds.slice(start, start + LIVE_CATEGORY_CONCURRENCY);
    const parts = await Promise.all(batch.map((categoryId) => wrap(() =>
      providerRequest(
        () => xtreamService.liveStreams(server, user, pass, categoryId),
        'Élő csatornalista (kategóriánként)'
      )
    )));
    for (const part of parts) streams.push(...part);
    await yieldToUi();
  }
  return streams;
}

/**
 * EGY ORSZÁG CSATORNÁI IGÉNY SZERINT (a néző 2. pontja).
 *
 * Induláskor csak a magyar csatornák jönnek le; a többi ország neve már akkor
 * is látszik az országlistában, de a csatornáit csak akkor töltjük le, amikor
 * a néző megnyitja azt az országot. Ez a függvény tölti le a kiválasztott
 * ország élő kategóriáit, és adja vissza kész Channel listaként.
 *
 * A hívó felel a listák összefésüléséért és a mentésért – ez a függvény csak a
 * hálózat és a dekódolás.
 */
export async function loadLiveChannelsForCategories(
  provider: ProviderRef,
  categories: XtreamCategory[],
  categoryIds: Array<string | number>
): Promise<Channel[]> {
  if (!Array.isArray(categoryIds) || categoryIds.length === 0) return [];
  const server = xtreamService.cleanUrl(provider.serverUrl || '');
  const user = (provider.username || '').trim();
  const pass = (provider.password || '').trim();
  logProviderEvent(
    `Élő csatornák: ${categoryIds.length} kategória töltődik igény szerint.`
  );
  const streams = await fetchLiveStreamsForCategories(server, user, pass, categoryIds, (task) => task());
  const categoryMap = makeCategoryMap(Array.isArray(categories) ? categories : []);
  const rows: Array<Array<string | number>> = [];
  const seen = new Set<string>();
  for (const stream of streams) {
    if (!stream || stream.stream_id === undefined || stream.stream_id === null) continue;
    const streamId = String(stream.stream_id);
    if (seen.has(streamId)) continue;
    seen.add(streamId);
    const category = resolveCategory(categoryMap, stream.category_id, 'lc-');
    const name = (stream.name || 'Csatorna').trim();
    const info = flagFor(category.name || name);
    rows.push([
      stream.num ?? rows.length + 1,
      name,
      normalizeLogoUrl(stream.stream_icon, xtreamService.playerApiBase(server, '', '')),
      category.id,
      category.name,
      stream.stream_id,
      info.flag,
      info.countryCode,
      stream.epg_channel_id || '',
    ]);
  }
  const channels = decodeChannelsForImport(rows, provider);
  logProviderEvent(`Élő csatornák: ${channels.length} csatorna töltődött be igény szerint.`);
  return channels;
}

/**
 * A TELJES élő lista egyetlen kéréssel.
 *
 * Erre akkor van szükség, amikor a szolgáltató kategóriái NEM ország szerint
 * vannak elnevezve: az 5-ös TV-napló (2.5.113) szerint a 340 élő kategóriából
 * csak 1 volt magyar nevű, a többi 339 mind a „Nemzetközi” gyűjtőbe esett.
 * Ilyenkor országonként nem lehet szűrni – ha a néző megnyitja a maradékot,
 * egyetlen nagy kéréssel jön le minden, pontosan úgy, ahogy induláskor tenné.
 */
export async function loadAllLiveChannels(provider: ProviderRef): Promise<Channel[]> {
  const server = xtreamService.cleanUrl(provider.serverUrl || '');
  const user = (provider.username || '').trim();
  const pass = (provider.password || '').trim();
  logProviderEvent('Élő csatornák: a teljes lista töltődik le (a kategóriák száma túl sok az egyenkénti kéréshez).');
  const streams = await providerRequest(
    () => xtreamService.liveStreams(server, user, pass),
    'Élő csatornalista'
  );
  const rows: Array<Array<string | number>> = [];
  const seen = new Set<string>();
  for (const stream of streams) {
    if (!stream || stream.stream_id === undefined || stream.stream_id === null) continue;
    const streamId = String(stream.stream_id);
    if (seen.has(streamId)) continue;
    seen.add(streamId);
    const name = (stream.name || 'Csatorna').trim();
    // Az ország a KATEGÓRIANÉVBŐL, és csak ha az nem ad országot, akkor a
    // csatorna nevéből – így a „[HU] M4 UHD” alakú nevek is besorolhatók.
    const byName = flagFor(name);
    const info = byName.countryCode !== 'INT' ? byName : { flag: '📺', countryCode: 'INT' };
    rows.push([
      stream.num ?? rows.length + 1,
      name,
      normalizeLogoUrl(stream.stream_icon, xtreamService.playerApiBase(server, '', '')),
      `lc-${String(stream.category_id ?? 'other')}`,
      String(stream.category_id ?? 'other'),
      stream.stream_id,
      info.flag,
      info.countryCode,
      stream.epg_channel_id || '',
    ]);
  }
  const channels = decodeChannelsForImport(rows, provider);
  logProviderEvent(`Élő csatornák: ${channels.length} csatorna töltődött be a teljes listából.`);
  return channels;
}

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
  /* Megjegyzések: nem hiba, nem hiány – csak tény, amit érdemes tudni. */
  const notes: string[] = [];

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
  /*
   * A szolgáltató NYERS kategórialistái. Az ujjlenyomatot ezekből képezzük a
   * letöltés pillanatában: a kész tartalomban már ott van a szintetikus
   * „Egyéb” kategória is, amitől az összehasonlítás mindig eltérne.
   */
  let rawLiveCategories: XtreamCategory[] = [];
  let rawVodCategories: XtreamCategory[] = [];
  let rawSeriesCategories: XtreamCategory[] = [];
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
    /*
     * INDULÁSKOR CSAK A MAGYAR CSATORNÁK.
     *
     * A néző kérése: induláskor csak az alap magyar TV-csatornák töltődjenek
     * be, más országoké ne. A 4-es TV-napló mutatja, miért fontos ez: a teljes
     * élő lista 20 190 csatorna, és a tárolóban ~4 MB-ot foglal a TV ~5 MB-os
     * kvótájából – emiatt a filmlistából csak 5800 elem fért el, a
     * sorozatlistából pedig EGY ADAG SEM:
     *
     *   TÁROLÓ HIBA: content-series-chunk … foglaltság=68 kulcs / 5059 kB
     *
     * Ezért a kategóriák MOST MÁR ELŐBB jönnek (eddig párhuzamosan futottak a
     * csatornákkal): nélkülük nem tudnánk eldönteni, mit kell egyáltalán
     * lekérni. A kategórialista kicsi és gyors, ezért ez nem látszik az
     * indulási időben.
     */
    const liveCats = await providerRequest(
      () => xtreamService.liveCategories(server, user, pass),
      'Élő kategóriák'
    ).catch((error) => {
      if (isNetworkRequestCancelled(error)) throw error;
      return [] as XtreamCategory[];
    });

    rawLiveCategories = liveCats;
    const hungarianCategoryIds = pickCategoryIdsByCountry(liveCats, 'HU');

    /*
     * DIAGNOSZTIKA: A KATEGÓRIANEVEK.
     *
     * Az 5-ös TV-napló (2.5.113) mutatta a problémát:
     *   SZOLGÁLTATÓ [élő kategóriák], OK, 218 ms, HTTP 200, 23.4 kB
     *   Élő csatornák: induláskor csak a magyar kategóriák töltődnek le (1/340)
     *   SZOLGÁLTATÓ FÁZIS [élő csatornák] kész – 107 csatorna, 340 kategória
     *
     * Tehát a szolgáltató 340 élő kategóriájából EGYET ismertünk fel
     * magyarként, és így csak 107 csatorna jött le a korábbi 20 190 helyett.
     * Hogy ez azért van-e, mert a kategóriák nem ország szerint vannak
     * elnevezve (pl. csak „Sport”, „News”), vagy azért, mert a név olyan
     * alakú, amit a szabály nem ismer fel (pl. „HUN”, „Венгрия”), a naplóból
     * nem derült ki – a kategórianév sehol nem jelent meg. Ezért most
     * kírjuk a találatokat és egy mintát a többiből.
     */
    const matchedNames = liveCats
      .filter((category) => flagFor(String(category.category_name || '')).countryCode === 'HU')
      .map((category) => String(category.category_name || '').trim())
      .slice(0, 8);
    const otherNames = liveCats
      .filter((category) => flagFor(String(category.category_name || '')).countryCode !== 'HU')
      .map((category) => String(category.category_name || '').trim())
      .filter((name) => name !== '')
      .slice(0, 12);
    logProviderEvent(
      `Élő kategóriák nevei: összes=${liveCats.length}, magyar=${hungarianCategoryIds.length}` +
      (matchedNames.length > 0 ? `; magyar nevek: ${matchedNames.join(' | ')}` : '') +
      (otherNames.length > 0 ? `; minta a többiből: ${otherNames.join(' | ')}` : '')
    );

    /*
     * Ha a bejelentkezés is elbukott, annak a hibája sokkal érthetőbb
     * ("rossz a jelszó" / "a szerver nem elérhető"), mint a csatornakérésé.
     * Ez a referencia viselkedés, és most már több kérésre is kell.
     */
    const withAuthProbe = async (task: () => Promise<XtreamLiveStream[]>) => {
      try {
        return await task();
      } catch (error: unknown) {
        const probe = await authPromise;
        if (!probe.ok) throw probe.error;
        throw error;
      }
    };

    /*
    /*
     * MINDEN ÉLŐ CSATORNA ÉS KATEGÓRIA – EGYSZER.
     *
     * Az 1-es TV-napló (2.5.114) megmutatta a kategórianeveket:
     *   Élő kategóriák nevei: összes=340, magyar=1; magyar nevek: [HU] HUNGARIA;
     *   minta a többiből: FRANCE FHD | TV | FRANCE HD/SD | TV | FR LIGUE1 + | TV | …
     *
     * A szolgáltató tehát ország szerint nevezi el a kategóriákat, de csak EGY
     * magyar kategóriát ad („[HU] HUNGARIA”), ezért a magyar szűrés 107
     * csatornát adott a korábbi 20 190 helyett. A felhasználó kérése
     * egyértelmű: a TV-csatornák és a kategóriák MIND töltődjenek le, egyszer,
     * és utána rendben jelenjenek meg – ez nem sok adat.
     *
     * A teljes lista egyetlen kérés (a napló szerint ~12 s, ~200 kB), a
     * kategóriák pedig a válaszból képződnek, így egyetlen csatorna sem vész el,
     * és nincs kategóriánkénti kérésözön sem.
     */
    logProviderEvent(`Élő csatornák: a teljes lista töltődik le (${liveCats.length} kategória).`);
    let liveStreams: XtreamLiveStream[];
    liveStreams = await withAuthProbe(() => providerRequest(
      () => xtreamService.liveStreams(server, user, pass),
      'Élő csatornalista'
    ));
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
  logProviderPhaseEnd(
    'élő csatornák',
    `${liveChannels.length} csatorna, ${liveCategories.length} kategória (mód=${channelLoadMode})`,
    liveReadyMs
  );

  // Az élő lista AZONNAL a felületre kerül (nem várunk a filmekre).
  await onPartial({
    channels: liveChannels,
    liveCategories,
    totals: { live: liveStreamCount },
    preview: true,
    liveComplete: true,
    durable: true,
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
  const phaseStartedAt = performance.now();
  logProviderPhaseStart('filmek', 'először a bulk (egyben) végpont, hiba esetén kategóriánként');
  try {
    onProgress({ phase: 'Film kategóriák letöltése…', percent: 45 });
    let vodCategories: XtreamCategory[] = [];
    try {
      vodCategories = await providerRequest(
        () => xtreamService.vodCategories(server, user, pass),
        'Film kategóriák'
      );
      rawVodCategories = vodCategories;
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
    let lastVodPartialAt = 0;
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
      if (Array.isArray(allVod) && allVod.length > 0) {
        /*
         * A feldolgozás eleve MAX_MOVIES elemnél megáll, ezért egy ennél
         * nagyobb válasz NEM ok a már letöltött lista eldobására.
         *
         * KORÁBBAN a MAX_MOVIES * 1,2 feletti bulk választ teljes egészében
         * kidobtunk, és utána kategóriánként TÖLTÖTTÜK LE UGYANAZT a listát
         * több tucat kérésben – ez volt a „túl lassan töltődik” hiba egyik
         * legdrágább útja. Most a letöltött válasz első MAX_MOVIES elemét
         * használjuk, és a néző figyelmeztetést kap a korlátról.
         */
        if (allVod.length > MAX_MOVIES) {
          notes.push(
            `A szolgáltató ${allVod.length.toLocaleString('hu-HU')} filmet adott vissza egyetlen válaszként; ` +
            `a beépített korlát miatt az első ${MAX_MOVIES.toLocaleString('hu-HU')} elemet dolgozzuk fel ` +
            `(a letöltött lista többi részét nem töltjük le újra kategóriánként).`
          );
          logProviderEvent(
            `[filmek egyben] a válasz ${allVod.length} elemű; a feldolgozás ${MAX_MOVIES} elemnél megáll, ` +
            `nincs kategóriánkénti újratöltés`
          );
        }
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
      } else {
        bulkFallbackReason = 'a bulk-végpont üres választ adott';
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
      notes.push('A filmek egyben letöltése nem sikerült, ezért kategóriánként töltődtek le.');
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
          logLabel: 'film kategória',
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
              /* 2.5.137: 5000 elemenként (és nem 2000-enként) adjuk át a
                 részlistát. A `.slice()` egy 100 ezres tömbről és az azt
                 követő teljes App-újrarajzolás okozta az akadozást. */
              if (decodedMovies.length - lastVodPartialAt >= 5000) {
                lastVodPartialAt = decodedMovies.length;
                const partialCats = buildCategories(vodCategories, 'vc-', 'movie', vodCounts);
                await onPartial({ preview: true, movies: decodedMovies.slice(), vodCategories: partialCats, totals: { vod: decodedMovies.length } });
                await yieldToUi();
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
        notes.push(
          'A filmek listája a biztonsági korlát miatt az első ' + MAX_MOVIES.toLocaleString('hu-HU') + ' elemet tartalmazza.'
        );
      }
      // A kategóriaválaszok nyers darabszáma tartalmazhat hibás/duplikált sort;
      // a UI és a provider-kártya ugyanazt a sikeresen dekódolt listát használja.
    }

    onProgress({ phase: 'Filmek feldolgozása…', percent: 86 });
    movies = decodedMovies;
    vodCats = buildCategories(vodCategories, 'vc-', 'movie', vodCounts);

    await onPartial({ preview: true, durable: true, movies, vodCategories: vodCats, totals: { vod: movies.length } });
    logProviderPhaseEnd(
      'filmek',
      `${movies.length} film, ${vodCats.length} kategória (út=${bulkUsed ? 'bulk (1 kérés)' : 'kategóriánként'})`,
      performance.now() - phaseStartedAt
    );
  } catch (error) {
    if (isNetworkRequestCancelled(error)) throw error;
    const detail = safeErrorDetail(error);
    console.warn('A filmek letöltése nem sikerült:', error);
    warnings.push(`A filmek listája nem töltődött le: ${detail}`);
    logPhase(`Filmek import hiba; ok=${detail.slice(0, 240)}`);
    logProviderEvent(`FÁZIS [filmek] MEGSZAKADT – ${detail}; eltelt ${(performance.now() - phaseStartedAt) / 1000 | 0} s`);
  }
  };

  /* ---- 3. szakasz: sorozatok --------------------------------------
   * Gyorsítás: először megpróbáljuk egyben lekérni az összes sorozatot.
   * Ha sikerül, 15-20 kérés helyett 1 kérés.
   */

  let series: Series[] = [];
  let seriesCats: Category[] = [];
  const loadSeriesPhase = async (): Promise<void> => {
  const phaseStartedAt = performance.now();
  logProviderPhaseStart('sorozatok', 'először a bulk (egyben) végpont, hiba esetén kategóriánként');
  try {
    onProgress({ phase: 'Sorozat kategóriák letöltése…', percent: 74 });
    let seriesCategories: XtreamCategory[] = [];
    try {
      seriesCategories = await providerRequest(
        () => xtreamService.seriesCategories(server, user, pass),
        'Sorozat kategóriák'
      );
      rawSeriesCategories = seriesCategories;
    } catch (categoryError) {
      if (isNetworkRequestCancelled(categoryError)) throw categoryError;
      const detail = safeErrorDetail(categoryError);
      warnings.push(`A sorozat kategórialistája nem tölthető le (${detail}); a sorozatok bulk-végpontja és az „Egyéb” kategória következik.`);
      logPhase(`Sorozat kategóriák hiba; ok=${detail}`);
    }
    const seriesCategoryMap = makeCategoryMap(seriesCategories);
    const decodedSeries: Series[] = [];
    let lastSeriesPartialAt = 0;
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
      if (Array.isArray(allSeries) && allSeries.length > 0) {
        // Ugyanaz, mint a filmeknél: a már letöltött nagy válasz nem kerül
        // a kukába, ezért nem indul kategóriánkénti újratöltés.
        if (allSeries.length > MAX_SERIES) {
          notes.push(
            `A szolgáltató ${allSeries.length.toLocaleString('hu-HU')} sorozatot adott vissza egyetlen válaszként; ` +
            `a beépített korlát miatt az első ${MAX_SERIES.toLocaleString('hu-HU')} elemet dolgozzuk fel ` +
            `(a letöltött lista többi részét nem töltjük le újra kategóriánként).`
          );
          logProviderEvent(
            `[sorozatok egyben] a válasz ${allSeries.length} elemű; a feldolgozás ${MAX_SERIES} elemnél megáll, ` +
            `nincs kategóriánkénti újratöltés`
          );
        }
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
      } else {
        bulkSeriesFallbackReason = 'a bulk-végpont üres választ adott';
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
      notes.push('A sorozatok egyben letöltése nem sikerült, ezért kategóriánként töltődtek le.');
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
          logLabel: 'sorozat kategória',
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
              if (decodedSeries.length - lastSeriesPartialAt >= 5000) {
                lastSeriesPartialAt = decodedSeries.length;
                const partialCats = buildCategories(seriesCategories, 'sc-', 'series', seriesCounts);
                await onPartial({ preview: true, series: decodedSeries.slice(), seriesCategories: partialCats, totals: { series: decodedSeries.length } });
                await yieldToUi();
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
        notes.push(
          'A sorozatok listája a biztonsági korlát miatt az első ' + MAX_SERIES.toLocaleString('hu-HU') + ' elemet tartalmazza.'
        );
      }
    }

    onProgress({ phase: 'Sorozatok feldolgozása…', percent: 96 });
    series = decodedSeries;
    seriesCats = buildCategories(seriesCategories, 'sc-', 'series', seriesCounts);

    await onPartial({ preview: true, durable: true, series, seriesCategories: seriesCats, totals: { series: series.length } });
    logProviderPhaseEnd(
      'sorozatok',
      `${series.length} sorozat, ${seriesCats.length} kategória (út=${bulkSeriesUsed ? 'bulk (1 kérés)' : 'kategóriánként'})`,
      performance.now() - phaseStartedAt
    );
  } catch (error) {
    if (isNetworkRequestCancelled(error)) throw error;
    const detail = safeErrorDetail(error);
    console.warn('A sorozatok letöltése nem sikerült:', error);
    warnings.push(`A sorozatok listája nem töltődött le: ${detail}`);
    logPhase(`Sorozatok import hiba; ok=${detail.slice(0, 240)}`);
    logProviderEvent(`FÁZIS [sorozatok] MEGSZAKADT – ${detail}; eltelt ${(performance.now() - phaseStartedAt) / 1000 | 0} s`);
  }
  };

  /*
   * A betöltés egyetlen, stabil sorozatot követ: élő csatornák, filmek,
   * majd sorozatok. A film- és sorozatlista nem indul egyszerre, mert a két
   * nagy JSON feldolgozása párhuzamosan a webOS TV-n memória-csúcsot és
   * félkész 0/elemszámú nézetet okozhatott. A filmek szakasza akkor is
   * befejeződik, ha hibával zárul; ezután külön indul a sorozat-szakasz.
   */
  await loadMoviesPhase();
  await yieldToUi();
  await loadSeriesPhase();

  // A részletes végpontok csak az első 20 (film + sorozat) VOD-elemet érintik.
  // Ezek mindkét alaplista után, egy külön, korlátozott körben futnak; a
  // részleges élő csatornalista addigra már használható a felületen.
  if (movies.length || series.length) {
    const enrichStartedAt = performance.now();
    const detailed = await enrichFirstVodMetadata(movies, series, server, user, pass);
    logProviderEvent(
      `VOD részletes metaadatok: ${detailed.requested} kérés (legfeljebb ${MAX_DETAILED_VOD}), ` +
      `${detailed.failed} hiba, ${Math.round(performance.now() - enrichStartedAt)} ms`
    );
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
    notes,
  };

  const totalMs = Math.round(performance.now() - startedAt);
  logPhase(
    `Xtream import kész: ${content.channels.length} csatorna, ${content.movies.length} film, ` +
    `${content.series.length} sorozat, ${totalMs} ms`
  );
  logMemory('import után');
  const summary = describeCatalogSummary(content);
  onProgress({
    phase: summary.phase,
    detail:
      `${summary.counts} • ⏱ ${(totalMs / 1000).toFixed(1)} s` +
      (summary.extra ? ` • ${summary.extra}` : ''),
    percent: 100,
  });

  return {
    content,
    fingerprint: rawCatalogFingerprint(rawLiveCategories, rawVodCategories, rawSeriesCategories),
    user: {
      expireDate,
      maxConnections: parseInt(String(info?.max_connections || '1'), 10) || 1,
      status: String(info?.status || 'Active'),
    },
  };
}

/* ------------------------------------------------- növekményes frissítés */

/**
 * Tájékoztató érték: ennyi idő után számít „régi”-nek az utolsó teljes
 * ellenőrzés a felületen megjelenő szövegben.
 *
 * FONTOS VÁLTOZÁS (2.5.141) – A FRISSESSÉGI ABLAK MÁR NEM DÖNT.
 *
 * Korábban a Frissítés gomb csak akkor hagyta ki a teljes újratöltést, ha a
 * kategóriák azonosak VOLTAK **és** az utolsó teljes szinkron 10 percen belül
 * történt. Vagyis 10 perc után minden „frissítés” letöltötte a teljes, több
 * tíz MB-os listát – pontosan az a felesleges újratöltés, amit a néző
 * jelezni. A döntés mostantól KIZÁRÓLAG a változásvizsgálat eredménye:
 *
 *   • a kategóriák azonosak  → a mentett tartalom marad, nincs letöltés;
 *   • a kategóriák változtak → teljes letöltés indul.
 *
 * A kategóriákon BELÜLI változást (pl. új film egy meglévő kategóriában)
 * ettől függetlenül a 12 órás háttér-ellenőrzés (CATALOG_TTL_MS) fedezi fel,
 * amely induláskor egyszer, csendesen lefut, és változás esetén magától
 * frissít. Így nem veszik el tartalom, de a Frissítés gomb nem húz le
 * feleslegesen több tíz MB-ot.
 */
export const FULL_CHECK_WINDOW_MS = 10 * 60 * 1000;

/** Egy kategórialista ujjlenyomata (azonosító + név, rendezve). */
export function catalogFingerprint(categories: Array<{ id: string; name: string }> | undefined): string {
  const rows = (Array.isArray(categories) ? categories : [])
    .filter((category) => category && category.id !== undefined && category.id !== null)
    .map((category) => `${category.id}\u0001${category.name ?? ''}`)
    .sort();
  let hash = 2166136261;
  for (const row of rows) {
    for (let index = 0; index < row.length; index++) {
      hash ^= row.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${(hash >>> 0).toString(36)}:${rows.length}`;
}

/** A három NYERS kategórialista együttes ujjlenyomata (a szolgáltató válaszából). */
export function rawCatalogFingerprint(
  live: XtreamCategory[] | undefined,
  vod: XtreamCategory[] | undefined,
  series: XtreamCategory[] | undefined
): string {
  const map = (list: XtreamCategory[] | undefined, prefix: string) =>
    catalogFingerprint((Array.isArray(list) ? list : []).map((category) => ({
      id: `${prefix}${category?.category_id ?? ''}`,
      name: String(category?.category_name ?? '').trim(),
    })));
  return [map(live, 'lc-'), map(vod, 'vc-'), map(series, 'sc-')].join('~');
}

/** A három kategórialista együttes ujjlenyomata. */
export function providerFingerprint(content: {
  liveCategories?: Array<{ id: string; name: string }>;
  vodCategories?: Array<{ id: string; name: string }>;
  seriesCategories?: Array<{ id: string; name: string }>;
}): string {
  return [
    catalogFingerprint(content.liveCategories),
    catalogFingerprint(content.vodCategories),
    catalogFingerprint(content.seriesCategories),
  ].join('~');
}

export interface ProviderChangeCheck {
  /** Igaz, ha a három kategórialista mindenben azonos a legutóbbival. */
  unchanged: boolean;
  /** Igaz, ha az utolsó teljes szinkron a frissességi ablakon belül volt. */
  fresh: boolean;
  /** Az utolsó teljes szinkron óta eltelt idő ezredmásodpercben. */
  ageMs: number | null;
  /** A most mért ujjlenyomat. */
  fingerprint: string;
  counts: { live: number; vod: number; series: number };
}

/**
 * OLCSÓ VÁLTOZÁSVIZSGÁLAT: csak a három kategórialistát kéri le.
 * A tartalmat nem tölti le – ezért kerül alig egy másodpercbe.
 */
export async function checkProviderChanges(input: {
  serverUrl: string;
  username: string;
  password: string;
  fingerprint?: string;
  lastFullSyncAt?: number | null;
}): Promise<ProviderChangeCheck> {
  const server = xtreamService.cleanUrl(input.serverUrl);
  const user = input.username.trim();
  const pass = input.password.trim();
  const [liveCats, vodCats, seriesCats] = await Promise.all([
    xtreamService.liveCategories(server, user, pass).catch(() => [] as XtreamCategory[]),
    xtreamService.vodCategories(server, user, pass).catch(() => [] as XtreamCategory[]),
    xtreamService.seriesCategories(server, user, pass).catch(() => [] as XtreamCategory[]),
  ]);
  const fingerprint = rawCatalogFingerprint(liveCats, vodCats, seriesCats);
  const ageMs = typeof input.lastFullSyncAt === 'number' && input.lastFullSyncAt > 0
    ? Math.max(0, Date.now() - input.lastFullSyncAt)
    : null;
  /*
   * Ha egy kategórialista sem jött meg (a panel nem válaszol), NEM
   * állíthatjuk, hogy „nincs változás”: olyankor a teljes import úgyis
   * értelmes hibaüzenetet ad.
   */
  const anyLoaded = liveCats.length + vodCats.length + seriesCats.length > 0;
  const unchanged = Boolean(
    anyLoaded
    && typeof input.fingerprint === 'string'
    && input.fingerprint === fingerprint
  );
  return {
    unchanged,
    fresh: ageMs !== null && ageMs <= FULL_CHECK_WINDOW_MS,
    ageMs,
    fingerprint,
    counts: { live: liveCats.length, vod: vodCats.length, series: seriesCats.length },
  };
}

/** Egy lista változásai. */
export interface CatalogDiff {
  added: number;
  removed: number;
  changed: number;
}

export function diffCatalogs<T>(
  previous: readonly T[] | undefined,
  next: readonly T[] | undefined,
  keyOf: (item: T) => string,
  signatureOf: (item: T) => string
): CatalogDiff {
  const before = new Map<string, string>();
  for (const item of Array.isArray(previous) ? previous : []) {
    if (!item) continue;
    before.set(keyOf(item), signatureOf(item));
  }
  const seen = new Set<string>();
  let added = 0;
  let changed = 0;
  for (const item of Array.isArray(next) ? next : []) {
    if (!item) continue;
    const key = keyOf(item);
    seen.add(key);
    const old = before.get(key);
    if (old === undefined) added += 1;
    else if (old !== signatureOf(item)) changed += 1;
  }
  let removed = 0;
  for (const key of before.keys()) if (!seen.has(key)) removed += 1;
  return { added, removed, changed };
}

/** „+12 / −3 csatorna, 1 módosult” – üres, ha nincs változás. */
export function describeCatalogDiff(diff: CatalogDiff, label: string): string {
  if (diff.added === 0 && diff.removed === 0 && diff.changed === 0) return '';
  const parts: string[] = [];
  if (diff.added > 0) parts.push(`+${diff.added}`);
  if (diff.removed > 0) parts.push(`−${diff.removed}`);
  const head = parts.length ? `${parts.join(' / ')} ${label}` : '';
  const tail = diff.changed > 0 ? `${diff.changed} módosult` : '';
  return [head, tail].filter(Boolean).join(', ');
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

  await onPartial({ preview: true, durable: true, liveComplete: true, channels: live, liveCategories: liveCats, totals: { live: live.length } });
  await onPartial({ preview: true, durable: true, movies: content.movies, vodCategories: vodCats, totals: { vod: movies.length } });

  const totalMs = Math.round(performance.now() - startedAt);
  logPhase(`M3U import kész: ${totalMs} ms`);
  onProgress({
    phase: m3uWarnings.length ? 'Figyelmeztetés' : 'Kész',
    detail:
      `${live.length.toLocaleString('hu-HU')} csatorna • ${movies.length.toLocaleString('hu-HU')} film • ` +
      `⏱ ${(totalMs / 1000).toFixed(1)} s` +
      (m3uWarnings.length ? ` • FIGYELEM: ${m3uWarnings.join(' ')}` : ''),
    percent: 100,
  });
  return content;
}

/** Újratöltés a mentett szolgáltatói adatokból. */
/** A frissítés eredménye: új tartalom, vagy „nem változott semmi”. */
export type RefreshOutcome =
  | ImportedProvider
  | ImportedContent
  | { unchanged: true; check: ProviderChangeCheck };

export async function refreshProviderContent(
  provider: ProviderAccount,
  onProgress: ProgressFn = () => {},
  onPartial: PartialFn = () => {},
  options: { incremental?: boolean } = {}
): Promise<RefreshOutcome> {
  if (provider.type === 'xtream') {
    if (!provider.serverUrl || !provider.username || !provider.password) {
      throw new Error('A szolgáltatóhoz nincs eltárolva szerver, felhasználó vagy jelszó.');
    }

    /*
     * NÖVEKMÉNYES FRISSÍTÉS – ELŐSZÖR AZ OLCSÓ ELLENŐRZÉS.
     *
     * A szolgáltató Xtream API-jának nincs változás-végpontja, ezért a
     * legolcsóbb jelzés a három kategórialista (~44 kB). Ha ez mindenben
     * azonos a legutóbbi teljes szinkronéval, ÉS az nem régebbi a
     * frissességi ablaknál, akkor a 76 MB-os listák újratöltése felesleges:
     * a tárolt tartalom marad, a felület pedig megmondja, mi történt.
     */
    if (options.incremental) {
      const state = loadSyncState(provider.id);
      if (state) {
        try {
          onProgress({ phase: 'Változások ellenőrzése…', percent: 4 });
          const check = await checkProviderChanges({
            serverUrl: provider.serverUrl,
            username: provider.username,
            password: provider.password,
            fingerprint: state.fingerprint,
            lastFullSyncAt: state.fullSyncAt,
          });
          /*
           * A DÖNTÉS KIZÁRÓLAG A VÁLTOZÁSVIZSGÁLAT EREDMÉNYE.
           * A frissesség-ablak (check.fresh) már csak tájékoztató adat:
           * nem kényszerít teljes újratöltést. A kategóriákon belüli
           * változást a 12 órás háttér-ellenőrzés fedezi fel.
           */
          if (check.unchanged) {
            const ageMinutes = Math.round((check.ageMs ?? 0) / 60000);
            logProviderEvent(
              `Frissítés: a kategóriák nem változtak (${check.counts.live}/${check.counts.vod}/${check.counts.series}), ` +
              `az utolsó teljes ellenőrzés ${ageMinutes} perce volt – a teljes listák nem töltődnek le újra.`
            );
            return { unchanged: true, check };
          }
          logProviderEvent('Frissítés: a kategóriák változtak – teljes letöltés következik.');
        } catch (error) {
          // Ha az ellenőrzés nem megy (halott panel), a teljes import ad
          // értelmes hibát – nem nyomjuk el.
          logProviderEvent(`Frissítés: a változás-ellenőrzés nem sikerült (${safeErrorDetail(error)}); teljes letöltés következik.`);
        }
      }
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
    // A most letöltött kategóriák lesznek a következő ellenőrzés viszonyítási alapjai.
    saveSyncState({
      providerId: provider.id,
      fingerprint: result.fingerprint ?? providerFingerprint(result.content),
      fullSyncAt: Date.now(),
    });
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
