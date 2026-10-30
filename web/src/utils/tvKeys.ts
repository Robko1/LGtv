/**
 * LG webOS távirányító gombkezelés – egységes kulcsnév minden TV-re.
 *
 * MIÉRT KELL: a régebbi LG webOS (Chrome 38–53 böngészőmotor) a nyilakra nem
 * az 'ArrowUp'/'ArrowDown' nevet küldi, hanem a régi 'Up'/'Down'/'Left'/'Right'
 * nevet – vagy csak keyCode-ot (37–40). Az OK gomb 13, a VISSZA gomb 461,
 * a csatorna fel/le 33/34. Ha a kód csak az `e.key === 'ArrowUp'` modern nevet
 * figyeli, a TV távirányítója SEMMIRE nem reagál.
 *
 * Minden gombkezelő ezt a normalizálót használja a nyers `e.key` helyett.
 */

/** webOS / TV távirányító keyCode → egységes kulcsnév. */
const KEYCODE_MAP: { [code: number]: string } = {
  37: 'ArrowLeft',
  38: 'ArrowUp',
  39: 'ArrowRight',
  40: 'ArrowDown',
  13: 'Enter', // OK / DPAD_CENTER
  32: ' ',
  8: 'Backspace',
  27: 'Escape',
  33: 'PageUp', // Csatorna fel (CH+)
  34: 'PageDown', // Csatorna le (CH-)
  48: '0',
  49: '1',
  50: '2',
  51: '3',
  52: '4',
  53: '5',
  54: '6',
  55: '7',
  56: '8',
  57: '9',
  96: '0',
  97: '1',
  98: '2',
  99: '3',
  100: '4',
  101: '5',
  102: '6',
  103: '7',
  104: '8',
  105: '9',
  461: 'Escape', // LG webOS VISSZA gomb
  10009: 'Escape', // Samsung Tizen VISSZA (biztonsági tartalék)
  415: 'MediaPlay',
  19: 'MediaPause',
  413: 'MediaStop',
  412: 'MediaRewind',
  417: 'MediaFastForward',
  403: 'ColorF0Red',
  404: 'ColorF1Green',
  405: 'ColorF2Yellow',
  406: 'ColorF3Blue',
};

/** Régi / TV-specifikus kulcsnevek → egységes kulcsnév. */
const KEYNAME_MAP: { [name: string]: string } = {
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Esc: 'Escape',
  Spacebar: ' ',
  'U+0020': ' ',
  OK: 'Enter',
  Accept: 'Enter',
  Select: 'Enter',
  NumpadEnter: 'Enter',
  Back: 'Escape',
  GoBack: 'Escape',
  BrowserBack: 'Escape',
  XF86Back: 'Escape',
  MediaPlayPause: 'MediaPlay',
};

interface KeyLike {
  key?: string;
  keyCode?: number;
  which?: number;
}

/**
 * Egységes kulcsnevet ad vissza ('ArrowUp', 'Enter', 'Escape', 'PageUp', …)
 * akár modern `key`, akár régi kulcsnév, akár csak keyCode érkezik a TV-től.
 */
export function normalizeTvKey(e: KeyLike): string {
  const code = (typeof e.keyCode === 'number' && e.keyCode) || (typeof e.which === 'number' && e.which) || 0;
  if (code && KEYCODE_MAP[code]) return KEYCODE_MAP[code];
  const raw = e.key || '';
  if (raw && KEYNAME_MAP[raw]) return KEYNAME_MAP[raw];
  if (raw === 'Unidentified') return '';
  return raw;
}

/** Igaz, ha a normalizált kulcs valamelyik D-pad nyíl. */
export function isTvArrowKey(key: string): boolean {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight';
}
