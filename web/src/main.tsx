import { StrictMode, Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./themes/webos.css";
document.body.classList.add('webos-theme', 'webos-tv', 'lg-webos');
import App from "./App";
import {
  appLog, appLogCritical, clearAppLog, getAppLogText, installCrashHandlers, logPhase, logStartup,
  manualLogSnapshot, startAutomaticTestLogging, startManualLogging, stopManualLogging,
  measurementSnapshot, resetMeasurements, uiStateSnapshot,
} from "./services/appLog";
import { attachStartupDiagnostics } from "./services/startupDiagnostics";
import {
  bootScreenComplete,
  bootScreenDetail,
  bootScreenPhase,
  bootScreenStart,
} from "./services/bootScreen";
import { WEB_VERSION } from "./appVersion";

/*
 * FAGYÁS-/ÖSSZEOMLÁS-DIAGNOSZTIKA.
 *
 * Még a felület felépítése ELŐTT elindul a hibakezelő.
 *
 * TESZT IDŐSZAK: a `diagnosticsConfig.ts` kapcsolója bekapcsolva a naplózás
 * itt, az IPK indulásakor AUTOMATIKUSAN elindul, és a teljes indulást rögzíti
 * (webOS-ellenőrzések, betöltött erőforrások, fázisidők, megjelenő elemek,
 * elrendezés-ugrások, képkocka-kihagyások). A kapcsoló kikapcsolásával a régi
 * viselkedés áll vissza: a naplózás csak a SÁRGA ablak gombjára indul, és
 * normál tévézésnél nem fut semmilyen háttérfigyelő.
 */
attachStartupDiagnostics();
installCrashHandlers();
try { startAutomaticTestLogging(); } catch { /* a naplózás hibája nem akadályozhatja az indulást */ }
logStartup(WEB_VERSION);
logPhase('bundle betöltve (main.tsx)');
/*
 * BETÖLTŐKÉPERNYŐ: az első VALÓS adat a bundle betöltése. A képernyő ettől
 * kezdve a futó alkalmazásból kapja a százalékot, a csatornaszámot, a mért
 * sebességet és a hátralévő idő becslését (web/src/services/bootScreen.ts).
 */
bootScreenStart(WEB_VERSION);

/*
 * DIAGNOSZTIKAI HÍD.
 *
 * A napló a SÁRGA (teletext) gombbal megnyíló kézi ablakból küldhető el, de a
 * fejlesztéshez/teszthez egy kis híd is kell: innen lehet a naplót írni,
 * kiolvasni és törölni a TV böngésző-konzoljából vagy automatizált teszttel.
 * Csak olvas/naplóz – a felület működését nem befolyásolja.
 */
try {
  (window as any).__IPTV_DIAG__ = {
    version: WEB_VERSION,
    log: (message: string) => appLog(String(message)),
    critical: (message: string) => appLogCritical(String(message)),
    phase: (label: string) => logPhase(String(label)),
    state: () => uiStateSnapshot(),
    text: () => getAppLogText(),
    clear: () => clearAppLog(),
    // A kézi napló csak innen vagy a SÁRGA ablak gombjáról indulhat.
    measure: () => measurementSnapshot(),
    resetMeasure: (reason?: string) => resetMeasurements(reason ? String(reason) : 'kézi frissítés'),
    logStatus: () => manualLogSnapshot(),
    startLogging: () => startManualLogging(),
    stopLogging: (reason?: string) => stopManualLogging(reason ? String(reason) : 'diagnosztikai híd'),
  };
} catch { /* nincs window (SSR) */ }

/*
 * LG webOS TV – csak TV kinézet, mindig webos-theme
 * Indítási napló boot-splash-hez
 */
const stage = (n: number, label: string) => {
  try { (window as any).__IPTV_STARTUP_STAGE_SET__?.(n, label); } catch {}
};
const fail = (e: unknown) => {
  try { appLogCritical(`INDULÁSI HIBA: ${e instanceof Error ? (e.message + ' | ' + (e.stack || '').split('\n').slice(1, 3).join(' ')) : String(e)}`); } catch {}
  try { (window as any).__IPTV_STARTUP_FAIL__?.(e instanceof Error ? (e.stack || e.message) : String(e)); } catch {}
};

class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    try { console.error("IPTV-RT hiba:", error, info?.componentStack); } catch {}
    fail(error);
  }
  render() {
    if (this.state.error) {
      const message = this.state.error?.message || String(this.state.error);
      return (
        <div style={{ position:"fixed", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:12, padding:24, background:"#080d1a", color:"#f1f5f9", textAlign:"center", fontFamily:"system-ui, sans-serif" }}>
          <div style={{ fontSize:18, fontWeight:800, letterSpacing:"0.04em" }}>IPTV R.T - webOS TV</div>
          <div style={{ color:"#f87171", fontWeight:700 }}>Hiba a felület betöltése közben</div>
          <div style={{ maxWidth:420, color:"#94a3b8", fontSize:12, lineHeight:1.6, wordBreak:"break-word" }}>{message}</div>
          <button onClick={() => window.location.reload()} style={{ marginTop:6, padding:"10px 18px", borderRadius:10, border:"1px solid rgba(56,189,248,0.5)", background:"rgba(56,189,248,0.15)", color:"#e2e8f0", fontWeight:700 }}>Újratöltés</button>
        </div>
      );
    }
    return this.props.children;
  }
}

