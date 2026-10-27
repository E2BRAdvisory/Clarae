// Mock of BasesAPI for UI tests and Playwright: a tiny subset of the Go engine (equality and
// inFolder filters, sort, order, one level of groupBy). The real semantics are tested in Go.
import { parse } from 'yaml';
import { extract } from '@memobrain/markdown';
import type { WriteResult } from '../../app/api';
import type { BaseCell, BaseInfo, BaseResult } from '../../bases/types';

interface Deps {
  files: (vaultId: string) => Map<string, string>;
  hashOf: (s: string) => string;
  updateProperty: (
    vaultId: string,
    path: string,
    key: string,
    valueJSON: string,
    hash: string,
  ) => Promise<WriteResult>;
}

type Dict = Record<string, unknown>;

const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';

const kindOf = (v: unknown): string =>
  typeof v === 'boolean'
    ? 'checkbox'
    : typeof v === 'number'
      ? 'number'
      : Array.isArray(v)
        ? 'list'
        : v === null || v === undefined
          ? 'null'
          : /^\d{4}-\d{2}-\d{2}$/.test(str(v))
            ? 'date'
            : 'text';

const chips = (f: unknown): BaseInfo['views'][number]['filters'] => {
  const list = (f as Dict | undefined)?.['and'];
  if (!Array.isArray(list)) return [];
  return list.map((x, i) => ({ text: String(x), simple: typeof x === 'string', index: i }));
};

function matches(expr: string, path: string, props: Dict): boolean {
  let m = /^file\.inFolder\("(.*)"\)$/.exec(expr);
  if (m) return path.startsWith((m[1] ?? '') + '/');
  m = /^file\.ext == "(.*)"$/.exec(expr);
  if (m) return path.endsWith('.' + (m[1] ?? ''));
  m = /^(\w+) (==|!=) "(.*)"$/.exec(expr);
  if (m) return (str(props[m[1] ?? '']) === m[3]) === (m[2] === '==');
  return true;
}

export function makeBasesAPI(d: Deps) {
  const read = (id: string, path: string): { doc: Dict; text: string } => {
    const text = d.files(id).get(path);
    if (text === undefined) throw new Error('not-found: no such file');
    return { doc: (parse(text) as Dict | null) ?? {}, text };
  };
  return {
    Load: (id: string, path: string): Promise<BaseInfo> => {
      try {
        const { doc, text } = read(id, path);
        const views = ((doc['views'] as Dict[] | undefined) ?? []).map((v) => ({
          name: str(v['name']),
          type: str(v['type']),
          supported: v['type'] === 'table' || v['type'] === 'cards',
          notice: '',
          order: (v['order'] as string[] | undefined) ?? [],
          sort: (v['sort'] as { property: string; direction: 'ASC' | 'DESC' }[] | undefined) ?? [],
          groupBy:
            (v['groupBy'] as { property: string; direction: 'ASC' | 'DESC' } | undefined) ?? null,
          limit: Number(v['limit'] ?? 0),
          filters: chips(v['filters']),
          baseFilters: chips(doc['filters']).map((c) => ({ ...c, simple: false, index: -1 })),
        }));
        return Promise.resolve({
          path,
          hash: d.hashOf(text),
          parseError: '',
          views,
          formulas: [],
          notices: [],
        });
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error('mock failure'));
      }
    },
    Run: (id: string, path: string, viewIndex: number): Promise<BaseResult> => {
      const { doc } = read(id, path);
      const view = ((doc['views'] as Dict[] | undefined) ?? [])[viewIndex] ?? {};
      const exprs = [...chips(doc['filters']), ...chips(view['filters'])].map((c) => c.text);
      const order = (view['order'] as string[] | undefined) ?? ['file.name'];
      type R = { path: string; hash: string; props: Dict };
      let rows: R[] = [];
      for (const [p, text] of d.files(id)) {
        if (!p.endsWith('.md')) continue;
        const props = extract(p, text).properties as Dict;
        if (exprs.every((e) => matches(e, p, props)))
          rows.push({ path: p, hash: d.hashOf(text), props });
      }
      const sort = (view['sort'] as { property: string; direction: string }[] | undefined) ?? [];
      rows.sort((a, b) => {
        for (const s of sort) {
          const x = str(a.props[s.property]),
            y = str(b.props[s.property]);
          const c = x.localeCompare(y, undefined, { numeric: true });
          if (c) return s.direction === 'DESC' ? -c : c;
        }
        return a.path.localeCompare(b.path);
      });
      const total = rows.length;
      const limit = Number(view['limit'] ?? 0);
      if (limit > 0) rows = rows.slice(0, limit);
      const cell = (r: R, id2: string): BaseCell => {
        if (id2 === 'file.name') {
          const n = (r.path.split('/').pop() ?? r.path).replace(/\.md$/, '');
          return { k: 'link', v: `[[${r.path}|${n}]]` };
        }
        if (id2.startsWith('file.')) return { k: 'text', v: r.path };
        const v = r.props[id2.replace(/^note\./, '')];
        return { k: kindOf(v), v: v ?? undefined };
      };
      return Promise.resolve({
        view: str(view['name']),
        type: str(view['type']) || 'table',
        columns: order.map((c) => ({
          id: c,
          key: c.startsWith('file.') || c.startsWith('formula.') ? '' : c,
          name: c === 'file.name' ? 'Name' : c,
          kind: c.startsWith('file.')
            ? 'text'
            : kindOf(rows.find((r) => r.props[c] !== undefined)?.props[c]),
          editable: !c.startsWith('file.') && !c.startsWith('formula.'),
          formula: c.startsWith('formula.'),
        })),
        rows: rows.map((r) => ({
          path: r.path,
          hash: r.hash,
          cells: order.map((c) => cell(r, c)),
        })),
        groups: [],
        total,
        summaries: [],
        notices: [],
      });
    },
    UpdateView: (): Promise<WriteResult> =>
      Promise.reject(new Error('mock: UpdateView is not implemented')),
    UpdateProperty: (id: string, path: string, key: string, valueJSON: string, hash: string) =>
      d.updateProperty(id, path, key, valueJSON, hash),
    NewBaseContent: (folder: string): Promise<string> =>
      Promise.resolve(
        `filters:\n  and:\n    - file.ext == "md"\n${folder ? `    - 'file.inFolder("${folder}")'\n` : ''}views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - file.mtime\n`,
      ),
  };
}
