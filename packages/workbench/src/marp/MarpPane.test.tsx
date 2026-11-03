import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { useAppStore } from '../state/store';
import { installWailsMock } from '../test/wails-mock';
import { MarpPane } from './MarpPane';
import { present } from './presenter';

const DECK = '---\nmarp: true\n---\n\n# One\n\n---\n\n## Two\n\n---\n\n## Three\n';

let vaultId: string;

beforeEach(async () => {
  initI18n('en');
  installWailsMock();
  const info = await api.vault.open('/vaults/Notes');
  vaultId = info.id;
  useAppStore.getState().setVault(info);
});

const slides = (): SVGSVGElement[] => [
  ...(screen
    .getByTestId('marp-slides')
    .shadowRoot?.querySelectorAll<SVGSVGElement>('div.marpit > svg') ?? []),
];

describe('Marp preview', () => {
  it('renders the slides in a shadow root with the theme, and marks the slide of the cursor', async () => {
    const view = render(
      <MarpPane
        vaultId={vaultId}
        path="Deck.marp"
        source={DECK}
        cursorLine={7}
        onPickSlide={() => undefined}
      />,
    );
    await waitFor(() => expect(slides()).toHaveLength(3));
    const root = screen.getByTestId('marp-slides').shadowRoot!;
    expect(root.querySelector('style')?.textContent).toContain('div.marpit');
    expect(slides()[1]?.classList.contains('current')).toBe(true);
    view.rerender(
      <MarpPane
        vaultId={vaultId}
        path="Deck.marp"
        source={DECK}
        cursorLine={0}
        onPickSlide={() => undefined}
      />,
    );
    await waitFor(() => expect(slides()[0]?.classList.contains('current')).toBe(true));
  });

  it('follows the text as it changes', async () => {
    const view = render(
      <MarpPane
        vaultId={vaultId}
        path="Deck.marp"
        source={DECK}
        cursorLine={0}
        onPickSlide={() => undefined}
      />,
    );
    await waitFor(() => expect(slides()).toHaveLength(3));
    view.rerender(
      <MarpPane
        vaultId={vaultId}
        path="Deck.marp"
        source={`${DECK}\n---\n\n## Four\n`}
        cursorLine={0}
        onPickSlide={() => undefined}
      />,
    );
    await waitFor(() => expect(slides()).toHaveLength(4));
  });

  it('moves the cursor to a clicked slide', async () => {
    const pick = vi.fn();
    render(
      <MarpPane
        vaultId={vaultId}
        path="Deck.marp"
        source={DECK}
        cursorLine={0}
        onPickSlide={pick}
      />,
    );
    await waitFor(() => expect(slides()).toHaveLength(3));
    fireEvent.click(slides()[2]!);
    expect(pick).toHaveBeenCalledWith(10);
  });

  it('presents one slide at a time, moved with the keys, until Escape', async () => {
    render(
      <MarpPane
        vaultId={vaultId}
        path="Deck.marp"
        source={DECK}
        cursorLine={0}
        onPickSlide={() => undefined}
      />,
    );
    await waitFor(() => expect(slides()).toHaveLength(3));
    const host = screen.getByTestId('marp-slides');
    act(() => void present('Deck.marp'));
    await waitFor(() => expect(host.classList.contains('presenting')).toBe(true));
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(slides()[1]?.classList.contains('current')).toBe(true));
    fireEvent.keyDown(window, { key: 'End' });
    await waitFor(() => expect(slides()[2]?.classList.contains('current')).toBe(true));
    fireEvent.keyDown(window, { key: 'ArrowRight' }); // stays on the last one
    await waitFor(() => expect(slides()[2]?.classList.contains('current')).toBe(true));
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(host.classList.contains('presenting')).toBe(false));
  });

  it('shows PPTX as not available yet', () => {
    render(
      <MarpPane
        vaultId={vaultId}
        path="Deck.marp"
        source={DECK}
        cursorLine={0}
        onPickSlide={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'PPTX' })).toHaveAttribute('aria-disabled', 'true');
  });
});
