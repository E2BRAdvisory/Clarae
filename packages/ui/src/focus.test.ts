import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureModalFocus, hasModalFocus, installModalFocus } from './focus';

// jsdom has no layout: every element reports no client rects, so the handler would see no focusable
// control. Pretend everything is rendered.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
    {} as DOMRect,
  ] as unknown as DOMRectList);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function button(label: string, parent: HTMLElement = document.body): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  parent.append(b);
  return b;
}

function modal(...labels: string[]): { el: HTMLElement; buttons: HTMLButtonElement[] } {
  const el = document.createElement('div');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  document.body.append(el);
  return { el, buttons: labels.map((l) => button(l, el)) };
}

function tab(shift = false): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}

describe('installModalFocus', () => {
  it('cycles Tab and Shift+Tab inside the topmost modal', async () => {
    const off = installModalFocus();
    button('outside').focus();
    const { buttons } = modal('a', 'b');
    await flush();
    const [a, b] = buttons as [HTMLButtonElement, HTMLButtonElement];
    b.focus();
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(a);
    expect(tab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(b);
    off();
  });

  it('pulls focus back into the modal when it is outside', async () => {
    const off = installModalFocus();
    const outside = button('outside');
    const { buttons } = modal('a');
    await flush();
    outside.focus();
    tab();
    expect(document.activeElement).toBe(buttons[0]);
    off();
  });

  it('gives focus back to the opener when the modal closes', async () => {
    const off = installModalFocus();
    const opener = button('open');
    opener.focus();
    const { el, buttons } = modal('ok');
    await flush();
    buttons[0]?.focus();
    el.remove();
    await flush();
    expect(document.activeElement).toBe(opener);
    off();
  });

  it('returns focus to the control of the first dialog when a second one closes over it', async () => {
    const off = installModalFocus();
    button('open').focus();
    const first = modal('more', 'close');
    await flush();
    const more = first.buttons[0] as HTMLButtonElement;
    more.focus();
    const second = modal('ok');
    await flush();
    second.buttons[0]?.focus();
    second.el.remove();
    await flush();
    expect(document.activeElement).toBe(more);
    off();
  });

  it('leaves the focus to a dialog that replaces the one that closed (palette → command)', async () => {
    const off = installModalFocus();
    const editor = button('editor');
    editor.focus();
    const palette = modal('cmd');
    await flush();
    palette.buttons[0]?.focus();
    // The command closes the palette and opens its own dialog in the same render.
    palette.el.remove();
    const dialog = modal('ok');
    dialog.buttons[0]?.focus();
    await flush();
    expect(document.activeElement).toBe(dialog.buttons[0]);
    dialog.el.remove();
    await flush();
    expect(document.activeElement).toBe(editor);
    off();
  });

  it('shares one handler between installs and stops when the last one is undone', () => {
    const a = installModalFocus();
    const b = installModalFocus();
    expect(hasModalFocus()).toBe(true);
    a();
    expect(hasModalFocus()).toBe(true);
    b();
    expect(hasModalFocus()).toBe(false);
  });

  it('stays installed once a Dialog asked for it', () => {
    const off = installModalFocus();
    ensureModalFocus();
    off();
    expect(hasModalFocus()).toBe(true);
  });
});
