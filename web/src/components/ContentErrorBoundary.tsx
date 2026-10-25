import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { appLogError } from '../services/appLog';

interface ContentErrorBoundaryProps {
  label: string;
  onBackToLive?: () => void;
  children: ReactNode;
}

interface ContentErrorBoundaryState {
  error: Error | null;
}

/**
 * A nagy, háttérben épülő VOD-nézet hibája nem ejtheti ki az egész TV-appot.
 *
 * A webOS egyes régi Chromium-motorjai memóriahiánynál nem küldenek
 * JavaScript-hibát, csak bezárják a webappot. Ezt a boundary-től nem lehet
 * teljesen elkapni, de a renderelési hibákat és a túl nagy/hibás cache egyéb
 * következményeit a sorozat- vagy mozinézetben tartjuk, az élő TV-t pedig
 * használható állapotban hagyjuk.
 */
export class ContentErrorBoundary extends Component<ContentErrorBoundaryProps, ContentErrorBoundaryState> {
  state: ContentErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ContentErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // appLogError csak kézi diagnosztikai naplózásnál ír ténylegesen, ezért a
    // normál tévézést nem terheli; kézi méréskor viszont megmarad a stack.
    appLogError(`${this.props.label} nézet megjelenítése`, error);
    try {
      console.error(`IPTV-RT ${this.props.label} nézet hiba`, error, info.componentStack);
    } catch {
      /* a TV konzolja nem kritikus */
    }
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div
        role="status"
        className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center bg-[#070e1e] text-slate-200"
      >
        <AlertTriangle className="w-12 h-12 text-amber-400" />
        <div>
          <div className="text-lg font-black text-amber-300">A {this.props.label.toLowerCase()} nézet nem tölthető be</div>
          <p className="mt-2 max-w-xl text-sm text-slate-400">
            Az élő TV továbbra is használható. A részletes hiba csak a kézi diagnosztikai naplóban jelenik meg.
          </p>
        </div>
        {this.props.onBackToLive && (
          <button
            type="button"
            onClick={this.props.onBackToLive}
            className="rounded-xl bg-cyan-400 px-5 py-3 font-black text-slate-950"
          >
            Élő TV megnyitása
          </button>
        )}
      </div>
    );
  }
}

export default ContentErrorBoundary;
