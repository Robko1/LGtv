/**
 * ÉLŐ KÉPMINŐSÉG-EMLÉKEZET – csatornánként, formátumonként MÉRT felbontás.
 *
 * MIÉRT KELL (éles napló #30 alapján):
 *
 *   A szolgáltató ugyanazt a csatornát két formátumban kínálja:
 *     • MPEG-TS (.ts)  – például [HU] HBO UHD: 1024x576 (SD+)
 *     • HLS (.m3u8)    – ugyanaz a csatorna:   1920x1080 (Full HD)
 *   Más csatornánál fordítva: a HLS 720x405, a TS 1024x576.
 *   A napló a felbontásváltást is rögzítette:
 *     „KÉPMINŐSÉG FELBONTÁS VÁLTOZOTT; cím=[HU] BBC EARTH UHD; 1024x576 → 1920x1080”.
 *
 *   A lejátszó (és a TV Doktor tanulása) eddig KIZÁRÓLAG azt nézte, melyik
 *   formátum indul el gyorsabban / melyik hibázott – a FELBONTÁST soha.
 *   Ezért fordult elő, hogy egy Full HD adás SD képként jelent meg, holott
 *   ugyanannak a csatornának a másik formátuma Full HD volt.
 *
 * MIT CSINÁL:
 *   A lejátszó a ténylegesen dekódolt kép méretét (videoWidth × videoHeight)
 *   formátumonként elmenti a csatornához. Indításkor a modul a MÉRT adatokból
 *   választja ki a jobb képű formátumot:
 *     • ha mindkét formátum mért → a nagyobb felbontásút (1,2x arány felett),
 *     • ha a jelenlegi formátum MÉRTEN Full HD alatti, a másik pedig még
 *       ismeretlen → a másikat kéri (egyszer kipróbáljuk, mérünk, tanulunk),
 *     • ha a váltás kockázatos (a másik formátum többször elhalt) → marad a
 *       jelenlegi, hogy egy hibás formátum ne rontsa el az indítást.
 *
 *   A tanulás így néhány csatornaváltás alatt beáll a csatorna legszebb
 *   képű formátumára, és onnantól mindig azzal indul. A tároló korlátozott
 *   méretű (MAX_RECORDS), a legrégebbi bejegyzések esnek ki először.
 */

export type LiveQualityFormat = 'ts' | 'hls';

import { providerScopePrefix } from './providerScope';

export interface LiveQualitySample {
  width: number;
  height: number;
  /** Mikor mértük (Date.now()). */
  at: number;
}

export interface LiveQualityRecord {
  key: string;
  name?: string;
  ts?: LiveQualitySample;
  hls?: LiveQualitySample;
  /** Hányszor nem indult el az adott formátum (kockázatbecsléshez). */
  tsFail: number;
  hlsFail: number;
  updatedAt: number;
}

const STORAGE_KEY = 'iptv_rt_live_quality_v1';
const MAX_RECORDS = 400;
/** Két felbontás között ekkora területarányt tekintünk érdemi különbségnek. */
export const QUALITY_AREA_MARGIN = 1.2;
/** Full HD-nál kisebb kép „gyengének” számít (a felhasználó Full HD-t vár). */
export const FULL_HD_HEIGHT = 1080;
/** A TV panel maximuma, amit figyelembe veszünk (4K). */
export const MAX_PANEL_HEIGHT = 2160;

type RecordMap = Record<string, LiveQualityRecord>;

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Csatorna-kulcs az emlékezethez: azonosító, ha van; különben a névből képzett alak. */
export function liveQualityKey(channel: { id?: string; name?: string } | null | undefined): string {
  const id = String(channel?.id || '').trim();
  if (id) return `${providerScopePrefix()}id:${id}`;
  const name = String(channel?.name || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name ? `${providerScopePrefix()}name:${name}` : '';
}

export function readLiveQualityRecords(): RecordMap {
  const store = storage();
  if (!store) return {};
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { records?: RecordMap } | null;
    const records = parsed && typeof parsed === 'object' && parsed.records && typeof parsed.records === 'object'
      ? parsed.records
      : {};
    const clean: RecordMap = {};
    for (const [key, value] of Object.entries(records)) {
      if (!value || typeof value !== 'object') continue;
      const record = value as LiveQualityRecord;
      if (!record.key) record.key = key;
      if (typeof record.tsFail !== 'number') record.tsFail = 0;
      if (typeof record.hlsFail !== 'number') record.hlsFail = 0;
      if (typeof record.updatedAt !== 'number') record.updatedAt = 0;
      clean[key] = record;
    }
    return clean;
  } catch {
    return {};
  }
}

