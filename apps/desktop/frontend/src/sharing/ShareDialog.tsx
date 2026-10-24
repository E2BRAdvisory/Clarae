// The "Share…" dialog (M4-WP4): who can see a folder or document of a connected vault, at what level.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  api,
  type DirectoryEntry,
  type GrantInput,
  type PermissionLevel,
  type ShareInfo,
} from '../app/api';
import { useSharing, type ShareTarget } from '../state/sharing';
import { dialog } from '../ui/dialogs';
import { sharingKeys, useVaultShares } from './queries';

const LEVELS: PermissionLevel[] = ['viewer', 'editor', 'manager'];

function LevelSelect({
  value,
  onChange,
  label,
}: {
  value: PermissionLevel;
  onChange: (v: PermissionLevel) => void;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as PermissionLevel)}
    >
      {LEVELS.map((l) => (
        <option key={l} value={l}>
          {t(`sharing.level_${l}`)}
        </option>
      ))}
    </select>
  );
}

/** Search box for users and groups; picking one calls onPick. */
function RecipientSearch({
  onPick,
  exclude,
}: {
  onPick: (e: DirectoryEntry) => void;
  exclude: Set<string>;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const { data = [] } = useQuery({
    queryKey: ['directory', q],
    queryFn: () => api.sharing.directory(q),
    enabled: q.trim().length >= 1,
    staleTime: 10_000,
  });
  const shown = data.filter((d) => !exclude.has(`${d.type}:${d.id}`));
  return (
    <div className="recipient-search">
      <input
        type="search"
        aria-label={t('sharing.searchPeople')}
        placeholder={t('sharing.searchPeople')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {q.trim() !== '' && (
        <ul className="pick-list" aria-label={t('sharing.searchResults')}>
          {shown.length === 0 && <li className="muted">{t('dialog.nothing')}</li>}
          {shown.map((d) => (
            <li key={`${d.type}:${d.id}`}>
              <button
                onClick={() => {
                  onPick(d);
                  setQ('');
                }}
              >
                {d.type === 'group' ? '👥 ' : '👤 '}
                {d.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ExistingShare({ share, vaultId }: { share: ShareInfo; vaultId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: sharingKeys.vault(vaultId) });
  const guard = async (p: Promise<unknown>) => {
    try {
      await p;
      await refresh();
    } catch (e) {
      await dialog.error(e);
    }
  };
  const [adding, setAdding] = useState<PermissionLevel>('editor');
  const have = new Set(share.grants.map((g) => `${g.principalType}:${g.principalId}`));
  return (
    <section className="existing-share" aria-label={share.displayName}>
      <header>
        <strong>{share.displayName}</strong>{' '}
        <span className="muted">
          {t(`sharing.type_${share.resourceType}`)}
          {share.pathPrefix ? ` · ${share.pathPrefix}` : ''}
        </span>
        <button
          className="danger"
          onClick={() =>
            void (async () => {
              if (
                await dialog.confirm(
                  t('sharing.revoke'),
                  t('sharing.confirmRevoke', { name: share.displayName }),
                  true,
                )
              )
                await guard(api.sharing.revoke(share.id));
            })()
          }
        >
          {t('sharing.revoke')}
        </button>
      </header>
      <ul className="grants">
        {share.grants.map((g) => (
          <li key={`${g.principalType}:${g.principalId}`}>
            <span>
              {g.principalType === 'group' ? '👥 ' : '👤 '}
              {g.principalName}
            </span>
            <span className={`badge status-${g.status}`}>{t(`sharing.status_${g.status}`)}</span>
            <LevelSelect
              label={t('sharing.levelOf', { name: g.principalName })}
              value={g.permission}
              onChange={(l) =>
                void guard(api.sharing.setGrant(share.id, g.principalType, g.principalId, l))
              }
            />
            <button
              className="icon"
              aria-label={t('sharing.removeRecipient', { name: g.principalName })}
              title={t('sharing.removeRecipient', { name: g.principalName })}
              onClick={() =>
                void guard(api.sharing.removeGrant(share.id, g.principalType, g.principalId))
              }
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="row">
        <LevelSelect label={t('sharing.newRecipientLevel')} value={adding} onChange={setAdding} />
        <RecipientSearch
          exclude={have}
          onPick={(d) => void guard(api.sharing.setGrant(share.id, d.type, d.id, adding))}
        />
      </div>
    </section>
  );
}

function NewShare({
  vaultId,
  target,
  onDone,
}: {
  vaultId: string;
  target: ShareTarget;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const base = target.path.split('/').pop() ?? '';
  const [name, setName] = useState(base || t('sharing.wholeVault'));
  const [level, setLevel] = useState<PermissionLevel>('editor');
  const [picked, setPicked] = useState<DirectoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const grants: GrantInput[] = picked.map((p) => ({
        principalType: p.type,
        principalId: p.id,
        permission: level,
      }));
      await api.sharing.create(vaultId, target.path, target.isDir, name.trim(), grants);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="new-share" aria-label={t('sharing.newShare')}>
      <h3>{t('sharing.newShare')}</h3>
      <div className="row">
        <label htmlFor="share-name">{t('sharing.name')}</label>
        <input id="share-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="row">
        <label>{t('sharing.level')}</label>
        <LevelSelect label={t('sharing.level')} value={level} onChange={setLevel} />
      </div>
      <RecipientSearch
        exclude={new Set(picked.map((p) => `${p.type}:${p.id}`))}
        onPick={(d) => setPicked((prev) => [...prev, d])}
      />
      <ul className="grants" aria-label={t('sharing.recipients')}>
        {picked.map((p) => (
          <li key={`${p.type}:${p.id}`}>
            <span>
              {p.type === 'group' ? '👥 ' : '👤 '}
              {p.label}
            </span>
            <button
              className="icon"
              aria-label={t('sharing.removeRecipient', { name: p.name })}
              onClick={() => setPicked((prev) => prev.filter((x) => x !== p))}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="actions">
        <button
          className="primary"
          disabled={busy || name.trim() === ''}
          onClick={() => void create()}
        >
          {t('sharing.create')}
        </button>
      </div>
    </section>
  );
}

export function ShareDialog({ vaultId, target }: { vaultId: string; target: ShareTarget }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const close = () => useSharing.getState().closeShare();
  const { data: shares = [], isLoading } = useVaultShares(vaultId);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const label = target.path || t('sharing.wholeVault');
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal wizard share-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('sharing.shareTitle', { name: label })}
      >
        <h2>{t('sharing.shareTitle', { name: label })}</h2>
        <NewShare
          vaultId={vaultId}
          target={target}
          onDone={() => void qc.invalidateQueries({ queryKey: sharingKeys.vault(vaultId) })}
        />
        <h3>{t('sharing.existing')}</h3>
        {isLoading && <p className="muted">…</p>}
        {!isLoading && shares.length === 0 && <p className="muted">{t('sharing.noShares')}</p>}
        {shares.map((s) => (
          <ExistingShare key={s.id} share={s} vaultId={vaultId} />
        ))}
        <div className="actions">
          <button onClick={close}>{t('sharing.close')}</button>
        </div>
      </div>
    </div>
  );
}
