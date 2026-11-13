import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { CloudMount } from '@clarae/cloud-features/port';
import type { MountRevokedPayload } from '../app/events';
import { actionById, actions, defineAction, type ActionArg } from '../commands/actions';
import { initI18n } from '../i18n';
import { configurePlatform } from '../platform';
import { useAppStore } from '../state/store';
import { installWailsMock } from '../test/wails-mock';
import { ActionButton, useAction } from './ActionButton';

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrap = (ui: ReactNode) => <QueryClientProvider client={client()}>{ui}</QueryClientProvider>;
const revoked: MountRevokedPayload = { vaultId: 'v-1', shareId: 'sh-1', name: 'Team docs' };

beforeEach(() => {
  initI18n('en');
  configurePlatform();
  installWailsMock();
  useAppStore.getState().setVault(null);
});
afterEach(() => configurePlatform());

describe('ActionButton', () => {
  it('shows an action where the host offers what it needs, and its alternative elsewhere', () => {
    useAppStore.getState().setVault({ id: 'v-1' } as never);
    const prompt = () => (
      <>
        <ActionButton id="mount:keep-copy" arg={revoked} />
        <ActionButton id="mount:download-copy" arg={revoked} />
      </>
    );
    const { unmount } = render(wrap(prompt()));
    expect(screen.getByRole('button', { name: 'Keep a copy' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download a copy' })).not.toBeInTheDocument();
    unmount();

    configurePlatform({ kind: 'web' });
    render(wrap(prompt()));
    expect(screen.queryByRole('button', { name: 'Keep a copy' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download a copy' })).toBeInTheDocument();
  });

  it('follows a capability the host switches off after the first render', () => {
    render(wrap(<ActionButton id="sync:unlink" arg="v-1" />));
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    act(() => configurePlatform({ kind: 'desktop', capabilities: { unlinkVault: false } }));
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });

  it('hides an action that does not apply to its argument', () => {
    const mount = {
      share_id: 'sh-1',
      local: { revoked: true, mounted: false },
    } as CloudMount;
    render(
      wrap(
        <>
          <ActionButton id="mount:open" arg={mount} />
          <ActionButton id="mount:remove" arg={mount} />
        </>,
      ),
    );
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('is disabled while it cannot run, and while it runs', async () => {
    const { rerender } = render(wrap(<ActionButton id="account:sign-in" arg="" />));
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    let pending: boolean[] = [];
    rerender(
      wrap(
        <ActionButton
          id="account:sign-in"
          arg="https://clarae.test"
          onPending={(p) => (pending = [...pending, p])}
        />,
      ),
    );
    const button = screen.getByRole('button', { name: 'Sign in' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(button).toBeDisabled();
    await waitFor(() => expect(pending).toEqual([true, false]));
    expect(button).toBeEnabled();
    expect(useAppStore.getState().auth?.status).toBe('ready');
  });

  it('useAction gives a shared component the bound action, or null where it is not offered', () => {
    useAppStore.getState().setVault({ id: 'v-1' } as never);
    const wrapper = ({ children }: { children: ReactNode }) => wrap(children);
    const { result } = renderHook(() => useAction('cloud-vault:new'), { wrapper });
    expect(result.current?.enabled).toBe(true);
    configurePlatform({ kind: 'web' });
    const { result: web } = renderHook(() => useAction('cloud-vault:new'), { wrapper });
    expect(web.current).toBeNull();
  });
});

describe('the action registry', () => {
  it('types each action by its id', () => {
    expectTypeOf<ActionArg<'mount:open'>>().toEqualTypeOf<CloudMount>();
    expectTypeOf<ActionArg<'mount:keep-copy'>>().toEqualTypeOf<MountRevokedPayload>();
    expectTypeOf<ActionArg<'account:sign-out'>>().toEqualTypeOf<void>();
    expect(actionById('sync:pause').feature).toBe('sync.engine');
    // @ts-expect-error: an action needs the argument it acts on
    void (() => <ActionButton id="mount:open" />);
    // @ts-expect-error: an id that no action has
    void (() => <ActionButton id="mount:ghost" />);
    void defineAction({
      id: 'x:y',
      // @ts-expect-error: a feature the registry (shared/parity/features.yaml) lacks
      feature: 'no.such-feature',
      run: () => undefined,
    });
  });

  it('labels every action that draws its own button', () => {
    for (const a of actions) {
      if (a.id === 'cloud-vault:new') continue; // drawn by CloudVaultsTable
      expect(a.label, a.id).toBeDefined();
    }
  });
});
