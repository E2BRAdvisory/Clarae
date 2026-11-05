import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Ribbon } from './Ribbon';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock } from '../test/wails-mock';
import { useAppStore } from '../state/store';

beforeEach(async () => {
  initI18n('en');
  installWailsMock();
  const info = await api.vault.open('/vaults/Ribbon');
  useAppStore.getState().setVault(info);
});
afterEach(cleanup);

const open = (path: string) => act(() => useAppStore.getState().openNote(path, { newTab: true }));
const labels = (): string[] =>
  screen
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label') ?? '')
    .filter((l) => /export/i.test(l));

describe('ribbon exports by kind of file', () => {
  it('shows the note exports for a note, with the PDF only for Markdown', () => {
    render(<Ribbon />);
    expect(labels()).toEqual([]);
    open('Note.md');
    expect(labels()).toHaveLength(3);
    expect(screen.getByRole('button', { name: /pdf/i })).toBeEnabled();
  });

  it('shows the drawing exports for a drawing', () => {
    render(<Ribbon />);
    open('Sketch.excalidraw');
    const l = labels();
    expect(l).toHaveLength(3);
    expect(l.join('|')).toMatch(/PNG/);
    expect(l.join('|')).toMatch(/SVG/);
    expect(l.join('|')).not.toMatch(/PowerPoint/);
  });

  it('shows HTML, PDF and PowerPoint for a presentation', () => {
    render(<Ribbon />);
    open('Deck.marp');
    const l = labels();
    expect(l).toHaveLength(3);
    expect(l.join('|')).toMatch(/PowerPoint/);
    expect(l.join('|')).toMatch(/HTML/);
  });

  it('shows no export for other kinds of file', () => {
    render(<Ribbon />);
    open('Photo.png');
    expect(labels()).toEqual([]);
    open('data.csv');
    expect(labels()).toEqual([]);
  });
});
