import { mountWorkbench } from '@memobrain/workbench';

// The whole UI lives in @memobrain/workbench (shared with the Web UI, ADR-0029); the desktop only
// decides where it is mounted, and gives it the Wails v3 backend first (wailsHost.ts). The runtime is
// a dynamic import, outside the initial bundle (ADR-0020). Playwright builds (MEMOBRAIN_E2E) leave
// both out: mountWorkbench installs the in-memory mock of the bindings instead.
const container = document.getElementById('root');
if (!container) {
  throw new Error('missing #root element');
}
const root = container;

/** The bridge to the Go core is down, before the UI (and its translations) exist: the only text outside i18n. */
function showFatal(error: unknown): void {
  console.error('memobrain: cannot reach the Go core:', error);
  const italian = navigator.language.toLowerCase().startsWith('it');
  const note = document.createElement('p');
  note.setAttribute('role', 'alert');
  note.textContent = italian
    ? 'Impossibile avviare MemoBrain Notes: il motore non risponde. Chiudi e riapri l’app.'
    : 'MemoBrain Notes cannot start: the engine does not answer. Close and reopen the app.';
  root.replaceChildren(note);
}

async function main(): Promise<void> {
  if (!import.meta.env.MEMOBRAIN_E2E) {
    try {
      const { installWailsHost } = await import('./wailsHost');
      await installWailsHost();
    } catch (e) {
      showFatal(e);
      return;
    }
  }
  await mountWorkbench(root);
}

void main();
