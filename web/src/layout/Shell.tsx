import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useTranslation } from 'react-i18next';
import { BrandMark, Button } from '@clarae/ui';
import { useSharingAllowed } from '../api/cloud';
import { useAdminAccess } from '../api/queries';
import { useAuth } from '../auth/AuthProvider';
import { setLanguage, supportedLanguages, isLanguage } from '../i18n';
import { applyTheme, loadTheme, type Theme } from './theme';
import { useForgetBrowser } from './ForgetBrowser';

/**
 * The frame of the console. Its actions that call no REST operation carry `data-action`: the feature
 * registry cites each of them (shared/parity/features.yaml, `console.actions`; ADR-0045 §4).
 */
export function Shell() {
  const { t, i18n } = useTranslation();
  const { user, signOut } = useAuth();
  const { isAdmin } = useAdminAccess();
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const lang = isLanguage(i18n.language) ? i18n.language : 'en';
  const sharingOn = useSharingAllowed();
  // A shared computer must not keep a clear-text copy of the vaults opened in the browser: signing out
  // removes them, after asking when one holds changes that were not uploaded.
  const forget = useForgetBrowser({
    subject: user?.sub,
    confirmLabel: t('forget.confirmSignOut'),
    onDone: signOut,
    // An unexpected failure must not keep the user signed in on a shared computer.
    onError: signOut,
  });

  return (
    <div className="app">
      <a className="app__skip" href="#main">
        {t('shell.skip')}
      </a>
      <header className="app__header">
        <strong className="app__brand">
          <BrandMark size={24} />
          {t('app.name')}
        </strong>
        <nav aria-label={t('nav.main')} className="app__nav">
          <NavLink to="/usage">{t('nav.usage')}</NavLink>
          <NavLink to="/vaults">{t('nav.vaults')}</NavLink>
          <NavLink to="/devices">{t('nav.devices')}</NavLink>
          {sharingOn && <NavLink to="/shares">{t('nav.shares')}</NavLink>}
          <NavLink to="/account">{t('nav.account')}</NavLink>
          {isAdmin && <NavLink to="/admin">{t('nav.admin')}</NavLink>}
        </nav>
        <div className="app__tools">
          <label className="app__tool">
            <span className="nd-visually-hidden">{t('shell.language')}</span>
            <select
              className="nd-select"
              data-action="language"
              value={lang}
              onChange={(e) =>
                void setLanguage(e.target.value as (typeof supportedLanguages)[number])
              }
            >
              {supportedLanguages.map((l) => (
                <option key={l} value={l}>
                  {l.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <label className="app__tool">
            <span className="nd-visually-hidden">{t('shell.theme')}</span>
            <select
              className="nd-select"
              data-action="theme"
              value={theme}
              onChange={(e) => {
                const next = e.target.value as Theme;
                setTheme(next);
                applyTheme(next);
              }}
            >
              <option value="auto">{t('shell.themeAuto')}</option>
              <option value="light">{t('shell.themeLight')}</option>
              <option value="dark">{t('shell.themeDark')}</option>
            </select>
          </label>
          <span className="app__user">{user?.name}</span>
          <Button small data-action="sign-out" onClick={forget.start} disabled={forget.working}>
            {t('shell.signOut')}
          </Button>
        </div>
      </header>
      {forget.dialogs}
      <main id="main" className="app__main">
        <Outlet />
      </main>
    </div>
  );
}
