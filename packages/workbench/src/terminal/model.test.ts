import { describe, expect, it } from 'vitest';
import {
  activate,
  addTab,
  closeTab,
  emptyTabs,
  fromSessions,
  markExited,
  retitle,
  step,
  type TerminalTab,
} from './model';

const tab = (id: string, title = id): TerminalTab => ({
  id,
  vaultId: '',
  cwd: '/x',
  title,
  exit: null,
});
const three = () => [tab('a'), tab('b'), tab('c')].reduce(addTab, emptyTabs);
const ids = (m: { tabs: TerminalTab[] }): string[] => m.tabs.map((t) => t.id);

describe('tabs model', () => {
  it('adds a tab at the end and brings it to the front', () => {
    const m = three();
    expect(ids(m)).toEqual(['a', 'b', 'c']);
    expect(m.active).toBe('c');
  });

  it('replaces a tab with the same id instead of doubling it', () => {
    const m = addTab(three(), tab('a', 'again'));
    expect(ids(m)).toEqual(['b', 'c', 'a']);
    expect(m.tabs[2]?.title).toBe('again');
  });

  it('passes the front to the next tab, else the previous one, when the front tab closes', () => {
    let m = activate(three(), 'b');
    m = closeTab(m, 'b');
    expect(m.active).toBe('c');
    m = closeTab(m, 'c');
    expect(m.active).toBe('a');
    m = closeTab(m, 'a');
    expect(m).toEqual(emptyTabs);
  });

  it('leaves the front tab alone when another one closes, and ignores an unknown id', () => {
    const m = three();
    expect(closeTab(m, 'a').active).toBe('c');
    expect(closeTab(m, 'zzz')).toBe(m);
  });

  it('activates only a tab that exists', () => {
    const m = three();
    expect(activate(m, 'a').active).toBe('a');
    expect(activate(m, 'zzz')).toBe(m);
  });

  it('steps through the tabs and wraps around', () => {
    let m = three();
    m = step(m, 1);
    expect(m.active).toBe('a');
    m = step(m, -1);
    expect(m.active).toBe('c');
    expect(step({ tabs: [tab('a')], active: 'a' }, 1).active).toBe('a');
  });

  it('keeps the folder name when a shell sets an empty title', () => {
    const m = three();
    expect(retitle(m, 'a', '  ')).toBe(m);
    expect(retitle(m, 'a', 'vim notes.md').tabs[0]?.title).toBe('vim notes.md');
    expect(retitle(m, 'zzz', 'x')).toBe(m);
  });

  it('marks a session as over without removing its tab', () => {
    const m = markExited(three(), 'b', { code: 2, reason: 'exited' });
    expect(m.tabs[1]?.exit).toEqual({ code: 2, reason: 'exited' });
    expect(ids(m)).toEqual(['a', 'b', 'c']);
  });

  it('builds a model from the sessions of the core, the newest in front unless one is kept', () => {
    const sessions = [tab('a'), tab('b')].map(({ exit: _exit, ...s }) => s);
    expect(fromSessions(sessions).active).toBe('b');
    expect(fromSessions(sessions, 'a').active).toBe('a');
    expect(fromSessions(sessions, 'gone').active).toBe('b');
    expect(fromSessions([])).toEqual(emptyTabs);
  });
});
