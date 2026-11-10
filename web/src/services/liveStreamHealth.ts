/*
 * 2.5.419 – ÉLŐ ADÁS SZOLGÁLTATÓNKÉNTI „EGÉSZSÉG-EMLÉKEZETE”.
 *
 * A #66-os TV-napló (2.5.418, valódi LG TV) két, egymástól független,
 * SZOLGÁLTATÓRA jellemző hibamintát bizonyított:
 *
 * 1) FORMÁTUM, AMELY ELINDUL, DE NÉHÁNY TUCAT MÁSODPERC UTÁN ELHAL.
 *    Az 1. szolgáltatón a HLS (.m3u8) minden hosszabb nézésnél ~50 mp után
 *    `MEDIA_ERR_DECODE (3)` hibával megállt (a puffer vége soha nem lépett
 *    túl az első lejátszási listán), vagy már induláskor `Format error (4)`
 *    jött; a TS ugyanott nem halt el. A lejátszó mégis
 *    HLS-t indított („kipróbálás a jobb képért”), a `playing` pillanatában
 *    HLS-t jegyzett meg a csatornához, és a megszakadás után is HLS-sel
 *    csatlakozott újra → „a csatorna egy idő után megfagy”, TV Doktorral és
 *    anélkül is.
 *
 * 2) SZAKASZOS ADATKÜLDÉS. A 2. szolgáltató minden frissen megnyitott
 *    csatornánál 10 mp-nyi adatot küld egyben, utána ~17 mp-ig semmit, majd
 *    10 mp-es adagokban, egyenetlenül: a kép ~2 mp alatt megjelenik, ~8
 *    mp-nél megáll, 9–17 mp múlva megy tovább, és később is meg-megakad.
 *    A hiányzó adatot semmilyen lejátszó nem tudja pótolni – csak az
 *    dönthető el, hogy a várakozás EGYBEN vagy apró megakadásokban teljen
 *    (részletek a modul 2. szakaszánál; 2.5.420, #67-es napló).
 *
 * Ez a modul TISZTA döntéseket és egy kicsi, szolgáltató-hosztonkénti
 * tartós számlálót ad; a lejátszó csak bekötést tartalmaz. Nincs benne sem
 * szolgáltatónév, sem csatornanév: a döntés kizárólag a helyben MÉRT
 * viselkedésből következik, ezért minden szolgáltatónál ugyanúgy működik.
 */

export type LiveStreamFormat = 'ts' | 'hls';

export interface HostHealth {
  /** Lejátszás közbeni KORAI elhalások (hiba / lezárás) formátumonként. */
  hlsDeaths: number;
  tsDeaths: number;
  /** Tartósan (≥ FORMAT_STABLE_MS) hibátlan lejátszások formátumonként. */
  hlsStable: number;
  tsStable: number;
  /** Indulási adathiány-megfigyelések (magától megoldódó korai megállás). */
  starve: number;
  /** Megállás nélküli indulások. */
  smooth: number;
  /** A megfigyelt indulási megállások jellemző hossza (ms). */
  gapMs: number;
  /** Az indulási megállás utáni tanult késleltetés-tartalék (ms); 0 = alapérték. */
  extraMs: number;
  /** A szándékos tartás ezen a TV-n / hoszton nem működött (a TV nem folytatta a lejátszást). */
  cushionBroken: boolean;
  updatedAt: number;
}

const STORAGE_KEY = 'iptv_rt_live_stream_health_v1';
const MAX_HOSTS = 40;
const COUNTER_CAP = 12;

/** Ennyi egészséges lejátszáson BELÜLI megszakadás számít a formátum korai elhalásának. */
export const EARLY_FORMAT_DEATH_MS = 180_000;
/** Ennyi folyamatos, egészséges lejátszás után „bizonyítottan tartós” a formátum. */
export const FORMAT_STABLE_MS = 90_000;
/** Az indulás utáni ablak, amelyben a megállás „indulási adathiánynak” számít. */
export const START_STARVE_WINDOW_MS = 20_000;
/** Ennél rövidebb megállás nem számít (hétköznapi apró újrapufferelés). */
export const START_STARVE_MIN_MS = 4_000;
/** Megállás nélküli indulásnak ennyi zavartalan lejátszás kell. */
export const START_SMOOTH_MS = 30_000;

