/**
 * Page-level overlays of the workbench page: they cover the whole page, workbench UI included, and are
 * built here with the DOM (no inline styles: the CSP forbids them; the look is in shell.css). One at a
 * time: showing an overlay replaces the previous one.
 */
import { checkPassphrase } from '@clarae/workbench/strength';
import { message, plural } from './strings';

export interface OverlayAction {
  label: string;
  kind?: 'primary' | 'danger';
  onClick: () => void;
}

export interface OverlayOptions {
  title?: string;
  lines: string[];
  actions?: OverlayAction[];
  /** Extra content between the text and the buttons (a form). */
  content?: HTMLElement;
  /** A progress message: announced politely, no buttons. */
  busy?: boolean;
}

export interface Overlay {
  readonly element: HTMLElement;
  close(): void;
}

const OVERLAY_ID = 'page-overlay';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function button(a: OverlayAction): HTMLButtonElement {
  const b = el('button', { type: 'button', textContent: a.label });
  if (a.kind) b.className = a.kind;
  b.addEventListener('click', () => a.onClick());
  return b;
}

export function showOverlay(o: OverlayOptions): Overlay {
  document.getElementById(OVERLAY_ID)?.remove();
  const card = el('div', { className: 'page-overlay__card' });
  const root = el('div', { id: OVERLAY_ID, className: 'page-overlay' }, [card]);
  if (o.busy) {
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
  } else {
    root.setAttribute('role', 'alertdialog');
    root.setAttribute('aria-modal', 'true');
  }
  if (o.title) {
    const h = el('h2', { id: `${OVERLAY_ID}-title`, textContent: o.title });
    card.append(h);
    root.setAttribute('aria-labelledby', h.id);
  }
  for (const line of o.lines) card.append(el('p', { textContent: line }));
  if (o.content) card.append(o.content);
  if (o.actions?.length)
    card.append(el('div', { className: 'page-overlay__actions' }, o.actions.map(button)));
  document.body.append(root);
  // Keyboard focus belongs to the overlay, not to the workbench underneath.
  (card.querySelector<HTMLElement>('input, button') ?? card).focus();
  return { element: root, close: () => root.remove() };
}

export function closeOverlay(): void {
  document.getElementById(OVERLAY_ID)?.remove();
}

/** The core stopped: nothing on the page works any more until it is reloaded. */
export function showFatal(reload: () => void = () => window.location.reload()): Overlay {
  return showOverlay({
    lines: [message('workbench.fatal')],
    actions: [{ label: message('workbench.reload'), kind: 'primary', onClick: reload }],
  });
}

/** What a copy kept in the browser holds that the cloud does not have, as sentences. */
export function unsyncedLines(pending: number, conflicts: number, dirty = false): string[] {
  const lines: string[] = [];
  if (pending > 0) lines.push(plural('workbench.lockedPending', pending));
  if (conflicts > 0) lines.push(plural('workbench.lockedConflicts', conflicts));
  if (lines.length === 0 && dirty) lines.push(message('workbench.lockedUnscanned'));
  return lines;
}

/**
 * Asks before deleting a copy that holds changes: the overlay turns into a confirmation, and back into
 * what it was (`back`) on Cancel.
 */
export function confirmDelete(onDelete: () => void, back: () => void): Overlay {
  return showOverlay({
    title: message('workbench.lockedTitle'),
    lines: [message('workbench.deleteConfirm')],
    actions: [
      { label: message('common.cancel'), onClick: back },
      { label: message('workbench.deleteConfirmButton'), kind: 'danger', onClick: onDelete },
    ],
  });
}

export interface LockedChoices {
  unlock: () => void;
  deleteCopy: () => void;
  backToConsole: () => void;
}

/** A private vault was locked while its copy holds changes the cloud does not have. */
export function showLocked(
  counts: { pending: number; conflicts: number; dirty?: boolean },
  c: LockedChoices,
): Overlay {
  const show = (): Overlay =>
    showOverlay({
      title: message('workbench.lockedTitle'),
      lines: [
        ...unsyncedLines(counts.pending, counts.conflicts, counts.dirty),
        message('workbench.lockedHint'),
      ],
      actions: [
        { label: message('workbench.back'), onClick: c.backToConsole },
        {
          label: message('workbench.deleteAnyway'),
          kind: 'danger',
          onClick: () => confirmDelete(c.deleteCopy, show),
        },
        { label: message('workbench.unlock'), kind: 'primary', onClick: c.unlock },
      ],
    });
  return show();
}

export interface UnlockGateOptions {
  counts: { pending: number; conflicts: number; dirty?: boolean };
  /** VaultCryptoAPI.Unlock: resolves to true when a new passphrase must be set (recovery key used). */
  unlock: (secret: string, recovery: boolean) => Promise<boolean>;
  /** VaultCryptoAPI.SetPassphrase: the core refuses a weak passphrase (`weak-passphrase: …`). */
  setPassphrase: (passphrase: string) => Promise<void>;
  /**
   * The live feedback on a new passphrase (§3.8.2): the workbench's own check (zxcvbn), the same rule
   * the core enforces, so the gate says early what the core would refuse. Replaceable in tests.
   */
  check?: (passphrase: string) => Promise<{ longEnough: boolean; ok: boolean }>;
  deleteCopy: () => void;
  backToConsole: () => void;
}

