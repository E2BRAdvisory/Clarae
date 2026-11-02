import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { initI18n } from '../i18n';
import { dialog, DialogHost } from './dialogs';

describe('dialog.pick', () => {
  it('mounts only the first matches of a long list and narrows with the filter', async () => {
    initI18n('en');
    render(<DialogHost />);
    const items = Array.from({ length: 5000 }, (_, i) => ({
      value: `n${i}.md`,
      label: `Note ${i}`,
    }));
    let picked: Promise<string | null> = Promise.resolve(null);
    act(() => {
      picked = dialog.pick('Add a note', items);
    });
    const list = await screen.findByRole('listbox', { name: 'Add a note' });
    expect(list.querySelectorAll('[role="option"]')).toHaveLength(200);
    expect(screen.getByText('4800 more: type to narrow the list')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter…'), { target: { value: 'note 4999' } });
    expect(list.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(screen.queryByText(/more: type to narrow/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Note 4999' }));
    await expect(picked).resolves.toBe('n4999.md');
  });
});