let memoryCache: Record<string, HostHealth> | null = null;

function emptyHealth(): HostHealth {
  return {
    hlsDeaths: 0, tsDeaths: 0, hlsStable: 0, tsStable: 0,
    starve: 0, smooth: 0, gapMs: 0, extraMs: 0, cushionBroken: false, updatedAt: 0,
  };
}

function clampCount(value: unknown): number {
  const number = Math.floor(Number(value) || 0);
  return Math.max(0, Math.min(COUNTER_CAP, number));
}

function readAll(): Record<string, HostHealth> {
  if (memoryCache) return memoryCache;
  const result: Record<string, HostHealth> = {};
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      for (const [host, value] of Object.entries(parsed as Record<string, Partial<HostHealth>>)) {
        if (!host || !value || typeof value !== 'object') continue;
        result[host] = {
          hlsDeaths: clampCount(value.hlsDeaths),
          tsDeaths: clampCount(value.tsDeaths),
          hlsStable: clampCount(value.hlsStable),
          tsStable: clampCount(value.tsStable),
          starve: clampCount(value.starve),
          smooth: clampCount(value.smooth),
          gapMs: Math.max(0, Math.min(60_000, Number(value.gapMs) || 0)),
          extraMs: Math.max(0, Math.min(60_000, Number(value.extraMs) || 0)),
          cushionBroken: value.cushionBroken === true,
          updatedAt: Number(value.updatedAt) || 0,
        };
      }
    }
  } catch {
    /* sérült vagy nem olvasható tár: üres emlékezettel indulunk */
  }
  memoryCache = result;
  return result;
}

function writeAll(all: Record<string, HostHealth>): void {
  const hosts = Object.keys(all);
  if (hosts.length > MAX_HOSTS) {
    hosts.sort((a, b) => (all[a].updatedAt || 0) - (all[b].updatedAt || 0));
    for (const host of hosts.slice(0, hosts.length - MAX_HOSTS)) delete all[host];
  }
  memoryCache = all;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* a webOS tárhelye megtelhet – a memóriában tartott érték ettől még működik */
  }
}

function update(host: string, mutate: (health: HostHealth) => void, now = Date.now()): HostHealth {
  const key = String(host || '').trim();
  if (!key) return emptyHealth();
  const all = readAll();
  const health = all[key] || emptyHealth();
  mutate(health);
  health.updatedAt = now;
  all[key] = health;
  writeAll(all);
  return health;
}

/** A stream-cím szolgáltató-hosztja (`host:port`), ez a tanulás kulcsa. */
export function streamHostKey(url: string | null | undefined): string {
  const value = String(url || '').trim();
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(value);
  if (!match) return '';
  return match[1].replace(/^[^@]*@/, '').toLowerCase();
}

export function readHostHealth(host: string): HostHealth {
  const key = String(host || '').trim();
  return { ...(readAll()[key] || emptyHealth()) };
}

/** Teszteknek és a „minden tanult adat törlése” műveletnek. */
export function resetLiveStreamHealth(): void {
  memoryCache = {};
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nem írható tár */
  }
}

/** A tár közvetlen módosítása után (tesztek) a memóriabeli másolat eldobása. */
export function forgetLiveStreamHealthCache(): void {
  memoryCache = null;
}

/* ───────────────────────── 1) FORMÁTUM-EGÉSZSÉG ───────────────────────── */

export function isEarlyFormatDeath(healthyPlaybackMs: number): boolean {
  return Number(healthyPlaybackMs) < EARLY_FORMAT_DEATH_MS;
}

export function recordFormatDeath(host: string, format: LiveStreamFormat, now = Date.now()): HostHealth {
  return update(host, (health) => {
    if (format === 'hls') health.hlsDeaths = clampCount(health.hlsDeaths + 1);
    else health.tsDeaths = clampCount(health.tsDeaths + 1);
  }, now);
}

