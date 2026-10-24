// In-memory implementation of the Wails bindings used by unit tests (Vitest)
// and by Playwright runs in a plain browser, where there is no Go backend.
// Install with installWailsMock() before the application modules are used.
import type {
  AppSettings,
  AuthState,
  Mention,
  NoteLink,
  RenamePlan,
  Entry,
  NoteContent,
  SearchHit,
  SearchResults,
  VaultInfo,
  WriteResult,
} from '../../app/api';

type Handler = (...data: unknown[]) => void;

export interface MockVault {
  info: VaultInfo;
  files: Map<string, string>; // path -> content
}

export interface WailsMock {
  vaults: Map<string, MockVault>;
  recent: VaultInfo[];
  settings: AppSettings;
  auth: AuthState;
  emit: (name: string, payload: unknown) => void;
}

function hashOf(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0').repeat(8);
}

function entriesOf(v: MockVault): Entry[] {
  const out: Entry[] = [];
  const dirs = new Set<string>();
  for (const path of v.files.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const d of dirs) {
    out.push({
      path: d,
      name: d.split('/').pop() ?? d,
      isDir: true,
      kind: '',
      size: 0,
      mtime: new Date(),
    });
  }
  for (const [path, content] of v.files) {
    out.push({
      path,
      name: path.split('/').pop() ?? path,
      isDir: false,
      kind: path.endsWith('.md') ? 'md' : 'other',
      size: content.length,
      mtime: new Date(),
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function installWailsMock(seed?: Partial<WailsMock>): WailsMock {
  const handlers = new Map<string, Set<Handler>>();
  const mock: WailsMock = {
    vaults: seed?.vaults ?? new Map<string, MockVault>(),
    recent: seed?.recent ?? [],
    settings: seed?.settings ?? { language: '', theme: 'system' },
    auth: seed?.auth ?? {
      status: 'signed_out',
      serverUrl: '',
      profile: { userId: '', username: '', email: '', displayName: '', role: '' },
      deviceId: '',
      error: '',
    },
    emit: (name, payload) => {
      for (const h of handlers.get(name) ?? []) h(payload);
    },
  };
  const vaultOf = (id: string): MockVault => {
    const v = mock.vaults.get(id);
    if (!v) throw new Error('vault is not open');
    return v;
  };
  const reject = (msg: string): Promise<never> => Promise.reject(new Error(msg));

  const VaultAPI = {
    ListRecent: (): Promise<VaultInfo[]> => Promise.resolve(mock.recent),
    ListOpen: (): Promise<VaultInfo[]> =>
      Promise.resolve([...mock.vaults.values()].map((v) => v.info)),
    PickFolder: (): Promise<string> => Promise.resolve('/mock/vault'),
    OpenVault: (path: string): Promise<VaultInfo> => {
      const id = hashOf(path).slice(0, 16);
      if (!mock.vaults.has(id)) {
        const info: VaultInfo = {
          id,
          name: path.split('/').pop() ?? path,
          path,
          lastOpenedAt: new Date(),
        };
        mock.vaults.set(id, { info, files: new Map() });
      }
      return Promise.resolve(vaultOf(id).info);
    },
    CloseVault: (id: string): Promise<void> => {
      mock.vaults.delete(id);
      return Promise.resolve();
    },
    ListTree: (id: string): Promise<Entry[]> => Promise.resolve(entriesOf(vaultOf(id))),
    ReadNote: (id: string, path: string): Promise<NoteContent> => {
      const content = vaultOf(id).files.get(path);
      if (content === undefined) return reject('not-found: no such file');
      return Promise.resolve({ path, content, hash: hashOf(content), size: content.length });
    },
    WriteNote: (
      id: string,
      path: string,
      content: string,
      expectedHash: string,
    ): Promise<WriteResult> => {
      const v = vaultOf(id);
      const current = v.files.get(path);
      if (expectedHash === '' && current !== undefined)
        return reject('exists: destination already exists');
      if (expectedHash !== '' && (current === undefined || hashOf(current) !== expectedHash))
        return reject('conflict: file changed on disk');
      v.files.set(path, content);
      return Promise.resolve({ path, hash: hashOf(content), size: content.length });
    },
    CreateFolder: (): Promise<void> => Promise.resolve(),
    Rename: (id: string, from: string, to: string): Promise<void> => {
      const v = vaultOf(id);
      const content = v.files.get(from);
      if (content === undefined) return reject('not-found: no such file');
      v.files.delete(from);
      v.files.set(to, content);
      return Promise.resolve();
    },
    Trash: (id: string, path: string): Promise<string> => {
      vaultOf(id).files.delete(path);
      return Promise.resolve('.trash/' + path);
    },
    RebuildIndex: (): Promise<void> => Promise.resolve(),
  };
  const SearchAPI = {
    Query: (id: string, q: string): Promise<SearchResults> => {
      const hits: SearchHit[] = [];
      for (const [path, content] of vaultOf(id).files) {
        if (content.toLowerCase().includes(q.toLowerCase())) {
          hits.push({
            path,
            title: path.replace(/\.md$/, ''),
            snippet: content.slice(0, 80),
            line: 1,
            matches: 1,
            score: 1,
          });
        }
      }
      return Promise.resolve({ hits, total: hits.length, explain: [q] });
    },
    Explain: (q: string): Promise<string[]> => Promise.resolve([q]),
  };
  const SettingsAPI = {
    Get: (): Promise<AppSettings> => Promise.resolve(mock.settings),
    Set: (s: AppSettings): Promise<void> => {
      mock.settings = s;
      return Promise.resolve();
    },
    Info: (): Promise<Record<string, string>> =>
      Promise.resolve({ version: 'test', dataDir: '/mock/data' }),
  };

  const LinksAPI = {
    Outgoing: (): Promise<NoteLink[]> => Promise.resolve([]),
    Backlinks: (id: string, path: string): Promise<NoteLink[]> => {
      const name = path.replace(/\.md$/, '').split('/').pop() ?? path;
      const out: NoteLink[] = [];
      for (const [p, content] of vaultOf(id).files) {
        if (p !== path && content.includes('[[' + name + ']]'))
          out.push({
            path: p,
            line: 1,
            raw: name,
            heading: '',
            block: '',
            alias: '',
            embed: false,
            resolved: true,
          });
      }
      return Promise.resolve(out);
    },
    UnlinkedMentions: (): Promise<Mention[]> => Promise.resolve([]),
    PlanRename: (_id: string, from: string, to: string): Promise<RenamePlan> =>
      Promise.resolve({ from, to, moves: [{ from, to }], files: [] } as unknown as RenamePlan),
    ApplyRename: (id: string, from: string, to: string): Promise<RenamePlan> => {
      const v = vaultOf(id);
      const content = v.files.get(from);
      if (content !== undefined) {
        v.files.delete(from);
        v.files.set(to, content);
      }
      return Promise.resolve({
        from,
        to,
        moves: [{ from, to }],
        files: [],
      } as unknown as RenamePlan);
    },
  };
  const AuthAPI = {
    Status: (): Promise<AuthState> => Promise.resolve(mock.auth),
    Login: (server: string): Promise<AuthState> => {
      if (server.includes('fail')) return reject('login failed');
      mock.auth = {
        status: 'ready',
        serverUrl: server,
        deviceId: 'dev-1',
        error: '',
        profile: {
          userId: 'u1',
          username: 'user1',
          email: 'user1@nodus.local',
          displayName: 'Uno',
          role: 'user',
        },
      };
      mock.emit('auth:state', mock.auth);
      return Promise.resolve(mock.auth);
    },
    Logout: (): Promise<AuthState> => {
      mock.auth = {
        ...mock.auth,
        status: 'signed_out',
        profile: { userId: '', username: '', email: '', displayName: '', role: '' },
        deviceId: '',
      };
      mock.emit('auth:state', mock.auth);
      return Promise.resolve(mock.auth);
    },
  };

  const w = window as unknown as Record<string, unknown>;
  w['go'] = { app: { VaultAPI, SearchAPI, SettingsAPI, AuthAPI, LinksAPI } };
  w['runtime'] = {
    EventsOnMultiple: (name: string, cb: Handler, _max: number) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)?.add(cb);
      return () => handlers.get(name)?.delete(cb);
    },
    EventsOff: (name: string) => handlers.delete(name),
    EventsEmit: (name: string, ...data: unknown[]) => mock.emit(name, data[0]),
    WindowShow: () => undefined,
  };
  return mock;
}
