import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { installActivityFeed } from './activity';

let mock: WailsMock;
let now = 0;
let off: () => void = () => undefined;

beforeEach(() => {
  mock = installWailsMock();
  now = 0;
  off = installActivityFeed(30_000, () => now);
});

afterEach(() => off());

const input = (type: string, at: number): void => {
  now = at;
  window.dispatchEvent(new Event(type));
};

describe('activity feed', () => {
  it('reports user input to the core at most once per window', () => {
    input('pointerdown', 0);
    expect(mock.activity).toBe(1);
    input('keydown', 1_000);
    input('wheel', 29_999);
    expect(mock.activity).toBe(1);
    input('touchstart', 30_000);
    expect(mock.activity).toBe(2);
    input('mousemove', 90_000); // not an input that counts
    expect(mock.activity).toBe(2);
  });

  it('counts input an inner element stops from propagating', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    el.addEventListener('keydown', (e) => e.stopPropagation());
    el.dispatchEvent(new Event('keydown', { bubbles: true }));
    expect(mock.activity).toBe(1);
    el.remove();
  });

  it('stops when uninstalled and ignores a failing backend', () => {
    off();
    input('pointerdown', 0);
    expect(mock.activity).toBe(0);
    const w = window as unknown as { go: { app: { VaultCryptoAPI: Record<string, unknown> } } };
    w.go.app.VaultCryptoAPI.Activity = () => Promise.reject(new Error('no core'));
    off = installActivityFeed(30_000, () => now);
    expect(() => input('pointerdown', 0)).not.toThrow();
  });
});
