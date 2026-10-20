/**
 * Óra-segédek.
 *
 * A webOS TV böngészőmotorja bizonyos modelleken a TV helyi ideje helyett
 * UTC-t ad vissza a `new Date()`-re (Írországban ez nyáron pontosan 1 óra
 * eltérés). Ezért a felület órája a beállításokban megadott eltolással
 * számol: 0 = a készülék órája, +1 = egy órával előrébb stb.
 */
export const CLOCK_OFFSET_MIN = -12;
export const CLOCK_OFFSET_MAX = 12;

export function normalizeClockOffset(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(CLOCK_OFFSET_MIN, Math.min(CLOCK_OFFSET_MAX, Math.round(numeric)));
}

/** A megjelenítendő "most" (a beállított eltolással). */
export function nowWithClockOffset(offsetHours: number): Date {
  const offset = normalizeClockOffset(offsetHours);
  const now = new Date();
  if (!offset) return now;
  return new Date(now.getTime() + offset * 60 * 60 * 1000);
}

/** Óra:perc (24 órás) a beállított eltolással. */
export function formatClockTime(offsetHours: number): string {
  const now = nowWithClockOffset(offsetHours);
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}
