// Live rendering of a ```query block (embedded search) into a DOM element, shared by
// Live Preview (CodeMirror widget) and Reading view (hydrate). Results come from the
// same search binding as the search panel and refresh when the shared query client
// invalidates `['search', vaultId]` (file changes, end of indexing), as the other
// panels do. Everything is built with DOM nodes and textContent: no HTML strings.
import { QueryObserver, type QueryClient } from '@tanstack/react-query';
import type { SearchResults, SearchSort } from '../app/api';
import { i18next } from '../i18n';
import { queryClient } from '../state/queryClient';
import { appendHighlighted, queryTerms } from './highlight';
import { DEFAULT_PAGE, parseQueryBlock } from './parse';

export interface QueryEnv {
  vaultId: string;
  /** The note containing the block. */
  hostPath: string;
  /** The user setting: leave the host note out of its own results. */
  excludeHost: boolean;
  search(q: string, sort: SearchSort, limit: number): Promise<SearchResults>;
  open(path: string, line: number, newTab: boolean): void;
  openInSearch(query: string): void;
  /** Override for tests; defaults to the application's shared client. */
  client?: QueryClient;
}

const t = (key: string, opts: Record<string, unknown> = {}): string =>
  i18next.t(`query.${key}`, opts);

function div(cls: string, text?: string): HTMLElement {
  const el = document.createElement('div');
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

const disposers = new WeakMap<HTMLElement, () => void>();

/** Stops the live updates of a block rendered into el (idempotent). */
export function disposeQueryBlock(el: HTMLElement): void {
  disposers.get(el)?.();
}

/** Renders the block into el and keeps it up to date; returns the dispose function. */
export function renderQueryBlock(el: HTMLElement, source: string, env: QueryEnv): () => void {
  disposeQueryBlock(el);
  const spec = parseQueryBlock(source);
  el.className = `query-block query-${spec.view}`;
  el.replaceChildren();
  const header = div('query-header');
  const body = div('query-body');
  el.append(header, body);

  const query = spec.query.trim();
  const problems = spec.problems.length
    ? div('query-notice', t('badOption', { line: spec.problems.join(' · ') }))
    : null;
  if (!query) {
    header.append(div('query-notice', t('empty')));
    if (problems) body.append(problems);
    return () => undefined;
  }

  const excludeHost = spec.self ? spec.self === 'exclude' : env.excludeHost;
  const terms = queryTerms(query);
  const client = env.client ?? queryClient;
  let shown = spec.limit ?? DEFAULT_PAGE;

  const options = () => ({
    queryKey: ['search', env.vaultId, 'block', query, spec.sort, shown, excludeHost] as const,
    queryFn: () => env.search(query, spec.sort, shown + (excludeHost ? 1 : 0)),
    retry: false,
    placeholderData: (prev: SearchResults | undefined) => prev,
  });
  const observer = new QueryObserver<SearchResults>(client, options());

  const openHit = (path: string, line: number, e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    env.open(path, line, e.metaKey || e.ctrlKey);
  };

  const paint = (): void => {
    const res = observer.getCurrentResult();
    header.replaceChildren();
    body.replaceChildren();
    if (problems) body.append(problems.cloneNode(true));
    if (res.isError) {
      const msg = res.error instanceof Error ? res.error.message : String(res.error);
      const err = div('query-error', msg);
      err.setAttribute('role', 'alert');
      body.append(err);
      return;
    }
    if (!res.data) {
      body.append(div('query-notice', t('searching')));
      return;
    }
    const all = excludeHost ? res.data.hits.filter((h) => h.path !== env.hostPath) : res.data.hits;
    const removed = res.data.hits.length - all.length;
    const total = Math.max(0, res.data.total - removed);
    const hits = all.slice(0, shown);

    const count = div('query-count', t('count', { count: total }));
    count.title = res.data.explain.join('\n');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'query-open';
    open.textContent = t('openInSearch');
    open.addEventListener('mousedown', (e) => e.stopPropagation());
    open.addEventListener('click', (e) => {
      e.preventDefault();
      env.openInSearch(query);
    });
    header.append(count, open);

    if (hits.length === 0) {
      body.append(div('query-notice', t('noResults')));
      return;
    }
    for (const h of hits) {
      const row = div('query-hit');
      const title = document.createElement('a');
      title.className = 'query-hit-title';
      title.href = '#';
      title.textContent = h.title;
      title.title = h.path;
      title.addEventListener('click', (e) => openHit(h.path, 0, e));
      row.append(title);
      const dir = h.path.includes('/') ? h.path.slice(0, h.path.lastIndexOf('/')) : '';
      if (dir) row.append(div('query-hit-path', dir));
      if (spec.context && h.snippet) {
        const snip = div('query-hit-snippet');
        if (h.line > 0) snip.append(`${h.line}: `);
        appendHighlighted(snip, h.snippet, terms);
        snip.addEventListener('click', (e) => openHit(h.path, h.line, e));
        row.append(snip);
      }
      body.append(row);
    }
    if (spec.limit === undefined && total > shown) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'query-more';
      more.textContent = t('showMore', { count: Math.min(DEFAULT_PAGE, total - shown) });
      more.addEventListener('mousedown', (e) => e.stopPropagation());
      more.addEventListener('click', (e) => {
        e.preventDefault();
        shown += DEFAULT_PAGE;
        observer.setOptions(options());
        paint();
      });
      body.append(more);
    } else if (spec.limit !== undefined && total > hits.length) {
      body.append(div('query-notice', t('limited', { shown: hits.length, count: total })));
    }
  };

  let wasConnected = false;
  let done = false;
  const dispose = (): void => {
    if (done) return;
    done = true;
    unsubscribe();
    disposers.delete(el);
  };
  const unsubscribe = observer.subscribe(() => {
    // The element was thrown away (document change, re-render): stop following the index.
    if (el.isConnected) wasConnected = true;
    else if (wasConnected) return dispose();
    paint();
  });
  disposers.set(el, dispose);
  paint();
  return dispose;
}
