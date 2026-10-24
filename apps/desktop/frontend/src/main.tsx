import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import 'katex/dist/katex.min.css';
import { App } from './app/App';
import { initI18n } from './i18n';
import { queryClient } from './state/queryClient';
import './style.css';

initI18n();

const container = document.getElementById('root');
if (!container) {
  throw new Error('missing #root element');
}

async function start(root: HTMLElement): Promise<void> {
  // Playwright runs the UI in a plain browser: swap the Wails bindings for the in-memory mock.
  if (import.meta.env.VITE_E2E) {
    const { installWailsMock } = await import('./test/wails-mock');
    (window as unknown as { __mock: unknown }).__mock = installWailsMock();
  }
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void start(container);
