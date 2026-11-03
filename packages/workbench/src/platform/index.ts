// What the host can do, so the same UI runs on the desktop (Wails) and in the browser (the Go core
// as WebAssembly, ADR-0029/0030). The host passes its kind to mountWorkbench; everything that only
// a desktop has (a local folder as vault, the updater, the OS window) is gated on a capability here
// instead of on scattered checks of the environment.
import { create } from 'zustand';
import { CORE_CAPABILITIES, type CoreCapabilities, type HostKind } from './capabilities.gen';

export type PlatformKind = HostKind;

/**
 * What the host offers. `true` = the UI shows the control. A control that only one host can honour
 * is gated here, never on scattered checks of the environment; a command declares it in
 * `Command.requires` (an action of a panel in its `requires` or `excludes`, commands/actions.ts),
 * and the feature registry (shared/parity/features.yaml) names it per surface. Every capability has
 * a consumer (`can`, `useCan`, `Command.requires` or an action's `requires`/`excludes`):
 * `parity --check` refuses one that gates nothing. Policies of a host that no control reads (the
 * browser wipes the clear text of a private vault at its lock, ADR-0029 §6) live in the host, not
 * here.
 *
 * The Go core declares them (apps/desktop/internal/app/capabilities.go, ADR-0045 §1), next to the
 * Host methods and bindings each one gates: the type and the values per kind of host are generated
 * (capabilities.gen.ts), and mountWorkbench replaces the values with the running core's answer
 * before the first render. A host can only switch a capability off (PlatformOptions.capabilities).
 */
export type Capabilities = CoreCapabilities;

/** The values a kind of host starts from (a copy), as its core declares them. */
export const capabilitiesFor = (kind: PlatformKind): Capabilities => ({
  ...CORE_CAPABILITIES[kind],
});

/** A received share, as the host needs it to open its mount (MountState). */
export interface MountRef {
  shareId: string;
  cloudVaultId: string;
}

export interface PlatformOptions {
  kind?: PlatformKind;
  /** Web only: where "back to the console" leads (a link target or a navigation callback). */
  onBackToConsole?: () => void;
  /** The vault to open as soon as the UI is up (the Web UI opens one vault per page). */
  vaultPath?: string;
  /**
   * Web only: removes the open vault's copy from this browser (uploading what is pending first) and
   * goes back to the console. The sync settings offer it where the desktop offers Disconnect.
   */
  onRemoveFromBrowser?: () => void;
  /**
   * Web only: opens the mount of a received share. The browser opens one vault per page, so the
   * host leaves this one (uploading what is pending, as going back to the console does) and loads
   * the mount's own page, where its guard and marker follow it. Without it the mount opens in
   * place (the desktop).
   */
  onOpenMount?: (mount: MountRef) => void;
  /**
   * Web only: the copy of a share's mount was removed from this browser (Settings › Sharing), so
   * the host forgets what it remembers of it (its marker).
   */
  onMountRemoved?: (shareId: string) => void;
  /**
   * What the host switches off itself, for what it detects (`false` wins over the core). An
   * override never switches on what the core lacks: the UI would offer a control whose call fails.
   */
  capabilities?: Partial<Capabilities>;
}

interface PlatformState {
  kind: PlatformKind;
  capabilities: Capabilities;
  /** The host's overrides, kept to narrow the core's answer too (applyCoreCapabilities). */
  overrides: Partial<Capabilities>;
  /** Set when the host has a place to go back to (the Web UI console); the header then shows a button. */
  backToConsole: (() => void) | null;
  /** Set when the host can remove the vault's copy from the browser (see PlatformOptions). */
  removeFromBrowser: (() => void) | null;
  /** Set when the host opens a mount itself (see PlatformOptions.onOpenMount). */
  openMount: ((mount: MountRef) => void) | null;
  /** Set when the host must hear of a removed mount (see PlatformOptions.onMountRemoved). */
  mountRemoved: ((shareId: string) => void) | null;
  /** Opened by the app once its listeners are attached. */
  initialVault: string | null;
}

export const usePlatform = create<PlatformState>(() => ({
  kind: 'desktop',
  capabilities: capabilitiesFor('desktop'),
  overrides: {},
  backToConsole: null,
  removeFromBrowser: null,
  openMount: null,
  mountRemoved: null,
  initialVault: null,
}));

/** The core's capabilities without what the host switched off. */
function narrow(core: Capabilities, overrides: Partial<Capabilities>): Capabilities {
  const out = { ...core };
  for (const k of Object.keys(out) as (keyof Capabilities)[])
    if (overrides[k] === false) out[k] = false;
  return out;
}

/**
 * Applies the host's choices, with the capabilities its kind starts from. Called once by
 * mountWorkbench, before the core's own answer (loadCoreCapabilities) and the first render.
 */
export function configurePlatform(options: PlatformOptions = {}): void {
  const kind = options.kind ?? 'desktop';
  const overrides = { ...options.capabilities };
  usePlatform.setState({
    kind,
    capabilities: narrow(capabilitiesFor(kind), overrides),
    overrides,
    backToConsole: options.onBackToConsole ?? null,
    removeFromBrowser: options.onRemoveFromBrowser ?? null,
    openMount: options.onOpenMount ?? null,
    mountRemoved: options.onMountRemoved ?? null,
    initialVault: options.vaultPath ?? null,
  });
}

/**
 * Applies the running core's answer (SettingsAPI.Capabilities), still narrowed by the host's
 * overrides. A capability the answer lacks, or does not give as `true`, is off: the UI never offers
 * what the core did not declare.
 */
export function applyCoreCapabilities(answer: unknown): void {
  const got =
    answer !== null && typeof answer === 'object' ? (answer as Record<string, unknown>) : {};
  const core = capabilitiesFor('desktop');
  for (const k of Object.keys(core) as (keyof Capabilities)[]) core[k] = got[k] === true;
  usePlatform.setState((s) => ({ capabilities: narrow(core, s.overrides) }));
}

/** How long mountWorkbench waits for the core's capabilities before keeping those of its kind. */
export const CORE_CAPABILITIES_TIMEOUT_MS = 15_000;

/**
 * Asks the core for its capabilities (`ask`: SettingsAPI.Capabilities) and applies them.
 * mountWorkbench awaits it before the first render, so no control reads the values of the kind
 * while the answer is on its way. Without an answer (a core that does not answer in time, a test
 * double without the binding) those values stay: the same table, generated from the core's
 * declaration (capabilities.gen.ts).
 */
export async function loadCoreCapabilities(
  ask: () => Promise<unknown>,
  timeoutMs = CORE_CAPABILITIES_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      ask(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('no answer in time')), timeoutMs);
      }),
    ]);
    applyCoreCapabilities(answer);
  } catch (e) {
    console.warn('capabilities: no answer from the core; keeping those of the host kind', e);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the UI talks to the Wails bindings of a desktop host. A web host brings its own backend
 * (the Go core in the browser), which the E2E builds must never replace with the in-memory mock.
 */
export const usesWailsBindings = (): boolean => usePlatform.getState().kind === 'desktop';

/** Reads a capability outside React (commands, util modules). */
export const can = (name: keyof Capabilities): boolean => usePlatform.getState().capabilities[name];

/** Reads a capability inside a component, re-rendering when the platform is reconfigured. */
export const useCan = (name: keyof Capabilities): boolean =>
  usePlatform((s) => s.capabilities[name]);