const errorText = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : String(e);

/**
 * The text of a failure of the core in the gate. The typed errors of the passphrase are translated:
 * `weak-passphrase: <reason>: …` (the core's policy, ADR-0045 point 8) and `wrong-secret: …` (the
 * passphrase or recovery key does not open the vault); anything else is shown as written.
 */
export function gateErrorText(e: unknown): string {
  const raw = errorText(e).trim();
  const weak = /^weak-passphrase:\s*([a-z-]+):/.exec(raw);
  if (weak)
    return message(
      weak[1] === 'too-short' ? 'workbench.newPassphraseShort' : 'workbench.newPassphraseWeak',
    );
  if (/^wrong-secret:/.test(raw)) return message('workbench.wrongSecret');
  return raw;
}

/**
 * Opening a private vault whose copy holds changes that were not uploaded: the clear text must not show
 * before the vault is unlocked, so the passphrase is asked here, before the workbench is mounted.
 * Resolves once the vault is unlocked (and, after the recovery key, has a new passphrase).
 */
export function showUnlockGate(o: UnlockGateOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    const secretStep = (): void => {
      const input = el('input', {
        id: 'gate-secret',
        type: 'password',
        autocomplete: 'off',
        required: true,
      });
      const label = el('label', {
        htmlFor: input.id,
        textContent: message('workbench.passphrase'),
      });
      const recovery = el('input', { id: 'gate-recovery', type: 'checkbox' });
      recovery.addEventListener('change', () => {
        label.textContent = message(
          recovery.checked ? 'workbench.recoveryKey' : 'workbench.passphrase',
        );
        input.type = recovery.checked ? 'text' : 'password';
      });
      const error = el('p', { className: 'page-overlay__error', hidden: true });
      error.setAttribute('role', 'alert');
      const submit = el('button', {
        type: 'submit',
        className: 'primary',
        textContent: message('workbench.unlock'),
      });
      const form = el('form', { className: 'page-overlay__form' }, [
        label,
        input,
        el('label', { className: 'page-overlay__check' }, [
          recovery,
          message('workbench.useRecoveryKey'),
        ]),
        error,
        el('div', { className: 'page-overlay__actions' }, [
          button({ label: message('workbench.back'), onClick: o.backToConsole }),
          button({
            label: message('workbench.deleteAnyway'),
            kind: 'danger',
            onClick: () => confirmDelete(o.deleteCopy, secretStep),
          }),
          submit,
        ]),
      ]);
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        if (!input.value) return;
        submit.disabled = true;
        error.hidden = true;
        o.unlock(input.value, recovery.checked).then(
          (mustChange) => (mustChange ? passphraseStep() : finish()),
          (e: unknown) => {
            submit.disabled = false;
            error.textContent = gateErrorText(e);
            error.hidden = false;
          },
        );
      });
      showOverlay({
        title: message('workbench.gateTitle'),
        lines: [
          ...unsyncedLines(o.counts.pending, o.counts.conflicts, o.counts.dirty),
          message('workbench.lockedHint'),
        ],
        content: form,
      });
    };

    const passphraseStep = (): void => {
      const pass = el('input', { id: 'gate-new', type: 'password', autocomplete: 'new-password' });
      const again = el('input', {
        id: 'gate-again',
        type: 'password',
        autocomplete: 'new-password',
      });
      const error = el('p', { className: 'page-overlay__error', hidden: true });
      error.setAttribute('role', 'alert');
      const submit = el('button', {
        type: 'submit',
        className: 'primary',
        textContent: message('workbench.save'),
      });
      const form = el('form', { className: 'page-overlay__form' }, [
        el('label', { htmlFor: pass.id, textContent: message('workbench.newPassphrase') }),
        pass,
        el('label', { htmlFor: again.id, textContent: message('workbench.newPassphraseAgain') }),
        again,
        error,
        el('div', { className: 'page-overlay__actions' }, [submit]),
      ]);
      const fail = (text: string): void => {
        error.textContent = text;
        error.hidden = false;
      };
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const value = pass.value;
        submit.disabled = true;
        error.hidden = true;
        void (o.check ?? checkPassphrase)(value)
          .then((strength) => {
            if (!strength.longEnough) throw new Error(message('workbench.newPassphraseShort'));
            if (!strength.ok) throw new Error(message('workbench.newPassphraseWeak'));
            if (value !== again.value) throw new Error(message('workbench.newPassphraseMismatch'));
            return o.setPassphrase(value);
          })
          // The live check is feedback: the core applies the policy again and its refusal
          // (`weak-passphrase`) is shown translated like the rest.
          .then(finish, (e: unknown) => {
            submit.disabled = false;
            fail(gateErrorText(e));
          });
      });
      showOverlay({
        title: message('workbench.gateTitle'),
        lines: [message('workbench.newPassphraseIntro')],
        content: form,
      });
    };

    const finish = (): void => {
      closeOverlay();
      resolve();
    };

    secretStep();
  });
}
