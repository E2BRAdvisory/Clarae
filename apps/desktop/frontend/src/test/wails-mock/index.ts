// In-memory implementation of the Wails bindings used by unit tests (Vitest)
// and by Playwright runs in a plain browser, where there is no Go backend.
// It mirrors the observable behavior of the Go backend closely enough for UI
// work: link resolution, backlinks, search, suggestions, properties, rename
// with link updates, attachments and vault settings files.
// Install with installWailsMock() before the application modules are used.
import { parseDocument } from 'yaml';
import { extract, splitFrontmatter } from '@nodus/markdown';
import { linkInfo } from '../../app/api';
import { buildMockGraph } from '../../graph/mockBuild';
import { syntheticGraph } from '../../graph/synthetic';
import type { GraphData, GraphOptions } from '../../graph/types';
import { makeBasesAPI } from './bases';
import { notesMock } from './notes';
import { createHistoryAPI, newMockHistory, type MockHistory } from './history';
import { createImporterMock } from '../../importer/mock';
import { createUpdaterMock } from '../../updater/mock';
import type {
  AppSettings,
  ConfigState,
  DirectoryEntry,
  GrantInput,
  MountState,
  ShareGrant,
  ShareInfo,
  AuthState,
  BinaryContent,
  CloudVault,
  ConflictAction,
  ConflictTexts,
  DeviceInfo,
  DiskEncryption,
  Entry,
  Mention,
  NoteContent,
  NoteLink,
  PropertyKey,
  RenamePlan,
  RevisionInfo,
  SearchHit,
  SearchResults,
  Suggestion,
  SyncConflict,
  ExportResult,
  SyncLinkInfo,
  SyncStatus,
  TagCount,
  UsageInfo,
  VaultInfo,
  WriteResult,
} from '../../app/api';

type Handler = (...data: unknown[]) => void;

export interface MockVault {
  info: VaultInfo;
  /** Text files: path -> content. Includes .nodus/*.json settings. */
  files: Map<string, string>;
  /** Binary attachments: path -> base64. */
  binaries: Map<string, string>;
}

/** State behind the SyncAPI/VaultCryptoAPI mock; tests seed and inspect it. */
export interface MockSync {
  /** Per local vault id: link info, plus the secrets of a private vault. */
  links: Map<string, SyncLinkInfo & { passphrase?: string; recoveryKey?: string }>;
  status: Map<string, SyncStatus>;
  conflicts: Map<string, SyncConflict[]>;
  conflictTexts: Map<number, ConflictTexts>;
  resolved: { vaultId: string; id: number; action: ConflictAction; merged: string }[];
  history: Map<string, RevisionInfo[]>; // key: vaultId + '|' + path
  revisionTexts: Map<string, string>; // key: vaultId + '|' + path + '|' + rev
  restored: { vaultId: string; path: string; rev: number }[];
  cloudVaults: CloudVault[];
  devices: DeviceInfo[];
  usage: UsageInfo;
  disk: DiskEncryption;
  /** Passphrase and recovery key that unlock a cloud vault being linked on a new device. */
  secrets: Map<string, { passphrase: string; recoveryKey: string }>;
}

/** State behind the SharingAPI mock: tests seed invitations and read what the UI did. */
export interface MockSharing {
  invitations: ShareInfo[];
  /** Accepted shares; accepting an invitation adds one. */
  mounts: MountState[];
  /** Shares of the open vault, as its owner sees them. */
  owned: ShareInfo[];
  directory: DirectoryEntry[];
  /** Files that appear in a mount when it is opened: share id -> path -> text. */
  mountFiles: Map<string, Record<string, string>>;
  declined: string[];
  revoked: string[];
}

export interface WailsMock {
  sync: MockSync;
  sharing: MockSharing;
  /** Local file snapshots (HistoryAPI). */
  history: MockHistory;
  /** The configuration of the (mock) server. */
  config: ConfigState;
  /** SVG previews of drawings by content hash (DrawingAPI cache). */
  previews: Map<string, string>;
  vaults: Map<string, MockVault>;
  /** Vaults exported to ZIP (VaultAPI.ExportZip); set `exportCancelled` to simulate a cancelled dialog. */
  exports: string[];
  exportCancelled: boolean;
  /** ExportAPI: standalone HTML files "saved" (cancelled when `exportCancelled`) and print requests. */
  htmlExports: { vaultId: string; name: string; html: string }[];
  prints: number;
  recent: VaultInfo[];
  settings: AppSettings;
  auth: AuthState;
  emit: (name: string, payload: unknown) => void;
  /** Handlers registered through EventsOn, for assertions. */
  listeners: (name: string) => number;
}

export function hashOf(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0').repeat(8);
}

const isNote = (p: string): boolean => p.endsWith('.md');
const isStructured = (p: string): boolean => /\.(excalidraw|canvas)$/.test(p);

/** The Markdown an indexer would read out of a drawing or canvas: its texts, links and files. */
function structuredSource(path: string, src: string): string {
  try {
    const o = JSON.parse(src) as {
      elements?: { text?: string; link?: string }[];
      nodes?: { type?: string; text?: string; file?: string }[];
    };
    const parts: string[] = [];
    for (const e of o.elements ?? []) parts.push(e.text ?? '', e.link ?? '');
    for (const n of o.nodes ?? [])
      parts.push(n.type === 'file' ? `![[${n.file ?? ''}]]` : (n.text ?? ''));
    return parts.filter(Boolean).join('\n\n');
  } catch {
    return '';
  }
}
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const stem = (p: string): string => baseName(p).replace(/\.md$/, '');
const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const lower = (s: string): string => s.toLowerCase();

