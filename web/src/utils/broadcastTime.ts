/**
 * 2.5.297 – MŰSORIDŐK: ÉRTELMEZÉS ÉS KIÍRÁS MAGYAR IDŐBEN.
 *
 * MIÉRT KELL:
 * A magyar csatornák műsora a magyar (közép-európai) óra szerint értendő. A
 * panelek és az XMLTV műsorújság viszont gyakran időzóna NÉLKÜL adja az
 * időpontokat („2026-11-04 02:00:00”, illetve `20261104020000`), amit a
 * böngésző a KÉSZÜLÉK saját idejeként olvasott. Aki nem magyar időzónában él
 * (pl. Írországban, UTC+0), annál ezért csúszott a műsorújság: a kijelölt
 * „most futó” műsor valójában a már lejárt, előző műsor volt (1 óra csúszás),
 * a magyar újsághoz képest pedig minden időpont eltért.
 *
 * MEGOLDÁS:
 *  • az időzóna nélküli időpontokat MAGYAR időnek vesszük (CET/CEST, az EU
 *    nyári időszámítás szabályai szerint, Intl nélkül – a régi webOS-on az
 *    Intl hiányos lehet),
 *  • a készüléken megjelenített műsoridőket is magyar időben írjuk ki, így a
 *    magyar műsorújság minden országban ugyanazt mutatja, mint a magyar újság,
 *    és a „most” jelölés is a valóban futó műsorra esik.
 *
 * Az időpontok belül TOVÁBBRA IS abszolút Unix-időbélyegek (a „most”
 * összehasonlítás és a gyorsítótár érintetlen marad).
 */

const MINUTES_MS = 60_000;

/** Egy hónap utolsó vasárnapja, 01:00 UTC-kor (az EU óraátállítás pillanata). */
function lastSundayAt1Utc(year: number, monthIndex: number): number {
  // A hónap utolsó napja (Date.UTC hónap+1, nap 0 → az előző hónap utolsó napja).
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0));
  const dayOfWeek = lastDay.getUTCDay(); // 0 = vasárnap
  const date = lastDay.getUTCDate() - dayOfWeek;
  return Date.UTC(year, monthIndex, date, 1, 0, 0);
}

/**
 * A magyar idő eltolása az UTC-hez képest egy adott pillanatban (percben):
 * télen +60, nyáron +120. Az EU-szabály: március utolsó vasárnapja 01:00 UTC-től
 * október utolsó vasárnapja 01:00 UTC-ig tart a nyári időszámítás.
 */
export function budapestOffsetMinutes(utcMs: number): number {
  if (!Number.isFinite(utcMs)) return 60;
  const year = new Date(utcMs).getUTCFullYear();
  const dstStart = lastSundayAt1Utc(year, 2); // március
  const dstEnd = lastSundayAt1Utc(year, 9); // október
  return utcMs >= dstStart && utcMs < dstEnd ? 120 : 60;
}

/**
 * Magyar falióra-idő → abszolút Unix-másodperc.
 * (A nyári/téli eltolást a dátumhoz tartozó szabály adja, nyáron +2 óra.)
 */
export function budapestWallClockToEpochSeconds(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): number {
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(wallMs)) return 0;
  // Első közelítés a faliórából, majd a valódi pillanathoz tartozó eltolással pontosítás
  // (az óraátállítás hajnalán ez a két lépés már a helyes időt adja).
  const firstGuess = wallMs - budapestOffsetMinutes(wallMs) * MINUTES_MS;
  const offset = budapestOffsetMinutes(firstGuess);
  const result = wallMs - offset * MINUTES_MS;
  return Math.floor(result / 1000);
}

// A végét nem rögzítjük: az XMLTV/panelek néha ezredmásodpercet vagy szöveges
// toldalékot is adnak („2026-11-04 02:00:00.000 +0100”), ezt is olvassuk.
const DASHED_WALL_CLOCK =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?/;
const COMPACT_WALL_CLOCK = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(Z|[+-]\d{2}:?\d{2})?/;

/**
 * Műsoridő szövegéből abszolút Unix-másodperc.
 *
 *  • „2026-11-04 02:00:00 +0100”, „2026-11-04T02:00:00Z” → a megadott időzóna,
 *  • „2026-11-04 02:00:00”, „20261104020000” (időzóna nélkül) → MAGYAR idő.
 *
 * Érvénytelen szövegnél 0-t ad (a hívók ezt kiszűrik).
 */
export function parseBroadcastTime(value: string | null | undefined): number {
  if (!value) return 0;
  const text = String(value).trim();
  if (!text) return 0;
  const match = DASHED_WALL_CLOCK.exec(text) || COMPACT_WALL_CLOCK.exec(text);
  if (!match) return 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] ? Number(match[6]) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return 0;

  const zone = match[7];
  if (zone) {
    let offsetMinutes = 0;
    if (zone !== 'Z') {
      const sign = zone.startsWith('-') ? -1 : 1;
      const digits = zone.slice(1).replace(':', '');
      offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
    }
    const utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
    return Number.isFinite(utcMs) ? Math.floor((utcMs - offsetMinutes * MINUTES_MS) / 1000) : 0;
  }

  // Időzóna nélkül: a magyar közvetítés ideje (CET/CEST).
  return budapestWallClockToEpochSeconds(year, month, day, hour, minute, second);
}

/** Abszolút Unix-másodperc → magyar falióra „HH:MM” (24 órás, nyelvfüggetlen). */
export function formatBudapestTime(seconds: number): string {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '--:--';
  const ms = value * 1000;
  const shifted = new Date(ms + budapestOffsetMinutes(ms) * MINUTES_MS);
  const hours = shifted.getUTCHours();
  const minutes = shifted.getUTCMinutes();
  return `${hours < 10 ? '0' : ''}${hours}:${minutes < 10 ? '0' : ''}${minutes}`;
}
