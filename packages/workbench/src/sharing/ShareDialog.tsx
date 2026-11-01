// The "Share…" dialog (M4-WP4): who can see a folder or document of a connected vault, at what level.
// The new share's target comes from the explorer (a folder or a document of the open vault, which
// the core resolves); the people are picked and the existing shares edited with the components of
// @memobrain/cloud-features (ADR-0037 §2), the same as Settings > Sharing and the console.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DirectorySearch,
  SharesManager,
  cloudKeys,
  createT,
  type DirectoryEntry,
} from '@memobrain/cloud-features';
import '@memobrain/cloud-features/workbench.css';
import { api, type GrantInput, type PermissionLevel } from '../app/api';
import { CoreCloudPort } from '../cloud/CoreCloudPort';
import { useSharing, type ShareTarget } from '../state/sharing';
import { infoOf, useSync } from '../state/sync';
import { sharingKeys } from './queries';
import { Icon } from '../shell/icons';

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

interface Picked {
  entry: DirectoryEntry;
  permission: PermissionLevel;
}

function NewShare({
  port,
  vaultId,
  target,
  onDone,
}: {
  port: CoreCloudPort;
  vaultId: string;
  target: ShareTarget;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation();
  const ct = useMemo(() => createT(i18n.language), [i18n.language]);
  const base = target.path.split('/').pop() ?? '';
  const [name, setName] = useState(base || t('sharing.wholeVault'));
  const [picked, setPicked] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const keyOf = (e: DirectoryEntry) => `${e.type}:${e.id}`;
  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const grants: GrantInput[] = picked.map((p) => ({
        principalType: p.entry.type,
        principalId: p.entry.id,
        permission: p.permission,
      }));
      await api.sharing.create(vaultId, target.path, target.isDir, name.trim(), grants);
      setPicked([]);
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
      <div className="mbcf">
        <DirectorySearch
          port={port}
          t={ct}
          exclude={new Set(picked.map((p) => keyOf(p.entry)))}
          defaultPermission="editor"
          onPick={(entry, permission) => setPicked((prev) => [...prev, { entry, permission }])}
        />
      </div>
      <ul className="grants" aria-label={t('sharing.recipients')}>
        {picked.map((p) => (
          <li key={keyOf(p.entry)}>
            <span>
              <Icon name={p.entry.type === 'group' ? 'group' : 'user'} size={14} /> {p.entry.name}
            </span>
            <LevelSelect
              label={t('sharing.levelOf', { name: p.entry.name })}
              value={p.permission}
              onChange={(permission) =>
                setPicked((prev) => prev.map((x) => (x === p ? { ...x, permission } : x)))
              }
            />
            <button
              className="icon"
              aria-label={t('sharing.removeRecipient', { name: p.entry.name })}
              onClick={() => setPicked((prev) => prev.filter((x) => x !== p))}
            >
              <Icon name="close" size={16} />
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
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const port = useMemo(() => new CoreCloudPort(), []);
  const cloudVaultId = useSync((s) => infoOf(s, vaultId).cloudVaultId);
  const close = () => useSharing.getState().closeShare();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: cloudKeys.shares(port) });
    void qc.invalidateQueries({ queryKey: sharingKeys.vault(vaultId) });
  };
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
        <NewShare port={port} vaultId={vaultId} target={target} onDone={refresh} />
        <h3>{t('sharing.existing')}</h3>
        {cloudVaultId ? (
          <SharesManager
            port={port}
            lang={i18n.language}
            vaultId={cloudVaultId}
            canCreate={false}
            onChanged={refresh}
          />
        ) : (
          <p className="muted">{t('sharing.noShares')}</p>
        )}
        <div className="actions">
          <button onClick={close}>{t('sharing.close')}</button>
        </div>
      </div>
    </div>
  );
}
