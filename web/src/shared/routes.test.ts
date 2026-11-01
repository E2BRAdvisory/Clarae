import { describe, expect, it } from 'vitest';
import { isWorkbenchReturn, isWorkbenchRoute, workbenchHref, workbenchVaultId } from './routes';

describe('workbench route', () => {
  it('matches only /vaults/:id/open', () => {
    for (const p of ['/vaults/x/open', '/vaults/x/open/', '/vaults/new/open'])
      expect(isWorkbenchRoute(p)).toBe(true);
    for (const p of [
      '/vaults',
      '/vaults/x',
      '/vaults/x/open/extra',
      '/vaults/x/opened',
      '/vaults//open',
    ])
      expect(isWorkbenchRoute(p)).toBe(false);
  });

  it('extracts the vault id, decoded', () => {
    expect(workbenchVaultId('/vaults/a%20b/open')).toBe('a b');
    expect(workbenchVaultId('/vaults/a')).toBeNull();
  });

  it('recognises a return address with a query or a fragment', () => {
    expect(isWorkbenchReturn('/vaults/x/open?share=1')).toBe(true);
    expect(isWorkbenchReturn('/vaults/x/open#top')).toBe(true);
    expect(isWorkbenchReturn('/vaults/x?next=/vaults/y/open')).toBe(false);
  });

  it('builds addresses the route accepts', () => {
    expect(workbenchHref('a/b')).toBe('/vaults/a%2Fb/open');
    expect(workbenchHref('v', { share: 's 1' })).toBe('/vaults/v/open?share=s+1');
    expect(workbenchVaultId(workbenchHref('a/b'))).toBe('a/b');
  });
});
