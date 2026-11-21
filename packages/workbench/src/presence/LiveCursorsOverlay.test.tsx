import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PresencePos } from '../app/api';
import { configurePlatform } from '../platform';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { getUserColor } from './colors';
import { LiveCursorsOverlay, type LayerPoint } from './LiveCursorsOverlay';
import { installPresenceFeed, usePresenceStore } from './store';

let mock: WailsMock;
let off: () => void;
const ada = { sid: 's1', userId: 'u-ada', name: 'Ada' };
const bob = { sid: 's2', userId: 'u-bob', name: 'Bob' };

beforeEach(() => {
  mock = installWailsMock();
  configurePlatform();
  usePresenceStore.getState().reset();
  off = installPresenceFeed();
});
afterEach(() => {
  cleanup();
  off();
});

const place = (pos: PresencePos): LayerPoint | null =>
  pos.kind === 'text' ? { x: pos.col * 8, y: pos.line * 20 } : null;

describe('the cursor layer', () => {
  it('draws the pointer of each person at the place of their position, with their name and colour', () => {
    render(<LiveCursorsOverlay vaultId="v1" path="Note.md" place={place} />);
    act(() => {
      mock.presence.members('v1', 'Note.md', [ada, bob]);
      mock.presence.move('v1', 'Note.md', 's1', { line: 2, col: 5 });
      mock.presence.move('v1', 'Note.md', 's2', { line: 4, col: 1 });
    });
    const cursors = screen.getAllByTestId('presence-cursor');
    expect(cursors).toHaveLength(2);
    expect(cursors[0]).toHaveTextContent('Ada');
    expect(cursors[0]!.style.transform).toBe('translate(40px, 40px)');
    expect(cursors[1]!.style.transform).toBe('translate(8px, 80px)');
    // the colour of the avatar: the same function, the same tokens
    expect(cursors[0]).toHaveAttribute('data-color', String(getUserColor('u-ada').index));
    expect(cursors[0]!.style.getPropertyValue('--presence-bg')).toBe(
      getUserColor('u-ada').background,
    );
    expect(cursors[0]!.style.getPropertyValue('--presence-fg')).toBe(
      getUserColor('u-ada').foreground,
    );
    // an image for the pointer, and it is not for assistive technology
    expect(cursors[0]!.querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('presence-cursors')).toHaveAttribute('aria-hidden', 'true');
  });

  it('moves a pointer with a new transform and draws nobody who has not moved or is not on screen', () => {
    render(<LiveCursorsOverlay vaultId="v1" path="Note.md" place={place} />);
    act(() => mock.presence.members('v1', 'Note.md', [ada, bob]));
    expect(screen.queryAllByTestId('presence-cursor')).toHaveLength(0); // nobody moved yet
    act(() => mock.presence.move('v1', 'Note.md', 's1', { line: 1, col: 1 }));
    const first = screen.getByTestId('presence-cursor');
    act(() => mock.presence.move('v1', 'Note.md', 's1', { line: 3, col: 2 }));
    expect(screen.getByTestId('presence-cursor')).toBe(first); // the same element: the transition runs
    expect(first.style.transform).toBe('translate(16px, 60px)');
    act(() => mock.presence.move('v1', 'Note.md', 's2', { x: 5, y: 5 })); // a point of a scene in a text view
    expect(screen.getAllByTestId('presence-cursor')).toHaveLength(1);
  });

  it('removes a pointer at once when the person leaves, and all of them on cleared', () => {
    render(<LiveCursorsOverlay vaultId="v1" path="Note.md" place={place} />);
    act(() => {
      mock.presence.members('v1', 'Note.md', [ada, bob]);
      mock.presence.move('v1', 'Note.md', 's1', { line: 1, col: 1 });
      mock.presence.move('v1', 'Note.md', 's2', { line: 2, col: 2 });
    });
    act(() => mock.presence.members('v1', 'Note.md', [bob]));
    expect(screen.getAllByTestId('presence-cursor').map((c) => c.getAttribute('data-sid'))).toEqual(
      ['s2'],
    );
    act(() => mock.presence.cleared('v1', 'Note.md'));
    expect(screen.queryAllByTestId('presence-cursor')).toHaveLength(0);
  });

  it('shows only the people of its own file: another file does not draw here', () => {
    const { rerender } = render(<LiveCursorsOverlay vaultId="v1" path="A.md" place={place} />);
    act(() => {
      mock.presence.members('v1', 'A.md', [ada]);
      mock.presence.move('v1', 'A.md', 's1', { line: 1, col: 1 });
    });
    expect(screen.getAllByTestId('presence-cursor')).toHaveLength(1);
    rerender(<LiveCursorsOverlay vaultId="v1" path="B.md" place={place} />); // the file changed
    expect(screen.queryAllByTestId('presence-cursor')).toHaveLength(0);
  });

  it('draws again when the view says its places changed (scroll, zoom, an edit), and stops listening at the end', () => {
    let listener: (() => void) | null = null;
    let unsubscribed = 0;
    let shift = 0;
    const subscribe = (l: () => void) => {
      listener = l;
      return () => void unsubscribed++;
    };
    const { unmount } = render(
      <LiveCursorsOverlay
        vaultId="v1"
        path="Note.md"
        place={() => ({ x: 10, y: 10 + shift })}
        subscribe={subscribe}
      />,
    );
    act(() => {
      mock.presence.members('v1', 'Note.md', [ada]);
      mock.presence.move('v1', 'Note.md', 's1', { line: 1, col: 1 });
    });
    expect(screen.getByTestId('presence-cursor').style.transform).toBe('translate(10px, 10px)');
    shift = 100;
    act(() => listener!());
    expect(screen.getByTestId('presence-cursor').style.transform).toBe('translate(10px, 110px)');
    unmount();
    expect(unsubscribed).toBe(1);
  });
});

describe('the style of the layer', () => {
  const css = readFileSync(join(__dirname, '../style.css'), 'utf8');
  const rule = (selector: string): string => {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('}', at));
  };

  it('ignores the mouse, moves by transform over 80 ms and stops moving for who asks for less motion', () => {
    expect(rule('.presence-cursors')).toContain('pointer-events: none');
    expect(rule('.presence-cursor')).toContain('pointer-events: none');
    expect(rule('.presence-cursor')).toContain('transition: transform 80ms linear');
    const reduced = css.slice(
      css.indexOf('@media (prefers-reduced-motion: reduce) {\n  .presence-cursor {'),
    );
    expect(reduced.slice(0, reduced.indexOf('}\n}'))).toContain('transition: none');
  });

  it('draws the pointer and the label with the colour tokens of the person, never a literal colour', () => {
    expect(rule('.presence-pointer')).toContain('fill: var(--presence-bg)');
    expect(rule('.presence-cursor-label')).toContain('background: var(--presence-bg)');
    expect(rule('.presence-cursor-label')).toContain('color: var(--presence-fg)');
  });
});
