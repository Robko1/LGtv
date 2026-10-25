/**
 * Rövid, csak memóriában élő indulási mérés.
 *
 * Ez nem diagnosztikai napló és nem ír localStorage-ba. Normál induláskor
 * legfeljebb néhány könnyű fázisjel marad benne; a kézi diagnosztikai napló
 * indításakor az appLog egyszer kiolvashatja, így a normál tévézés közben
 * nincs plusz hálózat-, timer- vagy tárolómunka.
 */
export interface StartupTraceMark {
  label: string;
  elapsedMs: number;
  detail?: string;
}

const startedAt = typeof performance !== 'undefined' && typeof performance.now === 'function'
  ? performance.now()
  : 0;
const marks: StartupTraceMark[] = [];

function elapsed(): number {
  try {
    return Math.max(0, Math.round(performance.now() - startedAt));
  } catch {
    return 0;
  }
}

export function markStartup(label: string, detail?: string): StartupTraceMark {
  const mark: StartupTraceMark = {
    label: String(label).slice(0, 120),
    elapsedMs: elapsed(),
    ...(detail ? { detail: String(detail).slice(0, 180) } : {}),
  };
  marks.push(mark);
  // A fejlesztői híd csak egy aktuális, kis, nem érzékeny pillanatképet kap.
  // Credential, URL és tartalomlista nem kerül bele.
  if (marks.length > 40) marks.shift();
  try {
    (window as unknown as { __IPTV_STARTUP_METRICS__?: StartupTraceMark[] }).__IPTV_STARTUP_METRICS__ = marks.slice();
  } catch {
    /* nincs window / régi környezet */
  }
  return mark;
}

export function startupTraceSnapshot(): StartupTraceMark[] {
  return marks.slice();
}

export function startupTraceText(): string {
  return marks
    .map((mark) => `${mark.elapsedMs} ms ${mark.label}${mark.detail ? ` (${mark.detail})` : ''}`)
    .join(' | ');
}
