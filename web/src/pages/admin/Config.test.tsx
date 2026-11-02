import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { problem, renderApp, type RecordedCall } from '../../test/utils';
import { checkConfigText, checkLockedKeys } from './ConfigPage';

const ADMIN = { roles: ['memobrain-admin'] };
const P = '44444444-aaaa-4444-8444-444444444444';

const profile = (over: Record<string, unknown> = {}) => ({
  id: P,
  name: 'Base',
  description: 'Defaults',
  is_global: false,
  version: 3,
  config: { editor: { fontSize: 16 } },
  locked_keys: ['editor.fontSize'],
  updated_at: '2026-02-01T10:00:00Z',
  ...over,
});
const versions = [
  {
    version: 1,
    name: 'Base',
    is_global: false,
    config: { editor: { fontSize: 12 } },
    locked_keys: [],
    updated_at: '2026-01-01T10:00:00Z',
  },
  {
    version: 3,
    name: 'Base',
    is_global: false,
    config: { editor: { fontSize: 16 } },
    locked_keys: ['editor.fontSize'],
    updated_at: '2026-02-01T10:00:00Z',
    updated_by: '99999999-aaaa-4999-8999-999999999999',
  },
  {
    version: 2,
    name: 'Base',
    is_global: false,
    config: { editor: { fontSize: 14 } },
    locked_keys: [],
    updated_at: '2026-01-15T10:00:00Z',
  },
];

describe('config JSON checks', () => {
  it('reports syntax errors, non-objects and unknown keys', () => {
    expect(checkConfigText('{"editor":{"fontSize":14}}').issues).toEqual([]);
    expect(checkConfigText('{').issues[0]?.kind).toBe('syntax');
    expect(checkConfigText('[]').issues).toEqual([{ kind: 'notObject' }]);
    expect(checkConfigText('{"nope":1}').issues).toEqual([{ kind: 'unknownKey', key: 'nope' }]);
  });
  it('accepts dotted keys under a schema top-level key only', () => {
    expect(checkLockedKeys(['editor.fontSize', 'features.sharing', 'hotkeys'])).toEqual([]);
    expect(checkLockedKeys(['bogus.key', 'editor..x', 'editor.', ''])).toEqual([
      'bogus.key',
      'editor..x',
      'editor.',
      '',
    ]);
  });
});

describe('config profiles list', () => {
  it('lists the global profile first', async () => {
    renderApp({
      path: '/admin/config',
      user: ADMIN,
      routes: {
        'GET /admin/config-profiles': [
          profile({ id: 'a', name: 'Alpha' }),
          profile({ id: 'g', name: 'Zeta', is_global: true }),
        ],
      },
    });
    const links = await screen.findAllByRole('link', { name: /Alpha|Zeta/ });
    expect(links.map((l) => l.textContent)).toEqual(['Zeta', 'Alpha']);
    expect(screen.getByText('Global')).toBeInTheDocument();
  });
});

