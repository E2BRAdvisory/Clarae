import { NavLink, Outlet } from 'react-router';
import { useTranslation } from 'react-i18next';

const SECTIONS = ['storage', 'limits', 'users', 'groups', 'config', 'audit'] as const;

/** Frame of the administration console: sub-navigation plus the nested page. */
export function AdminLayout() {
  const { t } = useTranslation();
  return (
    <>
      <h1>{t('admin.title')}</h1>
      <div className="admin-layout">
        <nav aria-label={t('admin.nav')} className="admin-nav">
          {SECTIONS.map((s) => (
            <NavLink key={s} to={`/admin/${s}`}>
              {t(`admin.sections.${s}`)}
            </NavLink>
          ))}
        </nav>
        <div className="admin-body">
          <Outlet />
        </div>
      </div>
    </>
  );
}
