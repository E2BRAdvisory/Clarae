// The tab of an application (M18, track E): a `.webapp` file shown as the page it points at.
//
// Where the host has an embedded browser (the capability `embeddedBrowser`, which the core answers,
// and the flag `web_viewer` of the profile) the page runs in a native view that the shell places above
// this tab (nativeViews.ts): the tab itself shows a bar (back, forward, reload, the address as text,
// edit, open in the browser) and an empty "stage" that gives the view its rectangle. Everywhere else
// (the browser, Windows, Linux, the flag off, a core that says it cannot) the tab is a card with the
// button that opens the page in the system's browser, or in a tab of the browser on the web. Nothing
// is ever loaded in an iframe: the page of the application is not allowed to be part of this one.
//
// Nothing the page says is believed. Its address, title and messages arrive as text and are shown as
// text; an address is followed only through openExternal, after checkWebappUrl.
import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Feature } from '@clarae/api-client/features';
import { runCommand } from '../commands/registry';
import { featureOn, useManaged } from '../state/managed';
import { useAppStore } from '../state/store';
import { infoOf, useSync } from '../state/sync';
import { Icon } from '../shell/icons';
import { useCan } from '../platform';
import { errorCodeOf, errorMessage } from '../util/errors';
import { openExternal } from '../util/external';
import type { Pane, Tab } from '../workspace/layout';
import { useWebappFile } from './files';
import { checkWebappUrl, nameOf } from './model';
import { nativeViews, useViewState, type ViewNotice } from './nativeViews';
import { confirmOrigin, useOriginConfirmed } from './origins';

interface Props {
  vaultId: string;
  pane: Pane;
  tab: Tab;
}

/** Page text that is shown, never longer than a line of the interface can use. */
const clip = (text: string, max = 160): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function BrowserView({ vaultId, pane, tab }: Props) {
  const { t } = useTranslation();
  const file = useWebappFile(vaultId, tab.path);
  const flag = featureOn(
    useManaged((s) => s.features),
    Feature.WebViewer,
  );
  const hasDriver = useCan('embeddedBrowser');
  const name = nameOf(tab.path);

  if (file.status === 'loading') return <div className="note-loading muted">…</div>;
  if (file.status === 'error')
    return (
      <div className="note-error" role="alert">
        {errorMessage(file.error)}
      </div>
    );
  if (!file.parse.ok)
    return (
      <AppCard name={name} title={t('webapp.invalid.title')} icon="warning" alert>
        <p>{t(`webapp.invalid.${file.parse.reason}`)}</p>
        <EditButton vaultId={vaultId} />
      </AppCard>
    );
  const { url, origin } = file.parse;

  // No embedded browser here, or the profile turns it off: the page opens outside.
  if (!hasDriver || !flag)
    return (
      <AppCard name={name} url={url}>
        <p className="muted">{t(hasDriver ? 'webapp.card.off' : 'webapp.card.unavailable')}</p>
        <OpenInBrowser url={url} primary />
      </AppCard>
    );
  return <Embedded vaultId={vaultId} pane={pane} tab={tab} name={name} url={url} origin={origin} />;
}

// ---- cards ----------------------------------------------------------------------------------------

function AppCard({
  name,
  url,
  title,
  icon = 'webapp',
  alert = false,
  children,
}: {
  name: string;
  url?: string;
  title?: string;
  icon?: 'webapp' | 'warning';
  alert?: boolean;
  children: React.ReactNode;
}) {
  // one card per pane: the id is the card's own
  const heading = useId();
  return (
    <div className="browser-view card-only">
      <div className="app-card" role={alert ? 'alert' : 'group'} aria-labelledby={heading}>
        <Icon name={icon} size={32} />
        <h2 id={heading}>{title ?? name}</h2>
        {title && <p className="app-name">{name}</p>}
        {url && <p className="app-url">{url}</p>}
        {children}
      </div>
    </div>
  );
}

function OpenInBrowser({ url, primary = false }: { url: string; primary?: boolean }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={primary ? 'primary' : undefined}
      onClick={() => {
        // Only an address an application may open leaves the app, from a file or from a page.
        if (checkWebappUrl(url).ok) openExternal(url);
      }}
    >
      {t('webapp.openInBrowser')}
    </button>
  );
}

