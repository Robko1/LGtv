import { StrictMode, Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./themes/webos.css";
document.body.classList.add('webos-theme', 'webos-tv', 'lg-webos');
import App from "./App";

/*
 * LG webOS TV – csak TV kinézet, mindig webos-theme
 * Indítási napló boot-splash-hez
 */
const stage = (n: number, label: string) => {
  try { (window as any).__IPTV_STARTUP_STAGE_SET__?.(n, label); } catch {}
};
const fail = (e: unknown) => {
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
   * A megjelenítést az index.html __IPTV_REVEAL__ függvénye végzi (7 mp-es
   * biztonsági hálóval, hogy semmi ne maradjon rejtve).
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

  const checkRendered = () => {
    const elapsed = Date.now() - startedAt;

    if (headerReady() && listReady()) {
      stage(6, "App állapot / Storage");
      stage(7, "Főképernyő kész");
      try { (window as any).__IPTV_APP_READY__ = true; } catch { /* nincs window */ }
      reveal("kész főoldal");
      return;
    }

    if (headerReady() && elapsed > 2000) {
      // Van felület, de nincs (vagy még nincs) lista - pl. nincs beállított
      // szolgáltató. Nem várakoztatjuk tovább a nézőt.
      stage(6, "App állapot / Storage");
      stage(7, "Főképernyő kész");
      try { (window as any).__IPTV_APP_READY__ = true; } catch { /* nincs window */ }
      reveal("lista nélkül");
      return;
    }

    if (elapsed > 8000) {
      // Kemény felső korlát: hibaüzenet helyett inkább látszódjon a felület
      // (az index.html 7 mp-es hálója ezt amúgy is megtenné).
      reveal("időtúllépés");
      if (!headerReady()) fail("A felület 8 másodperc alatt nem rajzolódott ki.");
      return;
    }

    window.setTimeout(checkRendered, 120);
  };

  window.setTimeout(checkRendered, 120);
} catch (e) {
  fail(e);
}
