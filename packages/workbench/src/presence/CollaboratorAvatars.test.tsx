import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initI18n } from '../i18n';
import { configurePlatform, usePlatform } from '../platform';
import { useManaged } from '../state/managed';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { emptyLayout } from '../workspace/layout';
import { CollaboratorAvatars } from './CollaboratorAvatars';
import { getUserColor } from './colors';
import { usePresenceStore } from './store';

let mock: WailsMock;
const people = ['Ada', 'Bob', 'Cy', 'Di', 'Ed', 'Flo'].map((name, i) => ({
  sid: `s${i}`,
  userId: `u-${name.toLowerCase()}`,
  name,
}));

const openNote = (path: string): void =>
  act(() => {
    useAppStore.setState({ layout: emptyLayout() });
    useAppStore.getState().openNote(path);
  });
const say = (path: string, n: number, vault = 'v1'): void =>
  act(() => mock.presence.members(vault, path, people.slice(0, n)));

beforeEach(() => {
  initI18n('en');
  mock = installWailsMock();
  configurePlatform();
  useManaged.setState({ features: {} });
  useSync.setState({ info: { v1: { linked: true, kind: 'shared' } as never } });
  usePresenceStore.getState().reset();
  openNote('Note.md');
});
afterEach(() => {
  cleanup();
  usePresenceStore.getState().reset();
});

// The feed is what puts the events in the store: here the events go straight to it.
import { installPresenceFeed } from './store';
let off: () => void;
beforeEach(() => {
  off = installPresenceFeed();
});
afterEach(() => off());

describe('the avatars of the collaborators', () => {
  it('draw nothing when nobody else is in the file', () => {
    const { container } = render(<CollaboratorAvatars vaultId="v1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('show the people of the file in front, named, with the colour of each user', () => {
    render(<CollaboratorAvatars vaultId="v1" />);
    say('Note.md', 2);
    const list = screen.getByRole('list', { name: 'People in this file' });
    const avatars = within(list).getAllByTestId('presence-avatar');
    expect(avatars.map((a) => a.getAttribute('aria-label'))).toEqual(['Ada', 'Bob']);
    expect(avatars[0]!.style.getPropertyValue('--nd-avatar-bg')).toBe(
      getUserColor('u-ada').background,
    );
    expect(avatars[0]!.style.getPropertyValue('--nd-avatar-fg')).toBe(
      getUserColor('u-ada').foreground,
    );
    expect(avatars[1]).toHaveAttribute('data-color', String(getUserColor('u-bob').index));
  });

  it('follow the file in front: other files and other vaults are not shown', () => {
    render(<CollaboratorAvatars vaultId="v1" />);
    say('Other.md', 2);
    say('Note.md', 1, 'v2');
    expect(screen.queryByTestId('avatar-group')).toBeNull();
    say('Note.md', 3);
    expect(screen.getAllByTestId('presence-avatar')).toHaveLength(3);
    openNote('Other.md');
    expect(screen.getAllByTestId('presence-avatar')).toHaveLength(2);
    act(() => useAppStore.setState({ layout: emptyLayout() })); // no tab in front
    expect(screen.queryByTestId('avatar-group')).toBeNull();
  });

  it('stop at four, with a +N badge that names the others', () => {
    render(<CollaboratorAvatars vaultId="v1" />);
    say('Note.md', 6);
    expect(screen.getAllByTestId('presence-avatar')).toHaveLength(4);
    const more = screen.getByTestId('avatar-more');
    expect(more).toHaveTextContent('+2');
    expect(more).toHaveAttribute('title', '2 more: Ed, Flo');
  });

  it('leave with the person: when somebody goes the avatar goes, when all do the group goes', () => {
    render(<CollaboratorAvatars vaultId="v1" />);
    say('Note.md', 3);
    say('Note.md', 2);
    expect(screen.getAllByTestId('presence-avatar')).toHaveLength(2);
    act(() => mock.presence.cleared('v1', 'Note.md'));
    expect(screen.queryByTestId('avatar-group')).toBeNull();
  });

  it('are off without the capability, with the flag off, and in a vault that is not a shared one', () => {
    render(<CollaboratorAvatars vaultId="v1" />);
    say('Note.md', 2);
    expect(screen.getByTestId('avatar-group')).toBeInTheDocument();

    act(() => useManaged.setState({ features: { presence: false } }));
    expect(screen.queryByTestId('avatar-group')).toBeNull();
    act(() => useManaged.setState({ features: {} }));
    expect(screen.getByTestId('avatar-group')).toBeInTheDocument();

    act(() => useSync.setState({ info: { v1: { linked: true, kind: 'private' } as never } }));
    expect(screen.queryByTestId('avatar-group')).toBeNull();
    act(() => useSync.setState({ info: { v1: { linked: false, kind: '' } as never } }));
    expect(screen.queryByTestId('avatar-group')).toBeNull();
    act(() => useSync.setState({ info: { v1: { linked: true, kind: 'shared' } as never } }));
    expect(screen.getByTestId('avatar-group')).toBeInTheDocument();

    act(() =>
      usePlatform.setState((s) => ({ capabilities: { ...s.capabilities, presence: false } })),
    );
    expect(screen.queryByTestId('avatar-group')).toBeNull();
  });
});
