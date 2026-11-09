/**
 * ÉLŐ FORMÁTUM-EMLÉKEZET – CSATORNÁNKÉNT.
 *
 * A szolgáltatók a legtöbb csatornát MPEG-TS (.ts) formátumban adják, de van,
 * amit a TV csak HLS-ként (.m3u8) tud lejátszani. A napló tanúsága szerint
 * ugyanaz a csatorna (pl. „[HU] ATV”) MINDEN váltásnál ugyanazzal a
 * „Format error” hibával állt le, mert a lejátszó csak egy GLOBÁLIS
 * formátumemlékezetet használt („a legutóbb sikeres formátum”), nem
 * csatornánkéntit.
 *
 * Ez a modul csatornánként jegyzi meg, melyik formátum indult el, és a
 * lejátszó ezt használja elsőként:
 *   • ha egy csatorna TS-sel nem indult, legközelebb rögtön HLS-sel próbálja,
 *   • ha HLS-sel nem indult, rögtön TS-sel,
 *   • a hibás formátumot elfelejti, hogy a következő próba tiszta lappal induljon.
 *
 * A tároló szigorúan korlátozott méretű (MAX_ENTRIES), a legrégebbi bejegyzések
 * esnek ki először – így hosszú használat után sem növi túl a TV tárhelyét.
 */

export type LiveFormat = 'ts' | 'hls';

const MEMORY_KEY = 'iptv_rt_live-format-memory-v1';
/** A korábbi, globális (csatornafüggetlen) emlékezet kulcsa – továbbra is működik. */
const GLOBAL_KEY = 'iptv_rt_live-format';
const MAX_ENTRIES = 3000;

type Memory = Record<string, LiveFormat>;

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    // A webOS néhány változatán a localStorage elérése is dobhat (privát mód).
    return null;
  }
}

/** Az URL-ből kiolvasott formátum (`.ts` → ts, `.m3u8` → hls), vagy null. */
export function formatOfUrl(url: string): LiveFormat | null {
  const clean = String(url || '').split(/[?#]/)[0].toLowerCase();
  if (/\.m3u8$/.test(clean)) return 'hls';
  if (/\.ts$/.test(clean)) return 'ts';
  return null;
}

export function otherFormat(format: LiveFormat): LiveFormat {
  return format === 'ts' ? 'hls' : 'ts';
}

/**
 * Ugyanaz az URL a kért formátumban.
 *
 * Csak a kiterjesztést írjuk át; ha a cím nem `.ts`/`.m3u8` végű, VÁLTOZATLANUL
 * adjuk vissza (ilyenkor nincs értelme „másik formátumot” próbálni).
 */
export function urlWithFormat(url: string, format: LiveFormat): string {
  const text = String(url || '');
  if (!text) return text;
  if (format === 'hls') return text.replace(/\.ts(?=([?#]|$))/i, '.m3u8');
  return text.replace(/\.m3u8(?=([?#]|$))/i, '.ts');
}

/**
 * A MÁSIK formátum címe – de csak akkor, ha abból tényleg MÁS cím lesz.
 * Ha nem (pl. kiterjesztés nélküli cím), null: nincs értelmes tartalék.
 */
export function alternativeUrl(url: string): { url: string; format: LiveFormat } | null {
  const current = formatOfUrl(url);
  if (!current) return null;
  const format = otherFormat(current);
  const next = urlWithFormat(url, format);
  if (!next || next === url) return null;
  return { url: next, format };
}

function readMemory(): Memory {
  const store = storage();
  if (!store) return {};
  try {
    const raw = store.getItem(MEMORY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const memory: Memory = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if ((value === 'ts' || value === 'hls') && key && key.length <= 120) memory[key] = value;
    }
    return memory;
  } catch {
    return {};
  }
}

function writeMemory(memory: Memory): void {
  const store = storage();
  if (!store) return;
  try {
    const keys = Object.keys(memory);
    // A legrégebbi bejegyzések kiesnek, hogy a tárhely ne nőjön korlátlanul.
    if (keys.length > MAX_ENTRIES) {
      for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete memory[key];
    }
    store.setItem(MEMORY_KEY, JSON.stringify(memory));
  } catch {
    /* a tárhely hibája nem akadályozhatja a lejátszást */
  }
}

function normalizeChannelId(channelId: string | number | null | undefined): string {
  return String(channelId ?? '').trim().slice(0, 120);
}

/** A csatorna legutóbb sikeres formátuma (vagy null, ha még nincs). */
export function rememberedFormatFor(channelId: string | number | null | undefined): LiveFormat | null {
  const key = normalizeChannelId(channelId);
  if (!key) return null;
  const memory = readMemory();
  return memory[key] || null;
}

/** Sikeres indítás után: jegyezzük meg a csatorna formátumát. */
export function rememberFormatFor(channelId: string | number | null | undefined, format: LiveFormat): void {
  const key = normalizeChannelId(channelId);
  if (!key || (format !== 'ts' && format !== 'hls')) return;
  const memory = readMemory();
  if (memory[key] === format) return;
  // Az áthelyezés a végére kerül: a legrégebben használtak esnek ki először.
  delete memory[key];
  memory[key] = format;
  writeMemory(memory);
}

/** Hibás próba után: ne a rossz formátummal kezdjünk legközelebb. */
export function forgetFormatFor(channelId: string | number | null | undefined): void {
  const key = normalizeChannelId(channelId);
  if (!key) return;
  const memory = readMemory();
  if (!(key in memory)) return;
  delete memory[key];
  writeMemory(memory);
}

/** A régi, globális emlékezet (a legutóbb bármelyik csatornán sikeres formátum). */
export function rememberedGlobalFormat(): LiveFormat | null {
  const store = storage();
  if (!store) return null;
  try {
    const stored = store.getItem(GLOBAL_KEY);
    return stored === 'ts' || stored === 'hls' ? stored : null;
  } catch {
    return null;
  }
}

export function rememberGlobalFormat(format: LiveFormat): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(GLOBAL_KEY, format);
  } catch {
    /* a tárhely hibája nem akadályozhatja a lejátszást */
  }
}

/** Teljes törlés (Beállítások → gyorsítótár törlése, diagnosztika). */
export function clearFormatMemory(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(MEMORY_KEY);
    store.removeItem(GLOBAL_KEY);
  } catch {
    /* nem kritikus */
  }
}
