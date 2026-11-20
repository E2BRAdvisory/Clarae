import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTerminal } from './controller';

// xterm needs a real layout engine: it is covered by the browser specs. Here the options the screen is made with.
const made = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  links: [] as ((e: MouseEvent, uri: string) => void)[],
}));
const openExternal = vi.hoisted(() => vi.fn());
const resize = vi.hoisted(() => vi.fn());

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      made.options.push(options);
    }
    loadAddon(): void {}
    open(): void {}
    attachCustomKeyEventHandler(): void {}
    onData(): void {}
    onTitleChange(): void {}
    onResize(): void {}
    focus(): void {}
    dispose(): void {}
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 100, rows: 30 };
    }
    fit(): void {}
  },
}));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(handler: (e: MouseEvent, uri: string) => void) {
      made.links.push(handler);
    }
  },
}));
vi.mock('../util/external', () => ({ openExternal }));
vi.mock('./controller', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resizeSession: resize,
}));

import { useSettings } from '../state/settings';
import { dispose, fontScreens, mountScreen } from './instances';

// jsdom lays nothing out: a host that has a size, so that a screen is measured and fitted
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get: () => 400,
});

beforeEach(() => {
  resize.mockClear();
  made.options.length = 0;
  made.links.length = 0;
  openExternal.mockClear();
  resetTerminal();
});

describe('the font of a screen', () => {
  const host = () => document.body.appendChild(document.createElement('div'));
  const options = (i = 0) => made.options[i] as { fontFamily: string; fontSize: number };
  afterEach(() => {
    Reflect.deleteProperty(document, 'fonts');
    useSettings.setState({
      appearance: {
        ...useSettings.getState().appearance,
        terminalFont: 'MesloLGS NF',
        terminalFontSize: 13,
      },
    });
  });

  it('is 13 pixels by default, and the size of Settings when the screen is made', () => {
    mountScreen('term-s1', host(), false);
    expect(options().fontSize).toBe(13);
    dispose('term-s1');
    useSettings.setState({
      appearance: { ...useSettings.getState().appearance, terminalFontSize: 18 },
    });
    mountScreen('term-s2', host(), false);
    expect(options(1).fontSize).toBe(18);
    dispose('term-s2');
    // a stored value out of range is the default
    useSettings.setState({
      appearance: { ...useSettings.getState().appearance, terminalFontSize: 99 },
    });
    mountScreen('term-s3', host(), false);
    expect(options(2).fontSize).toBe(13);
    dispose('term-s3');
  });

  it('changes the size at once on every screen, then measures again and tells the core', async () => {
    mountScreen('term-s4', host(), false);
    mountScreen('term-s5', host(), false);
    await new Promise((r) => setTimeout(r, 10)); // the measuring that follows the making of a screen
    resize.mockClear();
    fontScreens('MesloLGS NF', 20);
    expect(options(0).fontSize).toBe(20);
    expect(options(1).fontSize).toBe(20);
    expect(options(0).fontFamily.startsWith('"MesloLGS NF", ')).toBe(true); // the font stays
    await vi.waitFor(() => expect(resize).toHaveBeenCalledTimes(2));
    expect(resize).toHaveBeenCalledWith('term-s4', expect.any(Number), expect.any(Number));
    expect(resize).toHaveBeenCalledWith('term-s5', expect.any(Number), expect.any(Number));
    // the same size again changes nothing
    resize.mockClear();
    fontScreens('MesloLGS NF', 20);
    await new Promise((r) => setTimeout(r, 10));
    expect(resize).not.toHaveBeenCalled();
    dispose('term-s4');
    dispose('term-s5');
  });

  it('is the one of Settings, MesloLGS NF by default, with the fallbacks', () => {
    mountScreen('term-3', host(), false);
    expect(options().fontFamily).toBe(
      '"MesloLGS NF", ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace',
    );
    dispose('term-3');
  });

  it('takes the font Settings has when the screen is made, and the default for an empty value', () => {
    useSettings.setState({
      appearance: { ...useSettings.getState().appearance, terminalFont: ' "Fira Code" ' },
    });
    mountScreen('term-4', host(), false);
    expect(options().fontFamily.startsWith('"Fira Code", ')).toBe(true);
    dispose('term-4');
    useSettings.setState({
      appearance: { ...useSettings.getState().appearance, terminalFont: '' },
    });
    mountScreen('term-5', host(), false);
    expect(options(1).fontFamily.startsWith('"MesloLGS NF", ')).toBe(true);
    dispose('term-5');
  });

  it('changes at once on every screen that exists, and is measured once the font is ready', async () => {
    const load = vi.fn(() => Promise.resolve([]));
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load, ready: Promise.resolve() },
    });
    mountScreen('term-6', host(), false);
    mountScreen('term-7', host(), false);
    await new Promise((r) => setTimeout(r, 10)); // what the making of a screen waited for
    load.mockClear();
    fontScreens('JetBrains Mono');
    expect(options(0).fontFamily.startsWith('"JetBrains Mono", ')).toBe(true);
    expect(options(1).fontFamily.startsWith('"JetBrains Mono", ')).toBe(true);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(load).toHaveBeenCalledWith(expect.stringMatching(/^13px "JetBrains Mono", /));
    // the same font again changes nothing
    load.mockClear();
    fontScreens('JetBrains Mono');
    expect(load).not.toHaveBeenCalled();
    dispose('term-6');
    dispose('term-7');
  });
});

describe('the screen of a session', () => {
  it('opens a link a program writes itself (OSC 8) in the system browser, never in the app', () => {
    mountScreen('term-1', document.body.appendChild(document.createElement('div')), false);
    const handler = made.options[0]?.['linkHandler'] as {
      activate(e: MouseEvent, uri: string): void;
      allowNonHttpProtocols?: boolean;
    };
    expect(handler).toBeDefined();
    expect(handler.allowNonHttpProtocols).toBeUndefined();
    handler.activate(new MouseEvent('click'), 'https://example.com/a');
    expect(openExternal).toHaveBeenCalledWith('https://example.com/a');
    dispose('term-1');
  });

  it('opens a link it finds in the text in the system browser too', () => {
    mountScreen('term-2', document.body.appendChild(document.createElement('div')), false);
    made.links[0]?.(new MouseEvent('click'), 'https://example.org/');
    expect(openExternal).toHaveBeenCalledWith('https://example.org/');
    dispose('term-2');
  });
});
