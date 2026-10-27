import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@memobrain/ui/styles.css';
import './app.css';
import { App } from './App';
import { createOidcAuth } from './auth/oidc';
import type { AuthService } from './auth/types';
import { applyTheme, loadTheme } from './layout/theme';
import { initI18n } from './i18n';

async function start() {
  const i18n = initI18n();
  document.documentElement.lang = i18n.language;
  applyTheme(loadTheme());

  let auth: AuthService;
  // `import.meta.env.VITE_E2E` is a build-time constant: in production this branch and
  // the e2e module are removed from the bundle.
  if (import.meta.env.VITE_E2E) {
    auth = (await import('./auth/e2e')).createE2EAuth();
  } else {
    auth = createOidcAuth();
  }
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <App auth={auth} />
    </StrictMode>,
  );
}

void start();
