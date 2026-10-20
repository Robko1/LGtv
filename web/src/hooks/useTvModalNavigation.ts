import { useEffect, useRef } from 'react';
import { normalizeTvKey } from '../utils/tvKeys';

/**
 * TV / stick / egér támogatás modalokhoz
 * - Auto-focus a modal első gombjára
 * - D-pad fel/le navigáció a fókuszálható elemek között
 * - Escape / Backspace bezárja a modalt
 * - Egér kattintás a háttérre bezár
 */
export function useTvModalNavigation(isOpen: boolean, onClose: () => void, deps: any[] = []) {
  const modalRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const focusModal = () => {
      try {
        const container = modalRef.current;
        if (!container) return;
        // FÓKUSZRABLÁS TILTVA: ha a fókusz már a modalban van (a néző épp
        // navigál benne), nem nyúlunk hozzá.
        const ae = document.activeElement as HTMLElement | null;
        if (ae && container.contains(ae) && ae !== container) return;
        // Ha a fókusz egy FELETTÜNK nyitott ablakban van (a webos.js nyitási
        // sorszáma nagyobb), szintén tilos elrabolni.
        const aeDlg = (ae && ae.closest ? ae.closest('[role="dialog"]') : null) as HTMLElement | null;
        const myDlg = (container.closest('[role="dialog"]') || container.querySelector('[role="dialog"]')) as HTMLElement | null;
        if (aeDlg && myDlg && aeDlg !== myDlg) {
          const aSeq = parseInt(aeDlg.getAttribute('data-iptv-dlgseq') || '0', 10);
          const mSeq = parseInt(myDlg.getAttribute('data-iptv-dlgseq') || '0', 10);
          if (aSeq > 0 && aSeq >= mSeq) return;
        }
        const focusable = container.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length > 0) {
          const firstButton = Array.from(focusable).find(
            (el) => el.tagName === 'BUTTON'
          ) as HTMLElement | undefined;
          (firstButton || focusable[0])?.focus({ preventScroll: true } as any);
        } else {
          container.focus();
        }
      } catch {}
    };
    const t1 = window.setTimeout(focusModal, 100);
    const t2 = window.setTimeout(focusModal, 500);
    const t3 = window.setTimeout(focusModal, 1000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [isOpen, ...deps]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // LG webOS: régi kulcsnév ('Up') vagy csak keyCode (37–40, VISSZA=461) is jöhet.
    const key = normalizeTvKey(e);
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      try {
        const container = modalRef.current;
        if (!container) return;
        const focusable = Array.from(
          container.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          )
        ).filter(
          (el) => !el.hasAttribute('disabled') && (el as HTMLElement).offsetParent !== null
        );
        if (focusable.length === 0) return;
        const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        e.stopPropagation();
        if (key === 'ArrowDown') {
          const next = focusable[(currentIndex + 1) % focusable.length];
          next?.focus();
          next?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } else {
          const prev =
            focusable[(currentIndex - 1 + focusable.length) % focusable.length];
          prev?.focus();
          prev?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      } catch {}
    } else if (key === 'Escape' || key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return { modalRef, handleKeyDown, handleBackdropClick };
}
