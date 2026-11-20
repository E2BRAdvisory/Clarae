import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Ribbon } from './Ribbon';
import { api, linkInfo } from '../app/api';
import { initI18n } from '../i18n';
import { configurePlatform } from '../platform';
import { installWailsMock } from '../test/wails-mock';
import { useManaged } from '../state/managed';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { resetTerminal } from '../terminal/controller';
import { useTerminal } from '../terminal/store';

beforeEach(async () => {
  initI18n('en');
  installWailsMock();
  const info = await api.vault.open('/vaults/Ribbon');
  useAppStore.getState().setVault(info);
});
afterEach(() => {
  cleanup();
  configurePlatform();
  resetTerminal();
  useSync.setState({ info: {} });
});

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

describe('ribbon applications', () => {
  it('has "New application" unless the profile turns applications off', () => {
    // on by default (ADR-0060)
    act(() => useManaged.setState({ features: {} }));
    render(<Ribbon />);
    expect(screen.getByRole('button', { name: 'New application' })).toBeEnabled();
    act(() => useManaged.setState({ features: { web_viewer: false } }));
    expect(screen.queryByRole('button', { name: 'New application' })).toBeNull();
    act(() => useManaged.setState({ features: {} }));
  });
});

describe('ribbon terminal', () => {
  const button = () => screen.queryByRole('button', { name: /^Terminal/ });

  it('sits right above Settings, off until a terminal is open', () => {
    render(<Ribbon />);
    const b = button();
    expect(b).toBeEnabled();
    expect(b).toHaveAttribute('aria-pressed', 'false');
    const bottom = b?.closest('.ribbon-bottom');
    const names = [...(bottom?.querySelectorAll('button') ?? [])].map((x) =>
      x.getAttribute('aria-label'),
    );
    expect(names.indexOf('Settings')).toBe(names.indexOf(b?.getAttribute('aria-label') ?? '') + 1);
  });

  it('is pressed while the panel is open, and while the terminal is in its own window', () => {
    render(<Ribbon />);
    act(() => useTerminal.setState({ open: true }));
    expect(button()).toHaveAttribute('aria-pressed', 'true');
    act(() => useTerminal.setState({ open: false }));
    expect(button()).toHaveAttribute('aria-pressed', 'false');
    act(() => useTerminal.setState({ mode: 'detached' }));
    expect(button()).toHaveAttribute('aria-pressed', 'true');
  });

  it('is not there where the host cannot run processes', () => {
    configurePlatform({ kind: 'web' });
    render(<Ribbon />);
    expect(button()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeNull();
  });

  it('is off, with the reason in its tooltip, for a vault the user may only read', () => {
    render(<Ribbon />);
    const id = useAppStore.getState().vault?.id ?? '';
    act(() => useSync.setState({ info: { [id]: linkInfo({ readOnly: true }) } }));
    const b = button();
    expect(b).toBeDisabled();
    expect(b?.getAttribute('title')).toBe('Terminal: this vault is read-only for you');
    // an open terminal can still be closed
    act(() => useTerminal.setState({ open: true }));
    expect(button()).toBeEnabled();
  });
});