export function recordFormatStable(host: string, format: LiveStreamFormat, now = Date.now()): HostHealth {
  return update(host, (health) => {
    if (format === 'hls') {
      health.hlsStable = clampCount(health.hlsStable + 1);
      health.hlsDeaths = clampCount(health.hlsDeaths - 1);
    } else {
      health.tsStable = clampCount(health.tsStable + 1);
      health.tsDeaths = clampCount(health.tsDeaths - 1);
    }
  }, now);
}

/**
 * Megbízhatatlan-e a formátum ezen a szolgáltatón?
 *
 * Legalább KÉT korai elhalás kell, és több mint kétszer annyi, mint ahány
 * tartósan hibátlan lejátszás volt. Egyetlen kiesés (vagy egy hálózati
 * zavar) tehát soha nem bélyegez meg egy formátumot, a jól működő formátum
 * pedig néhány jó nézés után a ritka hibák ellenére is megbízható marad.
 */
export function isFormatDistrusted(host: string, format: LiveStreamFormat): boolean {
  const health = readAll()[String(host || '').trim()];
  if (!health) return false;
  const deaths = format === 'hls' ? health.hlsDeaths : health.tsDeaths;
  const stable = format === 'hls' ? health.hlsStable : health.tsStable;
  return deaths >= 2 && deaths > stable * 2;
}

export interface HealthyFormatChoice {
  format: LiveStreamFormat;
  changed: boolean;
  reason: string;
}

/**
 * Az indítási formátum utolsó ellenőrzése: a szolgáltatón bizonyítottan
 * elhaló formátum helyett a másikat indítjuk – akkor is, ha a csatorna
 * formátum-emléke, a „szebb kép” választó vagy a TV Doktor tanult profilja
 * azt kérné. A néző KÉZZEL beállított formátumát nem írjuk felül.
 */
export function chooseHealthyStartFormat(params: {
  host: string;
  format: LiveStreamFormat;
  hasAlternative: boolean;
  /** A néző a Beállításokban kifejezetten ezt a formátumot kérte. */
  userForced?: boolean;
}): HealthyFormatChoice {
  const format: LiveStreamFormat = params.format === 'hls' ? 'hls' : 'ts';
  const keep: HealthyFormatChoice = { format, changed: false, reason: 'a formátum ezen a szolgáltatón nem megbízhatatlan' };
  if (!params.host || !params.hasAlternative) return keep;
  if (!isFormatDistrusted(params.host, format)) return keep;
  const other: LiveStreamFormat = format === 'hls' ? 'ts' : 'hls';
  const health = readHostHealth(params.host);
  const deaths = format === 'hls' ? health.hlsDeaths : health.tsDeaths;
  const stable = format === 'hls' ? health.hlsStable : health.tsStable;
  if (isFormatDistrusted(params.host, other)) {
    return { ...keep, reason: 'mindkét formátum többször elhalt ezen a szolgáltatón – nincs jobb választás' };
  }
  if (params.userForced) {
    return { ...keep, reason: `a ${format.toUpperCase()} kézzel beállított formátum – a többszöri elhalás ellenére is ezt indítjuk` };
  }
  return {
    format: other,
    changed: true,
    reason: `a ${format.toUpperCase()} ezen a szolgáltatón ${deaths} alkalommal elhalt lejátszás közben `
      + `(tartósan hibátlan: ${stable}) – ${other.toUpperCase()} indul`,
  };
}

/**
 * Lejátszás közben elhalt formátum után a MÁSIK formátummal érdemes-e
 * újracsatlakozni? (Az elhalás rögzítése UTÁN kell hívni.)
 *
 * Csak akkor, ha az elhalás korai volt, a formátum ezen a szolgáltatón már
 * MEGBÍZHATATLAN (legalább a második elhalás, tartósan jó nézés nélkül), a
 * másik formátum pedig nem az. Az ELSŐ kiesés után tehát ugyanarra a címre
 * csatlakozunk vissza: egy pillanatnyi zavar nem indít formátumugrást (ez a
 * régi, bevált szabály), a visszatérően elhaló formátumból viszont kilépünk.
 */
export function shouldSwitchFormatAfterDeath(params: {
  host: string;
  format: LiveStreamFormat;
  healthyPlaybackMs: number;
  hasAlternative: boolean;
}): boolean {
  if (!params.hasAlternative || !isEarlyFormatDeath(params.healthyPlaybackMs)) return false;
  if (!isFormatDistrusted(params.host, params.format)) return false;
  const other: LiveStreamFormat = params.format === 'hls' ? 'ts' : 'hls';
  return !isFormatDistrusted(params.host, other);
}

