import { describe, expect, it } from 'vitest';
import { canvasSvg, wrap } from './preview';
import { type CanvasData } from './model';

describe('canvas preview', () => {
  const data: CanvasData = {
    nodes: [
      {
        id: 'a',
        type: 'text',
        x: 0,
        y: 0,
        width: 200,
        height: 80,
        text: 'Hello <b>world</b> & more',
        color: '4',
      },
      { id: 'f', type: 'file', x: 300, y: 0, width: 200, height: 80, file: 'Notes/Plan.md' },
      { id: 'g', type: 'group', x: -20, y: -20, width: 600, height: 200, label: 'Group' },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'f', label: 'uses' }],
  };

  it('draws nodes, edges and labels, escaping text', () => {
    const svg = canvasSvg(data);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Hello &lt;b&gt;world&lt;/b&gt;');
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('Plan.md');
    expect(svg).toContain('uses');
    expect(svg).toContain('marker-end');
    expect(svg).toContain('#44cf6e'); // preset color 4
    // The group is drawn first, so it stays behind.
    expect(svg.indexOf('Group')).toBeLessThan(svg.indexOf('Hello'));
  });

  it('copes with an empty canvas', () => {
    expect(canvasSvg({ nodes: [], edges: [] })).toContain('</svg>');
  });

  it('wraps words', () => {
    expect(wrap('aaa bbb ccc ddd', 7)).toEqual(['aaa bbb', 'ccc ddd']);
    expect(wrap('one\n\ntwo', 20)).toEqual(['one', '', 'two']);
  });
});
