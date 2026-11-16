// An application (M18, track E) is a file of the vault: `Name.webapp`, a small JSON document
// `{"version":1,"url":"https://…"}`. Being an ordinary file, it is renamed, deleted, bookmarked,
// restored with the tabs and synchronized like any other; two people who add an application at the
// same time never overwrite each other. (The quick switcher finds them by name, like the notes, the
// canvases, the bases and the drawings; "Open application…", the command `app:open`, lists only them.)
//
// The file is not trusted: it may come from the sync, or from another user of a shared vault. Its
// address is checked here (the same rules as `webview.ValidateURL` in the Go core, which checks it
// again when the view opens) and only an http or https address with a host, without credentials,
// ever leaves this module.

export const WEBAPP_EXT = '.webapp';

/** A file of the vault that stands for an application. */
export const isWebapp = (path: string): boolean => /\.webapp$/i.test(path);

/** The name of an application as the interface shows it: the file's name without the extension. */
export const nameOf = (path: string): string =>
  (path.split('/').pop() ?? path).replace(new RegExp(`\\${WEBAPP_EXT}$`, 'i'), '');

/** Longest address accepted (webview.MaxURLBytes). */
export const MAX_URL_LENGTH = 16 * 1024;

/** Why an address is refused; the values are the reasons of the core (`webview-invalid-url`). */
export type UrlProblem =
  'empty' | 'too-long' | 'characters' | 'malformed' | 'scheme' | 'credentials' | 'host' | 'port';

export type UrlCheck =
  | {
      ok: true;
      /** The address as written (it is what the view is given). */
      url: string;
      /** `https://host:port`, lower case, default port left out: what the user confirms. */
      origin: string;
      host: string;
    }
  | { ok: false; reason: UrlProblem };

/** A control, white space or invisible formatting character, a replacement character or a backslash. */
const BAD_CHARACTER = /[\p{Cc}\p{Cf}\s\\�]/u;

/**
 * Whether `raw` is an address an application may open: absolute http or https with an authority, a
 * host, a valid port and neither credentials nor characters that two parsers would read differently.
 * Nothing is trimmed or repaired: what the core would refuse is refused here.
 */
export function checkWebappUrl(raw: string): UrlCheck {
  const refuse = (reason: UrlProblem): UrlCheck => ({ ok: false, reason });
  if (raw === '') return refuse('empty');
  if (raw.length > MAX_URL_LENGTH) return refuse('too-long');
  if (BAD_CHARACTER.test(raw)) return refuse('characters');
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(raw)?.[1]?.toLowerCase();
  if (scheme === undefined) return refuse('malformed');
  if (scheme !== 'http' && scheme !== 'https') return refuse('scheme');
  // `http:host` has no authority: the URL standard repairs it, the core refuses it.
  const authority = /^[A-Za-z]+:\/\/([^/?#]*)/.exec(raw)?.[1];
  if (authority === undefined) return refuse('malformed');
  if (authority.includes('@')) return refuse('credentials');
  // `https:///path` and `https://:80` have no host: the URL standard reads the first as `path`
  if (authority.replace(/:[^:\]]*$/, '') === '') return refuse('host');
  const port = /:([^:\]]*)$/.exec(authority)?.[1];
  if (port !== undefined && port !== '') {
    if (!/^\d+$/.test(port)) return refuse('malformed');
    const n = Number(port);
    if (n < 1 || n > 65535) return refuse('port');
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return refuse('malformed');
  }
  if (u.username !== '' || u.password !== '') return refuse('credentials');
  if (u.hostname === '') return refuse('host');
  return { ok: true, url: raw, origin: u.origin, host: u.hostname };
}

/** The byte order mark an editor may put at the start of a file. */
const BOM = String.fromCharCode(0xfeff);

export type WebappParse =
  | { ok: true; url: string; origin: string; host: string }
  | { ok: false; reason: 'empty' | 'json' | 'shape' | 'version' | UrlProblem };

/**
 * Reads the text of a `.webapp` file. Tolerant of what does not matter (a byte order mark, unknown
 * fields, a missing `version`), strict about what does: a version this build does not know, and an
 * address that does not pass checkWebappUrl.
 */
export function parseWebapp(text: string): WebappParse {
  const body = (text.startsWith(BOM) ? text.slice(1) : text).trim();
  if (body === '') return { ok: false, reason: 'empty' };
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'json' };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc))
    return { ok: false, reason: 'shape' };
  const { version, url } = doc as { version?: unknown; url?: unknown };
  if (version !== undefined && version !== 1) return { ok: false, reason: 'version' };
  if (typeof url !== 'string') return { ok: false, reason: 'shape' };
  const checked = checkWebappUrl(url);
  return checked.ok
    ? { ok: true, url: checked.url, origin: checked.origin, host: checked.host }
    : { ok: false, reason: checked.reason };
}

/** The text of a `.webapp` file for an address (the caller has checked it). */
export function serializeWebapp(url: string): string {
  return `${JSON.stringify({ version: 1, url }, null, 2)}\n`;
}

/** The file name (without extension) an address suggests: its host, without a leading `www.`. */
export function suggestName(url: string): string {
  const c = checkWebappUrl(url.trim());
  return c.ok ? c.host.replace(/^www\./, '') : '';
}

/** A name fit for a file of the vault (what the user typed, minus what a path cannot hold). */
export function fileNameOf(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
}

/**
 * What a person typed as an address, made absolute: `example.com` and `localhost:3000` get `https://`
 * in front. Anything that starts with a scheme of its own (`javascript:`, `mailto:`, `file:`) is left
 * as typed, so checkWebappUrl refuses it for what it is.
 */
export function completeUrl(typed: string): string {
  const text = typed.trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) return text;
  // `name:digits` is a host and a port; `name:` followed by anything else is a scheme
  if (/^[A-Za-z][A-Za-z0-9+.-]*:(?!\d)/.test(text)) return text;
  return text === '' ? '' : `https://${text}`;
}