/* ───────────── 2) SZAKASZOS ADATKÜLDÉS: INDULÁSI ADATHIÁNY ÉS KÉSLELTETÉS-TARTALÉK ─────────────
 *
 * 2.5.420 – a #67-es TV-napló (2.5.419, valódi LG TV, 2. szolgáltató) a
 * szerver adatküldését pontosan megmutatta (TV2 HD, 185 mp nézés):
 *
 *   - az adat 10 mp-es ADAGOKBAN érkezik: az első adag azonnal, a második
 *     csak ~17 mp múlva, utána adagonként ~11–12 mp-enként (időnként egy
 *     6 mp-es „behozó” adaggal). A szerver tehát VALÓS IDŐBEN, de egyenetlenül
 *     küld – előre SOHA nem ad többet;
 *   - a TV már ~2,7 mp-nyi pufferrel megáll (`waiting`, readyState=2);
 *   - ezért a kép az első megállás (11,5 mp) után is alig az adagok mögött
 *     halad, és minden kicsit későbbi adagnál újra megáll: 2,6 + 0,3 + 0,5 +
 *     1,4 mp – „pufferel tévénézés közben is”, TV Doktorral és anélkül is.
 *
 * A megállások összege (~16 mp) az a KÉSLELTETÉS, amennyivel a képnek az
 * adagok mögött kell járnia, hogy a késő adag se érje utol. A hiányzó adatot
 * nem lehet pótolni; azt viszont el lehet dönteni, hogy ez a várakozás EGYBEN,
 * az első (úgyis elkerülhetetlen) megállás végén teljen le, és ne apró
 * megakadásokban a műsor közben. Ez a „késleltetés-tartalék”:
 *
 *   - csak olyan szolgáltatón él, ahol az indulási adathiány ISMÉTELTEN
 *     megfigyelhető volt (jól működő szolgáltatóhoz nem nyúl);
 *   - csak egy TÉNYLEGESEN bekövetkezett megállás végét hosszabbítja meg
 *     (megállás nélküli indulásnál nincs semmilyen várakozás);
 *   - a TV Doktor kapcsolótól független: a sima tévénézés része.
 *
 * A 2.5.419 TV Doktor-féle „első képkocka tartása” megszűnt: a naplóban a
 * mért megállás hosszából számolt 12 mp kevés volt (a szükséges késleltetés
 * nem a megállás hossza), és a csatornaváltáskor azonnal megjelenő mozgó
 * kép többet ér a nézőnek, mint egy állókép.
 */

/** A második és további megfigyeléstől számít „szakaszosan küldőnek” a szolgáltató. */
export const BURSTY_HOST_MIN_OBSERVATIONS = 2;
/** Az indulási megállás UTÁNI tartalék, amíg a szolgáltatóról nincs pontosabb tudás. */
export const LIVE_HOLD_DEFAULT_EXTRA_MS = 6_000;
export const LIVE_HOLD_MIN_EXTRA_MS = 2_000;
export const LIVE_HOLD_MAX_EXTRA_MS = 12_000;
/** Egy KÉSŐBBI (műsor közbeni) megállás utáni ráhagyás. */
export const LIVE_HOLD_LATER_MS = 2_000;
/** A megállások és tartások együttes hossza egy betöltésen belül legfeljebb ennyi lehet. */
export const LIVE_LAG_MAX_MS = 25_000;
/** Ennél rövidebb megakadás nem számít megállásnak. */
export const LIVE_STALL_MIN_MS = 800;
/** Esemény nélküli megállás: ennyi ideig nem haladt az idővonal. */
export const LIVE_SILENT_STALL_MIN_MS = 1_800;
/** Ennyi megállás nélküli lejátszás után vizsgáljuk, túl nagy-e a tartalék. */
export const LIVE_SPARE_WINDOW_MS = 120_000;
/**
 * Ha a puffer közben végig legalább ennyi volt, a tartalék csökkenthető.
 * Szándékosan óvatos: a túl nagy tartalék ára néhány másodperc csatorna-
 * váltáskor, a túl kicsié viszont megakadás a műsor közben.
 */
