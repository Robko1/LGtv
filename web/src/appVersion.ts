export const WEB_VERSION = '2.5.226';

// A webOS kezelő (webos.js) innen olvassa a verziót a SÁRGA gombos
// kézi diagnosztikához - így az mindig a valóban futó kiadást mutatja.
try { (window as unknown as { IPTV_RT_WEB_VERSION?: string }).IPTV_RT_WEB_VERSION = WEB_VERSION; } catch { /* SSR/teszt környezetben nincs window */ }

// A build a legfrissebb bejegyzés verzióját is szinkronizálja. A régi történet a Gitben marad.
export const WEB_VERSION_HISTORY = [
  {
    version: '2.5.226',
    date: '2026-10-31',
    changes: [
      'Napló kitisztítva: a tisztán mérési sorok (TÁVIRÁNYÍTÓ, SEBESSÉG, HOSSZÚ FELADAT, VOD-DIAG válasz-dumpok, IMPORT-API minták) kikerültek a hibajavító naplóból, és az előállításuk sem terheli a TV-t – a hibák, a TV Doktor és az import mérföldkövei továbbra is naplózva vannak.',
      'Első letöltés gyorsítása: a nagy listák tartós mentése átlapolt IndexedDB-írással és gyorsabb főszál-lélegzéssel fut (az 1-es naplóban a filmmentés 68,9 mp volt), a 20 elemes részletkör pedig időkeretet kapott.',
      'Indulás utáni visszatöltés gyorsítása: a tárolt film-/sorozatlista adagjai előreolvasással töltődnek (eddig a filmlista visszaolvasása ~1 perc volt) – ez NEM letöltés, a katalógus a TV tárolójából jön.',
      'Frissítés gomb: a gyors ellenőrzés mostantól a tárolt katalógus beolvasása NÉLKÜL fut le – változatlan szolgáltatónál pár másodperc alatt végez; a napi mély összevetés letöltése csak összehasonlításra szolgál, a tárolt lista nem íródik újra feleslegesen.',
    ],
  },
  {
    version: '2.5.225',
    date: '2026-10-30',
    changes: [
      'Első letöltés gyorsítása: a filmek és sorozatok tömeges listáinak feldolgozása új, egy menetes gyors úton fut (bitre azonos eredménnyel), így a 103 ezres filmlista feldolgozása a töredékére csökken.',
      'A filmlista tartós mentése (~25 mp a TV-n) mostantól a sorozatok letöltésével párhuzamosan, a háttérben fut – a 100% csak akkor jelenik meg, ha minden szakasz ténylegesen a tartós tárban van.',
      'IPK építés javítása: a webos/appinfo.json verziója szinkronban marad a web verzióval, és az újrapróbálkozó ág magától helyreigazítja az eltérést.',
    ],
  },
  {
    version: '2.5.224',
    date: '2026-10-30',
    changes: [
      'Frissítés gomb: már letöltött listánál először csak a ~44 kB-os kategória-ellenőrzés fut – ha nincs változás, a frissítés pár másodperc alatt végez, a több tíz MB-os listák nem töltődnek le újra (a teljes, elemenkénti összevetés naponta legfeljebb egyszer fut).',
      'Fagyásjavítás: az indulás utáni tárhely-tömörítés nem írja újra a teljes élő listát az IndexedDB-be (ez eddig 8-12 másodperces megakadást okozott), és a nagy mentések minden adag után visszaadják a vezérlést a felületnek.',
      'A betöltési diagnosztika ablakot a távirányító VISSZA gombja mostantól mindig bezárja – akkor is, ha a fókusz a Beállítások ablakban ragadt; a háttérben futó frissítés közben is.',
    ],
  },
  {
    version: '2.5.223',
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
