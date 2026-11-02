// Addresses shared by the console, the workbench page and the build's dev server. Plain TypeScript with
// erasable syntax only: web/scripts/esbuild.mjs imports this file directly (Node strips the types).

/**
 * The vault workbench lives at /vaults/:id/open (ADR-0029); everything else is the console. The cloud
 * picks the page with the same pattern (workbenchRoute in services/cloud/web-embed/webembed.go, minus
 * the capture group): TestWorkbenchRouteMatchesTheWebUI compares the two.
 */
export const WORKBENCH_ROUTE_PATTERN = '^/vaults/([^/]+)/open/?$';
const workbenchRoute = new RegExp(WORKBENCH_ROUTE_PATTERN);

/** Whether a path (no query string) is the workbench page. */
export const isWorkbenchRoute = (path: string): boolean => workbenchRoute.test(path);

/**
 * The vault id of a workbench path, or null when the path is not the workbench page or its id is not
 * valid percent-encoding (`/vaults/%E0%A4%A/open`): such an address names no vault.
 */
export function workbenchVaultId(path: string): string | null {
  const m = workbenchRoute.exec(path);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1] as string);
  } catch {
    return null; // URIError: malformed escape
  }
}

/** Whether a same-origin return address (path and query) leads to the workbench page. */
export const isWorkbenchReturn = (to: string): boolean =>
  isWorkbenchRoute(to.split(/[?#]/)[0] ?? '');

/** The address of a vault's workbench, with an optional query (`share`, the creation parameters…). */
export function workbenchHref(vaultId: string, query?: Record<string, string>): string {
  const q = query ? new URLSearchParams(query).toString() : '';
  return `/vaults/${encodeURIComponent(vaultId)}/open${q ? `?${q}` : ''}`;
}
