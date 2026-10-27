// In-app dialogs. window.alert/confirm/prompt are not dependable in the native
// webviews Wails uses, so every confirmation and text question goes through here.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { i18next } from '../i18n';

type Request =
  | {
      kind: 'prompt';
      title: string;
      label?: string;
      initial: string;
      resolve: (v: string | null) => void;
    }
  | {
      kind: 'confirm';
      title: string;
      message: string;
      danger: boolean;
      resolve: (v: boolean) => void;
    }
  | { kind: 'alert'; title: string; message: string; resolve: () => void }
  | {
      kind: 'pick';
      title: string;
      items: readonly PickItem[];
      resolve: (v: string | null) => void;
    };

export interface PickItem {
  value: string;
  label: string;
}

interface DialogState {
  current: Request | null;
  queue: Request[];
}

const useDialogs = create<DialogState>(() => ({ current: null, queue: [] }));

function enqueue(r: Request): void {
  useDialogs.setState((s) => (s.current ? { queue: [...s.queue, r] } : { current: r }));
}

function next(): void {
  useDialogs.setState((s) => ({ current: s.queue[0] ?? null, queue: s.queue.slice(1) }));
}

export const dialog = {
  /** Asks for a line of text; resolves null when cancelled. */
  prompt: (title: string, initial = '', label?: string): Promise<string | null> =>
    new Promise((resolve) =>
      enqueue({ kind: 'prompt', title, initial, ...(label ? { label } : {}), resolve }),
    ),
  confirm: (title: string, message = '', danger = false): Promise<boolean> =>
    new Promise((resolve) => enqueue({ kind: 'confirm', title, message, danger, resolve })),
  alert: (title: string, message = ''): Promise<void> =>
    new Promise((resolve) => enqueue({ kind: 'alert', title, message, resolve })),
  /** Asks to choose one of the items (with a filter); resolves its value, null when cancelled. */
  pick: (title: string, items: readonly PickItem[]): Promise<string | null> =>
    new Promise((resolve) => enqueue({ kind: 'pick', title, items, resolve })),
  /** Shows a failure from the backend. */
  error: (e: unknown): Promise<void> =>
    dialog.alert(i18next.t('dialog.error'), e instanceof Error ? e.message : String(e)),
};

function PickBody({
  request,
  onDone,
}: {
  request: Extract<Request, { kind: 'pick' }>;
  onDone: (v: string | null) => void;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const shown = request.items.filter((i) => i.label.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div>
      <input
        autoFocus
        aria-label={t('dialog.filter')}
        placeholder={t('dialog.filter')}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && shown[0]) {
            e.preventDefault();
            e.stopPropagation();
            onDone(shown[0].value);
          }
        }}
        style={{ width: '100%' }}
      />
      <ul className="pick-list" role="listbox" aria-label={request.title}>
        {shown.length === 0 && <li className="muted">{t('dialog.nothing')}</li>}
        {shown.map((i) => (
          <li key={i.value} role="option" aria-selected={false}>
            <button onClick={() => onDone(i.value)}>{i.label}</button>
          </li>
        ))}
      </ul>
      <div className="actions">
        <button onClick={() => onDone(null)}>{t('dialog.cancel')}</button>
      </div>
    </div>
  );
}

function PromptBody({
  request,
  onDone,
}: {
  request: Extract<Request, { kind: 'prompt' }>;
  onDone: (v: string | null) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(request.initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onDone(text);
      }}
    >
      {request.label && <label htmlFor="dialog-input">{request.label}</label>}
      <input
        id="dialog-input"
        ref={input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={{ width: '100%' }}
      />
      <div className="actions">
        <button type="button" onClick={() => onDone(null)}>
          {t('dialog.cancel')}
        </button>
        <button type="submit" className="primary">
          {t('dialog.ok')}
        </button>
      </div>
    </form>
  );
}

/** Renders the pending dialog; mount once near the root. */
export function DialogHost() {
  const { t } = useTranslation();
  const current = useDialogs((s) => s.current);
  if (!current) return null;

  const finish = (value: string | boolean | null): void => {
    if (current.kind === 'prompt' || current.kind === 'pick')
      current.resolve(value as string | null);
    else if (current.kind === 'confirm') current.resolve(value === true);
    else current.resolve();
    next();
  };
  const cancel = (): void =>
    finish(current.kind === 'prompt' || current.kind === 'pick' ? null : false);

  return (
    <div className="modal-backdrop" onMouseDown={cancel} role="presentation">
      <div
        className="modal dialog"
        role="dialog"
        aria-modal="true"
        aria-label={current.title}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
          if (e.key === 'Enter' && current.kind !== 'prompt' && current.kind !== 'pick') {
            e.preventDefault();
            finish(true);
          }
        }}
      >
        <h2>{current.title}</h2>
        {current.kind === 'prompt' ? (
          <PromptBody key={current.title + current.initial} request={current} onDone={finish} />
        ) : current.kind === 'pick' ? (
          <PickBody key={current.title} request={current} onDone={finish} />
        ) : (
          <>
            {current.message && <p className="muted">{current.message}</p>}
            <div className="actions">
              {current.kind === 'confirm' && <button onClick={cancel}>{t('dialog.cancel')}</button>}
              <button
                className={current.kind === 'confirm' && current.danger ? 'danger' : 'primary'}
                autoFocus
                onClick={() => finish(true)}
              >
                {t('dialog.ok')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
