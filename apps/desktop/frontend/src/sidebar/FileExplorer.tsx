import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Entry } from '../app/api';
import { featureOn, useManaged } from '../state/managed';
import { useSharing } from '../state/sharing';
import { infoOf, useSync } from '../state/sync';
import { useRecovery } from '../recovery/store';
import { newCanvas } from '../canvas/commands';
import { newBase } from '../bases/commands';
import { newDrawing } from '../drawing/commands';
import { createFolder, createNote, deleteEntry, renameEntry } from '../app/actions';
import { selectActivePath, useAppStore } from '../state/store';
import { useTree } from '../state/queries';
import { bookmarkMenuItems } from '../bookmarks/actions';
import { useSettings } from '../state/settings';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { dialog } from '../ui/dialogs';
import { useExpanded } from './expanded';

interface TreeNode {
  entry: Entry;
  children: TreeNode[];
}

export type FileSort = 'name' | 'name-desc' | 'modified' | 'created';

export function buildTree(entries: Entry[], sort: FileSort = 'name'): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  for (const entry of entries) {
    const node: TreeNode = { entry, children: [] };
    byPath.set(entry.path, node);
    const i = entry.path.lastIndexOf('/');
    const parent = i >= 0 ? byPath.get(entry.path.slice(0, i)) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const time = (e: Entry): number => new Date(e.mtime as string).getTime() || 0;
  const cmp = (a: TreeNode, b: TreeNode): number => {
    if (a.entry.isDir !== b.entry.isDir) return a.entry.isDir ? -1 : 1;
    const byName = a.entry.name.localeCompare(b.entry.name, undefined, {
      sensitivity: 'base',
      numeric: true,
    });
    if (sort === 'name-desc') return -byName;
    if (sort === 'modified' || sort === 'created') return time(b.entry) - time(a.entry) || byName;
    return byName;
  };
  const sortNodes = (nodes: TreeNode[]): void => {
    nodes.sort(cmp);
    nodes.forEach((n) => sortNodes(n.children));
  };
  sortNodes(roots);
  return roots;
}

/** Fixed row height of the tree (px): rows are windowed, so every row must have the same height. */
export const ROW_HEIGHT = 24;
const OVERSCAN = 12;
/** Viewport height assumed until the container is measured (and where layout does not exist, as in jsdom). */
const FALLBACK_VIEWPORT = 800;

export interface FlatRow {
  node: TreeNode;
  depth: number;
  /** Path of the containing folder, null at the top level (keyboard navigation goes there with ←). */
  parent: string | null;
  /** A folder whose children are listed right below it. */
  open: boolean;
}

/** The visible rows in display order; only the folders in `open` show their content. */
export function flattenTree(nodes: TreeNode[], open: ReadonlySet<string>): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (list: TreeNode[], depth: number, parent: string | null): void => {
    for (const node of list) {
      const isOpen = node.entry.isDir && open.has(node.entry.path);
      out.push({ node, depth, parent, open: isOpen });
      if (isOpen) walk(node.children, depth + 1, node.entry.path);
    }
  };
  walk(nodes, 0, null);
  return out;
}

/** Dot-files and dot-folders (.memobrain, .trash, .git) are not shown in the explorer. */
export const isHidden = (path: string): boolean => path.split('/').some((s) => s.startsWith('.'));

const parentDir = (path: string | null): string =>
  path && path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const display = (e: Entry): string =>
  e.isDir || !e.name.endsWith('.md') ? e.name : e.name.slice(0, -3);

async function guard(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (e) {
    await dialog.error(e);
  }
}