function writeLiveQualityRecords(records: RecordMap): void {
  const store = storage();
  if (!store) return;
  try {
    const entries = Object.entries(records);
    if (entries.length > MAX_RECORDS) {
      entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
      const trimmed: RecordMap = {};
      for (const [key, value] of entries.slice(0, MAX_RECORDS)) trimmed[key] = value;
      records = trimmed;
    }
    store.setItem(STORAGE_KEY, JSON.stringify({ v: 1, records }));
  } catch {
    /* betelt tároló: az emlékezet kimarad, a lejátszást nem érinti */
  }
}

export function getLiveQualityRecord(key: string): LiveQualityRecord | null {
  if (!key) return null;
  const records = readLiveQualityRecords();
  return records[key] || null;
}

function sampleOf(width: number, height: number, at: number): LiveQualitySample | null {
  const w = Math.round(Number(width) || 0);
  const h = Math.round(Number(height) || 0);
  if (w <= 0 || h <= 0) return null;
  // A böngésző néha 0x0-t vagy 2x2-t ad az első képkocka előtt: ezt nem mérjük.
  if (w < 64 || h < 64) return null;
  return { width: w, height: h, at };
}

/**
 * Egy MÉRT felbontás rögzítése (a dekódolt kép tényleges mérete).
 * A mérés egyben azt is jelenti, hogy a formátum elindult, ezért a
 * korábbi hibaszámlálót nullázzuk.
 */
export function recordLiveQualityMeasurement(params: {
  key: string;
  name?: string;
  format: LiveQualityFormat;
  width: number;
  height: number;
  now?: number;
}): LiveQualityRecord | null {
  const { key, name, format } = params;
  const at = typeof params.now === 'number' ? params.now : Date.now();
  const sample = sampleOf(params.width, params.height, at);
  if (!key || !sample) return null;
  const records = readLiveQualityRecords();
  const record: LiveQualityRecord = records[key] || {
    key,
    tsFail: 0,
    hlsFail: 0,
    updatedAt: at,
  };
  if (name) record.name = String(name).slice(0, 140);
  record[format] = sample;
  if (format === 'ts') record.tsFail = 0;
  else record.hlsFail = 0;
  record.updatedAt = at;
  records[key] = record;
  writeLiveQualityRecords(records);
  return record;
}

/** Egy formátum elhalt (nem indult el) – a kockázatbecsléshez. */
export function recordLiveQualityFailure(params: {
  key: string;
  format: LiveQualityFormat;
  now?: number;
}): LiveQualityRecord | null {
  const { key, format } = params;
  if (!key) return null;
  const at = typeof params.now === 'number' ? params.now : Date.now();
  const records = readLiveQualityRecords();
  const record: LiveQualityRecord = records[key] || {
    key,
    tsFail: 0,
    hlsFail: 0,
    updatedAt: at,
  };
  if (format === 'ts') record.tsFail = Math.min(9, (record.tsFail || 0) + 1);
  else record.hlsFail = Math.min(9, (record.hlsFail || 0) + 1);
  record.updatedAt = at;
  records[key] = record;
  writeLiveQualityRecords(records);
  return record;
}

