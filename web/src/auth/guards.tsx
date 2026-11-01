import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button, EmptyState } from '@memobrain/ui';
import { useAuth } from './AuthProvider';

/** Routes below this one need a signed-in user; anonymous visitors are sent to sign in. */
export function RequireAuth() {
  const { t } = useTranslation();
  const { status, user, error, retry, signIn } = useAuth();
  const loc = useLocation();
  const needsLogin = status === 'ready' && !user && !error;

  useEffect(() => {
    if (needsLogin) signIn(`${loc.pathname}${loc.search}`);
  }, [needsLogin, signIn, loc.pathname, loc.search]);

  if (status === 'loading') return <p role="status">{t('app.loading')}</p>;
  if (error && !user)
    return (
      <div role="alert">
        <p>{t('app.signInFailed')}</p>
        <Button onClick={retry}>{t('common.retry')}</Button>
      </div>
    );
  if (!user) return <p role="status">{t('app.redirecting')}</p>;
  return <Outlet />;
}

/** Routes below this one need a realm role; others see a "not allowed" page. */
export function RequireRole({ role }: { role: string }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  if (!user?.roles.includes(role)) {
    return <EmptyState title={t('forbidden.title')}>{t('forbidden.body')}</EmptyState>;
  }
  return <Outlet />;
}
