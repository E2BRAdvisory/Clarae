import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TagCount } from '../app/api';
import { useAppStore } from '../state/store';
import { useTags } from '../state/queries';
import { Icon } from '../shell/icons';

interface TagNode {
  name: string;
  full: string;
  count: number;
  children: TagNode[];
}

/** Builds the hierarchy: "a/b" nests under "a"; a parent's count includes its children. */
export function buildTagTree(tags: readonly TagCount[]): TagNode[] {
  const roots: TagNode[] = [];
  const byFull = new Map<string, TagNode>();
  const own = new Map(tags.map((t) => [t.name, t.count]));
  for (const { name: tag } of [...tags].sort((a, b) => a.name.localeCompare(b.name))) {
    const parts = tag.split('/');
    let parentList = roots;
    let full = '';
    for (const part of parts) {
      full = full ? `${full}/${part}` : part;
      let node = byFull.get(full);
      if (!node) {
        node = { name: part, full, count: own.get(full) ?? 0, children: [] };
        byFull.set(full, node);
        parentList.push(node);
      }
      parentList = node.children;
    }
  }
  const total = (n: TagNode): number => {
    n.count += n.children.reduce((s, c) => s + total(c), 0);
    return n.count;
  };
  roots.forEach(total);
  return roots;
}

export function TagsPanel({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const { data = [] } = useTags(vaultId);
  const search = useAppStore((s) => s.search);
  const tree = useMemo(() => buildTagTree(data), [data]);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const render = (nodes: TagNode[], depth: number) =>
    nodes.map((n) => (
      <div key={n.full}>
        <div
          className="node tag-node"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => search(`tag:#${n.full}`)}
          title={`#${n.full}`}
        >
          <span
            className="caret"
            onClick={(e) => {
              e.stopPropagation();
              setOpen((prev) => {
                const next = new Set(prev);
                if (next.has(n.full)) next.delete(n.full);
                else next.add(n.full);
                return next;
              });
            }}
          >
            {n.children.length ? (
              <Icon name={open.has(n.full) ? 'chevronDown' : 'chevronRight'} />
            ) : null}
          </span>
          <span className="name">#{n.name}</span>
          <span className="count">{n.count}</span>
        </div>
        {open.has(n.full) && render(n.children, depth + 1)}
      </div>
    ));

  return (
    <div className="content tree" aria-label={t('sidebar.tags')}>
      {data.length === 0 && <div className="muted pad">{t('tags.none')}</div>}
      {render(tree, 0)}
    </div>
  );
}
