// What the host can do, so the same UI runs on the desktop (Wails) and in the browser (the Go core
// as WebAssembly, ADR-0029/0030). The host passes its kind to mountWorkbench; everything that only
// a desktop has (a local folder as vault, the updater, the OS window) is gated on a capability here
// instead of on scattered checks of the environment.
import { create } from 'zustand';

export type PlatformKind = 'desktop' | 'web';

/**
 * What the host offers, or how it behaves. `true` = the UI shows the control (every flag except
 * `ephemeralPlaintext`, which describes a policy of the host). A control that only one host can
 * honour is gated here, never on scattered checks of the environment; a command declares it in
 * `Command.requires`, and the feature registry (shared/parity/features.yaml) names it per surface.
 */
export interface Capabilities {
  /** Open a folder of the computer as a vault, pick a folder to import. The browser has cloud vaults only. */
  localFolders: boolean;
  /** Automatic updates of the application. The Web UI is served by the cloud and is always current. */
  updater: boolean;
  /** Warn when the disk is not encrypted (a private vault's keys may end up on it). */
  diskEncryptionCheck: boolean;
  /** The window itself (full screen through the OS, the system browser for external links). */
  nativeWindow: boolean;
  /** Deleted files can go to the system trash; the browser always uses the vault's `.trash/`. */
  osTrash: boolean;
  /**
   * Several vaults over time in one window: recent vaults, switching from the vault menu. The browser
   * opens one vault per page, chosen in the console.
   */
  multiVault: boolean;
  /**
   * A local vault can be disconnected from the cloud and kept as a plain folder. In the browser the
   * copy belongs to the cloud vault: it is removed from the browser instead.
   */
  unlinkVault: boolean;
  /**
   * The application owns the cloud session (sign-in through the system browser, sign-out, choice of
   * the server). In the browser the session is the page's OIDC one, managed by the console.
   */
  ownsSession: boolean;
  /**
   * Policy, not a control: the clear text of a private vault must not outlive its lock (ADR-0029 §6).
   * True in the browser, where the copy is wiped on lock; the desktop keeps the folder.
   */
  ephemeralPlaintext: boolean;
  /**
   * A folder of the computer can be picked: the native dialog on the desktop, the File System Access
   * API in a browser that has it (detected at run time). Core-backed pickers also need localFolders.
   */
  directoryPicker: boolean;
}

const DESKTOP: Capabilities = {
  localFolders: true,
  updater: true,
  diskEncryptionCheck: true,
  nativeWindow: true,
  osTrash: true,
  multiVault: true,
  unlinkVault: true,
  ownsSession: true,
  ephemeralPlaintext: false,
  directoryPicker: true,
};

const WEB: Capabilities = {
  localFolders: false,
  updater: false,
  diskEncryptionCheck: false,
  nativeWindow: false,
  osTrash: false,
  multiVault: false,
  unlinkVault: false,
  ownsSession: false,
  ephemeralPlaintext: true,
  directoryPicker: false,
};

/** The browser's folder picker (File System Access API), where it exists. */
const browserHasDirectoryPicker = (): boolean =>
  typeof window !== 'undefined' &&
  typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

export const capabilitiesFor = (kind: PlatformKind): Capabilities =>
  kind === 'web' ? { ...WEB, directoryPicker: browserHasDirectoryPicker() } : { ...DESKTOP };

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
  /** Overrides of the kind's capabilities, for what the host detects itself. */
  capabilities?: Partial<Capabilities>;
}

interface PlatformState {
  kind: PlatformKind;
  capabilities: Capabilities;
  /** Set when the host has a place to go back to (the Web UI console); the header then shows a button. */
  backToConsole: (() => void) | null;
  /** Set when the host can remove the vault's copy from the browser (see PlatformOptions). */
  removeFromBrowser: (() => void) | null;
  /** Opened by the app once its listeners are attached. */
  initialVault: string | null;
}

export const usePlatform = create<PlatformState>(() => ({
  kind: 'desktop',
  capabilities: capabilitiesFor('desktop'),
  backToConsole: null,
  removeFromBrowser: null,
  initialVault: null,
}));

/** Applies the host's choices. Called once by mountWorkbench, before the first render. */
export function configurePlatform(options: PlatformOptions = {}): void {
  const kind = options.kind ?? 'desktop';
  usePlatform.setState({
    kind,
    capabilities: { ...capabilitiesFor(kind), ...options.capabilities },
    backToConsole: options.onBackToConsole ?? null,
    removeFromBrowser: options.onRemoveFromBrowser ?? null,
    initialVault: options.vaultPath ?? null,
  });
}

/** Reads a capability outside React (commands, util modules). */
export const can = (name: keyof Capabilities): boolean => usePlatform.getState().capabilities[name];

/** Reads a capability inside a component, re-rendering when the platform is reconfigured. */
export const useCan = (name: keyof Capabilities): boolean =>
  usePlatform((s) => s.capabilities[name]);
