import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTree } from '../state/queries';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { dialog } from '../ui/dialogs';
import { activateBookmark, newBookmarkGroup } from './actions';
import {
  groupsOf,
  isGroup,
  itemLabel,
  moveItem,
  pathKey,
  removeItem,
  renameItem,
  type BookmarkItem,
  type ItemPath,
} from './model';
import { Icon, type IconName } from '../shell/icons';
import { bookmarksReadOnly, useBookmarks } from './store';
import './bookmarks.css';

const DRAG_TYPE = 'application/x-memobrain-bookmark';

type Drop = { key: string; zone: 'before' | 'after' | 'into' } | null;

const ICONS: Record<string, IconName> = {
  file: 'note',
  folder: 'folderClosed',
  search: 'search',
  graph: 'graph',
};

function iconOf(item: BookmarkItem): IconName {
  if (item.type === 'file') {
    const sub = item.subpath ?? '';
    if (sub.startsWith('#')) return 'tag';
  }
  return ICONS[item.type] ?? 'note';
}

/** The Bookmarks sidebar tab: a tree of groups and bookmarks, draggable and keyboard operable. */
export function BookmarksPanel({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const items = useBookmarks((s) => s.file.items);
  const update = useBookmarks((s) => s.update);
  const readOnly = bookmarksReadOnly(vaultId);
  const { data: entries } = useTree(vaultId);
  const existing = useMemo(() => (entries ? new Set(entries.map((e) => e.path)) : null), [entries]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [drop, setDrop] = useState<Drop>(null);

  const isMissing = (item: BookmarkItem): boolean =>
    item.type === 'file' && !!existing && !existing.has(item.path ?? '');

  const toggle = (key: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const rename = async (path: ItemPath, item: BookmarkItem): Promise<void> => {
    const title = await dialog.prompt(t('bookmarks.renamePrompt'), itemLabel(item));
    if (title !== null) update((list) => renameItem(list, path, title));
  };

  const remove = async (path: ItemPath, item: BookmarkItem): Promise<void> => {
    if (isGroup(item)) {
      const n = item.items?.length ?? 0;
      const ok = await dialog.confirm(
        t('bookmarks.deleteGroup'),
        t('bookmarks.deleteGroupConfirm', { name: itemLabel(item), count: n }),
        true,
      );
      if (!ok) return;
    }
    update((list) => removeItem(list, path));
  };

  const moveTo = async (path: ItemPath): Promise<void> => {
    const groups = groupsOf(items).filter(
      (g) => !(g.path.length >= path.length && path.every((v, i) => g.path[i] === v)),
    );
    const root = t('bookmarks.root');
    const key = await dialog.pick(t('bookmarks.moveTo'), [
      { value: '', label: root },
      ...groups.map((g) => ({
        value: pathKey(g.path),
        label: `${'— '.repeat(g.depth)}${g.title}`,
      })),
    ]);
    if (key === null) return;
    const dest = key === '' ? [] : (groups.find((g) => pathKey(g.path) === key)?.path ?? null);
    if (dest) update((list) => moveItem(list, path, dest));
  };

  const contextFor = (path: ItemPath, item: BookmarkItem): MenuItem[] => {
    const open: MenuItem[] = isGroup(item)
      ? []
      : [
          { label: t('bookmarks.openItem'), onSelect: () => void activateBookmark(item) },
          { label: t('sidebar.openNewTab'), onSelect: () => void activateBookmark(item, true) },
        ];
    if (readOnly) return open;
    return [
      ...open,
      {
        label: t('bookmarks.rename'),
        onSelect: () => void rename(path, item),
        separator: open.length > 0,
      },
      ...(isGroup(item)
        ? [{ label: t('bookmarks.newGroupInside'), onSelect: () => void newBookmarkGroup(path) }]
        : []),
      { label: t('bookmarks.moveTo'), onSelect: () => void moveTo(path) },
      {
        label: t('bookmarks.remove'),
        onSelect: () => void remove(path, item),
        danger: true,
        separator: true,
      },
    ];
  };

  const onDropOn = (e: React.DragEvent, path: ItemPath, item: BookmarkItem, zone: string): void => {
    e.preventDefault();
    e.stopPropagation();
    setDrop(null);
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw || readOnly) return;
    const from = raw.split('.').map(Number);
    const parent = path.slice(0, -1);
    const idx = path[path.length - 1] as number;
    if (zone === 'into' && isGroup(item)) update((list) => moveItem(list, from, path));
    else update((list) => moveItem(list, from, parent, zone === 'after' ? idx + 1 : idx));
  };

  const render = (list: BookmarkItem[], prefix: ItemPath, depth: number): React.ReactNode =>
    list.map((item, i) => {
      const path = [...prefix, i];
      const key = pathKey(path);
      const group = isGroup(item);
      const open = group && !collapsed.has(key);
      const missing = isMissing(item);
      const label = itemLabel(item);
      const hint = drop?.key === key ? `drop-${drop.zone}` : '';
      return (
        <div key={key} role="none">
          <div
            className={`node bookmark ${group ? 'group' : item.type} ${missing ? 'missing' : ''} ${hint}`}
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={group ? open : undefined}
            tabIndex={0}
            style={{ paddingLeft: 8 + depth * 14 }}
            title={missing ? t('bookmarks.missing', { path: item.path }) : label}
            draggable={!readOnly}
            onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, key)}
            onDragEnd={() => setDrop(null)}
            onDragOver={(e) => {
              if (readOnly || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
              e.preventDefault();
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              const y = (e.clientY - r.top) / (r.height || 1);
              const zone = group && y > 0.25 && y < 0.75 ? 'into' : y < 0.5 ? 'before' : 'after';
              setDrop({ key, zone });
            }}
            onDrop={(e) => onDropOn(e, path, item, drop?.key === key ? drop.zone : 'before')}
            onClick={(e) =>
              group ? toggle(key) : void activateBookmark(item, e.metaKey || e.ctrlKey)
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (group) toggle(key);
                else void activateBookmark(item, e.metaKey || e.ctrlKey);
              } else if (e.key === 'F2' && !readOnly) {
                e.preventDefault();
                void rename(path, item);
              } else if ((e.key === 'Delete' || e.key === 'Backspace') && !readOnly) {
                e.preventDefault();
                void remove(path, item);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ x: e.clientX, y: e.clientY, items: contextFor(path, item) });
            }}
          >
            <span className="caret">
              {group ? <Icon name={open ? 'chevronDown' : 'chevronRight'} /> : null}
            </span>
            <span className="icon-type" aria-hidden="true">
              {group ? null : <Icon name={iconOf(item)} size={16} />}
            </span>
            <span className="name">{label}</span>
          </div>
          {group && open && <div role="group">{render(item.items ?? [], path, depth + 1)}</div>}
        </div>
      );
    });

  return (
    <>
      <div className="toolbar">
        <button
          className="icon"
          disabled={readOnly}
          onClick={() => void newBookmarkGroup()}
          title={t('bookmarks.newGroup')}
          aria-label={t('bookmarks.newGroup')}
        >
          <Icon name="folderPlus" />
        </button>
        <span className="spacer" />
        {readOnly && <span className="muted">{t('bookmarks.readOnly')}</span>}
      </div>
      <div
        className="content tree bookmarks"
        // An empty tree would have no treeitem (only the hint): it is a plain region then.
        {...(items.length > 0 ? { role: 'tree', 'aria-label': t('bookmarks.title') } : {})}
        onDragOver={(e) => {
          if (!readOnly && e.dataTransfer.types.includes(DRAG_TYPE)) e.preventDefault();
        }}
        onDrop={(e) => {
          const raw = e.dataTransfer.getData(DRAG_TYPE);
          setDrop(null);
          if (raw && !readOnly) update((list) => moveItem(list, raw.split('.').map(Number), []));
        }}
      >
        {items.length === 0 && <div className="muted pad">{t('bookmarks.empty')}</div>}
        {render(items, [], 0)}
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </>
  );
}
