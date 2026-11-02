import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TableHTMLAttributes,
} from 'react';
import { ensureModalFocus } from './focus';
import { quotaLevel, quotaPercent, type QuotaLevel } from './quota';

function cx(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/* ---- Button ---------------------------------------------------------- */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger';
  small?: boolean;
}

export function Button({ variant = 'default', small, className, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={cx(
        'nd-button',
        variant !== 'default' && `nd-button--${variant}`,
        small && 'nd-button--small',
        className,
      )}
      {...rest}
    />
  );
}

/* ---- Badge ----------------------------------------------------------- */

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'danger';
  children: ReactNode;
}) {
  return (
    <span className={cx('nd-badge', tone !== 'neutral' && `nd-badge--${tone}`)}>{children}</span>
  );
}

/* ---- Form controls ---------------------------------------------------- */

interface FieldShellProps {
  label: string;
  hint?: string;
}

/** A labelled text input; the label is always rendered (visually) and bound with htmlFor. */
export function TextField({
  label,
  hint,
  className,
  ...rest
}: FieldShellProps & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="nd-field">
      <label className="nd-field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={cx('nd-input', className)}
        aria-describedby={hint ? hintId : undefined}
        {...rest}
      />
      {hint && (
        <span id={hintId} className="nd-field__hint">
          {hint}
        </span>
      )}
    </div>
  );
}

export function SelectField({
  label,
  hint,
  className,
  children,
  ...rest
}: FieldShellProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="nd-field">
      <label className="nd-field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className={cx('nd-select', className)}
        aria-describedby={hint ? hintId : undefined}
        {...rest}
      >
        {children}
      </select>
      {hint && (
        <span id={hintId} className="nd-field__hint">
          {hint}
        </span>
      )}
    </div>
  );
}

/* ---- Table ------------------------------------------------------------ */

export function Table({
  caption,
  children,
  ...rest
}: { caption?: string } & TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="nd-table-wrap">
      <table className="nd-table" {...rest}>
        {caption && <caption>{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

/* ---- Card, empty state, inline error ----------------------------------- */

export function Card({
  children,
  ...rest
}: { children: ReactNode } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className="nd-card" {...rest}>
      {children}
    </section>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="nd-empty">
      <p className="nd-empty__title">{title}</p>
      {children && <div>{children}</div>}
    </div>
  );
}

/** Error message next to the content it relates to (announced to screen readers). */
export function InlineError({ children }: { children: ReactNode }) {
  return (
    <p className="nd-inline-error" role="alert">
      {children}
    </p>
  );
}

/* ---- Quota bar ---------------------------------------------------------- */

export interface QuotaBarProps {
  usedBytes: number;
  /** -1 means unlimited. */
  quotaBytes: number;
  /** Accessible name of the bar. */
  label: string;
  /** Visible caption, already formatted (e.g. "1.2 GB of 5 GB"). */
  caption: string;
  /** Visible percentage text, already formatted. */
  percentText?: string;
  /**
   * The level as the server computed it from the administrator's thresholds (`Usage.level`); when
   * absent, the default thresholds apply (quotaLevel).
   */
  level?: QuotaLevel | undefined;
}

/**
 * Storage quota meter. Levels: ok below 80 %, warn from 80 %, critical from 95 %,
 * full at 100 % (or the server's, `level`). Rendered with a native <progress>: its fill is
 * painted by CSS, so the page needs no inline style (style-src 'self').
 */
export function QuotaBar({
  usedBytes,
  quotaBytes,
  label,
  caption,
  percentText,
  level: serverLevel,
}: QuotaBarProps) {
  const level = serverLevel ?? quotaLevel(usedBytes, quotaBytes);
  const pct = quotaPercent(usedBytes, quotaBytes);
  return (
    <div className="nd-quota" data-level={level} data-testid="quota-bar">
      <progress
        className="nd-quota__bar"
        aria-label={label}
        value={quotaBytes > 0 ? Math.round(pct) : 0}
        max={100}
      />
      <div className="nd-quota__caption">
        <span>{caption}</span>
        {percentText && <span>{percentText}</span>}
      </div>
    </div>
  );
}

/* ---- Dialog -------------------------------------------------------------- */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Footer buttons. */
  actions?: ReactNode;
  /**
   * Classes of a host's own look, used instead of the nd-* ones (the workbench keeps its `modal`
   * classes): the behaviour stays the same.
   */
  classNames?: { backdrop?: string; dialog?: string };
  /** A press on the backdrop (outside the dialog) closes it. */
  closeOnBackdrop?: boolean;
  /** Keys the host handles itself (Enter to confirm, …), before Escape closes the dialog. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}

/**
 * Modal dialog: focus moves in (unless a control inside already took it), Escape closes. Tab stays
 * inside and focus returns to the opener on close through the document's one modal focus handler
 * (focus.ts), which the dialog installs if the host has not.
 */
export function Dialog({
  title,
  onClose,
  children,
  actions,
  classNames,
  closeOnBackdrop,
  onKeyDown,
}: DialogProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    // Before moving the focus, so the handler still sees the opener.
    ensureModalFocus(document);
    const node = ref.current;
    if (node && !node.contains(document.activeElement)) {
      node.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }
  }, []);

  const keyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const handled = e.defaultPrevented;
    onKeyDown?.(e);
    if (!handled && e.defaultPrevented) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    }
  };

  return (
    <div
      className={classNames?.backdrop ?? 'nd-dialog-backdrop'}
      role="presentation"
      onMouseDown={closeOnBackdrop ? () => onCloseRef.current() : undefined}
    >
      <div
        ref={ref}
        className={classNames?.dialog ?? 'nd-dialog'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={keyDown}
        onMouseDown={closeOnBackdrop ? (e) => e.stopPropagation() : undefined}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
        {actions && <div className="nd-dialog__actions">{actions}</div>}
      </div>
    </div>
  );
}

/* ---- Toasts --------------------------------------------------------------- */

export type ToastKind = 'info' | 'error';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}
interface ToastApi {
  push: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({
  children,
  durationMs = 6000,
}: {
  children: ReactNode;
  durationMs?: number;
}) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const push = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = nextId.current++;
      setItems((cur) => [...cur, { id, kind, message }]);
      window.setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), durationMs);
    },
    [durationMs],
  );
  const api = useMemo(() => ({ push }), [push]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="nd-toasts">
        {items.map((t) => (
          <div
            key={t.id}
            className={cx('nd-toast', t.kind === 'error' && 'nd-toast--error')}
            role={t.kind === 'error' ? 'alert' : 'status'}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
