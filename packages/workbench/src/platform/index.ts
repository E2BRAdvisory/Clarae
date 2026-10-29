// What the host can do, so the same UI runs on the desktop (Wails) and in the browser (the Go core
// as WebAssembly, ADR-0029/0030). The host passes its kind to mountWorkbench; everything that only
// a desktop has (a local folder as vault, the updater, the OS window) is gated on a capability here
// instead of on scattered checks of the environment.
import { create } from 'zustand';

export type PlatformKind = 'desktop' | 'web';

/** What the host offers. `true` = the UI shows it. */
export interface Capabilities {
  /** Open a folder of the computer as a vault, pick a folder to import. The browser has cloud vaults only. */
  localFolders: boolean;
  /** Automatic updates of the application. The Web UI is served by the cloud and is always current. */
  updater: boolean;
  /** Warn when the disk is not encrypted (a private vault's keys may end up on it). */
  diskEncryptionCheck: boolean;
  /** The window itself (full screen through the OS, the system browser for external links). */
  nativeWindow: boolean;
}

const DESKTOP: Capabilities = {
  localFolders: true,
  updater: true,
  diskEncryptionCheck: true,
  nativeWindow: true,
};

const WEB: Capabilities = {
  localFolders: false,
  updater: false,
  diskEncryptionCheck: false,
  nativeWindow: false,
};

export const capabilitiesFor = (kind: PlatformKind): Capabilities => ({
  ...(kind === 'web' ? WEB : DESKTOP),
});

export interface PlatformOptions {
  kind?: PlatformKind;
  /** Web only: where "back to the console" leads (a link target or a navigation callback). */
  onBackToConsole?: () => void;
  /** The vault to open as soon as the UI is up (the Web UI opens one vault per page). */
  vaultPath?: string;
}

interface PlatformState {
  kind: PlatformKind;
  capabilities: Capabilities;
  /** Set when the host has a place to go back to (the Web UI console); the header then shows a button. */
  backToConsole: (() => void) | null;
  /** Opened by the app once its listeners are attached. */
  initialVault: string | null;
}

export const usePlatform = create<PlatformState>(() => ({
  kind: 'desktop',
  capabilities: capabilitiesFor('desktop'),
  backToConsole: null,
  initialVault: null,
}));

/** Applies the host's choices. Called once by mountWorkbench, before the first render. */
export function configurePlatform(options: PlatformOptions = {}): void {
  const kind = options.kind ?? 'desktop';
  usePlatform.setState({
    kind,
    capabilities: capabilitiesFor(kind),
    backToConsole: options.onBackToConsole ?? null,
    initialVault: options.vaultPath ?? null,
  });
}

/** Reads a capability outside React (commands, util modules). */
export const can = (name: keyof Capabilities): boolean => usePlatform.getState().capabilities[name];

/** Reads a capability inside a component, re-rendering when the platform is reconfigured. */
export const useCan = (name: keyof Capabilities): boolean =>
  usePlatform((s) => s.capabilities[name]);
