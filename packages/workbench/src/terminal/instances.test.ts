import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTerminal } from './controller';

// xterm needs a real layout engine: it is covered by the browser specs. Here the options the screen is made with.
const made = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  links: [] as ((e: MouseEvent, uri: string) => void)[],
}));
const openExternal = vi.hoisted(() => vi.fn());

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
    proposeDimensions(): undefined {
      return undefined;
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

import { dispose, mountScreen } from './instances';

beforeEach(() => {
  made.options.length = 0;
  made.links.length = 0;
  openExternal.mockClear();
  resetTerminal();
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
