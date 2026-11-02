// A dialog with a text area for tools that take a block of text (a LaTeX formula, later a Mermaid
// diagram). `onSubmit` may throw: its message is shown and the dialog stays open.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  title: string;
  hint?: string;
  initial: string;
  /** Monospace text area rows. */
  rows?: number;
  submitLabel: string;
  onSubmit: (text: string) => Promise<void>;
  onClose: () => void;
}

export function TextToolDialog({
  title,
  hint,
  initial,
  rows = 6,
  submitLabel,
  onSubmit,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.focus(), []);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await onSubmit(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {hint && <p className="muted small">{hint}</p>}
        <textarea
          ref={area}
          rows={rows}
          value={text}
          spellCheck={false}
          aria-label={title}
          style={{ width: '100%', fontFamily: 'monospace' }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
          }}
        />
        {error && (
          <div className="note-error" role="alert">
            {error}
          </div>
        )}
        <div className="actions">
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary" disabled={busy || !text.trim()} onClick={() => void submit()}>
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
