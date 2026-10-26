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

  const headerReady = () => {
    const root = document.getElementById("root");
    return !!root && root.childElementCount > 0 && !!document.querySelector("header");
  };

  // A csatornalista sorai (role="option") - ezek megjelenése jelenti a kész
  // főoldalt. Ha nincs mentett szolgáltató/csatorna, a felület egy ablakot
  // (role="dialog") mutat: ilyenkor nincs mire várni, azonnal megjelenhet.
  const listReady = () =>
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

  const chromeReady = () => {
    return headerReady() && !!document.querySelector("[data-tv-folders]");
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
    // A lejátszó az első képkockánál __IPTV_VIDEO_READY__-t állít.
    // Ha nincs lejátszó (pl. nincs szolgáltató), nincs mit várni.
    const hasPlayer = !!document.querySelector('video[data-iptv-player="true"]');
    if (!hasPlayer) return true;
    return !!(window as any).__IPTV_VIDEO_READY__;
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
  /** Nagy felbontású óra, ha van; egyébként a falióra. */
  const nowMs = (): number => {
    try {
      if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
      }
    } catch { /* nincs performance */ }
    return Date.now();
  };
  const afterPaint = (fn: () => void) => {
    window.requestAnimationFrame(() => {
      const frameStartedAt = nowMs();
      window.requestAnimationFrame(() => {
        const frameGap = nowMs() - frameStartedAt;
        if (frameGap > FRAME_GAP_LIMIT_MS && Date.now() - startedAt <= 9000) {
          logPhase(`a takarókép fent marad: a fő szál ${Math.round(frameGap)} ms-ig foglalt volt`);
          window.setTimeout(checkRendered, 120);
          return;
        }
        fn();
      });
    });
  };

  let revealed = false;
  const revealNow = (reason: string) => {
    if (revealed) return;
    revealed = true;
    stage(6, "App állapot / Storage");
    stage(7, "Főképernyő kész");
    logPhase('főoldal kész és kirajzolva');
    try { (window as any).__IPTV_APP_READY__ = true; } catch { /* nincs window */ }
    // A webOS indítóképe és a kész főoldal egyetlen váltással cserélődik.
    reveal(reason);
  };

  const logoStartedAt = { value: 0 };

  const checkRendered = () => {
    if (revealed) return;
    const elapsed = Date.now() - startedAt;

    // Nincs beállított szolgáltató: a felület egy ablakot mutat, és ez már
    // a teljes, kész állapot – nincs mire várni.
    const onlyDialog = !!document.querySelector('[role="dialog"]');

    if (chromeReady() && (listReady() || onlyDialog)) {
      // A logókra és az első képkockára a LISTA megjelenésétől számítunk:
      // így a korábbi lépések (bundle betöltése, tár olvasása) nem
      // "eszik meg" a várakozási időt, és a takarékép nem marad fent
      // feleslegesen másodpercekig.
      if (logoStartedAt.value === 0) logoStartedAt.value = Date.now();
      const waited = Date.now() - logoStartedAt.value;
      const logosOk = logosSettled() || waited > LOGO_WAIT_MS;
      const videoOk = videoSettled() || waited > VIDEO_WAIT_MS;
      if (logosOk && videoOk) {
        afterPaint(() => revealNow("kész főoldal"));
        return;
      }
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

    window.setTimeout(checkRendered, 60);
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

  window.setTimeout(checkRendered, 60);
} catch (e) {
  fail(e);
}
