// The files this device does not send to the cloud, with the reason (ADR-0066 §9): a block of
// Settings › Sync. The list comes from the core (SyncAPI.Unsent) and is read again when the number of
// unsent files or the time of the last sync changes (the sync:status event carries both).
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type UnsentItem } from '../app/api';
import { useSync } from '../state/sync';
import { ActionButton } from '../ui/ActionButton';
import { errorMessage } from '../util/errors';

/** The items grouped by reason, in the order the core gives them (grouped already, then by path). */
function byReason(items: UnsentItem[]): [string, UnsentItem[]][] {
  const groups = new Map<string, UnsentItem[]>();
  for (const it of items) {
    const g = groups.get(it.reason);
    if (g) g.push(it);
    else groups.set(it.reason, [it]);
  }
  return [...groups];
}

/** The full path (with its extension: a technical list, ADR-0063 does not apply); a folder ends in /. */
const shownPath = (it: UnsentItem) => (it.isDir ? `${it.path}/` : it.path);

function detailOf(it: UnsentItem): string {
  if (it.code && it.detail) return `${it.code}: ${it.detail}`;
  return it.code || it.detail;
}

function Item({ vaultId, item }: { vaultId: string; item: UnsentItem }) {
  const { t } = useTranslation();
  const detail = detailOf(item);
  return (
    <li className="row">
      <span>
        <code>{shownPath(item)}</code>
        {detail && <span className="muted small"> · {detail}</span>}
      </span>
      {item.retryable && (
        // The file in the button's name, so that a screen reader tells one «Retry» from the next.
        <ActionButton
          id="sync:retry-unsent"
          arg={{ vaultId, paths: [item.path] }}
          ariaLabel={t('sync.unsent.retryFile', { path: shownPath(item) })}
        />
      )}
    </li>
  );
}

export function SyncUnsent({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const count = useSync((s) => s.status[vaultId]?.unsent ?? 0);
  const lastSync = useSync((s) => s.status[vaultId]?.lastSync ?? '');
  const [items, setItems] = useState<UnsentItem[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api.sync.unsent(vaultId).then(
      (list) => {
        if (!live) return;
        setItems(list);
        setError('');
      },
      (e: unknown) => {
        if (live) setError(errorMessage(e));
      },
    );
    return () => {
      live = false;
    };
  }, [vaultId, count, lastSync]);

  const pending = (items ?? []).filter((it) => !it.info);
  const excluded = (items ?? []).filter((it) => it.info);
  const anyRetryable = pending.some((it) => it.retryable);

  return (
    <section className="sync-unsent" aria-labelledby="sync-unsent-title">
      <h3 id="sync-unsent-title">{t('sync.unsent.title')}</h3>
      {error && (
        <div className="error small" role="alert">
          {error}
        </div>
      )}
      {/* Always mounted, so that its text is announced when the list empties. */}
      <p className="muted small" role="status">
        {items !== null && pending.length === 0 ? t('sync.unsent.empty') : ''}
      </p>
      {byReason(pending).map(([reason, group]) => (
        <div key={reason} className="unsent-group">
          <h4>
            {t(`sync.unsent.reason_${reason}`, { defaultValue: reason })} ({group.length})
          </h4>
          <ul className="unsent-list">
            {group.map((it) => (
              <Item key={it.path} vaultId={vaultId} item={it} />
            ))}
          </ul>
        </div>
      ))}
      {anyRetryable && (
        <div className="actions left">
          <ActionButton id="sync:retry-unsent" arg={{ vaultId, paths: [] }} />
        </div>
      )}
      {excluded.length > 0 && (
        <details>
          <summary>{t('sync.unsent.excludedTitle', { count: excluded.length })}</summary>
          <ul className="unsent-list">
            {excluded.map((it) => (
              <li key={it.path} className="row">
                <code>{shownPath(it)}</code>
                <span className="muted small">{t(`sync.unsent.reason_${it.reason}`)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="muted small">{t('sync.unsent.hint')}</p>
    </section>
  );
}
