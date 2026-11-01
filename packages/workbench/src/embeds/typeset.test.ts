import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderMermaid } from './typeset';

beforeAll(() => {
  const proto = window.SVGElement.prototype as unknown as Record<string, unknown>;
  proto['getBBox'] = () => ({ x: 0, y: 0, width: 60, height: 20 });
  proto['getComputedTextLength'] = () => 60;
});

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.body.replaceChildren();
});

describe('renderMermaid', () => {
  it('renders with labels and its theme, and follows a theme change', async () => {
    document.documentElement.setAttribute('data-theme', 'light');
    const el = document.createElement('div');
    document.body.append(el);
    renderMermaid(el, 'flowchart TD\n  A[Start] --> B[End]');
    await waitFor(() => expect(el.querySelector('svg')).not.toBeNull(), { timeout: 20000 });
    expect(el.textContent).toContain('Start');
    const css = (): string => el.querySelector('svg style')?.textContent ?? '';
    expect(css()).toContain('#ECECFF'); // the light theme's node fill

    document.documentElement.setAttribute('data-theme', 'dark');
    await waitFor(() => expect(css()).not.toContain('#ECECFF'), { timeout: 20000 });
    expect(el.textContent).toContain('End');
  }, 40000);
});
