import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@memobrain/ui';
import { useAuth } from '../auth/AuthProvider';
import { setLanguage, supportedLanguages, isLanguage } from '../i18n';
import { applyTheme, loadTheme, type Theme } from './theme';

export function Shell() {
  const { t, i18n } = useTranslation();
  const { user, isAdmin, signOut } = useAuth();
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const lang = isLanguage(i18n.language) ? i18n.language : 'en';

  return (
    <div className="app">
      <a className="app__skip" href="#main">
        {t('shell.skip')}
      </a>
      <header className="app__header">
        <strong className="app__brand">{t('app.name')}</strong>
        <nav aria-label={t('nav.main')} className="app__nav">
          <NavLink to="/usage">{t('nav.usage')}</NavLink>
          <NavLink to="/vaults">{t('nav.vaults')}</NavLink>
          <NavLink to="/devices">{t('nav.devices')}</NavLink>
          <NavLink to="/shares">{t('nav.shares')}</NavLink>
          <NavLink to="/account">{t('nav.account')}</NavLink>
          {isAdmin && <NavLink to="/admin">{t('nav.admin')}</NavLink>}
        </nav>
        <div className="app__tools">
          <label className="app__tool">
            <span className="nd-visually-hidden">{t('shell.language')}</span>
            <select
              className="nd-select"
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
          <Button small onClick={signOut}>
            {t('shell.signOut')}
          </Button>
        </div>
      </header>
      <main id="main" className="app__main">
        <Outlet />
      </main>
    </div>
  );
}
