// User-facing text for a failure from the Go core. Binding errors carry a stable code before the
// first colon ("conflict: file changed on disk", see bindingError in apps/desktop/internal/app), and
// cloud problems arrive as "<CODE>: <detail>" or "<CODE> (<status>)" (RFC 9457 `code`). A known code
// becomes a translated sentence; anything else is shown as written, so no detail is lost. Every
// dialog, banner and inline error that shows a backend failure goes through errorMessage.
import { i18next } from '../i18n';

const CODE = /^([A-Za-z][A-Za-z0-9_-]*)(?::|\s\(\d{3}\)$)/;

/**
 * Messages of the core that carry no code but are common enough to deserve a translation: the
 * whole message (as the core writes it) -> i18n key.
 */
const KNOWN_TEXT = new Map<string, string>([
  // crypto.ErrWrongSecret: unlock, change of passphrase, new recovery key.
  ['wrong passphrase or recovery key', 'errors.wrongSecret'],
]);

const rawOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The stable code of an error message, or '' when it has none. */
export function errorCodeOf(e: unknown): string {
  return CODE.exec(rawOf(e))?.[1] ?? '';
}

/**
 * A translated message for a known error code, otherwise the raw message. The text after the code
 * is available to the translation as {{detail}} (errors.io quotes the failed operation).
 */
export function errorMessage(e: unknown): string {
  const raw = rawOf(e);
  const code = errorCodeOf(raw);
  const key = `errors.${code}`;
  if (code && i18next.exists(key))
    return i18next.t(key, { detail: raw.slice(code.length).replace(/^:\s*/, '').trim() });
  const known = KNOWN_TEXT.get(raw.trim());
  if (known) return i18next.t(known);
  return raw;
}
