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

/** Óra:perc (24 órás), a TV rendszerének helyi időzónájában. */
export function formatClockTime(_offsetHours: number): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * 2.5.405 / #50 – A TV DOKTOR ÁLLAPOTABLAK FELHASZNÁLÓI IDŐPONTJAI.
 *
 * A fejléc sárga órája (`formatClockTime`) a TV rendszerének HELYI idejét
 * mutatja (`getHours()`), a kézi SÁRGA / TV DOKTOR napló viszont fixen
 * Europe/Dublin faliórát használ (`appLog.ts: dateTimeText`). A #50-ben a bal
 * felső 4 kártya `Mikor:` sora ezért EGY ÓRÁVAL KEVESEBBET mutatott, mint a
 * TV órája. Ezek a formázók ugyanazt az epochot a TV HELYI zónájában írják ki,
 * és NEM nyúlnak a napló Dublin-időbélyegeihez.
 */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Óra:perc:másodperc (24 órás), a TV rendszerének helyi időzónájában. */
export function formatDeviceClock(at: number = Date.now()): string {
  const date = new Date(at);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** `ÉÉÉÉ-HH-NN ÓÓ:PP:MM`, a TV rendszerének helyi időzónájában. */
export function formatDeviceDateTime(at: number = Date.now()): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatDeviceClock(at)}`;
}
