// Entry of the vault workbench page (/vaults/:id/open). It is a page of its own, with its own HTML and
// style sheet, because the desktop UI's global styles must not reach the console (ADR-0029).
import { mountCreateCloudVault, mountWorkbench } from '@memobrain/workbench';
import { createOidcAuth } from '../auth/oidc';
import { workbenchVaultId } from '../shared/routes';
import type { AuthService } from '../auth/types';
import { parseCreation } from './create';
import { WORKBENCH_LOCK } from './forget';
import { CANCELLED, DISABLED, launchWorkbench } from './launch';
import type { CoreAssets } from './protocol';
import { message, STEP_MESSAGE } from './strings';
import './shell.css';

const status = document.getElementById('status') as HTMLElement;
const root = document.getElementById('root') as HTMLElement;

function show(text: string, opts: { error?: boolean; back?: boolean; retry?: boolean } = {}): void {
  status.hidden = false;
  status.className = opts.error ? 'status error' : 'status';
  status.replaceChildren(Object.assign(document.createElement('p'), { textContent: text }));
  if (opts.retry) {
    const b = Object.assign(document.createElement('button'), {
      type: 'button',
      textContent: message('common.retry'),
    });
    b.addEventListener('click', () => location.reload());
    status.append(b);
  }
  if (opts.back) {
    const a = Object.assign(document.createElement('a'), {
      href: '/vaults',
      textContent: message('workbench.back'),
    });
    a.setAttribute('data-allow-navigation', ''); // the workbench's link guard lets this one through
    status.append(a);
  }
}

/** One workbench per browser: its files and databases are held exclusively (OPFS synchronous handles). */
async function takeLock(): Promise<boolean> {
  if (!navigator.locks) return true;
  const attempt = (): Promise<boolean> =>
    new Promise((resolve) => {
      void navigator.locks.request(WORKBENCH_LOCK, { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        // Holding the lock means never settling: it is released when the page goes away.
        return lock ? new Promise<void>(() => undefined) : undefined;
      });
    });
  // The workbench page this one replaces (opening a mount from Settings › Sharing, a reload) may
  // still be releasing it for a moment; another tab keeps it.
  for (let i = 0; i < 8; i++) {
    if (await attempt()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function start(): Promise<void> {
  document.documentElement.lang = navigator.language.startsWith('it') ? 'it' : 'en';
  const params = new URLSearchParams(location.search);
  const vaultId = workbenchVaultId(location.pathname);
  if (vaultId === null) return show(message('workbench.notFound'), { error: true, back: true });
  // /vaults/new/open?kind=private&name=…: the console sends the creation of a private vault here.
  const create = parseCreation(vaultId, params);
  if (create === 'invalid')
    return show(message('workbench.badCreate'), { error: true, back: true });

  // Playwright opens a folder of the browser without a cloud, using the OIDC test double.
  const localOnly = Boolean(import.meta.env.MEMOBRAIN_E2E) && params.has('local');

  let auth: AuthService;
  if (import.meta.env.MEMOBRAIN_E2E) auth = (await import('../auth/e2e')).createE2EAuth();
  else auth = createOidcAuth();

  // A cloud that does not answer (its client configuration, the identity provider) is shown with a
  // retry, never as an endless "redirecting".
  const signInFailed = (e: unknown): void => {
    console.error(e);
    show(message('workbench.signInFailed'), { error: true, retry: true, back: true });
  };
  if (!localOnly) {
    let user: Awaited<ReturnType<AuthService['getUser']>>;
    try {
      user = await auth.getUser();
    } catch (e) {
      return signInFailed(e);
    }
    if (!user) {
      auth.signIn(`${location.pathname}${location.search}`).catch(signInFailed);
      return;
    }
  }
  if (!(await takeLock())) return show(message('workbench.busy'), { error: true, back: true });

  const assets =
    typeof __MEMOBRAIN_CORE__ === 'undefined' ? null : (__MEMOBRAIN_CORE__ as CoreAssets | null);
  if (!assets) return show(message('workbench.noCore'), { error: true, back: true });

  show(message('workbench.core'));
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
      progress: (step) => show(message(STEP_MESSAGE[step])),
      mount: async ({
        vaultPath,
        onBackToConsole,
        onRemoveFromBrowser,
        onOpenMount,
        onMountRemoved,
      }) => {
        status.hidden = true;
        return mountWorkbench(root, {
          kind: 'web',
          onBackToConsole,
          vaultPath,
          onOpenMount,
          onMountRemoved,
          ...(onRemoveFromBrowser ? { onRemoveFromBrowser } : {}),
        });
      },
    });
  } catch (e) {
    if (e instanceof Error && e.message === CANCELLED) return; // on the way back to the console
    if (e instanceof Error && e.message === DISABLED)
      return show(message('workbench.disabled'), { error: true, back: true });
    console.error(e);
    // A start-up that timed out (a storage that did not answer, a slow removal) may well work again.
    show(`${message('workbench.failed')} ${e instanceof Error ? e.message : String(e)}`, {
      error: true,
      retry: true,
      back: true,
    });
  }
}

window.addEventListener('unhandledrejection', (ev) => {
  if (String(ev.reason).includes('signed out')) ev.preventDefault();
});
void start();
