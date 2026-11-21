import {
  Children,
  isValidElement,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';

/** The initials of a name: the first letter of its first two words, upper case ("Anna Maria Rossi" is "AM"). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const first = (w: string): string => Array.from(w)[0] ?? '';
  const letters =
    words.length === 1 ? Array.from(words[0] as string).slice(0, 2) : words.slice(0, 2).map(first);
  return letters.join('').toLocaleUpperCase();
}

export interface AvatarProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'color' | 'children'> {
  /** Whose avatar it is: its initials are shown and it is the accessible name. */
  name: string;
  /** Background: a CSS colour or `var(--token)`. Defaults to the neutral surface. */
  color?: string;
  /** Text colour on `color`: choose a pair that reaches 4.5:1. */
  textColor?: string;
  /**
   * An image, optional: there are no profile pictures in Clarae and the CSP (`img-src`) blocks remote
   * origins, so only a `data:` / `blob:` / same-origin URL can show. The initials remain as the fallback
   * when it fails to load.
   */
  src?: string;
  /** Diameter in px (default 24). */
  size?: number;
  className?: string;
}

/** A round avatar: initials on a colour, with the name as `title` (tooltip) and accessible name. */
export function Avatar({ name, color, textColor, src, size, className, ...rest }: AvatarProps) {
  const [broken, setBroken] = useState(false);
  const vars = {
    ...(color ? { '--nd-avatar-bg': color } : {}),
    ...(textColor ? { '--nd-avatar-fg': textColor } : {}),
    ...(size ? { '--nd-avatar-size': `${size}px` } : {}),
  } as CSSProperties;
  return (
    <span
      {...rest}
      role="img"
      aria-label={name}
      title={name}
      className={['nd-avatar', className].filter(Boolean).join(' ')}
      style={vars}
    >
      <span aria-hidden="true">{initialsOf(name)}</span>
      {src && !broken ? <img src={src} alt="" onError={() => setBroken(true)} /> : null}
    </span>
  );
}

export type AvatarSpacing = 'small' | 'medium' | number;

export interface AvatarGroupProps {
  /** `Avatar` elements. */
  children: ReactNode;
  /** How many avatars are shown; the rest becomes the `+N` badge. Default 4. */
  max?: number;
  /** The overlap of the avatars: `small` (default), `medium` or a number of px. */
  spacing?: AvatarSpacing;
  /** Accessible name of the list ("People here"). */
  label: string;
  /** Text of the badge for the hidden ones, for the tooltip and the accessible name ("2 more: Anna, Bruno"). */
  moreLabel?: (count: number, names: string[]) => string;
  /** Diameter of the avatars in px (default 24). */
  size?: number;
  className?: string;
}

const OVERLAP: Record<'small' | 'medium', number> = { small: 8, medium: 14 };

/**
 * Overlapping avatars like the MUI AvatarGroup: the first `max` are drawn, a `+N` badge stands for the
 * others (its tooltip lists their names). The border of each is `--nd-avatar-border`, which the host sets
 * to the colour of the surface the group sits on. Nothing is drawn for an empty group.
 */
export function AvatarGroup({
  children,
  max = 4,
  spacing = 'small',
  label,
  moreLabel,
  size,
  className,
}: AvatarGroupProps) {
  const all = Children.toArray(children).filter(isValidElement) as ReactElement<AvatarProps>[];
  if (all.length === 0) return null;
  const shown = all.slice(0, Math.max(0, max));
  const hidden = all.slice(shown.length);
  const names = hidden.map((a) => a.props.name);
  const more = moreLabel
    ? moreLabel(hidden.length, names)
    : `+${hidden.length}: ${names.join(', ')}`;
  const overlap = typeof spacing === 'number' ? spacing : OVERLAP[spacing];
  const vars = {
    '--nd-avatar-overlap': `${overlap}px`,
    ...(size ? { '--nd-avatar-size': `${size}px` } : {}),
  } as CSSProperties;
  return (
    <ul
      className={['nd-avatar-group', className].filter(Boolean).join(' ')}
      aria-label={label}
      style={vars}
      data-testid="avatar-group"
    >
      {shown.map((a, i) => (
        <li key={a.key ?? i}>{a}</li>
      ))}
      {hidden.length > 0 && (
        <li>
          <span
            role="img"
            className="nd-avatar nd-avatar--more"
            aria-label={more}
            title={more}
            data-testid="avatar-more"
          >
            <span aria-hidden="true">+{hidden.length}</span>
          </span>
        </li>
      )}
    </ul>
  );
}