export const LIVE_SPARE_AHEAD_SECONDS = 10;

export function recordStartStarvation(host: string, stallMs: number, now = Date.now()): HostHealth {
  const observed = Math.max(START_STARVE_MIN_MS, Math.min(60_000, Number(stallMs) || 0));
  return update(host, (health) => {
    health.starve = clampCount(health.starve + 1);
    health.smooth = clampCount(health.smooth - 1);
    health.gapMs = Math.round(health.gapMs > 0
      ? Math.max(observed, health.gapMs * 0.7 + observed * 0.3)
      : observed);
  }, now);
}

export function recordSmoothStart(host: string, now = Date.now()): HostHealth {
  return update(host, (health) => {
    health.smooth = clampCount(health.smooth + 1);
    health.starve = clampCount(health.starve - 1);
    if (health.starve === 0) {
      health.gapMs = 0;
      health.extraMs = 0;
    }
  }, now);
}

/** A szándékos tartás után a TV nem folytatta a lejátszást: többé nem tartunk. */
export function markLiveHoldBroken(host: string, now = Date.now()): HostHealth {
  return update(host, (health) => { health.cushionBroken = true; }, now);
}

/**
 * Szakaszosan küld-e a szolgáltató? Legalább KÉT indulási adathiány kell,
 * és több, mint ahány megállás nélküli indulás volt.
 */
export function isBurstyHost(host: string): boolean {
  const health = readAll()[String(host || '').trim()];
  if (!health || health.cushionBroken) return false;
  return health.starve >= BURSTY_HOST_MIN_OBSERVATIONS && health.starve > health.smooth;
}

/** Az indulási megállás utáni tartalék hossza ezen a szolgáltatón (ms). */
export function liveHoldExtraMs(host: string): number {
  const health = readAll()[String(host || '').trim()];
  const learned = health ? Number(health.extraMs) || 0 : 0;
  if (learned <= 0) return LIVE_HOLD_DEFAULT_EXTRA_MS;
  return Math.max(LIVE_HOLD_MIN_EXTRA_MS, Math.min(LIVE_HOLD_MAX_EXTRA_MS, Math.round(learned)));
}

/**
 * Egy éppen véget ért megállás után mennyi ideig tartsuk még a képet?
 *
 *   - indulási adathiány (az indulás utáni első, ≥ 4 mp-es megállás): a
 *     szolgáltatóra tanult tartalék (alapból 6 mp);
 *   - későbbi megállás: 2 mp ráhagyás (a megállás hossza önmagában pont
 *     annyi késleltetést ad, amennyi a MOSTANI késő adaghoz kellett – a
 *     következő, kicsit későbbi adag megint megállítaná);
 *   - a megállások és tartások összege a betöltésen belül legfeljebb 25 mp.
 *
 * 0-t ad, ha a szolgáltató nem szakaszosan küld (ott nincs beavatkozás).
 */
export function liveStallHoldMs(params: {
  host: string;
  /** Ez a megállás az indulási adathiány volt. */
  start: boolean;
  /** A betöltés eddigi megállásainak és tartásainak összege (ezzel a megállással együtt). */
  lagSoFarMs: number;
}): number {
  if (!isBurstyHost(params.host)) return 0;
  const wanted = params.start ? liveHoldExtraMs(params.host) : LIVE_HOLD_LATER_MS;
  const room = LIVE_LAG_MAX_MS - Math.max(0, Number(params.lagSoFarMs) || 0);
  const hold = Math.min(wanted, room);
  return hold >= 500 ? Math.round(hold) : 0;
}

/**
 * A tartalék kevésnek bizonyult: az indulási megállás UTÁN összesen ennyi
 * további késleltetés (későbbi megállás + tartások) kellett. A következő
 * csatornaindításnál már ennyit tartunk egyben.
 */
export function recordLiveHoldExtra(host: string, extraMs: number, now = Date.now()): HostHealth {
  const needed = Math.max(LIVE_HOLD_MIN_EXTRA_MS, Math.min(LIVE_HOLD_MAX_EXTRA_MS, Math.round(Number(extraMs) || 0)));
  return update(host, (health) => {
    health.extraMs = Math.max(health.extraMs > 0 ? health.extraMs : LIVE_HOLD_DEFAULT_EXTRA_MS, needed);
  }, now);
}