export function resetLiveQualityMemory(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function qualityAreaOf(sample: LiveQualitySample | null | undefined): number {
  return sample ? Math.max(0, sample.width) * Math.max(0, sample.height) : 0;
}

/** Full HD alatti kép (a megadott panel-plafonhoz viszonyítva). */
export function isBelowFullHd(
  sample: LiveQualitySample | null | undefined,
  panelMaxHeight = FULL_HD_HEIGHT,
): boolean {
  if (!sample) return false;
  const target = Math.min(MAX_PANEL_HEIGHT, Math.max(480, Math.round(panelMaxHeight) || FULL_HD_HEIGHT));
  const wanted = Math.min(target, FULL_HD_HEIGHT);
  return sample.height < wanted;
}

export function qualityLabelOf(sample: LiveQualitySample | null | undefined): string {
  if (!sample) return 'nem mért';
  const { width: w, height: h } = sample;
  const klass = w >= 3840 || h >= 2160 ? 'UHD 4K'
    : w >= 2560 || h >= 1440 ? 'QHD'
      : w >= 1920 || h >= 1080 ? 'Full HD'
        : w >= 1280 || h >= 720 ? 'HD'
          : w >= 1024 || h >= 576 ? 'SD+'
            : 'SD';
  return `${w}×${h} (${klass})`;
}

export interface LiveQualityChoice {
  /** A választott formátum (a tervezett formátum, ha nincs érdemi ok váltani). */
  format: LiveQualityFormat;
  /** true, ha a mért adatok miatt MÁS formátumot kell indítani. */
  changed: boolean;
  /** Emberi indok a naplóhoz. */
  reason: string;
  basis: 'keep' | 'measured' | 'unmeasured-probe';
}

/**
 * A csatorna indítási formátumának eldöntése a MÉRT felbontások alapján.
 *
 * Tiszta függvény (nincs mellékhatás, nincs tároló) – így egységteszttel
 * ellenőrizhető, és a lejátszó ugyanezt használja.
 */
export function chooseLiveQualityFormat(params: {
  record: LiveQualityRecord | null;
  plannedFormat: LiveQualityFormat;
  /** A TV panel várható magassága pixelben (1080/2160); 1080 az alap. */
  panelMaxHeight?: number;
  /** A felhasználó által kért (Beállítások) formátum – ehhez képest kímélőbb a váltás. */
  configuredFormat?: LiveQualityFormat;
  /**
   * 2.5.390: a TV Doktor által MÁR IGAZOLTAN MEGTANULT, működő formátum.
   * Ha ez meg van adva, egy MÉRETlen (csak kipróbálásra szánt) másik
   * formátummal NEM írjuk felül: a #34 naplóban a CINEMAX, CINEMAX 2,
   * VIASAT 3 és VIASAT 6 csatornákon a doktor TS-t tanult, a választó mégis
   * HLS-sel indított → MEDIA_ERR_4 → javítási létra → újra HLS-próba.
   * Két MÉRT felbontás összehasonlítását ez NEM tiltja (2.5.383 megmarad).
   */
  learnedFormat?: LiveQualityFormat;
}): LiveQualityChoice {
  const planned = params.plannedFormat === 'hls' ? 'hls' : 'ts';
  const record = params.record;
  const panelMaxHeight = params.panelMaxHeight || FULL_HD_HEIGHT;
  const keep: LiveQualityChoice = { format: planned, changed: false, reason: 'nincs jobb mért formátum', basis: 'keep' };
  if (!record) return keep;

  const other: LiveQualityFormat = planned === 'ts' ? 'hls' : 'ts';
  const plannedSample = record[planned] || null;
  const otherSample = record[other] || null;
  const otherFails = other === 'ts' ? (record.tsFail || 0) : (record.hlsFail || 0);
  const plannedFails = planned === 'ts' ? (record.tsFail || 0) : (record.hlsFail || 0);
  const targetHeight = Math.min(MAX_PANEL_HEIGHT, Math.max(480, Math.round(panelMaxHeight) || FULL_HD_HEIGHT));

  // 1) Mindkét formátum mért: a nagyobb felbontású győz, érdemi különbség felett.
  if (plannedSample && otherSample) {
    const plannedArea = qualityAreaOf(plannedSample);
    const otherArea = qualityAreaOf(otherSample);
    const otherWins = otherArea >= plannedArea * QUALITY_AREA_MARGIN
      || (otherSample.height >= Math.min(targetHeight, FULL_HD_HEIGHT) && plannedSample.height < Math.min(targetHeight, FULL_HD_HEIGHT));
    if (otherWins && otherFails <= plannedFails + 1) {
      return {
        format: other,
        changed: true,
        reason: `mért jobb kép: ${other.toUpperCase()} ${qualityLabelOf(otherSample)} > ${planned.toUpperCase()} ${qualityLabelOf(plannedSample)}`,
        basis: 'measured',
      };
    }
    return keep;
  }

  // 2) Csak a MÁSIK formátum van mérve: nem bolygatjuk a tervezettet
  //    (nincs összehasonlítási alap, és a tervezett indult eddig megbízhatóan).
  if (!plannedSample && otherSample) {
    return keep;
  }

  // 3) A tervezett formátum MÉRTEN Full HD alatti, a másik ismeretlen:
  //    egyetlen kipróbálást megér, mert a másik formátum adhat Full HD-t
  //    (a naplóban pontosan ez történt a TS → HLS esetben). Ha a másik
  //    korábban többször elhalt, nem kockáztatunk.
  if (plannedSample && !otherSample) {
    const target = Math.min(targetHeight, FULL_HD_HEIGHT);
    const belowTarget = plannedSample.height < target;
    const doctorVerified = params.learnedFormat === planned;
    if (doctorVerified) {
      return {
        ...keep,
        reason: `a TV Doktor igazoltan működő ${planned.toUpperCase()} formátumát nem cseréljük méretlen ${other.toUpperCase()} próbára`,
      };
    }
    if (belowTarget && otherFails === 0) {
      return {
        format: other,
        changed: true,
        reason: `a ${planned.toUpperCase()} mért képe ${qualityLabelOf(plannedSample)}, a ${other.toUpperCase()} még nem mért – kipróbálás a jobb képért`,
        basis: 'unmeasured-probe',
      };
    }
    return keep;
  }

  return keep;
}
