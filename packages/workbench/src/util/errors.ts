// User-facing text for a failure from the Go core. Binding errors carry a stable code before the
// first colon ("conflict: file changed on disk", see bindingError in apps/desktop/internal/app), and
// cloud problems arrive as "<CODE>: <detail>" or "<CODE> (<status>)" (RFC 9457 `code`). A known code
// becomes a translated sentence; anything else is shown as written, so no detail is lost.
import { i18next } from '../i18n';

const CODE = /^([A-Za-z][A-Za-z0-9_-]*)(?::|\s\(\d{3}\)$)/;

/** The stable code of an error message, or '' when it has none. */
export function errorCodeOf(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return CODE.exec(msg)?.[1] ?? '';
}

/** A translated message for a known error code, otherwise the raw message. */
export function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const code = errorCodeOf(raw);
  const key = `errors.${code}`;
  if (code && i18next.exists(key)) return i18next.t(key);
  return raw;
}
