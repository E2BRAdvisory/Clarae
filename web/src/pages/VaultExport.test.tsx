import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  b64,
  deriveKekPassphrase,
  deriveKekRecovery,
  deriveSubkeys,
  encodeRecoveryKey,
  encryptBlob,
  encryptPath,
  generateKey,
  hex,
  newPassphraseKdf,
  newRecoveryKdf,
  uuidBytes,
  wrap,
  type Subkeys,
} from '@nodus/vaultcrypto-web';
import { readZip } from '../../../packages/vaultcrypto-web/src/zipreader.testutil';
import { problem, renderApp, type Routes } from '../test/utils';

const V = '0190a3b4-1111-7222-8333-444455556666';
const PASS = 'correct horse battery staple';
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const vaultRow = (id: string, name: string, kind: 'private' | 'shared') => ({
  id,
  owner_id: 'u1',
  name,
  kind,
  last_seq: 1,
  total_bytes: 100,
  file_count: 2,
  created_at: '2026-01-15T10:00:00Z',
});

/* ---- a tiny private vault, encrypted by the library itself ---- */

interface Fixture {
  keys: Subkeys;
  envelopes: unknown[];
  recoveryText: string;
  tree: { path: string; file_id: string; hash: string; size: number; rev: number; kind: string }[];
  blobs: Map<string, Uint8Array>;
}
let fx: Fixture;
const PLAIN: Record<string, string> = { 'notes/a.md': '# Alpha', 'b.txt': 'bravo' };

async function sha256Hex(b: Uint8Array) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b))));
}

beforeAll(async () => {
  const vmk = generateKey();
  const keys = await deriveSubkeys(vmk);
  const pk = newPassphraseKdf();
  const recovery = generateKey();
  const rk = newRecoveryKdf();
  const envelopes = [
    {
      kind: 'passphrase',
      kdf: pk,
      wrapped_vmk: b64(await wrap(await deriveKekPassphrase(PASS, pk), vmk)),
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      kind: 'recovery',
      kdf: rk,
      wrapped_vmk: b64(await wrap(await deriveKekRecovery(recovery, rk), vmk)),
      created_at: '2026-01-01T00:00:00Z',
    },
  ];
  const tree: Fixture['tree'] = [];
  const blobs = new Map<string, Uint8Array>();
  let n = 0;
  for (const [path, text] of Object.entries(PLAIN)) {
    const fileId = `0190a3b4-aaaa-7222-8333-00000000000${n++}`;
    const cipher = await encryptBlob(keys, uuidBytes(V), uuidBytes(fileId), enc(text));
    const hash = await sha256Hex(cipher);
    blobs.set(hash, cipher);
    tree.push({
      path: await encryptPath(keys, uuidBytes(V), path),
      file_id: fileId,
      hash,
      size: cipher.length,
      rev: 1,
      kind: 'file',
    });
  }
  fx = { keys, envelopes, recoveryText: await encodeRecoveryKey(recovery), tree, blobs };
}, 60_000);

function privateRoutes(
  over: { tree?: Fixture['tree']; blobs?: Map<string, Uint8Array> } = {},
): Routes {
  const tree = over.tree ?? fx.tree;
  const blobs = over.blobs ?? fx.blobs;
  const routes: Routes = {
    'GET /vaults': { items: [vaultRow(V, 'Diary', 'private')], mounts: [] },
    [`GET /vaults/${V}/key-envelopes`]: { items: fx.envelopes },
    [`GET /vaults/${V}/tree`]: { items: tree, as_of_seq: 1 },
  };
  for (const item of tree) {
    routes[`GET /vaults/${V}/blobs/${item.hash}`] = () => {
      const b = blobs.get(item.hash);
      return b ? new Response(new Uint8Array(b)) : problem(404, 'NOT_FOUND');
    };
  }
  return routes;
}