describe('config profile editor', () => {
  it('validates the JSON live and blocks saving invalid content', async () => {
    const user = userEvent.setup();
    const { api } = renderApp({
      path: `/admin/config/${P}`,
      user: ADMIN,
      routes: {
        'GET /admin/config-profiles': [profile()],
        [`GET /admin/config-profiles/${P}`]: profile(),
        [`GET /admin/config-profiles/${P}/versions`]: versions,
        [`PUT /admin/config-profiles/${P}`]: profile({ version: 4 }),
      },
    });
    const editor = await screen.findByLabelText('Configuration (JSON)');
    expect(screen.getByText('Valid JSON.')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save profile' });
    expect(save).toBeEnabled();

    fireEvent.change(editor, { target: { value: '{ "editor": ' } });
    expect(await screen.findByText(/Invalid JSON/)).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.change(editor, { target: { value: '{"bogus": 1}' } });
    expect(await screen.findByText('Unknown top-level key: bogus.')).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.change(editor, { target: { value: '[1]' } });
    expect(await screen.findByText('The configuration must be a JSON object.')).toBeInTheDocument();

    fireEvent.change(editor, { target: { value: '{"editor":{"fontSize":18}}' } });
    fireEvent.change(screen.getByLabelText('Locked keys'), { target: { value: 'nope.x' } });
    expect(await screen.findByText(/Not valid keys: nope\.x/)).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Locked keys'), {
      target: { value: 'editor.fontSize\nfeatures.sharing' },
    });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() => expect(api.called('PUT', `/admin/config-profiles/${P}`)).toHaveLength(1));
    expect(api.called('PUT', `/admin/config-profiles/${P}`)[0]?.body).toEqual({
      name: 'Base',
      description: 'Defaults',
      is_global: false,
      config: { editor: { fontSize: 18 } },
      locked_keys: ['editor.fontSize', 'features.sharing'],
      // Saved from the version on screen: another administrator's change is never overwritten.
      expected_version: 3,
    });
    expect(await screen.findByText('Profile saved (version 4).')).toBeInTheDocument();
  });

  it('keeps the edits and offers the newer version when another administrator saved meanwhile', async () => {
    const user = userEvent.setup();
    let current = profile();
    const { api } = renderApp({
      path: `/admin/config/${P}`,
      user: ADMIN,
      routes: {
        'GET /admin/config-profiles': () => [current],
        [`GET /admin/config-profiles/${P}`]: () => current,
        [`GET /admin/config-profiles/${P}/versions`]: versions,
        [`PUT /admin/config-profiles/${P}`]: (c: RecordedCall) =>
          (c.body as { expected_version?: number }).expected_version === current.version
            ? (current = profile({ ...(c.body as object), version: current.version + 1 }))
            : problem(409, 'REV_CONFLICT', 'the profile is at version 4, not 3'),
      },
    });
    const editor = await screen.findByLabelText('Configuration (JSON)');
    // Meanwhile another administrator saves version 4.
    current = profile({ version: 4, config: { editor: { fontSize: 20 } } });
    fireEvent.change(editor, { target: { value: '{"editor":{"fontSize":18}}' } });
    await user.click(screen.getByRole('button', { name: 'Save profile' }));

    expect(await screen.findByText(/Another administrator saved this profile/)).toBeInTheDocument();
    expect(await screen.findByText(/Version 4 is the current one/)).toBeInTheDocument();
    // The edits are still there.
    expect(editor).toHaveValue('{"editor":{"fontSize":18}}');
    expect(api.called('PUT', `/admin/config-profiles/${P}`)).toHaveLength(1);

    // Reloading shows version 4; saving from it succeeds.
    await user.click(screen.getByRole('button', { name: 'Load the current version' }));
    await waitFor(() =>
      expect(editor).toHaveValue(JSON.stringify({ editor: { fontSize: 20 } }, null, 2)),
    );
    expect(screen.queryByText(/Version 4 is the current one/)).not.toBeInTheDocument();
    fireEvent.change(editor, { target: { value: '{"editor":{"fontSize":22}}' } });
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText('Profile saved (version 5).')).toBeInTheDocument();
    expect(api.called('PUT', `/admin/config-profiles/${P}`)[1]?.body).toMatchObject({
      expected_version: 4,
    });
  });

  it('shows the server validation message on a 400', async () => {
    const user = userEvent.setup();
    renderApp({
      path: `/admin/config/${P}`,
      user: ADMIN,
      routes: {
        'GET /admin/config-profiles': [profile()],
        [`GET /admin/config-profiles/${P}`]: profile(),
        [`GET /admin/config-profiles/${P}/versions`]: versions,
        [`PUT /admin/config-profiles/${P}`]: problem(
          400,
          'VALIDATION_FAILED',
          'editor.fontSize: must be <= 48',
        ),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Save profile' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('editor.fontSize: must be <= 48');
  });

  it('warns that a new global profile replaces the current one and asks to confirm', async () => {
    const user = userEvent.setup();
    const { api } = renderApp({
      path: '/admin/config/new',
      user: ADMIN,
      routes: {
        'GET /admin/config-profiles': [profile({ id: 'g', name: 'Company', is_global: true })],
        'POST /admin/config-profiles': (c: RecordedCall) => ({
          ...profile({ id: 'n', is_global: true }),
          name: (c.body as { name: string }).name,
        }),
        'GET /admin/config-profiles/n': profile({ id: 'n', is_global: true }),
        'GET /admin/config-profiles/n/versions': [],
      },
    });
    await user.type(await screen.findByLabelText('Name'), 'New global');
    await user.click(screen.getByRole('checkbox', { name: /Global profile/ }));
    expect(
      await screen.findByText(/replace the current global profile, Company/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    const dialog = screen.getByRole('dialog', { name: 'Replace the global profile?' });
    expect(api.called('POST', '/admin/config-profiles')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Replace and save' }));
    await waitFor(() => expect(api.called('POST', '/admin/config-profiles')).toHaveLength(1));
    expect(api.called('POST', '/admin/config-profiles')[0]?.body).toMatchObject({
      name: 'New global',
      is_global: true,
      config: {},
    });
  });

  it('lists the history newest first and compares a version with the current one', async () => {
    const user = userEvent.setup();
    renderApp({
      path: `/admin/config/${P}`,
      user: ADMIN,
      routes: {
        'GET /admin/config-profiles': [profile()],
        [`GET /admin/config-profiles/${P}`]: profile(),
        [`GET /admin/config-profiles/${P}/versions`]: versions,
      },
    });
    const history = await screen.findByRole('list', { name: 'History' });
    const items = await within(history).findAllByRole('listitem');
    expect(items.map((i) => /Version (\d)/.exec(i.textContent ?? '')?.[1])).toEqual([
      '3',
      '2',
      '1',
    ]);
    expect(within(items[0] as HTMLElement).getByText('current')).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).getByText(/by 99999999/)).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Compare version 1 with the current one' }),
    );
    const diff = screen.getByRole('group', { name: 'Comparison' });
    expect(within(diff).getByText(/"fontSize": 12/)).toBeInTheDocument();
    expect(within(diff).getByText(/"fontSize": 16/)).toBeInTheDocument();
  });

  it('restores a version after confirmation (creating a new version)', async () => {
    const user = userEvent.setup();
    let current = profile();
    const { api } = renderApp({
      path: `/admin/config/${P}`,
      user: ADMIN,
      routes: {
        'GET /admin/config-profiles': () => [current],
        [`GET /admin/config-profiles/${P}`]: () => current,
        [`GET /admin/config-profiles/${P}/versions`]: versions,
        [`POST /admin/config-profiles/${P}/versions/1:restore`]: () => {
          current = profile({ version: 4, config: { editor: { fontSize: 12 } }, locked_keys: [] });
          return current;
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Restore version 1' }));
    const dialog = screen.getByRole('dialog', { name: 'Restore version 1?' });
    expect(within(dialog).getByText(/A new version/)).toBeInTheDocument();
    expect(api.called('POST', `/admin/config-profiles/${P}/versions/1:restore`)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('Restored as version 4.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText('Configuration (JSON)')).toHaveValue(
        JSON.stringify({ editor: { fontSize: 12 } }, null, 2),
      ),
    );
    // after the restore, version 3 is no longer the current one and can be restored itself
    expect(await screen.findByRole('button', { name: 'Restore version 3' })).toBeInTheDocument();
  });

  it('deletes a profile only after confirmation', async () => {
    const user = userEvent.setup();
    const { api } = renderApp({
      path: `/admin/config/${P}`,
      user: ADMIN,
      routes: {
        'GET /admin/config-profiles': [profile()],
        [`GET /admin/config-profiles/${P}`]: profile(),
        [`GET /admin/config-profiles/${P}/versions`]: versions,
        [`DELETE /admin/config-profiles/${P}`]: () => undefined,
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Delete profile' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this profile?' });
    expect(api.called('DELETE', `/admin/config-profiles/${P}`)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete profile' }));
    expect(await screen.findByText('Profile deleted.')).toBeInTheDocument();
    expect(api.called('DELETE', `/admin/config-profiles/${P}`)).toHaveLength(1);
  });
});
