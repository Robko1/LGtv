export const WEB_VERSION = '2.5.180';

// A webOS kezelő (webos.js) innen olvassa a verziót a SÁRGA gombos
// kézi diagnosztikához - így az mindig a valóban futó kiadást mutatja.
try { (window as unknown as { IPTV_RT_WEB_VERSION?: string }).IPTV_RT_WEB_VERSION = WEB_VERSION; } catch { /* SSR/teszt környezetben nincs window */ }

// A build a legfrissebb bejegyzés verzióját is szinkronizálja. A régi történet a Gitben marad.
export const WEB_VERSION_HISTORY = [
  {
    version: '2.5.180',
    date: '2026-10-28',
    changes: [
      'Kizárólag kézzel indítható, célzott sebességnapló: távirányító, teljes képernyő, csatornaváltás és film/sorozat lejátszása.',
      'A napló a betöltési és médiaesemények, várakozások és újrapróbák idejét rögzíti; az indulási és képminőségi háttérdiagnosztika nem fut.',
    ],
  },
];
