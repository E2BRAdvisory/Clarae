import { afterEach, describe, expect, it } from 'vitest';
import { applyAppearance } from '../state/settings';
import { enterFullscreen, leaveFullscreen, PRESENTING_ATTR } from './fullscreen';

const root = document.documentElement;
const presenting = (): boolean => root.hasAttribute(PRESENTING_ATTR);

afterEach(async () => {
  await leaveFullscreen();
  root.style.removeProperty('zoom');
});

describe('presentations at actual size', () => {
  it('marks the root while presenting, also where the element full screen is missing', async () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'requestFullscreen', { value: undefined });
    await enterFullscreen(el);
    expect(presenting()).toBe(true);
    await leaveFullscreen();
    expect(presenting()).toBe(false);
  });

  it('marks the root also when the element full screen is refused', async () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'requestFullscreen', {
      value: () => Promise.reject(new Error('denied')),
    });
    await enterFullscreen(el);
    expect(presenting()).toBe(true);
    await leaveFullscreen(); // no document.fullscreenElement: the mark goes all the same
    expect(presenting()).toBe(false);
  });

  it('leaves the interface zoom of the appearance settings as it is, to come back after the show', async () => {
    applyAppearance({
      accent: '',
      fontFamily: '',
      interfaceFontSize: 14,
      zoom: 150,
    } as Parameters<typeof applyAppearance>[0]);
    const el = document.createElement('div');
    Object.defineProperty(el, 'requestFullscreen', { value: undefined });
    await enterFullscreen(el);
    expect(root.style.getPropertyValue('zoom')).toBe('1.5'); // overridden by style.css, not removed
    await leaveFullscreen();
    expect(root.style.getPropertyValue('zoom')).toBe('1.5');
  });
});
