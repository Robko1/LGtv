export const WEB_VERSION = '2.5.192';

// A webOS kezelő (webos.js) innen olvassa a verziót a SÁRGA gombos
// kézi diagnosztikához - így az mindig a valóban futó kiadást mutatja.
try { (window as unknown as { IPTV_RT_WEB_VERSION?: string }).IPTV_RT_WEB_VERSION = WEB_VERSION; } catch { /* SSR/teszt környezetben nincs window */ }

// A build a legfrissebb bejegyzés verzióját is szinkronizálja. A régi történet a Gitben marad.
export const WEB_VERSION_HISTORY = [
  {
    version: '2.5.192',
    date: '2026-10-29',
    changes: [
      'TV Doktor lenyíló állapot-, Supabase kapcsolat-, memóriahasználat- és hibalokalizáló panel a Rendszer menüben, a kapcsoló mellett elhelyezett kézi Memória: 0 visszaállítással.',
      'Kézi hibakeresési napló bővítése a TV Doktor működés-, memória-, kapcsolat- és elakadás-naplózásával a meglévő naplóküldési útvonal változatlanul hagyásával.',
    ],
  },
  {
    version: '2.5.191',
    date: '2026-10-29',
    changes: [
      'TV Doktor intelligens hibajavító és csatorna-optimalizáló rendszer: villámgyors csatornaváltás, csatornánkénti formátum- és puffertanulás, okos fagyásfigyelés és korlátozott automatikus javítás.',
      'Hibrid helyi + Supabase tudásbázis offline gyorsítótárral, valamint dedikált egykapcsolós TV Doktor vezérlődoboz a Rendszer menüben.',
    ],
  },
];
