// User-facing text for a failure from the Go core. Binding errors carry a stable code before the
// first colon ("conflict: file changed on disk", see bindingError in apps/desktop/internal/app), and
// cloud problems arrive as "<CODE>: <detail>" or "<CODE> (<status>)" (RFC 9457 `code`). A known code
// becomes a translated sentence; anything else is shown as written, so no detail is lost. Every
// dialog, banner and inline error that shows a backend failure goes through errorMessage.
import { i18next } from '../i18n';

const CODE = /^([A-Za-z][A-Za-z0-9_-]*)(?::|\s\(\d{3}\)$)/;

const rawOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The stable code of an error message, or '' when it has none. */
export function errorCodeOf(e: unknown): string {
  return CODE.exec(rawOf(e))?.[1] ?? '';
}

/** A reason after the code: "weak-passphrase: too-short: …" -> "too-short". */
const REASON = /^([a-z][a-z0-9-]*):\s/;

/**
 * A translated message for a known error code, otherwise the raw message. The text after the code
 * is available to the translation as {{detail}} (errors.io quotes the failed operation). A code may
 * carry a reason as the first word of its text ("weak-passphrase: too-short: …", see bindingError in
 * apps/desktop/internal/app): `errors.<code>_<reason>` then wins over `errors.<code>`.
 */
export function errorMessage(e: unknown): string {
  const raw = rawOf(e);
  const code = errorCodeOf(raw);
  const detail = raw.slice(code.length).replace(/^:\s*/, '').trim();
  const reason = code ? REASON.exec(detail)?.[1] : undefined;
  if (reason && i18next.exists(`errors.${code}_${reason}`))
    return i18next.t(`errors.${code}_${reason}`, {
      detail: detail.slice(reason.length + 1).trim(),
    });
  const key = `errors.${code}`;
  if (code && i18next.exists(key)) return i18next.t(key, { detail });
  return raw;
}
