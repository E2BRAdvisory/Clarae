// ```query blocks in Reading view (hydrate). The Live editor's view of them is tested with the Live views
// (editor/live/views).
import { describe, expect, it, vi } from 'vitest';
import { hydrate, type EmbedBackend } from '../embeds/hydrate';
import { renderMarkdown } from '../reading/render';

describe('query block in Reading view', () => {
  const backend: EmbedBackend = {
    resolve: () => Promise.resolve(''),
    readNote: () => Promise.resolve(''),
    readBinary: () => Promise.reject(new Error('none')),
  };
  const deps = (renderQuery?: (el: HTMLElement, source: string, from: string) => void) => ({
    backend,
    fromPath: 'Host.md',
    depth: 0,
    visited: ['Host.md'],
    ...(renderQuery ? { renderQuery } : {}),
  });

  it('hands the block source and host note to the query renderer', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('Before\n\n```query\ntag:#todo\nlimit: 3\n```\n\nAfter');
    const renderQuery = vi.fn((el: HTMLElement) => void (el.className = 'query-block'));
    hydrate(root, deps(renderQuery));
    expect(renderQuery).toHaveBeenCalledTimes(1);
    expect(renderQuery.mock.calls[0]?.slice(1)).toEqual(['tag:#todo\nlimit: 3\n', 'Host.md']);
    expect(root.querySelector('.query-block')).not.toBeNull();
    expect(root.querySelector('pre')).toBeNull();
  });

  it('leaves other code blocks alone', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('```js\nlet a = 1\n```');
    const renderQuery = vi.fn();
    hydrate(root, deps(renderQuery));
    expect(renderQuery).not.toHaveBeenCalled();
    expect(root.querySelector('pre')).not.toBeNull();
  });
});
