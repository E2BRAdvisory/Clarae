import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Avatar, AvatarGroup, initialsOf } from './index';

afterEach(cleanup);

describe('initialsOf', () => {
  it.each([
    ['Anna Rossi', 'AR'],
    ['anna maria rossi', 'AM'],
    ['  Bruno ', 'BR'],
    ['Élodie Ünal', 'ÉÜ'],
    ['', '?'],
  ])('%j is %j', (name, initials) => expect(initialsOf(name)).toBe(initials));
});

describe('Avatar', () => {
  it('shows the initials, names itself and carries the colour pair', () => {
    render(<Avatar name="Anna Rossi" color="var(--a)" textColor="#fff" size={30} />);
    const a = screen.getByRole('img', { name: 'Anna Rossi' });
    expect(a).toHaveAttribute('title', 'Anna Rossi');
    expect(a).toHaveTextContent('AR');
    expect(a.style.getPropertyValue('--nd-avatar-bg')).toBe('var(--a)');
    expect(a.style.getPropertyValue('--nd-avatar-fg')).toBe('#fff');
    expect(a.style.getPropertyValue('--nd-avatar-size')).toBe('30px');
  });

  it('falls back to the initials when the picture fails', () => {
    const { container } = render(<Avatar name="Anna" src="data:image/png;base64,AA==" />);
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('alt', '');
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('img', { name: 'Anna' })).toHaveTextContent('AN');
  });
});

const people = ['Ada', 'Bob', 'Cy', 'Di', 'Ed', 'Flo'];
const group = (n: number, props = {}) => (
  <AvatarGroup label="People here" {...props}>
    {people.slice(0, n).map((p) => (
      <Avatar key={p} name={p} />
    ))}
  </AvatarGroup>
);

describe('AvatarGroup', () => {
  it('is a named list with one item per avatar', () => {
    render(group(3));
    const list = screen.getByRole('list', { name: 'People here' });
    expect(list.querySelectorAll('li')).toHaveLength(3);
    expect(screen.queryByTestId('avatar-more')).toBeNull();
  });

  it('shows 4 by default and a +N badge whose tooltip lists the hidden names', () => {
    render(group(6));
    expect(screen.getAllByRole('img')).toHaveLength(5); // 4 avatars + the badge
    const more = screen.getByTestId('avatar-more');
    expect(more).toHaveTextContent('+2');
    expect(more).toHaveAttribute('title', '+2: Ed, Flo');
    expect(more).toHaveAttribute('aria-label', '+2: Ed, Flo');
    expect(screen.queryByRole('img', { name: 'Ed' })).toBeNull();
  });

  it('honours max and a custom text for the badge', () => {
    render(
      group(6, {
        max: 2,
        moreLabel: (n: number, names: string[]) => `${n} more (${names.join('/')})`,
      }),
    );
    expect(screen.getByTestId('avatar-more')).toHaveAttribute('title', '4 more (Cy/Di/Ed/Flo)');
    expect(screen.getAllByRole('img')).toHaveLength(3);
  });

  it('overlaps by the spacing and leaves the border to the host', () => {
    const { rerender } = render(group(2));
    expect(screen.getByTestId('avatar-group').style.getPropertyValue('--nd-avatar-overlap')).toBe(
      '8px',
    );
    rerender(group(2, { spacing: 'medium' }));
    expect(screen.getByTestId('avatar-group').style.getPropertyValue('--nd-avatar-overlap')).toBe(
      '14px',
    );
    rerender(group(2, { spacing: 5 }));
    expect(screen.getByTestId('avatar-group').style.getPropertyValue('--nd-avatar-overlap')).toBe(
      '5px',
    );
  });

  it('draws nothing when empty', () => {
    const { container } = render(<AvatarGroup label="x">{[]}</AvatarGroup>);
    expect(container).toBeEmptyDOMElement();
  });
});
