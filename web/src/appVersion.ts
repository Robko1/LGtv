export const WEB_VERSION = '2.5.194';

// A webOS kezelő (webos.js) innen olvassa a verziót a SÁRGA gombos
// kézi diagnosztikához - így az mindig a valóban futó kiadást mutatja.
try { (window as unknown as { IPTV_RT_WEB_VERSION?: string }).IPTV_RT_WEB_VERSION = WEB_VERSION; } catch { /* SSR/teszt környezetben nincs window */ }

// A build a legfrissebb bejegyzés verzióját is szinkronizálja. A régi történet a Gitben marad.
export const WEB_VERSION_HISTORY = [
  {
    version: '2.5.194',
    date: '2026-10-29',
    changes: [
      '3D TV Doktor ikon (televíziót tartó kis doktor) a csatornasorokban a kedvenc csillag alatt (zöld állapotjelzés a már kezelt csatornáknál) és teljes képernyőn a jobb felső sarokban az óra előtt, az órával azonos méretben.',
      'TV Doktor működés kiterjesztése a VOD tartalmakra (filmek és sorozatok), valamint teljes képernyős, automatikusan eltűnő félig átlátszó állapotablak aktív betöltés, pufferelés, hiba és újrapróbálkozás közben.',
    ],
  },
  {
    version: '2.5.193',
    date: '2026-10-29',
    changes: [
      'TV Doktor lenyíló állapot-, Supabase kapcsolat-, memóriahasználat- és hibalokalizáló panel a Rendszer menüben, a kapcsoló mellett elhelyezett kézi Memória: 0 visszaállítással.',
      'Kézi hibakeresési napló bővítése a TV Doktor működés-, memória-, kapcsolat- és elakadás-naplózásával a meglévő naplóküldési útvonal változatlanul hagyásával.',
    ],
  },
];
