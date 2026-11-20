// The screens of the terminal: one xterm per session, kept for as long as the session is a tab of this
// window. They live here, outside React, so that hiding the panel, changing vault (which rebuilds the
// vault view) or switching tab does not lose a screen: the view only parents it. This is the lazy chunk
// of the panel: xterm and its style sheet are fetched the first time a terminal is shown.
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { DEFAULT_TERMINAL_FONT_SIZE, terminalFontSizeOf, useSettings } from '../state/settings';
import { openExternal } from '../util/external';
import {
  attachSink,
  queueWrite,
  resizeSession,
  setSizeHint,
  setTabTitle,
  type TerminalSink,
} from './controller';
import { isCopyKey, isPasteKey } from './keys';
import { isReservedKey } from './reserved';
import { useTerminal } from './store';
import { fontReady, xtermFontFamily, xtermTheme } from './theme';

interface Instance {
  term: Terminal;
  fit: FitAddon;
  /** The element xterm draws in; parented by the view of the tab. */
  el: HTMLDivElement;
  unregister: () => void;
  resizeTimer: ReturnType<typeof setTimeout> | undefined;
}

const instances = new Map<string, Instance>();

/** Delay before a change of size reaches the core: a drag of the splitter makes dozens. */
const RESIZE_DELAY_MS = 60;
const SCROLLBACK = 5000;

/** The keys xterm leaves to the page (see isApplicationKey) and the few it handles for us. */
function keyHandler(term: Terminal): (e: KeyboardEvent) => boolean {
  return (e) => {
    const separate = useTerminal.getState().role === 'window';
    if (isReservedKey(e, useSettings.getState().hotkeys, separate)) return false; // the page's hotkeys take it
    if (e.type === 'keydown') {
      // A key that is the shell's must not run an application command on its way up.
      e.stopPropagation();
    }
    if (isCopyKey(e)) {
      if (e.type === 'keydown') {
        const text = term.getSelection();
        if (text) navigator.clipboard?.writeText(text).catch(() => undefined);
        e.preventDefault();
      }
      return false;
    }
    // Ctrl+Shift+V: the browser's paste event gives xterm the text; the key itself is not input.
    return !isPasteKey(e);
  };
}

function create(id: string, host: HTMLElement, dark: boolean): Instance {
  const el = document.createElement('div');
  el.className = 'terminal-screen';
  host.appendChild(el);
  const term = new Terminal({
    cursorBlink: true,
    scrollback: SCROLLBACK,
    fontFamily: xtermFontFamily(useSettings.getState().appearance.terminalFont),
    fontSize: terminalFontSizeOf(useSettings.getState().appearance.terminalFontSize),
    theme: xtermTheme(dark),
    allowProposedApi: false,
    // A link a program writes itself (OSC 8) opens in the system browser too. Without a handler xterm
    // asks with confirm() and opens it with window.open, which a web view turns into a window of the app;
    // `allowNonHttpProtocols` stays off, and openExternal only passes web, mail and phone addresses.
    linkHandler: { activate: (_event, uri) => openExternal(uri) },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // A link in the output opens in the system browser, like the ones of the notes (util/external).
  term.loadAddon(new WebLinksAddon((_event, uri) => openExternal(uri)));
  term.open(el);
  term.attachCustomKeyEventHandler(keyHandler(term));
  term.onData((data) => queueWrite(id, data));
  term.onTitleChange((title) => setTabTitle(id, title));
  const inst: Instance = { term, fit, el, unregister: () => undefined, resizeTimer: undefined };
  term.onResize(({ cols, rows }) => {
    clearTimeout(inst.resizeTimer);
    inst.resizeTimer = setTimeout(() => resizeSession(id, cols, rows), RESIZE_DELAY_MS);
  });
  const sink: TerminalSink = {
    write: (data) => term.write(data),
    reset: () => term.reset(),
    dispose: () => dispose(id),
  };
  inst.unregister = attachSink(id, sink);
  instances.set(id, inst);
  // The cells are measured with the font the screen was made with: measure again once it is ready.
  void fontReady(term.options.fontFamily ?? '', term.options.fontSize).then(
    () => instances.get(id) === inst && fitScreen(id, inst, true),
  );
  return inst;
}

/** The screen of a session, put in `host` (made on first use, when `host` is on the screen and can be measured). */
export function mountScreen(id: string, host: HTMLElement, dark: boolean): void {
  const known = instances.get(id);
  if (!known) {
    fitScreen(id, create(id, host, dark), true);
    return;
  }
  if (known.el.parentElement !== host) host.appendChild(known.el);
  fitScreen(id, known, true);
}

/**
 * Fits the screen to its host; `announce` also tells the core the size, which a screen drawn in a new window
 * must do even when the size did not change (the pseudo-terminal still has the old window's).
 */
function fitScreen(id: string, inst: Instance, announce = false): void {
  const host = inst.el.parentElement;
  if (!host || host.clientWidth === 0 || host.clientHeight === 0) return;
  const dims = inst.fit.proposeDimensions();
  if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
  if (dims.cols !== inst.term.cols || dims.rows !== inst.term.rows) inst.fit.fit();
  setSizeHint(inst.term.cols, inst.term.rows);
  if (announce) resizeSession(id, inst.term.cols, inst.term.rows);
}

export function fit(id: string): void {
  const inst = instances.get(id);
  if (inst) fitScreen(id, inst);
}

export function focusScreen(id: string): void {
  instances.get(id)?.term.focus();
}

/** The theme changed: every screen takes the new colours. */
export function themeScreens(dark: boolean): void {
  const theme = xtermTheme(dark);
  for (const inst of instances.values()) inst.term.options.theme = theme;
}

/**
 * The font or its size, chosen in Settings, changed: every screen takes it, and once the font is ready the size
 * is measured again and told to the core (the cells, so the columns and rows, are not those of the old font).
 */
export function fontScreens(setting: string, size: number = DEFAULT_TERMINAL_FONT_SIZE): void {
  const family = xtermFontFamily(setting);
  const px = terminalFontSizeOf(size);
  for (const [id, inst] of instances) {
    if (inst.term.options.fontFamily === family && inst.term.options.fontSize === px) continue;
    inst.term.options.fontFamily = family;
    inst.term.options.fontSize = px;
    void fontReady(family, px).then(() => instances.get(id) === inst && fitScreen(id, inst, true));
  }
}

/** Releases the screen of a session (it ended, or the panel went to the other window). */
export function dispose(id: string): void {
  const inst = instances.get(id);
  if (!inst) return;
  instances.delete(id);
  clearTimeout(inst.resizeTimer);
  inst.unregister();
  inst.term.dispose();
  inst.el.remove();
}

/** The sessions that have a screen now (tests). */
export const screenIds = (): string[] => [...instances.keys()];
