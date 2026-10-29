// The body of a ```query block: search-panel syntax (§2.4) plus optional option
// lines. Option lines are recognised by their key only (`sort:`, `limit:`, `view:`,
// `context:`, `self:`); no search operator uses those names, so everything else is
// passed to the search engine untouched.
import type { SearchSort } from '../app/api';

export type QueryView = 'list' | 'cards';

export interface QuerySpec {
  /** The search query (option lines removed, remaining lines joined by a space). */
  query: string;
  sort: SearchSort;
  /** Hard cap given by the author; undefined = pages of DEFAULT_PAGE with "show more". */
  limit: number | undefined;
  view: QueryView;
  /** Show the matching line under each result. */
  context: boolean;
  /** include/exclude the note hosting the block; undefined = the user setting. */
  self: 'include' | 'exclude' | undefined;
  /** Option lines that could not be understood (shown as a notice, the block still runs). */
  problems: string[];
}

export const DEFAULT_PAGE = 100;
export const MAX_LIMIT = 500;

const OPTION = /^\s*(sort|limit|view|context|self)\s*:\s*(.*?)\s*$/i;
const SORTS: Record<string, SearchSort> = {
  relevance: 'relevance',
  name: 'name',
  title: 'name',
  modified: 'modified',
  date: 'modified',
};

export function parseQueryBlock(source: string): QuerySpec {
  const spec: QuerySpec = {
    query: '',
    sort: 'relevance',
    limit: undefined,
    view: 'list',
    context: true,
    self: undefined,
    problems: [],
  };
  const rest: string[] = [];
  for (const line of source.split('\n')) {
    const m = OPTION.exec(line);
    if (!m) {
      if (line.trim()) rest.push(line.trim());
      continue;
    }
    const key = (m[1] ?? '').toLowerCase();
    const value = (m[2] ?? '').toLowerCase();
    switch (key) {
      case 'sort': {
        const s = SORTS[value];
        if (s) spec.sort = s;
        else spec.problems.push(line.trim());
        break;
      }
      case 'limit': {
        const n = Number(value);
        if (/^\d+$/.test(value) && n > 0) spec.limit = Math.min(n, MAX_LIMIT);
        else spec.problems.push(line.trim());
        break;
      }
      case 'view':
        if (value === 'list' || value === 'cards') spec.view = value;
        else spec.problems.push(line.trim());
        break;
      case 'context':
        if (['true', 'yes', 'on', 'show'].includes(value)) spec.context = true;
        else if (['false', 'no', 'off', 'hide'].includes(value)) spec.context = false;
        else spec.problems.push(line.trim());
        break;
      case 'self':
        if (value === 'include' || value === 'exclude') spec.self = value;
        else spec.problems.push(line.trim());
        break;
    }
  }
  spec.query = rest.join(' ');
  return spec;
}
