/**
 * Subresource Integrity for the scripts the workbench loads outside its module graph (ADR-0029, Esito).
 * Module chunks are pinned by the import map the build writes into workbench.html; classic scripts get
 * `integrity` on their tag. What remains is what the browser starts from a bare URL with no integrity
 * option: workers (the graph layout, pdf.js). For those the page fetches the script with the hash the
 * build recorded (the page bundle that holds it was itself loaded with SRI) and starts it from a blob:
 * URL of the checked bytes, as for the core's worker (VerifiedWorker in bridge.ts).
 *
 * The web build wires these in (web/scripts/esbuild.mjs, plugin `verified-loaders`): the desktop build
 * of the same sources keeps plain URLs, served by the Wails asset server from the signed binary.
 */
import { VerifiedWorker } from './bridge';

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** The bytes of a script that passed its SRI check. Rejects on a mismatch, an HTTP error or no hash. */
export async function fetchVerified(
  url: string,
  integrity: string,
  fetchImpl: Fetch = (u, i) => fetch(u, i),
): Promise<Blob> {
  if (!integrity) throw new Error(`cannot load ${url}: no integrity to check`);
  const res = await fetchImpl(url, { integrity, credentials: 'same-origin' });
  if (!res.ok) throw new Error(`cannot load ${url}: HTTP ${res.status}`);
  return new Blob([await res.arrayBuffer()], { type: 'text/javascript' });
}

/**
 * A blob: URL of a checked script, for libraries that take a worker URL (pdf.js `workerSrc`). It is
 * never revoked: pdf.js may start a new worker from it for every document.
 */
export async function verifiedScriptURL(
  url: string,
  integrity: string,
  fetchImpl?: Fetch,
): Promise<string> {
  return URL.createObjectURL(await fetchVerified(url, integrity, fetchImpl));
}

/**
 * A module worker whose script passes SRI before it runs (the graph layout). It is created at once and
 * queues messages until the checked script starts; a failed check is an `error` event and the script
 * never runs.
 */
export const verifiedWorker = (url: string, integrity: string, options: WorkerOptions): Worker =>
  new VerifiedWorker(url, integrity, options) as unknown as Worker;
