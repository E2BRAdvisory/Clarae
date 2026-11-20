import { mountTerminalWindow } from '@clarae/workbench/terminal-window';

// The page of the separate terminal window (ADR-0064): the terminal panel of the workbench and nothing
// else, in a window of its own. The core serves it at /terminal.html when the user undocks the terminal.
// It needs the same backend as the main page (the Wails v3 shim), installed first; Playwright builds
// (CLARAE_E2E) leave it out and mountTerminalWindow installs the mock of the bindings instead.
const container = document.getElementById('root');
if (!container) {
  throw new Error('missing #root element');
}
const root = container;

/** The bridge to the Go core is down, before the UI (and its translations) exist: the only text outside i18n. */
function showFatal(error: unknown): void {
  console.error('clarae: cannot reach the Go core:', error);
  const italian = navigator.language.toLowerCase().startsWith('it');
  const note = document.createElement('p');
  note.setAttribute('role', 'alert');
  note.textContent = italian
    ? 'Impossibile avviare il terminale: il motore non risponde. Chiudi la finestra.'
    : 'The terminal cannot start: the engine does not answer. Close the window.';
  root.replaceChildren(note);
}

async function main(): Promise<void> {
  if (!import.meta.env.CLARAE_E2E) {
    try {
      const { installWailsHost } = await import('./wailsHost');
      await installWailsHost();
    } catch (e) {
      showFatal(e);
      return;
    }
  }
  await mountTerminalWindow(root);
}

void main();
