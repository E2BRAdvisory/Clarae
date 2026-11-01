// Entry of the vault workbench page (/vaults/:id/open). It is a page of its own, with its own HTML and
// style sheet, because the desktop UI's global styles must not reach the console (ADR-0029).
import { mountCreateCloudVault, mountWorkbench } from '@memobrain/workbench';
import { createOidcAuth } from '../auth/oidc';
import type { AuthService } from '../auth/types';
import { parseCreation } from './create';
import { CANCELLED, DISABLED, launchWorkbench } from './launch';
import type { CoreAssets } from './protocol';
import { message } from './strings';
import './shell.css';

const status = document.getElementById('status') as HTMLElement;
const root = document.getElementById('root') as HTMLElement;

function show(text: string, opts: { error?: boolean; back?: boolean } = {}): void {
  status.hidden = false;
  status.className = opts.error ? 'status error' : 'status';
  status.replaceChildren(Object.assign(document.createElement('p'), { textContent: text }));
  if (opts.back) {
    const a = Object.assign(document.createElement('a'), {
      href: '/vaults',
      textContent: message('back'),
    });
    status.append(a);
  }
}

/** One workbench per browser: its files and databases are held exclusively (OPFS synchronous handles). */
function takeLock(): Promise<boolean> {
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    void navigator.locks.request('memobrain-workbench', { ifAvailable: true }, (lock) => {
      resolve(lock !== null);
      // Holding the lock means never settling: it is released when the page goes away.
      return lock ? new Promise<void>(() => undefined) : undefined;
    });
  });
}

async function start(): Promise<void> {
  document.documentElement.lang = navigator.language.startsWith('it') ? 'it' : 'en';
  const params = new URLSearchParams(location.search);
  const match = /^\/vaults\/([^/]+)\/open\/?$/.exec(location.pathname);
  if (!match) return show(message('notFound'), { error: true, back: true });
  const vaultId = decodeURIComponent(match[1] as string);
  // /vaults/new/open?kind=private&name=…: the console sends the creation of a private vault here.
  const create = parseCreation(vaultId, params);
  if (create === 'invalid') return show(message('badCreate'), { error: true, back: true });

  // Playwright opens a folder of the browser without a cloud, using the OIDC test double.
  const localOnly = Boolean(import.meta.env.MEMOBRAIN_E2E) && params.has('local');

  let auth: AuthService;
  if (import.meta.env.MEMOBRAIN_E2E) auth = (await import('../auth/e2e')).createE2EAuth();
  else auth = createOidcAuth();

  if (!localOnly && !(await auth.getUser())) {
    void auth.signIn(`${location.pathname}${location.search}`);
    return;
  }
  if (!(await takeLock())) return show(message('busy'), { error: true, back: true });

  const assets =
    typeof __MEMOBRAIN_CORE__ === 'undefined' ? null : (__MEMOBRAIN_CORE__ as CoreAssets | null);
  if (!assets) return show(message('noCore'), { error: true, back: true });

  show(message('core'));
  try {
    await launchWorkbench({
      auth,
      vaultId,
      share: params.get('share'),
      create,
      mountCreate: (options) => {
        status.hidden = true;
        return mountCreateCloudVault(root, options);
      },
      localOnly,
      fsTrace: Boolean(import.meta.env.MEMOBRAIN_E2E) && params.has('fstrace'),
      assets,
      version: typeof __MEMOBRAIN_VERSION__ === 'undefined' ? 'dev' : __MEMOBRAIN_VERSION__,
      progress: (step) => show(message(step)),
      mount: async ({ vaultPath, onBackToConsole }) => {
        status.hidden = true;
        return mountWorkbench(root, { kind: 'web', onBackToConsole, vaultPath });
      },
    });
  } catch (e) {
    if (e instanceof Error && e.message === CANCELLED) return; // on the way back to the console
    if (e instanceof Error && e.message === DISABLED)
      return show(message('disabled'), { error: true, back: true });
    console.error(e);
    show(`${message('failed')} ${e instanceof Error ? e.message : String(e)}`, {
      error: true,
      back: true,
    });
  }
}

window.addEventListener('unhandledrejection', (ev) => {
  if (String(ev.reason).includes('signed out')) ev.preventDefault();
});
void start();
