import { useEffect, useRef } from 'react';

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
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
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
        if (e.key === 'ArrowDown') {
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
    } else if (e.key === 'Escape' || e.key === 'Backspace') {
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
