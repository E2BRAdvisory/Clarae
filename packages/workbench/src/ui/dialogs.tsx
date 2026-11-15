// In-app dialogs. window.alert/confirm/prompt are not dependable in the native
// webviews Wails uses, so every confirmation and text question goes through here.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@clarae/ui';
import { create } from 'zustand';
import { i18next } from '../i18n';
import { errorMessage } from '../util/errors';

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
      /** Text of the confirming button (default: OK). */
      confirmLabel?: string;
      resolve: (v: boolean) => void;
    }
  | { kind: 'alert'; title: string; message: string; resolve: () => void }
  | {
      kind: 'pick';
      title: string;
      items: readonly PickItem[];
      resolve: (v: string | null) => void;
    }
  | {
      kind: 'form';
      title: string;
      fields: readonly FormField[];
      validate?: (values: Record<string, string>) => string | null;
      resolve: (v: Record<string, string> | null) => void;
    };

/** A line of text of a form dialog. */
export interface FormField {
  /** The key of the value in the result. */
  name: string;
  label: string;
  initial?: string;
  placeholder?: string;
  /** Shown to the right of the label as a hint (a sentence, translated by the caller). */
  hint?: string;
  /** `url` gives an address keyboard where there is one. */
  type?: 'text' | 'url';
}

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
  confirm: (title: string, message = '', danger = false, confirmLabel?: string): Promise<boolean> =>
    new Promise((resolve) =>
      enqueue({
        kind: 'confirm',
        title,
        message,
        danger,
        ...(confirmLabel ? { confirmLabel } : {}),
        resolve,
      }),
    ),
  alert: (title: string, message = ''): Promise<void> =>
    new Promise((resolve) => enqueue({ kind: 'alert', title, message, resolve })),
  /** Asks to choose one of the items (with a filter); resolves its value, null when cancelled. */
  pick: (title: string, items: readonly PickItem[]): Promise<string | null> =>
    new Promise((resolve) => enqueue({ kind: 'pick', title, items, resolve })),
  /**
   * Asks for several lines of text at once; resolves their values by field name, null when cancelled.
   * `validate` returns the message that keeps the dialog open (shown under the fields), or null.
   */
  form: (
    title: string,
    fields: readonly FormField[],
    validate?: (values: Record<string, string>) => string | null,
  ): Promise<Record<string, string> | null> =>
    new Promise((resolve) =>
      enqueue({ kind: 'form', title, fields, ...(validate ? { validate } : {}), resolve }),
    ),
  /** Shows a failure from the backend. */
  error: (e: unknown): Promise<void> => dialog.alert(i18next.t('common.error'), errorMessage(e)),
};

/** Items of a pick list mounted at once. */
const PICK_SHOWN = 200;

function PickBody({
  request,
  onDone,
}: {
  request: Extract<Request, { kind: 'pick' }>;
  onDone: (v: string | null) => void;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const lowered = useMemo(() => request.items.map((i) => i.label.toLowerCase()), [request.items]);
  // A whole vault can be offered: only the first matches are mounted, the filter narrows the rest.
  const { shown, more } = useMemo(() => {
    const needle = filter.toLowerCase();
    const out: PickItem[] = [];
    let total = 0;
    request.items.forEach((item, k) => {
      if (!lowered[k]?.includes(needle)) return;
      total++;
      if (out.length < PICK_SHOWN) out.push(item);
    });
    return { shown: out, more: total - out.length };
  }, [request.items, lowered, filter]);
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
        {more > 0 && <li className="muted">{t('dialog.more', { count: more })}</li>}
      </ul>
      <div className="actions">
        <button onClick={() => onDone(null)}>{t('common.cancel')}</button>
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
          {t('common.cancel')}
        </button>
        <button type="submit" className="primary">
          {t('common.ok')}
        </button>
      </div>
    </form>
  );
}

function FormBody({
  request,
  onDone,
}: {
  request: Extract<Request, { kind: 'form' }>;
  onDone: (v: Record<string, string> | null) => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(request.fields.map((f) => [f.name, f.initial ?? ''])),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
    first.current?.select();
  }, []);
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const message = request.validate?.(values) ?? null;
        if (message) setProblem(message);
        else onDone(values);
      }}
    >
      {request.fields.map((f, i) => (
        <div className="form-field" key={f.name}>
          <label htmlFor={`dialog-field-${f.name}`}>{f.label}</label>
          <input
            id={`dialog-field-${f.name}`}
            ref={i === 0 ? first : undefined}
            type={f.type === 'url' ? 'url' : 'text'}
            inputMode={f.type === 'url' ? 'url' : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder={f.placeholder}
            aria-describedby={
              [f.hint ? `dialog-hint-${f.name}` : '', problem ? 'dialog-problem' : '']
                .filter(Boolean)
                .join(' ') || undefined
            }
            aria-invalid={problem ? true : undefined}
            value={values[f.name] ?? ''}
            onChange={(e) => {
              setValues({ ...values, [f.name]: e.target.value });
              setProblem(null);
            }}
          />
          {f.hint && (
            <small id={`dialog-hint-${f.name}`} className="muted">
              {f.hint}
            </small>
          )}
        </div>
      ))}
      {problem && (
        <p id="dialog-problem" className="form-problem" role="alert">
          {problem}
        </p>
      )}
      <div className="actions">
        <button type="button" onClick={() => onDone(null)}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="primary">
          {t('common.ok')}
        </button>
      </div>
    </form>
  );
}

/** The workbench look of the imperative dialogs (style.css `.modal.dialog`). */
const DIALOG_CLASSES = { backdrop: 'modal-backdrop', dialog: 'modal dialog' };

/**
 * Renders the pending dialog; mount once near the root. It goes through the Dialog primitive of
 * @clarae/ui (focus, Escape, labelling: ADR-0043) with the workbench classes.
 */
export function DialogHost() {
  const { t } = useTranslation();
  const current = useDialogs((s) => s.current);
  if (!current) return null;

  const finish = (value: string | boolean | Record<string, string> | null): void => {
    if (current.kind === 'prompt' || current.kind === 'pick')
      current.resolve(value as string | null);
    else if (current.kind === 'form') current.resolve(value as Record<string, string> | null);
    else if (current.kind === 'confirm') current.resolve(value === true);
    else current.resolve();
    next();
  };
  const cancel = (): void =>
    finish(
      current.kind === 'prompt' || current.kind === 'pick' || current.kind === 'form'
        ? null
        : false,
    );

  return (
    <Dialog
      title={current.title}
      onClose={cancel}
      classNames={DIALOG_CLASSES}
      closeOnBackdrop
      onKeyDown={(e) => {
        if (
          e.key === 'Enter' &&
          current.kind !== 'prompt' &&
          current.kind !== 'pick' &&
          current.kind !== 'form'
        ) {
          e.preventDefault();
          finish(true);
        }
      }}
    >
      {current.kind === 'prompt' ? (
        <PromptBody key={current.title + current.initial} request={current} onDone={finish} />
      ) : current.kind === 'form' ? (
        <FormBody key={current.title} request={current} onDone={finish} />
      ) : current.kind === 'pick' ? (
        <PickBody key={current.title} request={current} onDone={finish} />
      ) : (
        <>
          {current.message && <p className="muted">{current.message}</p>}
          <div className="actions">
            {current.kind === 'confirm' && <button onClick={cancel}>{t('common.cancel')}</button>}
            <button
              className={current.kind === 'confirm' && current.danger ? 'danger' : 'primary'}
              autoFocus
              onClick={() => finish(true)}
            >
              {(current.kind === 'confirm' && current.confirmLabel) || t('common.ok')}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