function entriesOf(v: MockVault): Entry[] {
  const out: Entry[] = [];
  const dirs = new Set<string>();
  // Device-local files inside .nodus/ are not part of the vault tree (pathrules.IsExcluded).
  const all = [...v.files.keys(), ...v.binaries.keys()].filter(
    (p) =>
      !/^\.nodus\/(workspace[^/]*\.json|(index|sync|app)\.db[^/]*|cache\/.*|snapshots\/.*)$/.test(
        p,
      ),
  );
  for (const path of all) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const d of dirs) {
    out.push({ path: d, name: baseName(d), isDir: true, kind: '', size: 0, mtime: new Date() });
  }
  for (const path of all) {
    const text = v.files.get(path);
    out.push({
      path,
      name: baseName(path),
      isDir: false,
      kind: isNote(path) ? 'md' : 'other',
      size: text?.length ?? 0,
      mtime: new Date(),
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function fuzzy(query: string, text: string): number {
  const q = lower(query.trim());
  const t = lower(text);
  if (!q) return 1;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800;
  if (t.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(q))) return 600;
  if (t.includes(q)) return 400;
  let i = 0;
  for (const c of q) {
    i = t.indexOf(c, i);
    if (i < 0) return 0;
    i++;
  }
  return 100;
}

/** Resolves a link target like internal/links.Resolver (shortest path, aliases). */
function resolve(v: MockVault, from: string, target: string): string {
  const t = target.trim().replace(/^\//, '');
  if (!t) return from;
  const paths = [...v.files.keys(), ...v.binaries.keys()];
  const byLower = new Map(paths.map((p) => [lower(p), p]));
  if (t.startsWith('./') || t.startsWith('../')) {
    const parts = [...(dirOf(from) ? dirOf(from).split('/') : []), ...t.split('/')];
    const stack: string[] = [];
    for (const p of parts) {
      if (p === '..') stack.pop();
      else if (p !== '.') stack.push(p);
    }
    const joined = stack.join('/');
    return byLower.get(lower(joined)) ?? byLower.get(lower(joined + '.md')) ?? '';
  }
  for (const c of [t, t + '.md']) if (byLower.has(lower(c))) return byLower.get(lower(c)) ?? '';
  const dir = dirOf(from);
  if (dir) {
    for (const c of [`${dir}/${t}`, `${dir}/${t}.md`]) {
      if (byLower.has(lower(c))) return byLower.get(lower(c)) ?? '';
    }
  }
  const key = lower(t.replace(/\.md$/, '').split('/').pop() ?? t);
  let cands = paths.filter((p) => (isNote(p) ? lower(stem(p)) : lower(baseName(p))) === key);
  if (t.includes('/')) {
    const suffix = '/' + lower(t.replace(/\.md$/, ''));
    cands = cands.filter((p) => ('/' + lower(p.replace(/\.md$/, ''))).endsWith(suffix));
  }
  if (cands.length === 0) {
    cands = [...v.files.entries()]
      .filter(
        ([p, c]) => isNote(p) && extract(stem(p), c).aliases.some((a) => lower(a) === lower(t)),
      )
      .map(([p]) => p);
  }
  cands.sort(
    (a, b) =>
      Number(dirOf(b) === dir) - Number(dirOf(a) === dir) ||
      a.length - b.length ||
      a.localeCompare(b),
  );
  return cands[0] ?? '';
}

export function installWailsMock(seed?: Partial<WailsMock>): WailsMock {
  const handlers = new Map<string, Set<Handler>>();
  const mock: WailsMock = {
    sync: seed?.sync ?? {
      links: new Map(),
      status: new Map(),
      conflicts: new Map(),
      conflictTexts: new Map(),
      resolved: [],
      history: new Map(),
      revisionTexts: new Map(),
      restored: [],
      cloudVaults: [],
      devices: [
        {
          id: 'dev-1',
          name: 'This computer',
          platform: 'macos',
          appVersion: '0.0.1',
          lastSeenAt: null,
          current: true,
        },
      ],
      usage: { usedBytes: 0, quotaBytes: 5 * 1024 ** 3, level: 'ok' },
      disk: 'encrypted',
      secrets: new Map(),
    },
    history: seed?.history ?? newMockHistory(),
    sharing: {
      invitations: [],
      mounts: [],
      owned: [],
      directory: [],
      mountFiles: new Map(),
      declined: [],
      revoked: [],
    },
    config: { version: 0, config: {}, lockedKeys: [], managed: false, fetchedAt: '', features: {} },
    previews: new Map<string, string>(),
    vaults: seed?.vaults ?? new Map<string, MockVault>(),
    exports: [],
    exportCancelled: false,
    htmlExports: [],
    prints: 0,
    recent: seed?.recent ?? [],
    settings: seed?.settings ?? { language: '', theme: 'system', trashMode: 'vault' },
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
    listeners: (name) => handlers.get(name)?.size ?? 0,
  };
  const vaultOf = (id: string): MockVault => {
    const v = mock.vaults.get(id);
    if (!v) throw new Error('vault is not open');
    return v;
  };
  const reject = (msg: string): Promise<never> => Promise.reject(new Error(msg));
  const changed = (id: string, paths: string[]): void =>
    mock.emit('vault:file-changed', { vaultId: id, paths });

  const outgoing = (v: MockVault, path: string): NoteLink[] => {
    const raw = v.files.get(path);
    if (raw === undefined) return [];
    const src = isStructured(path) ? structuredSource(path, raw) : raw;
    return extract(stem(path), src)
      .links.filter((l) => l.kind !== 'external')
      .map((l) => {
        const res = resolve(v, path, l.target);
        return {
          path: res,
          line: l.line,
          raw: l.target,
          heading: l.heading,
          block: l.block,
          alias: l.alias,
          embed: l.embed,
          resolved: res !== '',
        };
      });
  };

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
          name: baseName(path) || path,
          path,
          lastOpenedAt: new Date(),
        };
        mock.vaults.set(id, { info, files: new Map(), binaries: new Map() });
      }
      const info = vaultOf(id).info;
      if (!mock.recent.some((r) => r.path === info.path)) mock.recent.unshift(info);
      return Promise.resolve(info);
    },
    ExportZip: (id: string): Promise<ExportResult> => {
      const v = vaultOf(id);
      if (mock.exportCancelled)
        return Promise.resolve({ path: '', files: 0, bytes: 0, cancelled: true });
      mock.exports.push(id);
      return Promise.resolve({
        path: `/mock/exports/${v.info.name}.zip`,
        files: v.files.size + v.binaries.size,
        bytes: 1024,
        cancelled: false,
      });
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
      changed(id, [path]);
      return Promise.resolve({ path, hash: hashOf(content), size: content.length });
    },
    CreateFolder: (): Promise<void> => Promise.resolve(),
    Rename: (id: string, from: string, to: string): Promise<void> => VaultAPI.rename(id, from, to),
    rename: (id: string, from: string, to: string): Promise<void> => {
      const v = vaultOf(id);
      const moves = [...v.files.keys()].filter((p) => p === from || p.startsWith(from + '/'));
      if (v.files.has(from) === false && moves.length === 0 && !v.binaries.has(from))
        return reject('not-found: no such file');
      for (const p of moves) {
        const content = v.files.get(p) ?? '';
        v.files.delete(p);
        v.files.set(to + p.slice(from.length), content);
      }
      const bin = v.binaries.get(from);
      if (bin !== undefined) {
        v.binaries.delete(from);
        v.binaries.set(to, bin);
      }
      changed(id, [from, to]);
      return Promise.resolve();
    },
    Trash: (id: string, path: string): Promise<string> => {
      const v = vaultOf(id);
      for (const p of [...v.files.keys()])
        if (p === path || p.startsWith(path + '/')) v.files.delete(p);
      v.binaries.delete(path);
      changed(id, [path]);
      return Promise.resolve('.trash/' + path);
    },
    RebuildIndex: (): Promise<void> => Promise.resolve(),
    ReadConfig: (id: string, name: string): Promise<string> =>
      Promise.resolve(vaultOf(id).files.get('.nodus/' + name) ?? ''),
    WriteConfig: (id: string, name: string, content: string): Promise<void> => {
      vaultOf(id).files.set('.nodus/' + name, content);
      return Promise.resolve();
    },
    ReadBinary: (id: string, path: string): Promise<BinaryContent> => {
      const data = vaultOf(id).binaries.get(path);
      if (data === undefined) return reject('not-found: no such file');
      const ext = path.split('.').pop()?.toLowerCase() ?? '';
      const mime =
        (
          {
            png: 'image/png',
            jpg: 'image/jpeg',
            gif: 'image/gif',
            svg: 'image/svg+xml',
            pdf: 'application/pdf',
          } as Record<string, string>
        )[ext] ?? 'application/octet-stream';
      return Promise.resolve({ path, mime, data, size: data.length });
    },
    SaveAttachment: (id: string, dir: string, name: string, base64: string): Promise<string> => {
      const v = vaultOf(id);
      let candidate = dir ? `${dir}/${name}` : name;
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
      for (let i = 1; v.binaries.has(candidate); i++) {
        candidate = `${dir ? dir + '/' : ''}${name.slice(0, name.length - ext.length)} ${i}${ext}`;
      }
      v.binaries.set(candidate, base64);
      changed(id, [candidate]);
      return Promise.resolve(candidate);
    },
  };

  const ExportAPI = {
    SaveHTML: (id: string, name: string, html: string): Promise<ExportResult> => {
      if (mock.exportCancelled)
        return Promise.resolve({ path: '', files: 0, bytes: 0, cancelled: true });
      mock.htmlExports.push({ vaultId: id, name, html });
      return Promise.resolve({
        path: `/mock/exports/${name}.html`,
        files: 1,
        bytes: html.length,
        cancelled: false,
      });
    },
    Print: (): Promise<void> => {
      mock.prints++;
      return Promise.resolve();
    },
  };

  const SearchAPI = {
    Query: (id: string, q: string, _sort: string, limit: number): Promise<SearchResults> => {
      const v = vaultOf(id);
      const terms = q.split(/\s+/).filter(Boolean);
      const hits: SearchHit[] = [];
      for (const [path, content] of v.files) {
        if (!isNote(path)) continue;
        let ok = terms.length > 0;
        let snippet = '';
        let line = 0;
        for (const term of terms) {
          const neg = term.startsWith('-');
          const t = lower(neg ? term.slice(1) : term);
          let match: boolean;
          if (t.startsWith('tag:'))
            match = extract(stem(path), content).tags.some(
              (x) => lower(x.name) === t.slice(4).replace(/^#/, ''),
            );
          else if (t.startsWith('file:')) match = lower(baseName(path)).includes(t.slice(5));
          else if (t.startsWith('path:')) match = lower(path).includes(t.slice(5));
          else match = lower(path).includes(t) || lower(content).includes(t);
          if (neg ? match : !match) {
            ok = false;
            break;
          }
          if (!neg && !snippet) {
            const lines = content.split('\n');
            const idx = lines.findIndex((l) => lower(l).includes(t.replace(/^\w+:/, '')));
            if (idx >= 0) {
              snippet = (lines[idx] ?? '').trim();
              line = idx + 1;
            }
          }
        }
        if (ok) hits.push({ path, title: stem(path), snippet, line, matches: 1, score: 1 });
      }
      const sliced = hits.slice(0, limit || 100);
      return Promise.resolve({ hits: sliced, total: hits.length, explain: [q] });
    },
    Explain: (q: string): Promise<string[]> => Promise.resolve([q]),
  };

  const LinksAPI = {
    Outgoing: (id: string, path: string): Promise<NoteLink[]> =>
      Promise.resolve(outgoing(vaultOf(id), path)),
    Backlinks: (id: string, path: string): Promise<NoteLink[]> => {
      const v = vaultOf(id);
      const out: NoteLink[] = [];
      for (const p of [...v.files.keys()].filter((f) => isNote(f) || isStructured(f)).sort()) {
        if (p === path) continue;
        for (const l of outgoing(v, p)) if (l.path === path) out.push({ ...l, path: p });
      }
      return Promise.resolve(out);
    },
    UnlinkedMentions: (id: string, path: string): Promise<Mention[]> => {
      const v = vaultOf(id);
      const name = stem(path);
      if (name.length < 3) return Promise.resolve([]);
      // Like the Go side: notes that already link here are not "unlinked" mentions.
      const linked = new Set(
        [...v.files.keys()].filter((p) => isNote(p) && outgoing(v, p).some((l) => l.path === path)),
      );
      return Promise.resolve(
        [...v.files.entries()]
          .filter(
            ([p, c]) => isNote(p) && p !== path && !linked.has(p) && lower(c).includes(lower(name)),
          )
          .map(([p, c]) => ({
            path: p,
            snippet: (c.split('\n').find((l) => lower(l).includes(lower(name))) ?? '').trim(),
          })),
      );
    },
    Resolve: (id: string, from: string, target: string): Promise<string> =>
      Promise.resolve(resolve(vaultOf(id), from, target)),
    Suggest: (
      id: string,
      kind: string,
      query: string,
      notePath: string,
      limit: number,
    ): Promise<Suggestion[]> => {
      const v = vaultOf(id);
      const out: Suggestion[] = [];
      const notes = [...v.files.entries()].filter(([p]) => isNote(p));
      if (kind === 'notes' || kind === 'all') {
        for (const [p, c] of notes) {
          const s = Math.max(fuzzy(query, stem(p)), Math.floor(fuzzy(query, p) / 2));
          if (s > 0)
            out.push({
              kind: 'note',
              label: stem(p),
              path: p,
              detail: dirOf(p),
              line: 0,
              score: s,
            });
          for (const a of extract(stem(p), c).aliases) {
            const sa = fuzzy(query, a);
            if (sa > 0)
              out.push({ kind: 'alias', label: a, path: p, detail: stem(p), line: 0, score: sa });
          }
        }
      }
      if (kind === 'headings' || (kind === 'all' && query.length >= 2)) {
        for (const [p, c] of notes) {
          if (notePath && p !== notePath) continue;
          for (const h of extract(stem(p), c).headings) {
            const s = fuzzy(query, h.text);
            if (s > 0)
              out.push({
                kind: 'heading',
                label: h.text,
                path: p,
                detail: '#'.repeat(h.level),
                line: h.line,
                score: s,
              });
          }
        }
      }
      if (kind === 'blocks') {
        const c = v.files.get(notePath) ?? '';
        const lines = c.split('\n');
        for (const b of extract(stem(notePath), c).blockIds) {
          out.push({
            kind: 'block',
            label: b.id,
            path: notePath,
            detail: (lines[b.line - 1] ?? '').replace(`^${b.id}`, '').trim(),
            line: b.line,
            score: 1,
          });
        }
      }
      if (kind === 'tags') {
        const counts = new Map<string, number>();
        for (const [p, c] of notes)
          for (const t of extract(stem(p), c).tags)
            counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
        for (const [name, n] of counts) {
          const s = fuzzy(query.replace(/^#/, ''), name);
          if (s > 0)
            out.push({ kind: 'tag', label: name, path: '', detail: String(n), line: 0, score: s });
        }
      }
      out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
      return Promise.resolve(out.slice(0, limit || 30));
    },
    PlanRename: (id: string, from: string, to: string): Promise<RenamePlan> =>
      Promise.resolve(planRename(vaultOf(id), from, to)),
    ApplyRename: (id: string, from: string, to: string): Promise<RenamePlan> => {
      const v = vaultOf(id);
      const plan = planRename(v, from, to);
      for (const f of plan.files) {
        let c = v.files.get(f.path) ?? '';
        for (const e of [...f.edits].sort((a, b) => b.start - a.start))
          c = c.slice(0, e.start) + e.new + c.slice(e.end);
        v.files.set(f.path, c);
      }
      void VaultAPI.rename(id, from, to);
      return Promise.resolve(plan);
    },
  };

  function planRename(v: MockVault, from: string, to: string): RenamePlan {
    const moved = new Map<string, string>();
    for (const p of [...v.files.keys(), ...v.binaries.keys()]) {
      if (p === from) moved.set(p, to);
      else if (p.startsWith(from + '/')) moved.set(p, to + p.slice(from.length));
    }
    const files: RenamePlan['files'] = [];
    for (const [p, content] of v.files) {
      if (!isNote(p)) continue;
      const edits: RenamePlan['files'][number]['edits'] = [];
      for (const l of extract(stem(p), content).links) {
        if (l.kind === 'external' || !l.target) continue;
        const old = resolve(v, p, l.target);
        const np = moved.get(old);
        if (!old || !np) continue;
        const text = isNote(np) ? stem(np) : baseName(np);
        if (content.slice(l.targetStart, l.targetEnd) !== text) {
          edits.push({
            line: l.line,
            start: l.targetStart,
            end: l.targetEnd,
            old: content.slice(l.targetStart, l.targetEnd),
            new: text,
          });
        }
      }
      if (edits.length) files.push({ path: p, hash: hashOf(content), edits });
    }
    return { from, to, moves: [...moved].map(([f, t]) => ({ from: f, to: t })), files };
  }

  const TagsAPI = {
    List: (id: string): Promise<TagCount[]> => {
      const v = vaultOf(id);
      const counts = new Map<string, number>();
      for (const [p, c] of v.files) {
        if (!isNote(p)) continue;
        for (const name of new Set(extract(stem(p), c).tags.map((t) => t.name)))
          counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      return Promise.resolve(
        [...counts]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => lower(a.name).localeCompare(lower(b.name))),
      );
    },
  };

  const schemaOf = (v: MockVault): Record<string, string> => {
    try {
      return JSON.parse(v.files.get('.nodus/types.json') || '{}') as Record<string, string>;
    } catch {
      return {};
    }
  };
  const inferKind = (x: unknown): string =>
    typeof x === 'boolean'
      ? 'checkbox'
      : typeof x === 'number'
        ? 'number'
        : Array.isArray(x)
          ? 'list'
          : typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)
            ? 'date'
            : typeof x === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(x)
              ? 'datetime'
              : 'text';

  const PropertiesAPI = {
    Keys: (id: string): Promise<PropertyKey[]> => {
      const v = vaultOf(id);
      const schema = schemaOf(v);
      const keys = new Map<string, PropertyKey>();
      for (const [p, c] of v.files) {
        if (!isNote(p)) continue;
        for (const [k, val] of Object.entries(extract(stem(p), c).properties)) {
          const cur = keys.get(lower(k));
          if (cur) cur.count++;
          else keys.set(lower(k), { key: k, kind: schema[k] ?? inferKind(val), count: 1 });
        }
      }
      return Promise.resolve(
        [...keys.values()].sort((a, b) => lower(a.key).localeCompare(lower(b.key))),
      );
    },
    Schema: (id: string): Promise<Record<string, string>> => Promise.resolve(schemaOf(vaultOf(id))),
    SetType: (id: string, key: string, kind: string): Promise<void> => {
      const v = vaultOf(id);
      const s = schemaOf(v);
      if (kind) s[key] = kind;
      else delete s[key];
      v.files.set('.nodus/types.json', JSON.stringify(s, null, 2));
      return Promise.resolve();
    },
    Update: (
      id: string,
      path: string,
      key: string,
      valueJSON: string,
      expectedHash: string,
    ): Promise<WriteResult> => {
      const v = vaultOf(id);
      const cur = v.files.get(path);
      if (cur === undefined) return reject('not-found: no such file');
      if (expectedHash && hashOf(cur) !== expectedHash)
        return reject('conflict: file changed on disk');
      const fm = splitFrontmatter(cur);
      const doc = parseDocument(fm.yaml ?? '');
      doc.set(key, JSON.parse(valueJSON));
      const out = `---\n${doc.toString()}---\n${fm.body}`;
      v.files.set(path, out);
      changed(id, [path]);
      return Promise.resolve({ path, hash: hashOf(out), size: out.length });
    },
    Remove: (id: string, path: string, key: string, expectedHash: string): Promise<WriteResult> => {
      const v = vaultOf(id);
      const cur = v.files.get(path);
      if (cur === undefined) return reject('not-found: no such file');
      if (expectedHash && hashOf(cur) !== expectedHash)
        return reject('conflict: file changed on disk');
      const fm = splitFrontmatter(cur);
      if (fm.yaml === null) return Promise.resolve({ path, hash: hashOf(cur), size: cur.length });
      const doc = parseDocument(fm.yaml);
      doc.delete(key);
      const body = doc.toString().trim();
      const out = body ? `---\n${doc.toString()}---\n${fm.body}` : fm.body;
      v.files.set(path, out);
      changed(id, [path]);
      return Promise.resolve({ path, hash: hashOf(out), size: out.length });
    },
  };

  const BasesAPI = makeBasesAPI({
    files: (id) => vaultOf(id).files,
    hashOf,
    updateProperty: (id, path, key, valueJSON, hash) =>
      PropertiesAPI.Update(id, path, key, valueJSON, hash),
  });

  const SettingsAPI = {
    Get: (): Promise<AppSettings> => Promise.resolve(mock.settings),
    Set: (s: AppSettings): Promise<void> => {
      mock.settings = s;
      return Promise.resolve();
    },
    Info: (): Promise<Record<string, string>> =>
      Promise.resolve({ version: 'test', dataDir: '/mock/data' }),
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

  // --- cloud synchronization ----------------------------------------------------
  const sy = mock.sync;
  const linkOf = (id: string): SyncLinkInfo & { passphrase?: string; recoveryKey?: string } =>
    sy.links.get(id) ?? linkInfo();
  const setStatus = (id: string, patch: Partial<SyncStatus>): void => {
    const cur = sy.status.get(id) ?? {
      vaultId: id,
      phase: 'idle',
      lastSync: '',
      pending: 0,
      conflicts: 0,
      done: 0,
      total: 0,
      error: '',
      kind: '',
    };
    const next = { ...cur, ...patch, vaultId: id } as SyncStatus;
    sy.status.set(id, next);
    mock.emit('sync:status', next);
  };
  const signedIn = (): boolean =>
    mock.auth.status === 'ready' || mock.auth.status === 'disconnected';
  const requireSignIn = (): Promise<never> | null =>
    signedIn() ? null : reject('not signed in to the cloud');
  const runFirstSync = (id: string): void => {
    setStatus(id, { phase: 'syncing', total: 3, done: 0 });
    setTimeout(
      () =>
        setStatus(id, {
          phase: 'idle',
          lastSync: new Date().toISOString(),
          total: 0,
          done: 0,
          pending: 0,
          conflicts: (sy.conflicts.get(id) ?? []).length,
        }),
      0,
    );
  };

  const SyncAPI = {
    Info: (id: string): Promise<SyncLinkInfo> => {
      const info: SyncLinkInfo & { passphrase?: string; recoveryKey?: string } = { ...linkOf(id) };
      delete info.passphrase;
      delete info.recoveryKey;
      return Promise.resolve(info);
    },
    Status: (id: string): Promise<SyncStatus> =>
      Promise.resolve(
        sy.status.get(id) ?? {
          vaultId: id,
          phase: 'idle',
          lastSync: '',
          pending: 0,
          conflicts: 0,
          done: 0,
          total: 0,
          error: '',
          kind: linkOf(id).kind,
        },
      ),
    LinkNew: (
      id: string,
      name: string,
      kind: string,
      passphrase: string,
    ): Promise<{ cloudVaultId: string; recoveryKey: string }> => {
      const err = requireSignIn();
      if (err) return err;
      if (linkOf(id).linked) return reject('this vault is already connected to the cloud');
      if (kind !== 'shared' && kind !== 'private') return reject(`unknown vault kind "${kind}"`);
      if (kind === 'private' && [...passphrase].length < 12)
        return reject('the passphrase must have at least 12 characters');
      if (sy.cloudVaults.some((v) => v.name === name))
        return reject('name-in-use: you already have a vault with this name');
      const cloudVaultId = `cloud-${sy.cloudVaults.length + 1}`;
      const recoveryKey =
        kind === 'private' ? 'ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z2345-67ABC-DEFGH-IJKLM-NOPQR-STU' : '';
      sy.cloudVaults.push({
        id: cloudVaultId,
        name,
        kind,
        totalBytes: 0,
        fileCount: 0,
        createdAt: new Date().toISOString(),
      });
      sy.links.set(id, {
        ...linkInfo({
          linked: true,
          cloudVaultId,
          kind,
          name,
          serverUrl: mock.auth.serverUrl,
          locked: false,
          paused: false,
          pollSeconds: 0,
        }),
        passphrase,
        recoveryKey,
      });
      sy.secrets.set(cloudVaultId, { passphrase, recoveryKey });
      runFirstSync(id);
      return Promise.resolve({ cloudVaultId, recoveryKey });
    },
    ListCloudVaults: (): Promise<CloudVault[]> =>
      requireSignIn() ?? Promise.resolve(sy.cloudVaults),
    LinkExisting: (id: string, cloudVaultId: string): Promise<void> => {
      const err = requireSignIn();
      if (err) return err;
      const v = sy.cloudVaults.find((x) => x.id === cloudVaultId);
      if (!v) return reject('not-found: vault not found');
      sy.links.set(id, {
        ...linkInfo({
          linked: true,
          cloudVaultId,
          kind: v.kind,
          name: v.name,
          serverUrl: mock.auth.serverUrl,
          locked: v.kind === 'private',
          paused: false,
          pollSeconds: 0,
        }),
      });
      if (v.kind === 'private') setStatus(id, { phase: 'locked', kind: 'private' });
      else runFirstSync(id);
      return Promise.resolve();
    },
    Unlink: (id: string): Promise<void> => {
      sy.links.delete(id);
      sy.status.delete(id);
      mock.emit('sync:status', {
        vaultId: id,
        phase: 'idle',
        lastSync: '',
        pending: 0,
        conflicts: 0,
        done: 0,
        total: 0,
        error: '',
        kind: '',
      });
      return Promise.resolve();
    },
    SetPaused: (id: string, paused: boolean): Promise<void> => {
      const l = linkOf(id);
      if (!l.linked) return reject('this vault is not connected to the cloud');
      sy.links.set(id, { ...l, paused });
      setStatus(id, { phase: paused ? 'paused' : 'idle' });
      return Promise.resolve();
    },
    SetPollInterval: (id: string, seconds: number): Promise<void> => {
      const l = linkOf(id);
      if (!l.linked) return reject('this vault is not connected to the cloud');
      if (seconds < 0 || (seconds > 0 && seconds < 15))
        return reject('the interval must be 0 (automatic) or at least 15 seconds');
      sy.links.set(id, { ...l, pollSeconds: seconds });
      return Promise.resolve();
    },
    SyncNow: (id: string): Promise<void> => {
      if (!linkOf(id).linked) return reject('this vault is not connected to the cloud');
      runFirstSync(id);
      return Promise.resolve();
    },
    Conflicts: (id: string): Promise<SyncConflict[]> => Promise.resolve(sy.conflicts.get(id) ?? []),
    ConflictTexts: (_id: string, cid: number): Promise<ConflictTexts> => {
      const t = sy.conflictTexts.get(cid);
      return t ? Promise.resolve(t) : reject('conflict not found');
    },
    ResolveConflict: (id: string, cid: number, action: string, merged: string): Promise<void> => {
      const list = sy.conflicts.get(id) ?? [];
      if (!list.some((c) => c.id === cid)) return reject('conflict not found or already resolved');
      sy.resolved.push({ vaultId: id, id: cid, action: action as ConflictAction, merged });
      sy.conflicts.set(
        id,
        list.filter((c) => c.id !== cid),
      );
      setStatus(id, { conflicts: list.length - 1 });
      return Promise.resolve();
    },
    History: (id: string, path: string): Promise<RevisionInfo[]> =>
      Promise.resolve(sy.history.get(`${id}|${path}`) ?? []),
    RevisionText: (id: string, path: string, rev: number): Promise<string> => {
      const t = sy.revisionTexts.get(`${id}|${path}|${rev}`);
      return t === undefined ? reject('not-found: revision not found') : Promise.resolve(t);
    },
    RestoreRevision: (id: string, path: string, rev: number): Promise<void> => {
      sy.restored.push({ vaultId: id, path, rev });
      return Promise.resolve();
    },
    Devices: (): Promise<DeviceInfo[]> => requireSignIn() ?? Promise.resolve(sy.devices),
    RevokeDevice: (devId: string): Promise<void> => {
      sy.devices = sy.devices.filter((d) => d.id !== devId);
      return Promise.resolve();
    },
    Usage: (): Promise<UsageInfo> => requireSignIn() ?? Promise.resolve(sy.usage),
  };

  // --- sharing and configuration ----------------------------------------------
  const sh = mock.sharing;
  const SharingAPI = {
    // Copies: the UI's query cache must see a different array after the test mutated the state.
    Invitations: (): Promise<ShareInfo[]> => Promise.resolve(structuredClone(sh.invitations)),
    Mounts: (): Promise<MountState[]> => Promise.resolve(structuredClone(sh.mounts)),
    AcceptShare: (shareId: string): Promise<MountState> => {
      const inv = sh.invitations.find((i) => i.id === shareId);
      if (!inv) return reject('not-found: no such invitation');
      sh.invitations = sh.invitations.filter((i) => i.id !== shareId);
      const m: MountState = {
        shareId,
        cloudVaultId: inv.vaultId,
        name: inv.displayName,
        ownerName: inv.ownerName,
        resourceType: inv.resourceType,
        permission: inv.myPermission || 'viewer',
        path: `/mock/mounts/${shareId}`,
        mounted: true,
        revoked: false,
        vaultId: '',
      };
      sh.mounts.push(m);
      mock.emit('shares:changed', { shareId, kind: 'granted' });
      return Promise.resolve(m);
    },
    DeclineShare: (shareId: string): Promise<void> => {
      sh.invitations = sh.invitations.filter((i) => i.id !== shareId);
      sh.declined.push(shareId);
      return Promise.resolve();
    },
    OpenMount: async (shareId: string): Promise<VaultInfo> => {
      const m = sh.mounts.find((x) => x.shareId === shareId);
      if (!m) return reject('not-found: this share is not available any more');
      const info = await VaultAPI.OpenVault(m.path);
      info.name = m.name;
      const v = vaultOf(info.id);
      for (const [p, text] of Object.entries(sh.mountFiles.get(shareId) ?? {}))
        v.files.set(p, text);
      m.vaultId = info.id;
      sy.links.set(
        info.id,
        linkInfo({
          linked: true,
          mount: true,
          kind: 'shared',
          name: m.name,
          cloudVaultId: m.cloudVaultId,
          permission: m.permission,
          readOnly: m.permission === 'viewer' || m.revoked,
          revoked: m.revoked,
          ownerName: m.ownerName,
          shareId,
        }),
      );
      return info;
    },
    RemoveMount: (shareId: string, keep: boolean): Promise<VaultInfo> => {
      const m = sh.mounts.find((x) => x.shareId === shareId);
      sh.mounts = sh.mounts.filter((x) => x.shareId !== shareId);
      if (m?.vaultId) mock.vaults.delete(m.vaultId);
      return Promise.resolve({
        id: keep ? `kept-${shareId}` : '',
        name: keep ? (m?.name ?? '') : '',
        path: keep ? `/mock/kept/${m?.name ?? shareId}` : '',
        lastOpenedAt: new Date(),
      });
    },
    VaultShares: (vaultId: string): Promise<ShareInfo[]> => {
      const cloud = sy.links.get(vaultId)?.cloudVaultId;
      return Promise.resolve(structuredClone(sh.owned.filter((s) => s.vaultId === cloud)));
    },
    CreateShare: (
      vaultId: string,
      path: string,
      isDir: boolean,
      name: string,
      grants: GrantInput[],
    ): Promise<ShareInfo> => {
      const link = sy.links.get(vaultId);
      if (!link?.linked)
        return reject('validation-failed: this vault is not connected to the cloud');
      const share: ShareInfo = {
        id: `share-${sh.owned.length + 1}`,
        vaultId: link.cloudVaultId,
        vaultName: link.name,
        resourceType: !isDir ? 'file' : path ? 'folder' : 'vault',
        pathPrefix: path,
        displayName: name || path || link.name,
        ownerName: 'me',
        createdAt: new Date().toISOString(),
        expiresAt: '',
        myPermission: 'manager',
        myStatus: '',
        grants: grants.map((g) => ({
          principalType: g.principalType,
          principalId: g.principalId,
          principalName: sh.directory.find((d) => d.id === g.principalId)?.name ?? g.principalId,
          permission: g.permission,
          status: 'pending',
        })),
      };
      sh.owned.push(share);
      return Promise.resolve(share);
    },
    Share: (id: string): Promise<ShareInfo> => {
      const s = sh.owned.find((x) => x.id === id);
      return s ? Promise.resolve(s) : reject('not-found: share not found');
    },
    RevokeShare: (id: string): Promise<void> => {
      sh.owned = sh.owned.filter((x) => x.id !== id);
      sh.revoked.push(id);
      return Promise.resolve();
    },
    SetGrant: (
      id: string,
      principalType: string,
      principalId: string,
      permission: string,
    ): Promise<ShareGrant> => {
      const s = sh.owned.find((x) => x.id === id);
      if (!s) return reject('not-found: share not found');
      let g = s.grants.find(
        (x) => x.principalId === principalId && x.principalType === principalType,
      );
      if (!g) {
        g = {
          principalType: principalType as ShareGrant['principalType'],
          principalId,
          principalName: sh.directory.find((d) => d.id === principalId)?.name ?? principalId,
          permission: permission as ShareGrant['permission'],
          status: 'pending',
        };
        s.grants.push(g);
      }
      g.permission = permission as ShareGrant['permission'];
      return Promise.resolve(g);
    },
    RemoveGrant: (id: string, principalType: string, principalId: string): Promise<void> => {
      const s = sh.owned.find((x) => x.id === id);
      if (s)
        s.grants = s.grants.filter(
          (g) => !(g.principalId === principalId && g.principalType === principalType),
        );
      return Promise.resolve();
    },
    Directory: (q: string): Promise<DirectoryEntry[]> =>
      Promise.resolve(sh.directory.filter((d) => d.label.toLowerCase().includes(q.toLowerCase()))),
  };
  const ConfigAPI = {
    Effective: (): Promise<ConfigState> => Promise.resolve(mock.config),
    Refresh: (): Promise<ConfigState> => Promise.resolve(mock.config),
  };

  const DrawingAPI = {
    ReadPreview: (_id: string, hash: string): Promise<string> =>
      Promise.resolve(mock.previews.get(hash) ?? ''),
    SavePreview: (_id: string, hash: string, svg: string): Promise<void> => {
      mock.previews.set(hash, svg);
      return Promise.resolve();
    },
  };

  const VaultCryptoAPI = {
    Unlock: (id: string, secret: string, isRecovery: boolean): Promise<boolean> => {
      const l = linkOf(id);
      if (!l.linked || l.kind !== 'private') return reject('only private vaults are encrypted');
      const keys = sy.secrets.get(l.cloudVaultId);
      const ok = isRecovery
        ? secret.replace(/[-\s]/g, '').toUpperCase() === (keys?.recoveryKey ?? '').replace(/-/g, '')
        : secret === keys?.passphrase;
      if (!ok) return reject('wrong passphrase or recovery key');
      sy.links.set(id, { ...l, locked: false });
      setStatus(id, { phase: 'idle', kind: 'private' });
      return Promise.resolve(isRecovery);
    },
    Lock: (id: string): Promise<void> => {
      const l = linkOf(id);
      sy.links.set(id, { ...l, locked: true });
      setStatus(id, { phase: 'locked' });
      mock.emit('vault:locked', { vaultId: id });
      return Promise.resolve();
    },
    SetPassphrase: (id: string, passphrase: string): Promise<void> => {
      const l = linkOf(id);
      if ([...passphrase].length < 12)
        return reject('the passphrase must have at least 12 characters');
      const keys = sy.secrets.get(l.cloudVaultId);
      if (keys) sy.secrets.set(l.cloudVaultId, { ...keys, passphrase });
      return Promise.resolve();
    },
    ChangePassphrase: (id: string, oldPass: string, newPass: string): Promise<void> => {
      const l = linkOf(id);
      const keys = sy.secrets.get(l.cloudVaultId);
      if (!keys || keys.passphrase !== oldPass) return reject('wrong passphrase or recovery key');
      if ([...newPass].length < 12)
        return reject('the passphrase must have at least 12 characters');
      sy.secrets.set(l.cloudVaultId, { ...keys, passphrase: newPass });
      return Promise.resolve();
    },
    RegenerateRecoveryKey: (id: string, passphrase: string): Promise<string> => {
      const l = linkOf(id);
      const keys = sy.secrets.get(l.cloudVaultId);
      if (!keys || keys.passphrase !== passphrase)
        return reject('wrong passphrase or recovery key');
      const recoveryKey = 'ZZZZZ-YYYYY-XXXXX-WWWWW-VVVVV-UUUUU-TTTTT-SSSSS-RRRRR-QQQQQ-PPP';
      sy.secrets.set(l.cloudVaultId, { ...keys, recoveryKey });
      return Promise.resolve(recoveryKey);
    },
    DiskEncryption: (): Promise<DiskEncryption> => Promise.resolve(sy.disk),
  };

  const GraphAPI = {
    Build: (id: string, o: GraphOptions): Promise<GraphData> => {
      // Benchmarks and e2e runs can ask for a synthetic graph of a given size.
      const fixture = (window as unknown as { __NODUS_GRAPH_FIXTURE__?: number })
        .__NODUS_GRAPH_FIXTURE__;
      if (fixture) return Promise.resolve(syntheticGraph(fixture));
      const v = vaultOf(id);
      const notes = [...v.files.keys()].filter(isNote);
      return Promise.resolve(
        buildMockGraph(
          {
            paths: [...notes, ...v.binaries.keys()],
            links: (p) =>
              outgoing(v, p)
                .filter((l) => l.path === '' || isNote(l.path) || v.binaries.has(l.path))
                .map((l) => ({ path: l.path, raw: l.raw })),
            tags: (p) => extract(stem(p), v.files.get(p) ?? '').tags.map((t) => t.name),
            text: (p) => v.files.get(p) ?? '',
          },
          o,
        ),
      );
    },
  };

  const w = window as unknown as Record<string, unknown>;
  w['go'] = {
    app: {
      VaultAPI,
      SearchAPI,
      ExportAPI,
      SettingsAPI,
      AuthAPI,
      LinksAPI,
      TagsAPI,
      PropertiesAPI,
      BasesAPI,
      SyncAPI,
      VaultCryptoAPI,
      DrawingAPI,
      SharingAPI,
      ConfigAPI,
      GraphAPI,
      ...notesMock({ vaultOf, resolve, changed }),
      HistoryAPI: createHistoryAPI(mock.history, {
        files: (id) => vaultOf(id).files,
        changed,
        hash: hashOf,
      }),
      ImporterAPI: createImporterMock((name, payload) => mock.emit(name, payload)),
      UpdaterAPI: createUpdaterMock((name, payload) => mock.emit(name, payload)),
    },
  };
  w['runtime'] = {
    EventsOnMultiple: (name: string, cb: Handler, _max: number) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)?.add(cb);
      return () => handlers.get(name)?.delete(cb);
    },
    EventsOff: (name: string) => handlers.delete(name),
    EventsEmit: (name: string, ...data: unknown[]) => mock.emit(name, data[0]),
    BrowserOpenURL: () => undefined,
    WindowShow: () => undefined,
  };
  return mock;
}
