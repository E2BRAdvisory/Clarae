import { useTranslation } from 'react-i18next';
import { BrandMark, Button, InlineError } from '@clarae/ui';
import { useAuth } from '../auth/AuthProvider';

/**
 * Where the identity provider sends the browser after a sign-out (`post_logout_redirect_uri`). A public
 * route, outside RequireAuth: nothing here signs in again by itself, so that signing out is visible.
 */
export function SignedOutPage() {
  const { t } = useTranslation();
  const { signIn, error } = useAuth();
  return (
    <main className="signed-out">
      <BrandMark size={56} />
      <h1 className="signed-out__title">{t('signedOut.title')}</h1>
      <p className="signed-out__body">{t('signedOut.body')}</p>
      {error && <InlineError>{t('app.signInFailed')}</InlineError>}
      <Button variant="primary" data-action="sign-in" onClick={() => signIn('/')}>
        {t('signedOut.signIn')}
      </Button>
    </main>
  );
}
