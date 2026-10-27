// Download of a shared vault as ZIP: stream directly when the server allows it, otherwise
// create an export job and poll it. Pure orchestration (no React) so it can be tested with
// a mock client and fake timers.
import { ApiError, isProblem, type MemobrainClient, type Schemas } from '@memobrain/api-client';

export type ExportJob = Schemas['ExportJob'];

export const POLL_MS = 2000;

/** The export job ended without a ZIP (failed on the server, or its download expired). */
export class ExportJobError extends Error {
  readonly status: 'failed' | 'expired';
  constructor(status: 'failed' | 'expired', message: string) {
    super(message);
    this.name = 'ExportJobError';
    this.status = status;
  }
}

export interface SharedExportDeps {
  api: MemobrainClient;
  getToken: () => string | undefined;
  fetchFn?: typeof fetch;
  /** Resolves after `ms`, rejects when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Origin that counts as "the API" for sending the bearer token (default: the page origin). */
  origin?: string;
}

export type SharedExportEvent =
  { kind: 'direct' } | { kind: 'job'; status: ExportJob['status']; error?: string };

export type SharedExportResult =
  | { kind: 'blob'; blob: Blob; filename: string }
  | { kind: 'redirect'; url: string; filename: string };

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** File name from a Content-Disposition header (RFC 6266 `filename*` first), or undefined. */
export function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star?.[2]) {
    try {
      return sanitizeName(decodeURIComponent(star[2].trim()));
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
  const raw = plain?.[1] ?? plain?.[2];
  return raw ? sanitizeName(raw.replace(/\\(.)/g, '$1').trim()) : undefined;
}

/** Keeps a download name to a single safe path segment. */
export function sanitizeName(name: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f"<>|:*?]/g, '_').trim();
  return base === '' || base === '.' || base === '..' ? undefined : base;
}

export function fallbackName(vaultName: string): string {
  return `${sanitizeName(vaultName) ?? 'vault'}.zip`;
}

async function problemError(res: Response): Promise<ApiError> {
  let problem: Schemas['Problem'] | undefined;
  try {
    const body: unknown = await res.json();
    if (isProblem(body)) problem = body;
  } catch {
    /* not JSON */
  }
  return new ApiError(res.status, problem, `${res.status} ${res.statusText}`.trim());
}

export async function exportShared(
  deps: SharedExportDeps,
  vault: { id: string; name: string },
  opts: { signal?: AbortSignal; onEvent?: (e: SharedExportEvent) => void; pollMs?: number } = {},
): Promise<SharedExportResult> {
  const { api, signal } = { api: deps.api, signal: opts.signal };
  const sleep = deps.sleep ?? defaultSleep;
  const pollMs = opts.pollMs ?? POLL_MS;
  const path = { vaultId: vault.id };

  // 1. direct stream (small vaults)
  opts.onEvent?.({ kind: 'direct' });
  const direct = await api.GET('/vaults/{vaultId}/export.zip', {
    params: { path },
    parseAs: 'blob',
    ...(signal ? { signal } : {}),
  });
  if (direct.response.ok) {
    return {
      kind: 'blob',
      blob: direct.data as unknown as Blob,
      filename:
        filenameFromDisposition(direct.response.headers.get('Content-Disposition')) ??
        fallbackName(vault.name),
    };
  }
  const problem = isProblem(direct.error) ? direct.error : undefined;
  const tooBig = direct.response.status === 409 && problem?.code === 'INVALID_STATE';
  if (!tooBig)
    throw new ApiError(
      direct.response.status,
      problem,
      `${direct.response.status} ${direct.response.statusText}`.trim(),
    );

  // 2. too large for a direct stream: background job
  const created = await api.POST('/vaults/{vaultId}/exports', {
    params: { path },
    ...(signal ? { signal } : {}),
  });
  if (!created.response.ok || !created.data) {
    throw new ApiError(
      created.response.status,
      isProblem(created.error) ? created.error : undefined,
      `${created.response.status} ${created.response.statusText}`.trim(),
    );
  }
  let job: ExportJob = created.data;
  for (;;) {
    opts.onEvent?.({ kind: 'job', status: job.status, ...(job.error ? { error: job.error } : {}) });
    if (job.status === 'ready') break;
    if (job.status === 'failed' || job.status === 'expired')
      throw new ExportJobError(job.status, job.error ?? '');
    await sleep(pollMs, signal);
    const next = await api.GET('/vaults/{vaultId}/exports/{exportId}', {
      params: { path: { vaultId: vault.id, exportId: job.id } },
      ...(signal ? { signal } : {}),
    });
    if (!next.response.ok || !next.data)
      throw new ApiError(
        next.response.status,
        isProblem(next.error) ? next.error : undefined,
        `${next.response.status} ${next.response.statusText}`.trim(),
      );
    job = next.data;
  }
  if (!job.download_url) throw new ExportJobError('failed', '');
  return fetchDownload(deps, job.download_url, fallbackName(vault.name), signal);
}

/**
 * A relative path or same-origin URL is the API itself: fetched with the bearer token. Any
 * other URL is a presigned object-store link: it carries its own authorization, must not
 * receive our token, and is opened as a navigation (the page CSP allows no cross-origin fetch).
 */
export async function fetchDownload(
  deps: SharedExportDeps,
  downloadUrl: string,
  fallback: string,
  signal?: AbortSignal,
): Promise<SharedExportResult> {
  const origin = deps.origin ?? window.location.origin;
  const url = new URL(downloadUrl, origin);
  if (url.origin !== new URL(origin).origin)
    return { kind: 'redirect', url: url.toString(), filename: fallback };
  const token = deps.getToken();
  const res = await (deps.fetchFn ?? fetch)(url.toString(), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw await problemError(res);
  return {
    kind: 'blob',
    blob: await res.blob(),
    filename: filenameFromDisposition(res.headers.get('Content-Disposition')) ?? fallback,
  };
}

/** Starts a navigation-style download of a presigned URL. */
export function openDownload(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