let saved: Blob[] = [];
let downloads: string[] = [];
beforeEach(() => {
  saved = [];
  downloads = [];
  URL.createObjectURL = vi.fn((b: Blob) => {
    saved.push(b);
    return 'blob:test';
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function unzip(blob: Blob) {
  return readZip(new Uint8Array(await blob.arrayBuffer()));
}

describe('vaults page: ZIP buttons', () => {
  it('offers the download only for owned vaults, with the right label per kind', async () => {
    renderApp({
      path: '/vaults',
      routes: {
        'GET /vaults': {
          items: [vaultRow('s1', 'Notes', 'shared'), vaultRow('p1', 'Diary', 'private')],
          mounts: [vaultRow('m1', 'Team', 'shared')],
        },
      },
    });
    expect(await screen.findByRole('button', { name: 'Download ZIP: Notes' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Download ZIP, decrypted in your browser: Diary' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Download ZIP/ })).toHaveLength(2);
  });
});

describe('shared vault download', () => {
  it('streams directly and saves under the server file name', async () => {
    const user = userEvent.setup();
    const { api } = renderApp({
      path: '/vaults',
      routes: {
        'GET /vaults': { items: [vaultRow('s1', 'Notes', 'shared')], mounts: [] },
        'GET /vaults/s1/export.zip': () =>
          new Response('PK', {
            headers: { 'Content-Disposition': 'attachment; filename="notes.zip"' },
          }),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Download ZIP: Notes' }));
    expect(await screen.findByText('The download of notes.zip started.')).toBeInTheDocument();
    expect(downloads).toEqual(['notes.zip']);
    expect(await saved[0]?.text()).toBe('PK');
    expect(api.called('POST', '/vaults/s1/exports')).toHaveLength(0);
  });

  it('falls back to an export job when the vault is too large and shows its states', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const states = ['running', 'ready'];
    const job = (status: string, extra = {}) =>
      new Response(
        JSON.stringify({
          id: 'j1',
          vault_id: 's1',
          status,
          created_at: '2026-01-01T00:00:00Z',
          ...extra,
        }),
        {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    const { api } = renderApp({
      path: '/vaults',
      routes: {
        'GET /vaults': { items: [vaultRow('s1', 'Notes', 'shared')], mounts: [] },
        'GET /vaults/s1/export.zip': () => problem(409, 'INVALID_STATE'),
        'POST /vaults/s1/exports': () => job('queued'),
        'GET /vaults/s1/exports/j1': () => {
          const s = states.shift() as string;
          return job(
            s,
            s === 'ready' ? { download_url: 'https://s3.example.com/x.zip?sig=1' } : {},
          );
        },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Download ZIP: Notes' }));
    expect(await screen.findByText('The export is queued…')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(await screen.findByText('The export is being prepared…')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(await screen.findByText('The download of Notes.zip started.')).toBeInTheDocument();
    expect(api.called('GET', '/vaults/s1/exports/j1')).toHaveLength(2);
    // presigned URL: opened as a download link, nothing blob-created
    expect(downloads).toEqual(['Notes.zip']);
    expect(saved).toHaveLength(0);
  });

  it('stops polling when the dialog is closed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const job = (status: string) =>
      new Response(
        JSON.stringify({ id: 'j1', vault_id: 's1', status, created_at: '2026-01-01T00:00:00Z' }),
        {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    const { api } = renderApp({
      path: '/vaults',
      routes: {
        'GET /vaults': { items: [vaultRow('s1', 'Notes', 'shared')], mounts: [] },
        'GET /vaults/s1/export.zip': () => problem(409, 'INVALID_STATE'),
        'POST /vaults/s1/exports': () => job('queued'),
        'GET /vaults/s1/exports/j1': () => job('running'),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Download ZIP: Notes' }));
    await screen.findByText('The export is queued…');
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(api.called('GET', '/vaults/s1/exports/j1')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Cancelled.')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(api.called('GET', '/vaults/s1/exports/j1')).toHaveLength(1);
  });

  it('shows a failed job', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/vaults',
      routes: {
        'GET /vaults': { items: [vaultRow('s1', 'Notes', 'shared')], mounts: [] },
        'GET /vaults/s1/export.zip': () => problem(409, 'INVALID_STATE'),
        'POST /vaults/s1/exports': () =>
          new Response(
            JSON.stringify({
              id: 'j1',
              vault_id: 's1',
              status: 'failed',
              error: 'disk full',
              created_at: '2026-01-01T00:00:00Z',
            }),
            {
              status: 202,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Download ZIP: Notes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The export failed on the server: disk full',
    );
  });
});

describe('private vault download (decrypted in the browser)', () => {
  const open = async (routes: Routes) => {
    const user = userEvent.setup();
    const view = renderApp({ path: '/vaults', routes });
    await user.click(
      await screen.findByRole('button', { name: 'Download ZIP, decrypted in your browser: Diary' }),
    );
    return { user, ...view, dialog: screen.getByRole('dialog', { name: /Diary/ }) };
  };

  it('explains that nothing leaves the browser in clear', async () => {
    const { dialog } = await open(privateRoutes());
    expect(
      within(dialog).getByText(
        /Nothing leaves your browser in clear and the server never sees your key/,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Passphrase')).toHaveAttribute('type', 'password');
  });

  it('rejects a wrong passphrase clearly and does not fetch the manifest', async () => {
    const { user, api, dialog } = await open(privateRoutes());
    await user.type(within(dialog).getByLabelText('Passphrase'), 'wrong');
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Wrong passphrase or recovery key.',
    );
    expect(api.called('GET', `/vaults/${V}/tree`)).toHaveLength(0);
    expect(within(dialog).getByRole('button', { name: 'Unlock' })).toBeInTheDocument();
  }, 30_000);

  it('unlocks with the passphrase, saves a ZIP equal to the plaintext and reports the counts', async () => {
    const { user, dialog } = await open(privateRoutes());
    await user.type(within(dialog).getByLabelText('Passphrase'), PASS);
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    expect(await within(dialog).findByText(/Unlocked: 2 files/)).toBeInTheDocument();
    // the secret is gone from the page
    expect(within(dialog).queryByLabelText('Passphrase')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save ZIP…' }));
    expect(await within(dialog).findByText(/Diary\.zip saved: 2 files/)).toBeInTheDocument();
    expect(within(dialog).getByText('No file was skipped.')).toBeInTheDocument();
    expect(downloads).toEqual(['Diary.zip']);
    const z = await unzip(saved[0] as Blob);
    expect(Object.fromEntries(z.entries.map((e) => [e.name, dec(e.data)]))).toEqual(PLAIN);
  }, 30_000);

  it('unlocks with the recovery key', async () => {
    const { user, dialog } = await open(privateRoutes());
    await user.selectOptions(within(dialog).getByLabelText('Unlock with'), 'recovery');
    await user.type(within(dialog).getByLabelText('Recovery key'), fx.recoveryText);
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    expect(await within(dialog).findByText(/Unlocked: 2 files/)).toBeInTheDocument();
  }, 30_000);

  it('reports a malformed recovery key and a missing key type', async () => {
    const { user, dialog } = await open(privateRoutes());
    await user.selectOptions(within(dialog).getByLabelText('Unlock with'), 'recovery');
    await user.type(within(dialog).getByLabelText('Recovery key'), 'AAAAA-BBBBB');
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('not a valid recovery key');
  });

  it('lists skipped files (corrupt blob) instead of failing the whole export', async () => {
    const blobs = new Map(fx.blobs);
    const victim = fx.tree[1] as Fixture['tree'][number];
    const bad = (blobs.get(victim.hash) as Uint8Array).slice();
    bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 1;
    blobs.set(victim.hash, bad);
    const { user, dialog } = await open(privateRoutes({ blobs }));
    await user.type(within(dialog).getByLabelText('Passphrase'), PASS);
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Save ZIP…' }));
    expect(
      await within(dialog).findByText('1 file was skipped and is not in the ZIP.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('rowheader', { name: 'b.txt' })).toBeInTheDocument();
    expect(within(dialog).getByText('Content is corrupt')).toBeInTheDocument();
    const z = await unzip(saved[0] as Blob);
    expect(z.entries.map((e) => e.name)).toEqual(['notes/a.md']);
  }, 30_000);

  it('can be cancelled while exporting: no file is saved and the state is visible', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const routes = privateRoutes();
    const first = fx.tree[0] as Fixture['tree'][number];
    routes[`GET /vaults/${V}/blobs/${first.hash}`] = async () => {
      await gate;
      return new Response(new Uint8Array(fx.blobs.get(first.hash) as Uint8Array));
    };
    const { user, dialog } = await open(routes);
    await user.type(within(dialog).getByLabelText('Passphrase'), PASS);
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Save ZIP…' }));
    expect(await within(dialog).findByText(/files processed/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(await within(dialog).findByText('Cancelled. No file was written.')).toBeInTheDocument();
    release();
    await waitFor(() => expect(saved).toHaveLength(0));
    expect(downloads).toHaveLength(0);
  }, 30_000);
});