export function FileExplorer({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const { data: entries = [] } = useTree(vaultId);
  const activePath = useAppStore(selectActivePath);
  const openNote = useAppStore((s) => s.openNote);
  const expanded = useExpanded((s) => s.open);
  const toggle = (path: string): void => useExpanded.getState().toggle(path);
  const [sort, setSort] = useState<FileSort>('name');
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const info = useSync((st) => infoOf(st, vaultId));
  const sharingOn = useManaged((m) => featureOn(m.features, 'sharing'));
  const readOnly = info.readOnly;
  const drawingsOn = useManaged((m) => featureOn(m.features, 'drawings'));
  const canvasOn = useManaged((m) => featureOn(m.features, 'canvas'));
  const canShare = sharingOn && info.linked && info.kind === 'shared' && !info.mount;
  const tree = useMemo(
    () =>
      buildTree(
        entries.filter((e) => !isHidden(e.path)),
        sort,
      ),
    [entries, sort],
  );

  // Only the rows in (or near) the viewport are mounted: with tens of thousands of notes the
  // full tree was 50,000 DOM nodes and seconds of render and toggle time.
  const rows = useMemo(() => flattenTree(tree, expanded), [tree, expanded]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = (): void => setViewport(el.clientHeight || FALLBACK_VIEWPORT);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const dirForNew = (entry?: Entry): string =>
    entry ? (entry.isDir ? entry.path : parentDir(entry.path)) : parentDir(activePath);

  const newNote = async (dir: string) => {
    await guard(createNote({ dir }));
  };
  const newDrawingIn = async (dir: string) => {
    await guard(newDrawing({ dir }));
  };
  const newCanvasIn = async (dir: string) => {
    await guard(newCanvas({ dir }));
  };
  const newBaseIn = async (dir: string) => {
    await guard(newBase({ dir }));
  };
  const newFolder = async (dir: string) => {
    const name = await dialog.prompt(t('sidebar.promptFolderName'));
    if (name) await guard(createFolder((dir ? dir + '/' : '') + name));
  };
  const rename = async (entry: Entry) => {
    const name = await dialog.prompt(t('sidebar.promptRename'), entry.name);
    if (!name || name === entry.name) return;
    const dir = parentDir(entry.path);
    await guard(
      renameEntry(entry.path, (dir ? dir + '/' : '') + name, ({ notes, links }) =>
        dialog.confirm(t('sidebar.rename'), t('sidebar.confirmLinkUpdate', { links, notes })),
      ),
    );
  };
  const trash = async (entry: Entry) => {
    if (
      useSettings.getState().editor.confirmDelete &&
      !(await dialog.confirm(t('sidebar.trash'), entry.path, true))
    )
      return;
    await guard(deleteEntry(entry.path));
  };
  const move = async (from: string, intoDir: string) => {
    if (readOnly) return;
    const name = from.slice(from.lastIndexOf('/') + 1);
    const to = (intoDir ? intoDir + '/' : '') + name;
    if (to === from || intoDir === from || intoDir.startsWith(from + '/')) return;
    await guard(
      renameEntry(from, to, ({ notes, links }) =>
        dialog.confirm(t('sidebar.rename'), t('sidebar.confirmLinkUpdate', { links, notes })),
      ),
    );
  };

  const recoveryItem = (entry: Entry): MenuItem => ({
    label: t('commands.recovery_open'),
    onSelect: () => useRecovery.getState().openNote(entry.path),
  });
  const contextFor = (entry: Entry): MenuItem[] =>
    readOnly
      ? [
          ...(!entry.isDir
            ? [
                {
                  label: t('sidebar.openNewTab'),
                  onSelect: () => openNote(entry.path, { newTab: true }),
                },
                recoveryItem(entry),
              ]
            : []),
          {
            label: t('sidebar.copyPath'),
            onSelect: () => void navigator.clipboard?.writeText(entry.path),
          },
        ]
      : [
          ...(!entry.isDir
            ? [
                {
                  label: t('sidebar.openNewTab'),
                  onSelect: () => openNote(entry.path, { newTab: true }),
                },
                {
                  label: t('sidebar.openRight'),
                  onSelect: () => openNote(entry.path, { split: 'row' }),
                },
                recoveryItem(entry),
              ]
            : []),
          {
            label: t('sidebar.newNote'),
            onSelect: () => void newNote(dirForNew(entry)),
            separator: !entry.isDir,
          },
          ...(drawingsOn
            ? [
                {
                  label: t('sidebar.newDrawing'),
                  onSelect: () => void newDrawingIn(dirForNew(entry)),
                },
              ]
            : []),
          ...(canvasOn
            ? [
                {
                  label: t('sidebar.newCanvas'),
                  onSelect: () => void newCanvasIn(dirForNew(entry)),
                },
              ]
            : []),
          { label: t('bases.new'), onSelect: () => void newBaseIn(dirForNew(entry)) },
          { label: t('sidebar.newFolder'), onSelect: () => void newFolder(dirForNew(entry)) },
          ...(canShare
            ? [
                {
                  label: t('sharing.menuShare'),
                  onSelect: () =>
                    useSharing.getState().openShare({ path: entry.path, isDir: entry.isDir }),
                  separator: true,
                },
              ]
            : []),
          { label: t('sidebar.rename'), onSelect: () => void rename(entry), separator: !canShare },
          {
            label: t('sidebar.copyPath'),
            onSelect: () => void navigator.clipboard?.writeText(entry.path),
          },
          ...bookmarkMenuItems(entry.path, entry.isDir),
          {
            label: t('sidebar.trash'),
            onSelect: () => void trash(entry),
            danger: true,
            separator: true,
          },
        ];

  // The one row that is in the tab order (roving tabindex): the focused one, else the active note.
  const tabbable =
    rows.find((r) => r.node.entry.path === focusPath)?.node.entry.path ??
    rows.find((r) => r.node.entry.path === activePath)?.node.entry.path ??
    rows[0]?.node.entry.path;
  const focusRow = (path: string) => {
    const i = rows.findIndex((r) => r.node.entry.path === path);
    if (i < 0) return;
    setFocusPath(path);
    // The row may be outside the mounted window: scroll it in before focusing it.
    const el = scroller.current;
    if (el) {
      const top = i * ROW_HEIGHT;
      let next = el.scrollTop;
      if (top < next) next = top;
      else if (top + ROW_HEIGHT > next + viewport) next = top + ROW_HEIGHT - viewport;
      if (next !== el.scrollTop) {
        el.scrollTop = next;
        setScrollTop(next);
      }
    }
    requestAnimationFrame(() => {
      const items = [
        ...(scroller.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []),
      ];
      items.find((x) => x.dataset['path'] === path)?.focus();
    });
  };
  // WAI-ARIA tree: arrows move/expand/collapse, Enter opens, F2 renames, Delete trashes,
  // the context-menu key (or Shift+F10) opens the same menu as a right click.
  const onTreeKey = (e: React.KeyboardEvent<HTMLElement>, entry: Entry) => {
    const i = rows.findIndex((r) => r.node.entry.path === entry.path);
    const row = rows[i];
    if (!row) return;
    const go = (to: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (target) focusRow(target.node.entry.path);
    };
    switch (true) {
      case e.key === 'ArrowDown':
        go(i + 1);
        break;
      case e.key === 'ArrowUp':
        go(i - 1);
        break;
      case e.key === 'Home':
        go(0);
        break;
      case e.key === 'End':
        go(rows.length - 1);
        break;
      case e.key === 'ArrowRight':
        if (entry.isDir && !row.open) toggle(entry.path);
        else if (entry.isDir) go(i + 1);
        break;
      case e.key === 'ArrowLeft':
        if (entry.isDir && row.open) toggle(entry.path);
        else if (row.parent !== null) focusRow(row.parent);
        break;
      case e.key === 'Enter' || e.key === ' ':
        if (entry.isDir) toggle(entry.path);
        else openNote(entry.path, { newTab: e.metaKey || e.ctrlKey });
        break;
      case e.key === 'F2' && !readOnly:
        void rename(entry);
        break;
      case e.key === 'Delete' && !readOnly:
        void trash(entry);
        break;
      case e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey): {
        const r = e.currentTarget.getBoundingClientRect();
        setMenu({ x: r.left + 24, y: r.bottom, items: contextFor(entry) });
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
  const renderRows = () =>
    rows.slice(first, last).map(({ node, depth, open }) => {
      const { entry } = node;
      return (
        <div
          key={entry.path}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={entry.isDir ? open : undefined}
          aria-selected={activePath === entry.path}
          data-path={entry.path}
          tabIndex={tabbable === entry.path ? 0 : -1}
          onFocus={() => setFocusPath(entry.path)}
          onKeyDown={(e) => onTreeKey(e, entry)}
          className={`node ${entry.isDir ? 'folder' : 'file'} ${activePath === entry.path ? 'active' : ''} ${dropTarget === entry.path ? 'drop' : ''}`}
          style={{ paddingLeft: 8 + depth * 14, height: ROW_HEIGHT, boxSizing: 'border-box' }}
          draggable={!readOnly}
          onDragStart={(e) => e.dataTransfer.setData('application/x-memobrain-path', entry.path)}
          onDragOver={(e) => {
            if (!entry.isDir || !e.dataTransfer.types.includes('application/x-memobrain-path'))
              return;
            e.preventDefault();
            setDropTarget(entry.path);
          }}
          onDragLeave={() => setDropTarget((d) => (d === entry.path ? null : d))}
          onDrop={(e) => {
            e.preventDefault();
            setDropTarget(null);
            const from = e.dataTransfer.getData('application/x-memobrain-path');
            if (from && entry.isDir) void move(from, entry.path);
          }}
          onClick={(e) =>
            entry.isDir
              ? toggle(entry.path)
              : openNote(entry.path, { newTab: e.metaKey || e.ctrlKey })
          }
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu({ x: e.clientX, y: e.clientY, items: contextFor(entry) });
          }}
          title={entry.path}
        >
          <span className="caret" aria-hidden="true">
            {entry.isDir ? (open ? '▾' : '▸') : ''}
          </span>
          <span className="name">{display(entry)}</span>
        </div>
      );
    });

  return (
    <>
      <div className="toolbar">
        <button
          className="icon"
          disabled={readOnly}
          onClick={() => void newNote(dirForNew())}
          title={t('sidebar.newNote')}
          aria-label={t('sidebar.newNote')}
        >
          ＋📝
        </button>
        <button
          className="icon"
          disabled={readOnly}
          onClick={() => void newFolder(dirForNew())}
          title={t('sidebar.newFolder')}
          aria-label={t('sidebar.newFolder')}
        >
          ＋📁
        </button>
        <span className="spacer" />
        <select
          aria-label={t('sidebar.sort')}
          value={sort}
          onChange={(e) => setSort(e.target.value as FileSort)}
        >
          <option value="name">{t('sidebar.sortName')}</option>
          <option value="name-desc">{t('sidebar.sortNameDesc')}</option>
          <option value="modified">{t('sidebar.sortModified')}</option>
        </select>
      </div>
      <div
        ref={scroller}
        role="tree"
        aria-label={t('sidebar.files')}
        className={`content tree ${dropTarget === '' ? 'drop' : ''}`}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (readOnly) return;
          setMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              { label: t('sidebar.newNote'), onSelect: () => void newNote('') },
              ...(drawingsOn
                ? [{ label: t('sidebar.newDrawing'), onSelect: () => void newDrawingIn('') }]
                : []),
              ...(canvasOn
                ? [{ label: t('sidebar.newCanvas'), onSelect: () => void newCanvasIn('') }]
                : []),
              { label: t('bases.new'), onSelect: () => void newBaseIn('') },
              { label: t('sidebar.newFolder'), onSelect: () => void newFolder('') },
            ],
          });
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/x-memobrain-path')) {
            e.preventDefault();
            setDropTarget('');
          }
        }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(e) => {
          const from = e.dataTransfer.getData('application/x-memobrain-path');
          setDropTarget(null);
          if (from) void move(from, '');
        }}
      >
        <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
          <div style={{ position: 'absolute', top: first * ROW_HEIGHT, left: 0, right: 0 }}>
            {renderRows()}
          </div>
        </div>
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </>
  );
}
