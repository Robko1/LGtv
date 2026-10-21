/**
 * Óra-segédek.
 * A JavaScript helyi idejét használjuk, amelyet a webOS TV rendszerének
 * időzónája és nyári/téli időszámítása határoz meg. Nincs kézi eltolás.
 */
export const CLOCK_OFFSET_MIN = -12;
export const CLOCK_OFFSET_MAX = 12;

/** Régi mentett beállítások kompatibilitása; az eltolást már nem alkalmazzuk. */
export function normalizeClockOffset(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(CLOCK_OFFSET_MIN, Math.min(CLOCK_OFFSET_MAX, Math.round(numeric)));
}

/** A TV rendszerének helyi ideje; a régi eltolásparamétert szándékosan figyelmen kívül hagyjuk. */
export function nowWithClockOffset(_offsetHours: number): Date {
  return new Date();
}

/** Óra:perc (24 órás), a TV rendszerének helyi időzónájában. */
export function formatClockTime(_offsetHours: number): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}
