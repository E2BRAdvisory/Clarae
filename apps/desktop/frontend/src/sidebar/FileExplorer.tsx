import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type Entry } from '../app/api';
import { useAppStore } from '../state/store';
import { useInvalidate, useTree } from '../state/queries';

interface TreeNode {
  entry: Entry;
  children: TreeNode[];
}

function buildTree(entries: Entry[]): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  for (const entry of entries) {
    const node: TreeNode = { entry, children: [] };
    byPath.set(entry.path, node);
    const i = entry.path.lastIndexOf('/');
    const parent = i >= 0 ? byPath.get(entry.path.slice(0, i)) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const sortNodes = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => {
      if (a.entry.isDir !== b.entry.isDir) return a.entry.isDir ? -1 : 1;
      return a.entry.name.localeCompare(b.entry.name, undefined, { sensitivity: 'base' });
    });
    nodes.forEach((n) => sortNodes(n.children));
  };
  sortNodes(roots);
  return roots;
}

function parentDir(path: string | null): string {
  if (!path) return '';
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
}

export function FileExplorer({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const { data: entries = [] } = useTree(vaultId);
  const invalidate = useInvalidate();
  const openPath = useAppStore((s) => s.openPath);
  const openNote = useAppStore((s) => s.openNote);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildTree(entries), [entries]);

  const dirForNew = (): string => {
    const active = entries.find((e) => e.path === openPath);
    return active?.isDir ? active.path : parentDir(openPath);
  };

  const newNote = async () => {
    const name = window.prompt(t('sidebar.promptNoteName'), t('sidebar.untitled'));
    if (!name) return;
    const dir = dirForNew();
    const path = (dir ? dir + '/' : '') + (name.endsWith('.md') ? name : name + '.md');
    try {
      await api.vault.writeNote(vaultId, path, '', '');
      await invalidate.tree(vaultId);
      openNote(path);
    } catch (e) {
      window.alert(String(e));
    }
  };

  const newFolder = async () => {
    const name = window.prompt(t('sidebar.promptFolderName'));
    if (!name) return;
    const dir = dirForNew();
    try {
      await api.vault.createFolder(vaultId, (dir ? dir + '/' : '') + name);
      await invalidate.tree(vaultId);
    } catch (e) {
      window.alert(String(e));
    }
  };

  const rename = async (entry: Entry) => {
    const name = window.prompt(t('sidebar.promptRename'), entry.name);
    if (!name || name === entry.name) return;
    const dir = parentDir(entry.path);
    const to = (dir ? dir + '/' : '') + name;
    try {
      const plan = await api.links.planRename(vaultId, entry.path, to);
      const notes = plan.files.length;
      const links = plan.files.reduce((n, f) => n + f.edits.length, 0);
      if (notes > 0 && !window.confirm(t('sidebar.confirmLinkUpdate', { links, notes }))) return;
      await api.links.applyRename(vaultId, entry.path, to);
      await invalidate.tree(vaultId);
      await invalidate.backlinks(vaultId);
      if (openPath === entry.path) openNote(to);
    } catch (e) {
      window.alert(String(e));
    }
  };

  const trash = async (entry: Entry) => {
    if (!window.confirm(`${t('sidebar.trash')}: ${entry.path}?`)) return;
    try {
      await api.vault.trash(vaultId, entry.path);
      await invalidate.tree(vaultId);
      if (openPath && (openPath === entry.path || openPath.startsWith(entry.path + '/'))) {
        openNote(null);
      }
    } catch (e) {
      window.alert(String(e));
    }
  };

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNodes = (nodes: TreeNode[], depth: number) =>
    nodes.map((node) => {
      const { entry } = node;
      const isCollapsed = collapsed.has(entry.path);
      return (
        <div key={entry.path}>
          <div
            className={`node ${entry.isDir ? 'folder' : 'file'} ${openPath === entry.path ? 'active' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => (entry.isDir ? toggle(entry.path) : openNote(entry.path))}
            onContextMenu={(ev) => {
              ev.preventDefault();
              const choice = window.prompt(
                `${entry.path}\n1 = ${t('sidebar.rename')}, 2 = ${t('sidebar.trash')}`,
              );
              if (choice === '1') void rename(entry);
              if (choice === '2') void trash(entry);
            }}
            title={entry.path}
          >
            <span className="caret">{entry.isDir ? (isCollapsed ? '▸' : '▾') : ''}</span>
            <span className="name">
              {entry.isDir || !entry.name.endsWith('.md') ? entry.name : entry.name.slice(0, -3)}
            </span>
          </div>
          {entry.isDir && !isCollapsed && renderNodes(node.children, depth + 1)}
        </div>
      );
    });

  return (
    <>
      <div className="toolbar">
        <button className="icon" onClick={() => void newNote()} title={t('sidebar.newNote')}>
          ＋📝
        </button>
        <button className="icon" onClick={() => void newFolder()} title={t('sidebar.newFolder')}>
          ＋📁
        </button>
      </div>
      <div className="content tree">{renderNodes(tree, 0)}</div>
    </>
  );
}
