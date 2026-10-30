export const WEB_VERSION = '2.5.208';

// A webOS kezelő (webos.js) innen olvassa a verziót a SÁRGA gombos
// kézi diagnosztikához - így az mindig a valóban futó kiadást mutatja.
try { (window as unknown as { IPTV_RT_WEB_VERSION?: string }).IPTV_RT_WEB_VERSION = WEB_VERSION; } catch { /* SSR/teszt környezetben nincs window */ }

// A build a legfrissebb bejegyzés verzióját is szinkronizálja. A régi történet a Gitben marad.
export const WEB_VERSION_HISTORY = [
  {
    version: '2.5.208',
    date: '2026-10-30',
    changes: [
      'VOD (Mozi és Sorozatok) memória-mentés nélküli TV Doktor üzemmód: valós idejű lejátszássegítés és pufferoptimalizálás akadásnál anélkül, hogy elmentené, melyik film vagy sorozat és hol akadt el.',
      '0-ás távirányító gomb (kizárólag a főoldalon és teljes képernyőn, élő TV lejátszásakor): nagy, olvasható 2 oszlopos TV Doktor ablak — bal oldalon a lefelé görgetve végigolvasható Legutóbbi TV Doktor naplóval, jobb oldalon az állandó állapot- és memóriaadatokkal, a jobb felső sarokban elérhető piros Memória: 0 törlés gombbal.',
      'Beállítások → Rendszer → TV Doktor doboz egyszerűsítése: kizárólag a Ki/Be kapcsoló és a feliratok jelennek meg.',
    ],
  },
  {
    version: '2.5.203',
    date: '2026-10-29',
    changes: [
      'Rendszer menü átrendezése: a TV Doktor első helyre került 3D zöld TV Doktor ikonnal, nagyobb és jobban olvasható feliratokkal, távirányítóval fókuszálható és lenyitható állapot-/naplópanellel, valamint a jobb sarokba helyezett Memória: 0 gombbal.',
      'Különálló, távirányítóval kezelhető Supabase-párosítás menüpont a TV Doktor alatt egyszeri 6 jegyű számkódos hitelesítéssel a védett TV Doktor adatok eléréséhez.',
    ],
  },
  {
    version: '2.5.195',
    date: '2026-10-29',
    changes: [
      '3D TV Doktor ikon (televíziót tartó kis doktor) a csatornasorokban a kedvenc csillag alatt és teljes képernyőn a jobb felső sarokban az óra előtt.',
      'TV Doktor működés kiterjesztése a VOD tartalmakra (filmek és sorozatok), valamint teljes képernyős, automatikusan eltűnő állapotablak aktív betöltés, pufferelés, hiba és újrapróbálkozás közben.',
    ],
  },
];
