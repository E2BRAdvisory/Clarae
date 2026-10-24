import { beforeEach, describe, expect, it } from 'vitest';
import {
  commandForEvent,
  commandById,
  commands,
  commandTitle,
  currentCombos,
  runCommand,
} from './registry';
import { comboIndex } from './hotkeys';
import { fuzzyScore } from './CommandPalette';
import { initI18n } from '../i18n';
import en from '../i18n/en.json';
import it_ from '../i18n/it.json';
import { api } from '../app/api';
import { installWailsMock } from '../test/wails-mock';
import { useAppStore } from '../state/store';
import { emptyLayout } from '../workspace/layout';

const key = (init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent =>
  new KeyboardEvent('keydown', { ...init });

describe('command registry', () => {
  beforeEach(() => {
    initI18n('en');
    installWailsMock();
    useAppStore.setState({ vault: null, layout: emptyLayout() });
  });

  it('has unique ids and no default hotkey shared by two commands', () => {
    expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length);
    const conflicts = [...comboIndex(currentCombos({}))].filter(([, ids]) => ids.length > 1);
    expect(conflicts).toEqual([]);
  });

  it('has a title in every language', () => {
    for (const lang of [en, it_]) {
      const titles = (lang as unknown as { commands: Record<string, string> }).commands;
      for (const c of commands) expect(titles[c.id.replace(/[:-]/g, '_')], c.id).toBeTruthy();
    }
    expect(commandTitle('note:new')).toBe('New note');
  });

  it('maps keyboard events to enabled commands only', async () => {
    // Ctrl is the "Mod" key outside macOS (jsdom reports no Mac platform).
    expect(commandForEvent(key({ key: 'n', code: 'KeyN', ctrlKey: true }), {})).toBeNull(); // no vault open
    expect(commandForEvent(key({ key: 'p', code: 'KeyP', ctrlKey: true }), {})?.id).toBe(
      'palette:open',
    );
    const info = await api.vault.open('/v/Demo');
    useAppStore.setState({ vault: info });
    expect(commandForEvent(key({ key: 'n', code: 'KeyN', ctrlKey: true }), {})?.id).toBe(
      'note:new',
    );
  });

  it('honors user overrides, including unbinding', () => {
    const e = key({ key: 'p', code: 'KeyP', ctrlKey: true });
    expect(commandForEvent(e, { 'palette:open': ['Mod-Shift-p'] })).toBeNull();
    expect(
      commandForEvent(key({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }), {
        'palette:open': ['Mod-Shift-p'],
      })?.id,
    ).toBe('palette:open');
    expect(commandForEvent(e, { 'palette:open': [] })).toBeNull();
  });

  it('runs commands that change the workspace', async () => {
    const info = await api.vault.open('/v/Demo');
    useAppStore.setState({ vault: info });
    await runCommand('sidebar:right');
    expect(useAppStore.getState().right.open).toBe(true);
    expect(commandById.get('pane:split-right')?.enabled?.()).toBe(false); // no note open yet
  });
});

describe('fuzzyScore', () => {
  it('prefers substring matches and rejects non-matches', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
    expect(fuzzyScore('split', 'Split right')).toBeLessThan(fuzzyScore('sr', 'Split right'));
    expect(fuzzyScore('sr', 'Split right')).toBeGreaterThanOrEqual(0);
    expect(fuzzyScore('xyz', 'Split right')).toBe(-1);
  });
});
