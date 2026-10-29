import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BaseView } from './BaseView';
import { cellText, splitLink, toggleColumn, toggleSort, viewIndexByName } from './model';
import type { BaseInfo, BaseViewInfo } from './types';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock } from '../test/wails-mock';

const BASE = `filters:
  and:
    - 'file.inFolder("Tasks")'
views:
  - type: table
    name: Open
    order:
      - file.name
      - status
      - done
    filters:
      and:
        - 'status == "open"'
    sort:
      - property: status
        direction: ASC
`;

describe('bases model', () => {
  const view = (sort: BaseViewInfo['sort']): BaseViewInfo => ({
    name: 'v',
    type: 'table',
    supported: true,
    notice: '',
    order: [],
    sort,
    groupBy: null,
    limit: 0,
    filters: [],
    baseFilters: [],
  });

  it('formats cells and links', () => {
    expect(splitLink('[[A/B.md|Bee]]')).toEqual({ target: 'A/B.md', display: 'Bee' });
    expect(splitLink('[[A/B.md]]').display).toBe('B');
    expect(cellText({ k: 'list', v: ['a', 'b'] })).toBe('a, b');
    expect(cellText({ k: 'checkbox', v: true })).toBe('✓');
    expect(cellText({ k: 'datetime', v: '2026-01-02T10:30:00' })).toBe('2026-01-02 10:30');
    expect(cellText({ k: 'error', e: 'boom' })).toBe('boom');
    expect(cellText({ k: 'duration', v: 172_800_000 })).toBe('2d');
    expect(cellText({ k: 'null' })).toBe('');
  });

  it('cycles the sort and toggles columns', () => {
    expect(toggleSort(view([]), 'x')).toEqual({ sort: [{ property: 'x', direction: 'ASC' }] });
    expect(toggleSort(view([{ property: 'note.x', direction: 'ASC' }]), 'x')).toEqual({
      sort: [{ property: 'x', direction: 'DESC' }],
    });
    expect(toggleSort(view([{ property: 'x', direction: 'DESC' }]), 'x')).toEqual({ sort: [] });
    expect(toggleColumn(['a', 'b'], 'b')).toEqual(['a']);
    expect(toggleColumn(['a'], 'c')).toEqual(['a', 'c']);
    const info = { views: [{ name: 'One' }, { name: 'Two' }] } as BaseInfo;
    expect(viewIndexByName(info, 'two')).toBe(1);
    expect(viewIndexByName(info, 'zzz')).toBe(0);
  });
});

describe('BaseView', () => {
  it('shows the rows of a view and edits a property inline', async () => {
    initI18n('en');
    const mock = installWailsMock();
    const v = await api.vault.open('/v/Bases');
    const files = mock.vaults.get(v.id)?.files;
    files?.set('Tasks/One.md', '---\nstatus: open\ndone: false\n---\nx');
    files?.set('Tasks/Two.md', '---\nstatus: closed\n---\nx');
    files?.set('Other/Three.md', '---\nstatus: open\n---\nx');
    files?.set('Tasks/Board.base', BASE);
    render(<BaseView vaultId={v.id} path="Tasks/Board.base" />);
    expect(await screen.findByText('One')).toBeInTheDocument();
    expect(screen.queryByText('Two')).toBeNull();
    expect(screen.queryByText('Three')).toBeNull();
    expect(screen.getByText('file.inFolder("Tasks")')).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole('table')).getByRole('checkbox'));
    await waitFor(() => expect(files?.get('Tasks/One.md')).toContain('done: true'));
  });

  it('degrades gracefully on an unsupported view type', async () => {
    initI18n('en');
    const mock = installWailsMock();
    const v = await api.vault.open('/v/Bases2');
    mock.vaults.get(v.id)?.files.set('Geo.base', 'views:\n  - type: map\n    name: Places\n');
    render(<BaseView vaultId={v.id} path="Geo.base" />);
    expect(await screen.findByText(/is not supported yet/)).toBeInTheDocument();
  });
});
