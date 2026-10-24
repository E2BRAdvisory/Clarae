import { useMemo, useState } from 'react';
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

/** Dot-files and dot-folders (.nodus, .trash, .git) are not shown in the explorer. */
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

  const renderNodes = (nodes: TreeNode[], depth: number) =>
    nodes.map((node) => {
      const { entry } = node;
      const isCollapsed = !expanded.has(entry.path);
      return (
        <div key={entry.path}>
          <div
            className={`node ${entry.isDir ? 'folder' : 'file'} ${activePath === entry.path ? 'active' : ''} ${dropTarget === entry.path ? 'drop' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            draggable={!readOnly}
            onDragStart={(e) => e.dataTransfer.setData('application/x-nodus-path', entry.path)}
            onDragOver={(e) => {
              if (!entry.isDir || !e.dataTransfer.types.includes('application/x-nodus-path'))
                return;
              e.preventDefault();
              setDropTarget(entry.path);
            }}
            onDragLeave={() => setDropTarget((d) => (d === entry.path ? null : d))}
            onDrop={(e) => {
              e.preventDefault();
              setDropTarget(null);
              const from = e.dataTransfer.getData('application/x-nodus-path');
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
            <span className="caret">{entry.isDir ? (isCollapsed ? '▸' : '▾') : ''}</span>
            <span className="name">{display(entry)}</span>
          </div>
          {entry.isDir && !isCollapsed && renderNodes(node.children, depth + 1)}
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
        className={`content tree ${dropTarget === '' ? 'drop' : ''}`}
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
          if (e.dataTransfer.types.includes('application/x-nodus-path')) {
            e.preventDefault();
            setDropTarget('');
          }
        }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(e) => {
          const from = e.dataTransfer.getData('application/x-nodus-path');
          setDropTarget(null);
          if (from) void move(from, '');
        }}
      >
        {renderNodes(tree, 0)}
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </>
  );
}
