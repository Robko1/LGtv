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
 *    jött. A TS ugyanott 146–159 mp-ig hibátlan volt. A lejátszó mégis
 *    HLS-t indított („kipróbálás a jobb képért”), a `playing` pillanatában
 *    HLS-t jegyzett meg a csatornához, és a megszakadás után is HLS-sel
 *    csatlakozott újra → „a csatorna egy idő után megfagy”, TV Doktorral és
 *    anélkül is.
 *
 * 2) INDULÁSI ADATHIÁNY. A 2. szolgáltató minden frissen megnyitott
 *    csatornánál 10 mp-nyi adatot küld egyben, utána 15–30 mp-ig semmit:
 *    a kép ~2 mp alatt megjelenik, ~8 mp-nél megáll, és 9–17 mp múlva megy
 *    tovább. Ezt a hiányzó adatot semmilyen lejátszó nem tudja pótolni –
 *    csak az dönthető el, hogy a várakozás a kép ELŐTT vagy KÖZBEN legyen.
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
  /** Az indulási puffer-tartás ezen a TV-n / hoszton nem működött. */
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
/** Az indulási tartás határai. */
export const START_CUSHION_MIN_MS = 6_000;
export const START_CUSHION_MAX_MS = 20_000;
/** Ha a puffer ennyi másodperccel a lejátszási pont elé ér, a tartás azonnal véget ér. */
export const START_CUSHION_TARGET_AHEAD_SECONDS = 15;

let memoryCache: Record<string, HostHealth> | null = null;

function emptyHealth(): HostHealth {
  return {
    hlsDeaths: 0, tsDeaths: 0, hlsStable: 0, tsStable: 0,
    starve: 0, smooth: 0, gapMs: 0, cushionBroken: false, updatedAt: 0,
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

/* ─────────────────────── 2) INDULÁSI ADATHIÁNY ─────────────────────── */

export function recordStartStarvation(host: string, stallMs: number, now = Date.now()): HostHealth {
  const observed = Math.max(START_STARVE_MIN_MS, Math.min(60_000, Number(stallMs) || 0));
  return update(host, (health) => {
    health.starve = clampCount(health.starve + 1);
    health.smooth = clampCount(health.smooth - 1);
    // A hosszabb megállás a mérvadó: a tartásnak azt kell áthidalnia.
    health.gapMs = Math.round(health.gapMs > 0
      ? Math.max(observed, health.gapMs * 0.7 + observed * 0.3)
      : observed);
  }, now);
}

export function recordSmoothStart(host: string, now = Date.now()): HostHealth {
  return update(host, (health) => {
    health.smooth = clampCount(health.smooth + 1);
    health.starve = clampCount(health.starve - 1);
    if (health.starve === 0) health.gapMs = 0;
  }, now);
}

export function markStartCushionBroken(host: string, now = Date.now()): HostHealth {
  return update(host, (health) => { health.cushionBroken = true; }, now);
}

export interface StartCushionPlan {
  /** Legfeljebb ennyi ideig tartjuk az első képkockát (ms). */
  holdMs: number;
  /** Ennyi előre pufferelt másodpercnél a tartás azonnal véget ér. */
  targetAheadSeconds: number;
}

/**
 * Kell-e indulási puffer-tartás ezen a szolgáltatón?
 *
 * Csak akkor, ha az indulási adathiány legalább KÉTSZER megismétlődött és
 * gyakoribb, mint a megállás nélküli indulás. A tartás hossza a mért
 * megállásból számolódik (+2 mp tartalék), szigorú 20 mp-es felső korláttal.
 */
export function startCushionPlan(host: string): StartCushionPlan | null {
  const health = readAll()[String(host || '').trim()];
  if (!health || health.cushionBroken) return null;
  if (health.starve < 2 || health.starve <= health.smooth) return null;
  const holdMs = Math.max(START_CUSHION_MIN_MS, Math.min(START_CUSHION_MAX_MS, Math.round(health.gapMs + 2000)));
  return { holdMs, targetAheadSeconds: START_CUSHION_TARGET_AHEAD_SECONDS };
}

export type StartCushionDecision = 'hold' | 'release-buffer' | 'release-time';

/** A tartás alatti másodpercenkénti döntés (tiszta függvény). */
export function startCushionDecision(params: {
  elapsedMs: number;
  plan: StartCushionPlan;
  /** A lejátszási pont elé pufferelt másodpercek; null, ha a TV nem közli. */
  aheadSeconds: number | null;
}): StartCushionDecision {
  if (params.aheadSeconds !== null && Number.isFinite(params.aheadSeconds)
      && params.aheadSeconds >= params.plan.targetAheadSeconds) {
    return 'release-buffer';
  }
  if (params.elapsedMs >= params.plan.holdMs) return 'release-time';
  return 'hold';
}

export type StartFlowEvent =
  | { kind: 'none' }
  | { kind: 'starved'; stallMs: number }
  | { kind: 'smooth' };

/**
 * Az indulás utáni adatfolyam megfigyelője.
 *
 * Kizárólag az idővonal tényleges haladását nézi (a `waiting` esemény a
 * #66-os naplóban 14 mp-es megállásnál sem jött meg). Egy betöltésre
 * legfeljebb EGY eredményt ad:
 *   - `starved`: az indulás utáni ablakban kezdődött, legalább 4 mp-es
 *     megállás MAGÁTÓL megoldódott (az adat megérkezett);
 *   - `smooth`:  30 mp telt el ilyen megállás nélkül.
 */
export class StartFlowObserver {
  private begun = false;
  private startedAt = 0;
  private lastTime = 0;
  private lastProgressAt = 0;
  private reported = false;

  reset(): void {
    this.begun = false;
    this.startedAt = 0;
    this.lastTime = 0;
    this.lastProgressAt = 0;
    this.reported = false;
  }

  /** A megfigyelés indítása (az első képkocka, illetve a tartás vége). */
  begin(now: number, currentTime: number): void {
    this.begun = true;
    this.startedAt = now;
    this.lastTime = Number.isFinite(currentTime) ? currentTime : 0;
    this.lastProgressAt = now;
    this.reported = false;
  }

  get active(): boolean {
    return this.begun && !this.reported;
  }

  observe(sample: { now: number; currentTime: number; paused: boolean }): StartFlowEvent {
    if (!this.active) return { kind: 'none' };
    const { now } = sample;
    const currentTime = Number.isFinite(sample.currentTime) ? sample.currentTime : this.lastTime;
    if (sample.paused) {
      // Szünet alatt nem mérünk adathiányt: a megállás nem a szolgáltatóé.
      this.lastProgressAt = now;
      this.lastTime = currentTime;
      return { kind: 'none' };
    }
    if (currentTime - this.lastTime > 0.05) {
      const stallMs = now - this.lastProgressAt;
      const stallBeganAt = this.lastProgressAt;
      this.lastTime = currentTime;
      this.lastProgressAt = now;
      if (stallMs >= START_STARVE_MIN_MS && stallBeganAt - this.startedAt <= START_STARVE_WINDOW_MS) {
        this.reported = true;
        return { kind: 'starved', stallMs };
      }
    }
    // Csak akkor „sima”, ha éppen most is halad (nem egy megállás közepén járunk).
    if (now - this.startedAt >= START_SMOOTH_MS && now - this.lastProgressAt < 2000) {
      this.reported = true;
      return { kind: 'smooth' };
    }
    return { kind: 'none' };
  }
}
