// Focus management shared by every modal dialog (WCAG 2.4.3, ARIA authoring practices):
// while an element with aria-modal="true" is open, Tab and Shift+Tab cycle inside the topmost
// one, and when it closes focus returns to the element that had it before the dialog opened.
// Installed once at the app root so every dialog (settings, wizards, palette, prompts)
// behaves the same without each one re-implementing it.

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function modals(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[aria-modal="true"]')];
}

function focusables(modal: HTMLElement): HTMLElement[] {
  return [...modal.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0,
  );
}

/** Keeps focus inside the topmost modal; returns an uninstall function. */
export function installModalFocus(doc: Document = document): () => void {
  const openers = new Map<HTMLElement, HTMLElement>();

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const all = modals(doc);
    const top = all[all.length - 1];
    if (!top) return;
    const items = focusables(top);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      e.preventDefault();
      top.focus?.();
      return;
    }
    const active = doc.activeElement;
    if (!top.contains(active)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const observer = new MutationObserver(() => {
    const open = new Set(modals(doc));
    for (const m of open) {
      if (!openers.has(m)) {
        // Remember who had focus *before* the modal grabbed it (the observer runs after the
        // render, so fall back to the last focused element outside any modal).
        const before = lastOutside;
        if (before) openers.set(m, before);
        else openers.set(m, doc.body);
      }
    }
    for (const [m, opener] of openers) {
      if (!open.has(m)) {
        openers.delete(m);
        // Focus goes back to the opener only when no modal is left: a command run from the palette
        // opens its own dialog in the same instant, and that dialog must keep the focus.
        if (open.size === 0 && opener !== doc.body && doc.contains(opener)) opener.focus();
      }
    }
  });

  let lastOutside: HTMLElement | null = null;
  const onFocusIn = (e: FocusEvent): void => {
    const t = e.target;
    if (t instanceof HTMLElement && !t.closest('[aria-modal="true"]')) lastOutside = t;
  };

  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('focusin', onFocusIn, true);
  observer.observe(doc.body, { childList: true, subtree: true });
  return () => {
    doc.removeEventListener('keydown', onKeyDown, true);
    doc.removeEventListener('focusin', onFocusIn, true);
    observer.disconnect();
  };
}