function EditButton({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const readOnly = useSync((s) => infoOf(s, vaultId).readOnly);
  const flag = featureOn(
    useManaged((s) => s.features),
    Feature.WebViewer,
  );
  // the command exists only with the flag of the profile: without it the button would do nothing
  if (!flag) return null;
  if (readOnly) return <p className="muted">{t('webapp.readOnly')}</p>;
  return (
    <button type="button" onClick={() => void runCommand('app:edit-url')}>
      {t('webapp.edit')}
    </button>
  );
}

// ---- the application with its browser -----------------------------------------------------------

function Embedded({
  vaultId,
  pane,
  tab,
  name,
  url,
  origin,
}: Props & { name: string; url: string; origin: string }) {
  const { t } = useTranslation();
  const confirmed = useOriginConfirmed(vaultId, origin);
  if (confirmed) return <Live vaultId={vaultId} pane={pane} tab={tab} name={name} url={url} />;
  // The first time this address would open on this device: the file may have come from the sync,
  // or from another user of a shared vault.
  return (
    <AppCard name={name} url={url} title={t('webapp.confirm.title', { origin })}>
      <p>{t('webapp.confirm.message')}</p>
      <div className="actions">
        <OpenInBrowser url={url} />
        <button type="button" className="primary" onClick={() => confirmOrigin(vaultId, origin)}>
          {t('webapp.confirm.open')}
        </button>
      </div>
    </AppCard>
  );
}

function Live({ vaultId, pane, tab, name, url }: Props & { name: string; url: string }) {
  const { t } = useTranslation();
  const stage = useRef<HTMLDivElement>(null);
  const state = useViewState(tab.id);
  const focused = useAppStore((s) => s.layout.activePane === pane.id);
  const focusedNow = useRef(focused);
  useEffect(() => {
    focusedNow.current = focused;
  }, [focused]);
  const readOnly = useSync((s) => infoOf(s, vaultId).readOnly);

  // The view follows the stage while the tab shows it; hiding the tab only hides the view.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    return nativeViews.attach({
      tabId: tab.id,
      vaultId,
      url,
      stage: el,
      paneFocused: focusedNow.current,
    });
  }, [tab.id, vaultId, url]);
  useEffect(() => nativeViews.setPaneFocused(tab.id, focused), [tab.id, focused]);
  // The vault was locked and is unlocked again: the application that ended with the lock opens again.
  const locked = useSync((s) => infoOf(s, vaultId).locked);
  const wasLocked = useRef(locked);
  useEffect(() => {
    if (wasLocked.current && !locked) nativeViews.resumeAfterUnlock(tab.id);
    wasLocked.current = locked;
  }, [locked, tab.id]);

  const code = state?.phase === 'failed' ? errorCodeOf(state.error) : '';
  // the core cannot do it here after all: the page opens outside, as where there is no driver
  if (code === 'webview-unavailable' || code === 'webview-disabled')
    return (
      <AppCard name={name} url={url}>
        <p className="muted">
          {t(code === 'webview-disabled' ? 'webapp.card.off' : 'webapp.card.unavailable')}
        </p>
        <OpenInBrowser url={url} primary />
      </AppCard>
    );

  const page = state?.page;
  const shown = page?.url || url;
  const open = state?.phase === 'open';
  const here = checkWebappUrl(shown).ok ? shown : url;
  const tabId = tab.id;
  return (
    <div className="browser-view" data-phase={state?.phase ?? 'pending'}>
      <div className="browser-bar" role="toolbar" aria-label={t('webapp.bar')}>
        <button
          type="button"
          className="icon"
          title={t('webapp.back')}
          aria-label={t('webapp.back')}
          disabled={!open || !page?.canGoBack}
          onClick={() => nativeViews.back(tabId)}
        >
          <Icon name="back" />
        </button>
        <button
          type="button"
          className="icon"
          title={t('webapp.forward')}
          aria-label={t('webapp.forward')}
          disabled={!open || !page?.canGoForward}
          onClick={() => nativeViews.forward(tabId)}
        >
          <Icon name="forward" />
        </button>
        <button
          type="button"
          className="icon"
          title={t('webapp.reload')}
          aria-label={t('webapp.reload')}
          disabled={!open}
          onClick={() => nativeViews.reload(tabId)}
        >
          <Icon name="refresh" />
        </button>
        {/* The address is shown as text, not typed: the file is where it is written, and a second way
            to go anywhere would skip the confirmation of the origin. "Edit address" changes the file. */}
        <span className="browser-url" title={shown}>
          {shown}
        </span>
        {page?.loading && (
          <span className="browser-loading" role="status">
            {t('webapp.loading')}
          </span>
        )}
        {!readOnly && (
          <button
            type="button"
            className="icon"
            title={t('webapp.edit')}
            aria-label={t('webapp.edit')}
            onClick={() => void runCommand('app:edit-url')}
          >
            <Icon name="edit" />
          </button>
        )}
        <button
          type="button"
          className="icon"
          title={t('webapp.openInBrowser')}
          aria-label={t('webapp.openInBrowser')}
          onClick={() => {
            if (checkWebappUrl(here).ok) openExternal(here);
          }}
        >
          <Icon name="openInBrowser" />
        </button>
      </div>
      {state && state.notices.length > 0 && (
        <ul className="browser-notices" aria-label={t('webapp.notices')} aria-live="polite">
          {state.notices.map((n) => (
            <li key={n.id}>
              <span>{noticeText(n, t)}</span>
              <button
                type="button"
                className="icon"
                title={t('common.close')}
                aria-label={t('common.close')}
                onClick={() => nativeViews.dismissNotice(tabId, n.id)}
              >
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div
        className="browser-stage"
        ref={stage}
        aria-busy={page?.loading ? true : undefined}
        data-phase={state?.phase ?? 'pending'}
        data-hidden={state?.hidden ?? true}
      >
        <StageCard tabId={tabId} name={name} url={url} locked={locked} />
      </div>
    </div>
  );
}

/** The reasons of webview:closed the cards have a sentence for; `gone` is a view the core no longer knows. */
const CLOSED_REASONS = ['vault-closed', 'vault-locked', 'data-cleared', 'disabled', 'quit', 'gone'];

/** What covers the stage when the page is not what shows there: an error, an end, a wait. */
function StageCard({
  tabId,
  name,
  url,
  locked,
}: {
  tabId: string;
  name: string;
  url: string;
  locked: boolean;
}) {
  const { t } = useTranslation();
  const state = useViewState(tabId);
  if (!state) return null;
  const retry = (
    <button type="button" className="primary" onClick={() => nativeViews.reload(tabId)}>
      {t('webapp.retry')}
    </button>
  );
  const outside = <OpenInBrowser url={url} />;

  if (state.crashed)
    return (
      <div className="app-card" role="alert">
        <Icon name="warning" size={32} />
        <h2>{t('webapp.crashed.title')}</h2>
        <p className="muted">{t('webapp.crashed.message')}</p>
        <div className="actions">
          {outside}
          {retry}
        </div>
      </div>
    );
  if (state.loadError) {
    const certificate = state.loadError.certificate;
    return (
      <div className="app-card" role="alert">
        <Icon name="warning" size={32} />
        <h2>{t(certificate ? 'webapp.certificate.title' : 'webapp.loadError.title')}</h2>
        <p className="muted">
          {t(certificate ? 'webapp.certificate.message' : 'webapp.loadError.message')}
        </p>
        {state.loadError.message && <p className="app-detail">{clip(state.loadError.message)}</p>}
        <div className="actions">
          {outside}
          {/* A refused certificate has no way around it: retrying is all there is. */}
          {retry}
        </div>
      </div>
    );
  }
  if (state.phase === 'closed') {
    const reason = CLOSED_REASONS.includes(state.reason) ? state.reason : 'gone';
    return (
      <div className="app-card" role="status">
        <Icon name="webapp" size={32} />
        <h2>{name}</h2>
        <p className="muted">{t(`webapp.closed.${reason}`)}</p>
        <div className="actions">
          {outside}
          {/* A locked vault cannot open a page: the lock ends and the application opens by itself. */}
          {!locked && (
            <button type="button" className="primary" onClick={() => nativeViews.reopen(tabId)}>
              {t('webapp.reopen')}
            </button>
          )}
        </div>
      </div>
    );
  }
  if (state.phase === 'failed') {
    const code = errorCodeOf(state.error);
    return (
      <div className="app-card" role="alert">
        <Icon name="warning" size={32} />
        <h2>{t(code === 'webview-limit' ? 'webapp.limit.title' : 'webapp.failed.title')}</h2>
        <p className="muted">{errorMessage(new Error(state.error))}</p>
        <div className="actions">
          {outside}
          <button type="button" className="primary" onClick={() => nativeViews.reopen(tabId)}>
            {t('webapp.retry')}
          </button>
        </div>
      </div>
    );
  }
  if (state.phase === 'opening')
    return (
      <p className="app-waiting muted" role="status">
        {t('webapp.loading')}
      </p>
    );
  return null;
}

function noticeText(n: ViewNotice, t: TFunction): string {
  switch (n.kind) {
    case 'blocked':
      return t('webapp.notice.blocked', { url: clip(n.url) });
    case 'new-window':
      return t(n.opened ? 'webapp.notice.newWindowOpened' : 'webapp.notice.newWindowBlocked', {
        url: clip(n.url),
      });
    case 'download':
      return t('webapp.notice.download', { url: clip(n.url) });
    case 'permission':
      return t('webapp.notice.permission', {
        permission: clip(n.permission, 40),
        origin: clip(n.origin, 80),
      });
  }
}