/** A tartalék bőven elég volt (a puffer végig nagy maradt): 1 mp-cel csökken. */
export function reduceLiveHoldExtra(host: string, now = Date.now()): HostHealth {
  return update(host, (health) => {
    const current = health.extraMs > 0 ? health.extraMs : LIVE_HOLD_DEFAULT_EXTRA_MS;
    health.extraMs = Math.max(LIVE_HOLD_MIN_EXTRA_MS, current - 1000);
  }, now);
}

export type LiveFlowEvent =
  | { kind: 'none' }
  /** Egy megállás MAGÁTÓL véget ért (az adat megérkezett). */
  | {
    kind: 'stall';
    stallMs: number;
    /** Ez volt az indulási adathiány (az indulás utáni ablakban kezdődött, ≥ 4 mp). */
    start: boolean;
    /** A betöltés indulási megállásának hossza (0, ha nem volt). */
    startStallMs: number;
    /** Az indulási megállás UTÁNI megállások és tartások összege, ezzel a megállással együtt. */
    extraLagMs: number;
  }
  /** 30 mp telt el indulási adathiány nélkül. */
  | { kind: 'smooth' }
  /** 2 perc megállás nélküli lejátszás az indulási adathiány (és tartás) után. */
  | { kind: 'spare'; minAheadSeconds: number | null };

/**
 * Egy élő betöltés adatfolyamának megfigyelője (tiszta osztály).
 *
 * Kizárólag az idővonal tényleges haladásából dolgozik; a `waiting` /
 * `playing` események csak PONTOSÍTJÁK a megállás kezdetét és végét (a
 * naplókban volt 14 mp-es megállás `waiting` nélkül is). A néző által kért
 * szünetet és a szándékos tartást nem tekinti megállásnak.
 */
export class LiveFlowTracker {
  private begun = false;
  private startedAt = 0;
  private lastTime = 0;
  private lastProgressAt = 0;
  private waitingAt: number | null = null;
  private waitingTime = 0;
  private startResult: 'pending' | 'starved' | 'smooth' = 'pending';
  private startStall = 0;
  private extraLag = 0;
  private cleanSince = 0;
  private minAhead: number | null = null;
  private spareReported = false;

  reset(): void {
    this.begun = false;
    this.startedAt = 0;
    this.lastTime = 0;
    this.lastProgressAt = 0;
    this.waitingAt = null;
    this.startResult = 'pending';
    this.startStall = 0;
    this.extraLag = 0;
    this.cleanSince = 0;
    this.minAhead = null;
    this.spareReported = false;
  }

  /** A megfigyelés indítása: a betöltés első képkockája. */
  begin(now: number, currentTime: number): void {
    this.reset();
    this.begun = true;
    this.startedAt = now;
    this.lastTime = Number.isFinite(currentTime) ? currentTime : 0;
    this.lastProgressAt = now;
    this.cleanSince = now;
  }

  get active(): boolean { return this.begun; }
  /** Volt-e ebben a betöltésben indulási adathiány. */
  get starved(): boolean { return this.startResult === 'starved'; }
  /** A betöltés megállásainak és tartásainak összege (ms). */
  get lagMs(): number { return this.startStall + this.extraLag; }
  get extraLagMs(): number { return this.extraLag; }

  /** `waiting` esemény valódi adathiánnyal (readyState < 3): a megállás pontos kezdete. */
  noteWaiting(now: number, currentTime: number): void {
    if (!this.begun || this.waitingAt !== null) return;
    this.waitingAt = now;
    this.waitingTime = Number.isFinite(currentTime) ? currentTime : this.lastTime;
  }

  /** A szándékos tartás hossza beleszámít a késleltetésbe, de nem megállás. */
  noteHold(heldMs: number, now: number): void {
    if (!this.begun) return;
    if (this.startResult === 'starved') this.extraLag += Math.max(0, Number(heldMs) || 0);
    this.lastProgressAt = now;
    this.waitingAt = null;
    this.cleanSince = now;
    this.minAhead = null;
  }

