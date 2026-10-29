import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchHit, SearchResults } from '../app/api';
import { initI18n } from '../i18n';
import { disposeQueryBlock, renderQueryBlock, type QueryEnv } from './block';

const hit = (path: string, snippet = '', line = 0): SearchHit => ({
  path,
  title: path.replace(/\.md$/, '').split('/').pop() ?? path,
  snippet,
  line,
  matches: 1,
  score: 1,
});

let client: QueryClient;
let hits: SearchHit[];
let total: number;
let search: ReturnType<typeof vi.fn>;
let env: QueryEnv;
let open: ReturnType<typeof vi.fn>;
let openInSearch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  initI18n('en');
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  hits = [hit('Host.md', 'meeting here', 1), hit('A/Plan.md', 'the meeting notes', 4), hit('B.md')];
  total = 3;
  search = vi.fn((_q: string, _s: string, limit: number): Promise<SearchResults> =>
    Promise.resolve({ hits: hits.slice(0, limit), total, explain: ['plan'] }),
  );
  open = vi.fn();
  openInSearch = vi.fn();
  env = {
    vaultId: 'v1',
    hostPath: 'Host.md',
    excludeHost: true,
    search: search as unknown as QueryEnv['search'],
    open: open as unknown as QueryEnv['open'],
    openInSearch: openInSearch as unknown as QueryEnv['openInSearch'],
    client,
  };
});

const mount = (source: string, e: QueryEnv = env): HTMLElement => {
  const el = document.createElement('div');
  document.body.append(el);
  renderQueryBlock(el, source, e);
  return el;
};
const titles = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('.query-hit-title')].map((a) => a.textContent ?? '');

describe('query block', () => {
  it('lists results with highlighted snippets and a count, leaving the host note out', async () => {
    const el = mount('meeting');
    await vi.waitFor(() => expect(titles(el)).toEqual(['Plan', 'B']));
    expect(el.querySelector('.query-count')?.textContent).toBe('2 results');
    expect(el.querySelector('.query-hit-snippet')?.innerHTML).toBe(
      '4: the <mark>meeting</mark> notes',
    );
    expect(el.querySelector('.query-hit-path')?.textContent).toBe('A');
    disposeQueryBlock(el);
  });

  it('includes the host note when asked to (block option or setting)', async () => {
    const el = mount('meeting\nself: include');
    await vi.waitFor(() => expect(titles(el)).toEqual(['Host', 'Plan', 'B']));
    const el2 = mount('meeting', { ...env, excludeHost: false });
    await vi.waitFor(() => expect(titles(el2)).toHaveLength(3));
  });

  it('passes sort and the limit, and hides context lines on request', async () => {
    const el = mount('meeting\nsort: name\nlimit: 2\ncontext: false');
    await vi.waitFor(() => expect(titles(el)).toEqual(['Plan', 'B']));
    expect(search).toHaveBeenCalledWith('meeting', 'name', 3); // limit + 1 for the host note
    expect(el.querySelector('.query-hit-snippet')).toBeNull();
  });

  it('opens a note, at the matching line, and the search panel', async () => {
    const el = mount('meeting');
    await vi.waitFor(() => expect(titles(el)).toHaveLength(2));
    el.querySelector<HTMLElement>('.query-hit-snippet')?.click();
    expect(open).toHaveBeenCalledWith('A/Plan.md', 4, false);
    el.querySelector<HTMLElement>('.query-hit-title')?.click();
    expect(open).toHaveBeenLastCalledWith('A/Plan.md', 0, false);
    el.querySelector<HTMLElement>('.query-open')?.click();
    expect(openInSearch).toHaveBeenCalledWith('meeting');
  });

  it('shows a query error inline', async () => {
    search.mockRejectedValue(new Error('query: unexpected ) (at 3)'));
    const el = mount('a ) b');
    await vi.waitFor(() =>
      expect(el.querySelector('.query-error')?.textContent).toBe('query: unexpected ) (at 3)'),
    );
    expect(el.querySelector('.query-error')?.getAttribute('role')).toBe('alert');
  });

  it('says so when there is no query or no result', async () => {
    expect(mount('sort: name').textContent).toContain('Write a search query');
    hits = [];
    total = 0;
    const el = mount('nothing');
    await vi.waitFor(() => expect(el.textContent).toContain('No results'));
  });

  it('pages long result lists with "show more"', async () => {
    hits = Array.from({ length: 230 }, (_, i) => hit(`n${String(i).padStart(3, '0')}.md`));
    total = 230;
    const el = mount('x', { ...env, excludeHost: false });
    await vi.waitFor(() => expect(titles(el)).toHaveLength(100));
    expect(el.querySelector('.query-count')?.textContent).toBe('230 results');
    el.querySelector<HTMLElement>('.query-more')?.click();
    await vi.waitFor(() => expect(titles(el)).toHaveLength(200));
    el.querySelector<HTMLElement>('.query-more')?.click();
    await vi.waitFor(() => expect(titles(el)).toHaveLength(230));
    expect(el.querySelector('.query-more')).toBeNull();
  });

  it('follows the index: invalidating the search queries refreshes the results', async () => {
    const el = mount('meeting');
    await vi.waitFor(() => expect(titles(el)).toEqual(['Plan', 'B']));
    hits = [hit('New.md', 'a meeting', 2), ...hits];
    total = 4;
    await client.invalidateQueries({ queryKey: ['search', 'v1'] });
    await vi.waitFor(() => expect(titles(el)).toEqual(['New', 'Plan', 'B']));
  });

  it('stops following once its element is gone', async () => {
    const el = mount('meeting');
    await vi.waitFor(() => expect(titles(el)).toHaveLength(2));
    el.remove();
    await client.invalidateQueries({ queryKey: ['search', 'v1'] });
    await client.invalidateQueries({ queryKey: ['search', 'v1'] });
    const after = search.mock.calls.length;
    await client.invalidateQueries({ queryKey: ['search', 'v1'] });
    expect(search.mock.calls.length).toBe(after);
  });
});
