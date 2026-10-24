import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SearchSort } from '../app/api';
import { useAppStore } from '../state/store';
import { useSearch } from '../state/queries';

export function SearchPanel({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SearchSort>('relevance');
  const { data, error, isFetched } = useSearch(vaultId, q, sort);
  const openNote = useAppStore((s) => s.openNote);
  const hits = data?.hits ?? [];
  const parseError = error instanceof Error ? error.message : error ? String(error) : '';

  return (
    <div className="search">
      <input
        type="search"
        placeholder={t('search.placeholder')}
        aria-label={t('search.placeholder')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
      />
      <div className="row">
        <select
          aria-label={t('search.sort')}
          value={sort}
          onChange={(e) => setSort(e.target.value as SearchSort)}
        >
          <option value="relevance">{t('search.sortRelevance')}</option>
          <option value="name">{t('search.sortName')}</option>
          <option value="modified">{t('search.sortModified')}</option>
        </select>
        {data && (
          <span className="muted" title={data.explain.join('\n')}>
            {t('search.count', { count: data.total })}
          </span>
        )}
      </div>
      {parseError && (
        <div className="snippet" role="alert" style={{ color: 'var(--danger)' }}>
          {parseError}
        </div>
      )}
      <div>
        {hits.map((h) => (
          <div key={h.path} className="hit" onClick={() => openNote(h.path)} title={h.path}>
            <div className="title">{h.title}</div>
            {h.snippet && (
              <div className="snippet">
                {h.line > 0 ? `${h.line}: ` : ''}
                {h.snippet}
              </div>
            )}
          </div>
        ))}
        {isFetched && !parseError && hits.length === 0 && q.trim() && (
          <div className="snippet">{t('search.noResults')}</div>
        )}
      </div>
    </div>
  );
}