  private closeStall(startedAt: number, now: number): LiveFlowEvent {
    const stallMs = now - startedAt;
    if (stallMs < LIVE_STALL_MIN_MS) return { kind: 'none' };
    this.cleanSince = now;
    this.minAhead = null;
    if (this.startResult === 'pending' && stallMs >= START_STARVE_MIN_MS
        && startedAt - this.startedAt <= START_STARVE_WINDOW_MS) {
      this.startResult = 'starved';
      this.startStall = stallMs;
      return { kind: 'stall', stallMs, start: true, startStallMs: stallMs, extraLagMs: 0 };
    }
    if (this.startResult === 'starved') this.extraLag += stallMs;
    return { kind: 'stall', stallMs, start: false, startStallMs: this.startStall, extraLagMs: this.extraLag };
  }

  /**
   * `playing` esemény a betöltés első képkockája UTÁN: ha megállás volt
   * folyamatban, az most ért véget – még mielőtt a kép újra elindulna.
   */
  resumed(now: number, currentTime: number): LiveFlowEvent {
    if (!this.begun) return { kind: 'none' };
    const time = Number.isFinite(currentTime) ? currentTime : this.lastTime;
    const fromWaiting = this.waitingAt !== null;
    const stallStart = fromWaiting
      ? this.waitingAt
      : (now - this.lastProgressAt >= LIVE_SILENT_STALL_MIN_MS ? this.lastProgressAt : null);
    this.waitingAt = null;
    if (stallStart === null) return { kind: 'none' };
    // Ha a kép a „megállás” alatt végig haladt, az nem megállás volt (hamis `waiting`).
    const advancedMs = Math.max(0, time - (fromWaiting ? this.waitingTime : this.lastTime)) * 1000;
    const stallMs = now - stallStart;
    this.lastProgressAt = now;
    this.lastTime = Math.max(this.lastTime, time);
    if (advancedMs > stallMs * 0.5) return { kind: 'none' };
    return this.closeStall(stallStart, now);
  }

  /** Másodpercenkénti minta. */
  observe(sample: { now: number; currentTime: number; paused: boolean; aheadSeconds?: number | null }): LiveFlowEvent {
    if (!this.begun) return { kind: 'none' };
    const { now } = sample;
    const currentTime = Number.isFinite(sample.currentTime) ? sample.currentTime : this.lastTime;
    if (sample.paused) {
      // Szünet (a néző kérte, vagy szándékos tartás): nem a szolgáltató megállása.
      this.lastProgressAt = now;
      this.lastTime = currentTime;
      this.waitingAt = null;
      return { kind: 'none' };
    }
    if (currentTime - this.lastTime <= 0.05) return { kind: 'none' };
    if (this.waitingAt !== null && currentTime - this.waitingTime <= 0.05) {
      // A minta és a `waiting` között még haladt a kép, azóta áll: a megállás
      // a `waiting` pillanatában kezdődött, és még tart.
      this.lastTime = currentTime;
      this.lastProgressAt = this.waitingAt;
      return { kind: 'none' };
    }
    const gapMs = now - this.lastProgressAt;
    const stallStart = this.lastProgressAt;
    this.lastTime = currentTime;
    this.lastProgressAt = now;
    this.waitingAt = null;
    if (gapMs >= LIVE_SILENT_STALL_MIN_MS) {
      // Esemény nélküli megállás ért véget (a `playing` nem jött meg).
      const event = this.closeStall(stallStart, now);
      if (event.kind !== 'none') return event;
    }
    const ahead = sample.aheadSeconds;
    if (typeof ahead === 'number' && Number.isFinite(ahead)) {
      this.minAhead = this.minAhead === null ? ahead : Math.min(this.minAhead, ahead);
    }
    if (this.startResult === 'pending' && now - this.startedAt >= START_SMOOTH_MS) {
      this.startResult = 'smooth';
      return { kind: 'smooth' };
    }
    if (this.startResult === 'starved' && !this.spareReported && now - this.cleanSince >= LIVE_SPARE_WINDOW_MS) {
      this.spareReported = true;
      return { kind: 'spare', minAheadSeconds: this.minAhead };
    }
    return { kind: 'none' };
  }
}
