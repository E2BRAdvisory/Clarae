import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button, InlineError } from '@memobrain/ui';
import { useAuth } from '../auth/AuthProvider';

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
      .then((to) => void navigate(to, { replace: true }))
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
