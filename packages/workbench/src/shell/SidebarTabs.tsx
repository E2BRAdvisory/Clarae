import { Icon, type IconName } from './icons';

export function SidebarTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  icon,
}: {
  tabs: readonly T[];
  value: T;
  onChange: (t: T) => void;
  label: (t: T) => string;
  /** When given, tabs show only the icon (the label stays as accessible name and tooltip). */
  icon?: (t: T) => IconName;
}) {
  // Roving tabindex: one tab stop, arrows/Home/End move and activate.
  const onKey = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = tabs.length;
    let target = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') target = (i + 1) % n;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') target = (i - 1 + n) % n;
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = n - 1;
    if (target < 0) return;
    e.preventDefault();
    const next = tabs[target];
    if (next === undefined) return;
    onChange(next);
    const all = e.currentTarget.parentElement?.querySelectorAll('[role="tab"]');
    requestAnimationFrame(() => (all?.[target] as HTMLElement | undefined)?.focus());
  };
  return (
    <div className={`tabs${icon ? ' icons' : ''}`} role="tablist">
      {tabs.map((tab, i) => (
        <button
          key={tab}
          role="tab"
          aria-selected={value === tab}
          tabIndex={value === tab ? 0 : -1}
          className={value === tab ? 'active' : ''}
          onClick={() => onChange(tab)}
          onKeyDown={(e) => onKey(e, i)}
          {...(icon ? { title: label(tab), 'aria-label': label(tab) } : {})}
        >
          {icon ? <Icon name={icon(tab)} /> : label(tab)}
        </button>
      ))}
    </div>
  );
}
