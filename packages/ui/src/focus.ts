// Focus management shared by every modal dialog (WCAG 2.4.3, ARIA authoring practices), for the
// console and the workbench alike (ADR-0043): while an element with aria-modal="true" is open, Tab
// and Shift+Tab cycle inside the topmost one, and when it closes focus returns to the element that
// had it before the dialog opened. One handler per document: the workbench installs it at its root,
// the Dialog primitive makes sure it is there (ensureModalFocus), so a page never has two traps.

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const MODAL = '[aria-modal="true"]';

/** The events of the user acting on a modal (see keepInside). */
const ACTIONS = ['keydown', 'mousedown', 'click', 'submit'] as const;

/** How many recent focus targets are remembered to find a dialog's opener. */
const HISTORY = 16;

function modals(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(MODAL)];
}

function focusables(modal: HTMLElement): HTMLElement[] {
  return [...modal.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0,
  );
}

interface Installed {
  uninstall: () => void;
  /** Registers the modals open now (without waiting for the observer). */
  sync: () => void;
  /** Explicit installs (installModalFocus) still holding the handler. */
  holders: number;
  /** Asked for by a Dialog (ensureModalFocus): stays installed for the life of the document. */
  pinned: boolean;
}

const installed = new WeakMap<Document, Installed>();

function attach(doc: Document): Pick<Installed, 'uninstall' | 'sync'> {
  // Candidates for the opener of each open modal, most recent first: the element that had focus
  // before it opened, then older ones, used when the first is gone by the time the modal closes.
  const openers = new Map<HTMLElement, HTMLElement[]>();
  // Recent focus targets, most recent first (inside modals too: a dialog opened from another
  // dialog gives focus back to the control of the first one).
  const history: HTMLElement[] = [];
  const remember = (el: Element | null): void => {
    if (!(el instanceof HTMLElement) || el === doc.body) return;
    const at = history.indexOf(el);
    if (at >= 0) history.splice(at, 1);
    history.unshift(el);
    if (history.length > HISTORY) history.length = HISTORY;
  };

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

  const sync = (): void => {
    const open = modals(doc);
    for (const m of open) {
      // The observer runs after the render, when the modal may already hold the focus: its opener
      // is the most recent element outside it.
      if (!openers.has(m))
        openers.set(
          m,
          history.filter((el) => !m.contains(el)),
        );
    }
    for (const [m, candidates] of openers) {
      if (open.includes(m)) continue;
      openers.delete(m);
      const opener = candidates.find((el) => el.isConnected && !el.closest('[inert]'));
      if (!opener) continue;
      if (open.length === 0) {
        opener.focus();
        continue;
      }
      // Another modal is still open. A command run from the palette opens its own dialog in the
      // same instant, and that dialog keeps the focus; a dialog opened from a control of the
      // remaining one gives the focus back to that control when nothing else holds it.
      const top = open[open.length - 1] as HTMLElement;
      const active = doc.activeElement;
      const focusLost = !active || active === doc.body || !active.isConnected;
      if (focusLost && top.contains(opener)) opener.focus();
    }
  };

  // Focus taken by a component outside the open modal, without the user asking for it: a widget
  // that focuses its own field a frame after it mounted (Excalidraw does so with the search box of
  // its library panel), a view that reclaims focus after an update. The modal is aria-modal, so
  // focus goes back where it was in it (or to its first control). Left alone: a target inside any
  // open modal (dialogs open over dialogs, and the order in the page is not always the stacking),
  // and what the handling of the user's own action in the modal does (the Enter that answers a
  // dialog resolves its promise, and the command goes on to focus the editor while the dialog is
  // still on screen for the few ms before it unmounts).
  let restoring = false;
  let acting = false;
  // From the start of the event in the modal (capture) to the end of its dispatch (bubble, which a
  // handler that stops the event does not reach: the timer is for that case).
  const onAction = (e: Event): void => {
    const t = e.target;
    if (!(t instanceof Node) || !modals(doc).some((m) => m.contains(t))) return;
    acting = true;
    setTimeout(() => {
      acting = false;
    }, 0);
  };
  const onActionEnd = (): void => {
    acting = false;
  };
  const keepInside = (e: FocusEvent): boolean => {
    if (restoring || acting) return false;
    const all = modals(doc);
    const top = all[all.length - 1];
    const target = e.target;
    if (!top || !(target instanceof Node)) return false;
    if (all.some((m) => m.contains(target))) return false;
    const from = e.relatedTarget;
    const back =
      from instanceof HTMLElement && from.isConnected && top.contains(from)
        ? from
        : (focusables(top)[0] ?? top);
    restoring = true;
    try {
      back.focus();
    } finally {
      restoring = false;
    }
    return true;
  };

  const observer = new MutationObserver(sync);
  // What took the focus and was sent back is not an opener to remember.
  const onFocusIn = (e: FocusEvent): void => {
    if (!keepInside(e)) remember(e.target as Element | null);
  };

  remember(doc.activeElement);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('focusin', onFocusIn, true);
  for (const type of ACTIONS) {
    doc.addEventListener(type, onAction, true);
    doc.addEventListener(type, onActionEnd);
  }
  observer.observe(doc.body, { childList: true, subtree: true });
  sync();
  return {
    sync,
    uninstall: () => {
      sync(); // settle the modals removed in this same task before stopping
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('focusin', onFocusIn, true);
      for (const type of ACTIONS) {
        doc.removeEventListener(type, onAction, true);
        doc.removeEventListener(type, onActionEnd);
      }
      observer.disconnect();
    },
  };
}

/**
 * Keeps focus inside the topmost modal; returns an uninstall function. Installing it again on the
 * same document shares the one handler (it is removed when the last install is undone, unless a
 * Dialog asked for it with ensureModalFocus).
 */
export function installModalFocus(doc: Document = document): () => void {
  let entry = installed.get(doc);
  if (!entry) {
    entry = { ...attach(doc), holders: 0, pinned: false };
    installed.set(doc, entry);
  }
  entry.holders++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const e = installed.get(doc);
    if (!e) return;
    e.holders--;
    if (e.holders <= 0 && !e.pinned) {
      e.uninstall();
      installed.delete(doc);
    }
  };
}

/**
 * Makes sure the document has the modal focus handler (installed by the host, or now, for good) and
 * that it knows the modals open now: the Dialog primitive calls it when it mounts, before moving the
 * focus, so a page that did not install the handler still traps Tab and a page that did keeps one.
 */
export function ensureModalFocus(doc: Document = document): void {
  const e = installed.get(doc);
  if (e) {
    e.pinned = true;
    // The dialog has just been rendered and has not moved the focus yet: register it now, so its
    // opener is known even if it closes before the observer runs.
    e.sync();
  } else installed.set(doc, { ...attach(doc), holders: 0, pinned: true });
}

/** Whether the document has the modal focus handler (for tests and diagnostics). */
export function hasModalFocus(doc: Document = document): boolean {
  return installed.has(doc);
}
