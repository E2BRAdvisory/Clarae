import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button, InlineError } from '@clarae/ui';
import { useAuth } from '../auth/AuthProvider';
import { isWorkbenchReturn } from '../shared/routes';

/** Target of the OIDC redirect: exchanges the code, then returns to where the user came from. */
export function CallbackPage() {
  const { t } = useTranslation();
  const { completeSignIn, signIn } = useAuth();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    // The code is single use: guard against React's double effect in development.
    if (started.current) return;
    started.current = true;
    completeSignIn()
      .then((to) => {
        // The workbench is a page of its own (not a route of this app): load it, do not navigate to it.
        if (isWorkbenchReturn(to)) window.location.replace(to);
        else void navigate(to, { replace: true });
      })
      .catch(() => setFailed(true));
  }, [completeSignIn, navigate]);

  if (failed) {
    return (
      <div>
        <InlineError>{t('auth.callbackFailed')}</InlineError>
        <Button variant="primary" onClick={() => signIn('/')}>
          {t('auth.backToStart')}
        </Button>
      </div>
    );
  }
  return <p role="status">{t('app.loading')}</p>;
}