try {
  stage(3, "webOS TV bridge ellenőrzése");
  stage(4, "JavaScript / React belépési pont");

  const container = document.getElementById("root");
  if (!container) throw new Error('Nincs id="root" elem az index.html-ben.');

  const root = createRoot(container);
  root.render(
    <StrictMode>
      <RootErrorBoundary>
        <App />
      </RootErrorBoundary>
    </StrictMode>
  );
  stage(5, "React mount elindítva");
  bootScreenPhase('react', 'A React felület felépítése elindult.');

  const startedAt = Date.now();

  /*
   * EGY PILLANAT ALATTI INDULÁS.
   *
   * A #root addig rejtve van (a webOS indítókép látszik helyette), amíg a
   * TELJES főoldal fel nem épült: fejléc + csatornalista sorai. Így nincs
   * "darabos" felépülés (fejléc, majd üres lista, majd sorok, majd EPG) -
   * a webOS töltőképe után EGYBEN jelenik meg a kész felület.
   *
   * A megjelenítést az index.html __IPTV_REVEAL__ függvénye végzi (12 mp-es
   * biztonsági hálóval, hogy semmi ne maradjon rejtve). A háló szándékosan a
   * lenti 9 mp-es saját korlát FELETT van: így normál esetben mindig az
   * alkalmazás dönt a megjelenésről, nem egy korábban elsülő időzítő – ez volt
   * az oka annak, hogy a takarókép idő előtt lement, és a félkész főoldal a
   * néző szeme előtt épült tovább („ugrált”).
   */
  const reveal = (reason: string) => {
    try { (window as any).__IPTV_REVEAL__?.(reason); } catch { /* nincs window */ }
  };

  /*
   * ELŐFESTÉS A TAKARÓKÉP ALATT (2.5.131 – a „nagy felvillanás” javítása).
   *
   * A 22:32:49-es naplóban a REVEAL +2770 ms-nál volt, de a legnagyobb
   * tartalom csak +3602 ms-nál lett kifestve, és +2879…+3479 között 600 ms-ra
   * leállt a fő szál. A #root ugyanis `visibility: hidden` volt: a böngésző
   * a teljes 4K-s felületet CSAK a takarókép levétele UTÁN festette ki,
   * ezért a néző egy üres képkockát látott („egy nagy felvillanás”).
   *
   * A HTML-híd `__IPTV_PREPARE_REVEAL__()` láthatóvá teszi a #root-ot, de az
   * átlátszatlan #tv-curtain továbbra is eltakarja. Így a drága festés még a
   * takarókép ALATT, láthatatlanul megtörténik, és a REVEAL már csak egyetlen
   * kompozitor-váltás. Az afterPaint két képkockája ekkor már a VALÓDI fát
   * méri, és a képkocka-őr is a tényleges festési költséget látja.
   */
  const preparePaint = () => {
    try { (window as any).__IPTV_PREPARE_REVEAL__?.(); } catch { /* nincs HTML-híd */ }
    bootScreenPhase('painted', 'A főoldal a betöltőképernyő alatt kifestve.');
  };

  /** A HTML-híd már két képkockán át festette a felületet a takarókép alatt. */
  const prepaintSettled = (): boolean => {
    try { return !!(window as any).__IPTV_PREPAINT_SETTLED__; } catch { return false; }
  };

  /*
   * FONTOS: a fejlécet a #root-ON BELÜL keressük. A betöltőképernyőnek is van
   * <header> eleme (a márka + a valós óra), ezért egy globális
   * document.querySelector("header") már a React előtt igazat adna – a
   * takarókép a félkész felület előtt lemegy.
   */
  const headerReady = () => {
    const root = document.getElementById("root");
    return !!root && root.childElementCount > 0 && !!root.querySelector("header");
  };

  /*
   * AZ ÜRES IPK JELE.
   *
   * A 21:31:49-es naplóban (üres, frissen telepített IPK) 9 257 ms-ig fent
   * maradt a takarókép, és csak „időtúllépés” címen ugrott elő a felület.
   * Oka: a listReady() legalább 3 csatornasorra várt, de üres alkalmazásnál
   * NINCS egyetlen sor sem. Az App a tároló-felmérés után beállítja a
   * <html data-iptv-boot="empty|content"> jelzőt – ebből pontosan tudjuk,
   * hogy a kész állapot az ÜRES felület, és nem kell videóra/logóra várni.
   */
  const bootState = (): string =>
    document.documentElement.getAttribute("data-iptv-boot") || "checking";
  const emptyBoot = (): boolean => bootState() === "empty";

  // A csatornalista sorai (role="option") - ezek megjelenése jelenti a kész
  // főoldalt. Üres IPK-nál az üres állapot maga a kész felület.
  const listReady = () =>
    emptyBoot() ||
    document.querySelectorAll('[role="listbox"] [role="option"]').length >= 3 ||
    !!document.querySelector('[role="dialog"]');

  /*
   * A KÉSZ FŐOLDAL FELTÉTELEI – a korábbi "2 másodperc után elég a fejléc"
   * ág volt a fokozatos felépülés oka: a takarékép lement, aztán a néző
   * látta, ahogy a sorok, az EPG és a logók egymás után megjelennek.
   *
   * Mostantól a megjelenéshez mindez kell (vagy egy hosszú biztonsági idő):
   *   • fejléc ÉS a kedvencek mappasávja is kirajzolódott,
   *   • a csatornalista sorai ott vannak,
   *   • a látható logók betöltődtek (korlátozott ideig várunk rájuk),
   *   • az élő kép első kockája megérkezett – DE csak rövid ideig várunk rá:
   *     addig a lejátszó borítóképe (poszter) látszik, tehát nincs fekete
   *     terület. A korábbi 3,5 mp-es (a listához képest összesen 6 mp-es)
   *     várakozás volt az oka, hogy a rendszerindítás után másodpercekig
   *     takarékép (zöld kép) látszott a kész főoldal helyett.
   */
  const VIDEO_WAIT_MS = 1200;
  const LOGO_WAIT_MS = 600;
  /**
   * A teljes lista készenléte – MÁR CSAK NAPLÓZÁSRA (2.5.149).
   * A felfedés nem vár rá: a takarókép akkor megy le, amikor a LÁTHATÓ
   * felület kész, a 20 190 csatornás lista pedig utána töltődik be.
   */
  const liveListReady = (): boolean =>
    (window as any).__IPTV_LIVE_READY__ === true;

  const chromeReady = () => {
    const root = document.getElementById("root");
    return headerReady() && !!root && !!root.querySelector("[data-tv-folders]");
  };

  const logosSettled = () => {
    const images = Array.prototype.slice.call(
      document.querySelectorAll('[role="listbox"] [role="option"] img')
    ) as HTMLImageElement[];
    if (!images.length) return true;
    const pending = images.filter((img) => !img.complete && img.currentSrc !== "");
    return pending.length === 0;
  };

  const videoSettled = () => {
    // Üres alkalmazásnál NINCS stream, ezért az első képkocka SOHA nem jön
    // el: a régi kód ilyenkor is végigvárta a VIDEO_WAIT_MS-et (majd a 9 mp-es
    // időtúllépést). Ilyenkor a lejátszó posztere a végleges kép.
    if (emptyBoot()) return true;
    /*
     * VAN-E EGYÁLTALÁN LEJÁTSZANDÓ STREAM?
     *
     * Az App az aktív csatorna (illetve a beírt közvetlen stream-cím) alapján
     * a <html data-iptv-stream="none|active"> jelzőt állítja. Ha nincs
     * lejátszandó stream, nincs első videókocka sem: ilyenkor AZONNAL kész
     * a felület, nem várunk 1,2 mp-et (és pláne nem a 9 mp-es korlátig).
     */
    const streamState = (): string =>
      document.documentElement.getAttribute("data-iptv-stream") || "unknown";
    if (streamState() === "none") return true;
    // A lejátszó az első képkockánál __IPTV_VIDEO_READY__-t állít.
    // Ha nincs lejátszó (pl. nincs szolgáltató), nincs mit várni.
    const hasPlayer = !!document.querySelector('video[data-iptv-player="true"]');
    if (!hasPlayer) return true;
    if ((window as any).__IPTV_VIDEO_READY__ !== true) return false;
    /*
     * 2.5.147 – A FELFEDÉS AZ ELSŐ KIRAJZOLT KÉPKOCKÁRA VÁR.
     *
     * A `playing` esemény a lejátszás indulását jelzi, a kép viszont még a
     * kompozitor előtt lehet: a takarókép levételekor ez villantott be
     * fekete/festetlen videó-területet („egy hatalmas fekete kép”). A
     * `requestVideoFrameCallback` akkor jelez, amikor a képkocka tényleg
     * megjelent. Ha a motor nem támogatja ezt a hívást, a `playing` elég.
     */
    if ((window as any).__IPTV_VIDEO_PAINTED__ === true) return true;
    const player = document.querySelector('video[data-iptv-player="true"]') as
      (HTMLVideoElement & { requestVideoFrameCallback?: unknown }) | null;
    if (!player || typeof player.requestVideoFrameCallback !== 'function') return true;
    return false;
  };

  /*
   * A megjelenés csak akkor történhet meg, ha a KÉSZ oldal már a képernyőn
   * van. Ezért a megjelenés előtt két animációs kép várakozik: az első
   * képben a rejtett (#root) felület már a DOM-ban és a méretezés után van,
   * a második képben pedig a böngésző biztosan kirajzolta. Aki a
   * megjelenés előtt váltana képernyőt, a félkész oldalt mutatná a
   * nézőnek – pontosan ezt a villanást szünteti meg a két kép.
   */
  /*
   * A TAKARÓKÉP NEM ESEHET LE EGY AKADÁS KÖZEPÉRE.
   *
   * A 4-es TV-napló (2.5.112) szerint a beolvasás alatt a fő szál többször
   * 3–6 másodpercig nem futott:
   *   LEÁLLÁS: a fő szál 5859 ms-ig nem futott (várt: 1000 ms)
   *   HOSSZÚ FELADAT: 5399 ms
   * Ha a megjelenés pont egy ilyen pillanatra esik, a néző egy rángatózó,
   * félig kirajzolódó első képkockát lát – ezért „nem folyékony az indulás”.
   *
   * Ezért a megjelenés előtt MÉRJÜK a két animációs kép közötti időt. Ha a
   * kép váltása a szokásosnál sokkal tovább tartott, a fő szál foglalt:
   * a takarókép FENT MARAD, és a következő körben próbáljuk újra. Így a
   * takarókép addig marad, amíg a rendszer valóban indulásra kész – és csak
   * egy sima, egyetlen váltás után tűnik el.
   *
   * A 9 mp-es kemény korát ez nem érinti: ha a szál tartósan foglalt, a
   * checkRender() önmaga is megjeleníti a felületet, semmi nem marad rejtve.
   */
  const FRAME_GAP_LIMIT_MS = 240;
  /*
   * 2.5.153: az újrapróbálkozás MEGSZŰNT. A 41–44. napló bizonyítja, hogy a
   * „képkocka-kihagyás” nem a saját munkánktól van, hanem a videó-indítástól,
   * ezért a váltás halasztása nem javított semmin – csak 1–3 mp-et tett a
   * felfedésre.
   */
  let revealPending = false;
  /** Nagy felbontású óra, ha van; egyébként a falióra. */
  const nowMs = (): number => {
    try {
      if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
      }
    } catch { /* nincs performance */ }
    return Date.now();
  };
  /*
   * A VÁLTÁS KÉPKOCKÁRA VÁR – DE LEGFELJEBB 350 ms-IG (2.5.153).
   *
   * A 41–44. napló mérése: a videó elindulásakor a TV NEM ad képkockát
   * 1,2–3,9 mp-ig (a `requestAnimationFrame` nem hívódik meg), miközben a
   * JavaScript tovább fut – a naplóban közben sorban jönnek a média- és
   * EPG-események. A régi „képkocka-őr” ezt úgy értelmezte, hogy „a fő szál
   * foglalt”, és ELHALASZTOTTA a takarókép levételét: a 41. naplóban a
   * felfedés 3,6 mp-nél már esedékes volt, mégis 6,5 mp-nél történt meg.
   *
   * A takarókép levétele EGYETLEN stílusváltás, amihez nem kell új képkocka:
   * a felület már elő van festve alatta. Ezért mostantól a képkockára
   * legfeljebb 350 ms-ot várunk – utána a váltás megtörténik. A késés
   * tényét a napló rögzíti, de a felfedést nem halasztja.
   */
  const REVEAL_PAINT_TIMEOUT_MS = 350;
  let paintFallbacks = 0;
  const afterPaint = (fn: () => void) => {
    let done = false;
    const finish = (how: 'képkocka' | 'időzítő', gap: number) => {
      if (done) return;
      done = true;
      if (how === 'időzítő') {
        paintFallbacks += 1;
        logPhase('a váltás nem vár tovább képkockára (a videó-pipeline visszatartotta)');
      } else if (gap > FRAME_GAP_LIMIT_MS) {
        logPhase(`képkocka-kihagyás a váltás előtt: ${Math.round(gap)} ms (nem halasztjuk)`);
      }
      fn();
    };
    const timer = window.setTimeout(() => finish('időzítő', REVEAL_PAINT_TIMEOUT_MS), REVEAL_PAINT_TIMEOUT_MS);
    try {
      window.requestAnimationFrame(() => {
        const frameStartedAt = nowMs();
        window.requestAnimationFrame(() => {
          window.clearTimeout(timer);
          finish('képkocka', nowMs() - frameStartedAt);
        });
      });
    } catch { /* az időzítő mindenképpen lefut */ }
  };

  let revealed = false;
  const revealNow = (reason: string) => {
    if (revealed) return;
    revealed = true;
    stage(6, "App állapot / Storage");
    stage(7, "Főképernyő kész");
    logPhase(liveListReady()
      ? 'főoldal kész és kirajzolva'
      : 'főoldal kész és kirajzolva – a teljes élő lista a háttérben töltődik tovább');
    /*
     * A FELFEDÉS BONTÁSA (2.5.153) – a következő naplóból egyértelműen
     * látszik, melyik lépés késleltette a váltást, ha még mindig késik.
     */
    try {
      logPhase(
        `FELFEDÉS: ${Date.now() - startedAt} ms; videó-kész=${videoSettled() ? 'igen' : 'nem'}; `
        + `logó-kész=${logosSettled() ? 'igen' : 'nem'}; előfestés=${prepaintSettled() ? 'igen' : 'nem'}; `
        + `képkocka-várakozás=${paintFallbacks}`,
      );
    } catch { /* a napló hibája nem akadály */ }
    try { (window as any).__IPTV_APP_READY__ = true; } catch { /* nincs window */ }
    /*
     * 100%-IG LÁTHATÓ BEFEJEZÉS, UTÁNA VÁLTÁS (2.5.160).
     *
     * A felhasználói elvárás: az indítási animáció a 100%-ig folyamatosan
     * látszódjon, és a 100%-nál induljon a főoldal. Ezért a takaróréteg
     * eltüntetése NEM itt, hanem a betöltőképernyő saját visszahívására
     * történik: a HTML `complete()` 240 ms alatt felfuttatja a sávot a valós
     * értékről 100%-ra, és csak utána szól vissza.
     *
     * Két dolog garantálja, hogy ez soha ne akassza meg az indulást:
     *   • a 240 ms-os animáció csak a százalékot és a szöveget írja (nincs
     *     drága GPU-munka, szemben a régi virágzás-effekttel);
     *   • 400 ms-os biztonsági időzítő: ha a visszahívás elmarad (régi motor,
     *     foglalt fő szál), akkor is megtörténik a váltás.
     */
    let bootRevealDone = false;
    const afterBootAnimation = () => {
      /*
       * CSAK EGYSZER: a visszahívás és a 400 ms-os biztonsági időzítő is ezt
       * hívja, a felfedés és az `iptv-app-ready` jelzés viszont egyszer
       * futhat le (különben a lista-visszatöltés kétszer indulna).
       */
      if (bootRevealDone) return;
      bootRevealDone = true;
      reveal(reason);
      /*
       * A jelzés a felfedés UTÁN megy ki – az App ebből indítja a teljes lista
       * visszatöltését. `window.CustomEvent` (nem a globális), mert a régi
       * webOS motorokon és a teszt-környezetben is ez a helyes példány.
       */
      try {
        let signal: Event | null = null;
        const custom = (window as any).CustomEvent;
        if (typeof custom === 'function') {
          signal = new custom('iptv-app-ready');
        } else if (typeof document.createEvent === 'function') {
          const legacy = document.createEvent('Event');
          legacy.initEvent('iptv-app-ready', false, false);
          signal = legacy;
        }
        if (signal) window.dispatchEvent(signal);
      } catch { /* régi motor */ }
    };
    try {
      (window as any).__IPTV_BOOT_DONE_CB__ = afterBootAnimation;
      bootScreenComplete();
    } catch {
      /* a HTML-réteg hibája nem akadályozhatja a megjelenítést */
      afterBootAnimation();
    }
    /*
     * BIZTONSÁGI HÁLÓ: az animáció legfeljebb 240 ms, a váltás 400 ms-nál
     * mindenképp megtörténik – akkor is, ha a visszahívás elmarad.
     */
    window.setTimeout(afterBootAnimation, 400);
  };

  /*
   * Egyetlen megjelenítési lánc. A 60 ms-os ellenőrző ciklus korábban minden
   * körben újabb afterPaint-láncot indíthatott, ami több párhuzamos
   * requestAnimationFrame-várakozást és látható „ugrálást” okozott.
   */
  const revealWhenPainted = (reason: string) => {
    if (revealed) return;
    /*
     * 2.5.151: 99% – „Váltás a főoldalra”. Ez az UTOLSÓ, festett állapot,
     * amit a néző lát: utána (100%-nál) jön a főoldal.
     */
    if (!revealed) bootScreenPhase('ready');
    // Ha a korai előfestés valamiért kimaradt, itt még pótoljuk: a két
    // animációs kép alatt a felület már látható (de takart) legyen.
    preparePaint();
    /*
     * NINCS MÉG KÉT KÉPKOCKA VÁRAKOZÁS (2.5.133).
     *
     * A 23:25:43-es naplóban az üres döntés +639 ms-nál készült el, de a
     * REVEAL csak +933 ms-nál történt: az előfestés közbeni 167/183/217 ms-os
     * főszál-leállások miatt a revealWhenPainted() két ÚJABB rAF-je 294 ms-t
     * várt. Pedig a felület már a takarókép alatt, korábban kifestődött.
     * Ha a HTML-híd két képkockája lefutott, azonnal válthatunk.
     */
    if (prepaintSettled()) {
      revealNow(reason);
      return;
    }
    if (revealPending) return;
    revealPending = true;
    afterPaint(() => {
      revealPending = false;
      revealNow(reason);
    });
  };

  const logoStartedAt = { value: 0 };
  let prepared = false;
  let shellReported = false;
  let framesReported = false;

  const checkRendered = () => {
    if (revealed) return;
    const elapsed = Date.now() - startedAt;

    // Nincs beállított szolgáltató: a felület egy ablakot mutat, és ez már
    // a teljes, kész állapot – nincs mire várni.
    const onlyDialog = !!document.querySelector('[role="dialog"]');
    const chromeOk = chromeReady();

    /*
     * VALÓS HELYZETJELZÉS: a fejléc és a mappasáv ténylegesen kirajzolódott.
     * Ez a betöltőképernyő 6/7 lépése – nem időzítő, hanem a DOM állapota.
     */
    if (chromeOk && !shellReported) {
      shellReported = true;
      bootScreenPhase('shell', 'A fejléc és a csatornalista kirajzolódott.');
      bootScreenDetail('A felület használható, a megjelenítés előkészítése…');
    }

    /*
     * A FESTÉST NEM A REVEAL PILLANATÁRA HAGYJUK. Amint a fejléc és a
     * mappasáv a DOM-ban van, a felületet a takarókép alatt kifestetjük;
     * a hátralévő tároló-próba és az afterPaint két képkockája alatt a
     * böngésző már a kész képet tartja a kompozitorban.
     */
    if (chromeOk && !prepared) {
      prepared = true;
      preparePaint();
      logPhase('főoldal előfestve a takarókép alatt');
    }

    /*
     * 2.5.151: a sáv VALÓS lépése. Amikor a HTML-híd két képkockán át már
     * kifestette a kész felületet a takarókép alatt, a néző a 94% helyett
     * 97%-ot lát – nem áll meg a folyamatjelző a váltásig.
     */
    if (prepaintSettled() && !framesReported) {
      framesReported = true;
      bootScreenPhase('frames', 'A főoldal két képkockán át kifestve.');
    }

    if (chromeOk && (listReady() || onlyDialog)) {
      /*
       * ÜRES IPK: nincs csatorna, nincs stream, nincs logó. A felület
       * EGYETLEN kész egységként rajzolódott ki – azonnal, egyetlen
       * festéssel jelenhet meg. Nincs 9 mp-es várakozás, nincs hirtelen
       * „időtúllépés” ugrás.
       */
      if (emptyBoot()) {
        revealWhenPainted("üres alkalmazás – kész felület");
        return;
      }
      // A logókra és az első képkockára a LISTA megjelenésétől számítunk:
      // így a korábbi lépések (bundle betöltése, tár olvasása) nem
      // "eszik meg" a várakozási időt, és a takarékép nem marad fent
      // feleslegesen másodpercekig.
      if (logoStartedAt.value === 0) logoStartedAt.value = Date.now();
      const waited = Date.now() - logoStartedAt.value;
      const logosOk = logosSettled() || waited > LOGO_WAIT_MS;
      const videoOk = videoSettled() || waited > VIDEO_WAIT_MS;
      /*
       * A FELFEDÉS NEM VÁR A TELJES (20 190 CSATORNÁS) LISTÁRA (2.5.149).
       *
       * A 28–30. napló: a lista dekódolása 3 mp, az alkalmazás 1,5 mp-re
       * fagyott tőle – mindkettő a takarókép ALATT, ezért a felfedés 7–10
       * mp-re tolódott. A látható felület viszont enélkül is kész: a fejléc,
       * a csatornalista (induló készlettel) és a lejátszó már megvan.
       * A teljes lista a felfedés UTÁN, a kész felület fölött érkezik
       * (App: startBackgroundWork → iptv-app-ready).
       */
      if (logosOk && videoOk) {
        revealWhenPainted("kész főoldal");
        return;
      }
    }

    /*
     * GYORS BIZTONSÁGI HÁLÓ: ha a tároló-felmérés valamiért nem döntött
     * (pl. az IndexedDB megnyitása elakad), 3,5 mp után akkor is megjelenik
     * a már kirajzolt felület. Így a legrosszabb eset sem 9 mp.
     */
    if (elapsed > 3500 && chromeReady() && bootState() === "checking") {
      revealWhenPainted("gyors indulás – tároló-próba lassú");
      return;
    }

    if (elapsed > 9000) {
      // Kemény felső korlát: semmi nem maradhat a takarékép mögött.
      // Ez az alkalmazás SAJÁT döntése, és az index.html 12 mp-es hálója elé
      // esik – tehát a takarékép soha nem tűnik el azelőtt, hogy az alkalmazás
      // befejezte volna a döntést a főoldal állapotáról.
      //
      // HIBA, AMIT EZ JAVÍT (2.5.112): korábban ez az ág a nyers reveal()-t
      // hívta a revealNow() helyett. A takarókép lement, de
      //   • a __IPTV_APP_READY__ jel NEM állt be,
      //   • a 6/7 és 7/7 indulási fázis NEM íródott ki,
      //   • és a 60 ms-os ellenőrző ciklus is megállt.
      // A webos.js UI-őre viszont éppen a __IPTV_APP_READY__-t figyeli; ha a
      // csatornalista akkor még nem volt a DOM-ban, 15 mp-nél diagUiFail()
      // futott, és a vörös hibaképernyő a már majdnem kész főoldal ELÉ ugrott.
      // Ez volt az „az utolsó másodpercre visszaugrott a takaróképre”.
      // Most ez az ág is a teljes revealNow() utat járja be.
      revealNow("időtúllépés");
      if (!headerReady()) fail("A felület 9 másodperc alatt nem rajzolódott ki.");
      return;
    }

    window.setTimeout(checkRendered, 40);
  };

  /*
   * A sorok megjelenését figyeljük, nem egy időzítőre várunk: így a
   * megjelenés a lehető legkésőbbi pillanatban, de egyetlen váltással
   * történik – se korábbi, se későbbi félkép nincs.
   */
  const rootElement = document.getElementById("root");
  if (rootElement && typeof MutationObserver !== "undefined") {
    const observer = new MutationObserver(() => {
      if (revealed) { observer.disconnect(); return; }
      if (chromeReady() && listReady()) observer.disconnect();
    });
    observer.observe(rootElement, { childList: true, subtree: true });
  }

  window.setTimeout(checkRendered, 40);
} catch (e) {
  fail(e);
}
