// The canvas editor (M3-WP3): infinite board with pan and zoom, text / note / media / link /
// group nodes, labelled edges, selection, drag, resize, color presets, undo and redo. The
// file is JSON Canvas 1.0 and is autosaved (same hash precondition as notes).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../app/api';
import { followLink } from '../app/actions';
import { renderEmbedInto, hydrate } from '../embeds/hydrate';
import { backendFor } from '../reading/ReadingView';
import { renderMarkdown } from '../reading/render';
import { useNoteDocument } from '../editor/useNoteDocument';
import { infoOf, useSync } from '../state/sync';
import { dialog } from '../ui/dialogs';
import { isSafeExternalUrl } from '../util/sanitize';
import { openExternal } from '../util/external';
import {
  addEdge,
  addNode,
  boundsOf,
  colorOf,
  drawOrder,
  edgeGeometry,
  History,
  moveNodes,
  parseCanvas,
  PRESET_COLORS,
  removeItems,
  resizeNode,
  serializeCanvas,
  setColor,
  setEdgeLabel,
  setNodeField,
  type CanvasData,
  type CNode,
  type NodeInit,
  type Side,
} from './model';

const AUTOSAVE_MS = 1000;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3;
const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];

interface View {
  x: number;
  y: number;
  k: number;
}

type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'move'; sx: number; sy: number; base: CanvasData; ids: string[]; moved: boolean }
  | { kind: 'resize'; sx: number; sy: number; base: CanvasData; id: string; w: number; h: number }
  | { kind: 'connect'; from: string; side: Side };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Rendered Markdown of a text node (sanitized by renderMarkdown), with live math and embeds. */
function MarkdownBlock({ text, vaultId, path }: { text: string; vaultId: string; path: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = html; // already sanitized by renderMarkdown
    hydrate(el, {
      backend: backendFor(vaultId),
      fromPath: path,
      depth: 1,
      visited: [path],
      openLink: (spec, newTab) => void followLink(path, spec, newTab),
    });
  }, [html, vaultId, path]);
  return <div className="cv-markdown reading" ref={ref} />;
}

/** A file node: the file embedded (note, image, PDF, drawing, audio, video…). */
function FileBlock({ node, vaultId, path }: { node: CNode; vaultId: string; path: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const file = node.file ?? '';
  const sub = node.subpath ?? '';
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    void renderEmbedInto(
      el,
      {
        target: file,
        heading: sub.startsWith('#^') ? '' : sub.replace(/^#/, ''),
        block: sub.startsWith('#^') ? sub.slice(2) : '',
        alias: '',
        embed: true,
      },
      {
        backend: backendFor(vaultId),
        fromPath: path,
        depth: 1,
        visited: [path],
        openLink: (spec, newTab) => void followLink(path, spec, newTab),
      },
    );
  }, [file, sub, vaultId, path]);
  return (
    <>
      <div
        className="cv-file-title"
        title={file}
        onDoubleClick={() => void followLink(path, { target: file, heading: '', block: '' }, false)}
      >
        {file.split('/').pop()}
      </div>
      <div className="cv-embed" ref={ref} />
    </>
  );
}

function ToolButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      className="icon"
      title={label}
      aria-label={label}
      disabled={disabled ?? false}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function CanvasView({ vaultId, path }: { vaultId: string; path: string }) {
  const { t } = useTranslation();
  const doc = useNoteDocument(vaultId, path, AUTOSAVE_MS);
  const locked = useSync((s) => infoOf(s, vaultId).locked || infoOf(s, vaultId).readOnly);

  const [data, setData] = useState<CanvasData>({ nodes: [], edges: [] });
  const [error, setError] = useState('');
  const [seenVersion, setSeenVersion] = useState(0);
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 });
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [link, setLink] = useState<{ from: string; x: number; y: number } | null>(null); // edge being drawn
  const history = useRef(new History<CanvasData>());
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const syncHistory = () => {
    setCanUndo(history.current.canUndo);
    setCanRedo(history.current.canRedo);
  };
  const drag = useRef<Drag | null>(null);
  const board = useRef<HTMLDivElement>(null);
  const dataRef = useRef(data);
  const viewRef = useRef(view);
  useEffect(() => {
    dataRef.current = data;
    viewRef.current = view;
  });

  // Load, and re-load when a newer version of the file arrives (sync or external edit).
  if (doc.status === 'ready' && doc.version !== seenVersion) {
    setSeenVersion(doc.version);
    try {
      setData(parseCanvas(doc.content));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const readOnly = locked;
  const commit = useCallback(
    (next: CanvasData, before: CanvasData = dataRef.current) => {
      history.current.record(before);
      setCanUndo(true);
      setCanRedo(false);
      setData(next);
      doc.edit(serializeCanvas(next));
    },
    [doc],
  );

  // ---- coordinates ----
  const toWorld = useCallback((clientX: number, clientY: number) => {
    const r = board.current?.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - (r?.left ?? 0) - v.x) / v.k, y: (clientY - (r?.top ?? 0) - v.y) / v.k };
  }, []);
  const centerWorld = useCallback(() => {
    const r = board.current?.getBoundingClientRect();
    return toWorld((r?.left ?? 0) + (r?.width ?? 0) / 2, (r?.top ?? 0) + (r?.height ?? 0) / 2);
  }, [toWorld]);

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setView((v) => {
      const k = clamp(v.k * factor, MIN_ZOOM, MAX_ZOOM);
      const f = k / v.k;
      return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
    });
  }, []);
  const zoomCenter = (factor: number) => {
    const r = board.current?.getBoundingClientRect();
    zoomAt(factor, (r?.width ?? 0) / 2, (r?.height ?? 0) / 2);
  };
  const fit = () => {
    const r = board.current?.getBoundingClientRect();
    if (!r || data.nodes.length === 0) return setView({ x: 40, y: 40, k: 1 });
    const b = boundsOf(data.nodes);
    const k = clamp(Math.min((r.width - 80) / b.width, (r.height - 80) / b.height), MIN_ZOOM, 1.5);
    setView({
      k,
      x: (r.width - b.width * k) / 2 - b.x * k,
      y: (r.height - b.height * k) / 2 - b.y * k,
    });
  };

  // Wheel: pinch or Ctrl/Cmd zooms around the pointer, plain scrolling pans.
  useEffect(() => {
    const el = board.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey)
        zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt, doc.status]);

  // ---- adding things ----
  const select = (ids: string[]) => setSelection(new Set(ids));
  const place = (n: NodeInit) => {
    const r = addNode(data, n);
    commit(r.data);
    select([r.id]);
    return r.id;
  };
  const addText = (at = centerWorld()) => {
    const id = place({
      type: 'text',
      x: Math.round(at.x - 130),
      y: Math.round(at.y - 60),
      text: '',
    });
    setEditing(id);
  };
  const addNoteNode = async () => {
    const notes = (await api.vault.listTree(vaultId)).filter(
      (e) => !e.isDir && e.path.endsWith('.md'),
    );
    const picked = await dialog.pick(
      t('canvas.addNote'),
      notes.map((n) => ({ value: n.path, label: n.path.replace(/\.md$/, '') })),
    );
    if (picked) {
      const c = centerWorld();
      place({
        type: 'file',
        x: Math.round(c.x - 200),
        y: Math.round(c.y - 150),
        width: 400,
        height: 300,
        file: picked,
      });
    }
  };
  const addMedia = async () => {
    const files = (await api.vault.listTree(vaultId)).filter(
      (e) => !e.isDir && !/\.(md|canvas|base)$/i.test(e.path) && !e.path.startsWith('.nodus/'),
    );
    const picked = await dialog.pick(
      t('canvas.addMedia'),
      files.map((f) => ({ value: f.path, label: f.path })),
    );
    if (picked) {
      const c = centerWorld();
      place({
        type: 'file',
        x: Math.round(c.x - 200),
        y: Math.round(c.y - 150),
        width: 400,
        height: 300,
        file: picked,
      });
    }
  };
  const addLink = async () => {
    const url = (await dialog.prompt(t('canvas.addLink'), 'https://', t('canvas.url')))?.trim();
    if (!url) return;
    if (!isSafeExternalUrl(url)) return dialog.alert(t('canvas.addLink'), t('canvas.badUrl'));
    const c = centerWorld();
    place({ type: 'link', x: Math.round(c.x - 130), y: Math.round(c.y - 40), height: 80, url });
  };
  const addGroup = () => {
    const c = centerWorld();
    place({
      type: 'group',
      x: Math.round(c.x - 250),
      y: Math.round(c.y - 175),
      width: 500,
      height: 350,
      label: t('canvas.group'),
    });
  };

  const removeSelected = () => {
    if (selection.size === 0) return;
    commit(removeItems(data, [...selection]));
    setSelection(new Set());
  };
  const recolor = (color: string | undefined) => {
    if (selection.size > 0) commit(setColor(data, [...selection], color));
  };
  const undo = () => {
    const prev = history.current.undo(data);
    if (prev) {
      setData(prev);
      doc.edit(serializeCanvas(prev));
      syncHistory();
    }
  };
  const redo = () => {
    const next = history.current.redo(data);
    if (next) {
      setData(next);
      doc.edit(serializeCanvas(next));
      syncHistory();
    }
  };

  // ---- pointer interaction ----
  const nodeAt = (wx: number, wy: number): CNode | undefined =>
    [...drawOrder(dataRef.current.nodes)]
      .reverse()
      .find((n) => wx >= n.x && wx <= n.x + n.width && wy >= n.y && wy <= n.y + n.height);

  const onBoardDown = (e: RPointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    board.current?.focus();
    if (editing) setEditing(null);
    if (!e.shiftKey) setSelection(new Set());
    drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    board.current?.setPointerCapture(e.pointerId);
  };
  const onNodeDown = (e: RPointerEvent, n: CNode) => {
    if (e.button !== 0 || editing === n.id) return;
    e.stopPropagation();
    board.current?.focus();
    const ids = e.shiftKey
      ? selection.has(n.id)
        ? [...selection].filter((i) => i !== n.id)
        : [...selection, n.id]
      : selection.has(n.id)
        ? [...selection]
        : [n.id];
    select(ids);
    if (readOnly || !ids.includes(n.id)) return;
    drag.current = { kind: 'move', sx: e.clientX, sy: e.clientY, base: data, ids, moved: false };
    board.current?.setPointerCapture(e.pointerId);
  };
  const onResizeDown = (e: RPointerEvent, n: CNode) => {
    e.stopPropagation();
    if (readOnly) return;
    drag.current = {
      kind: 'resize',
      sx: e.clientX,
      sy: e.clientY,
      base: data,
      id: n.id,
      w: n.width,
      h: n.height,
    };
    board.current?.setPointerCapture(e.pointerId);
  };
  const onHandleDown = (e: RPointerEvent, n: CNode, side: Side) => {
    e.stopPropagation();
    if (readOnly) return;
    drag.current = { kind: 'connect', from: n.id, side };
    setLink({ from: n.id, ...toWorld(e.clientX, e.clientY) });
    board.current?.setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'pan') {
      setView((v) => ({ ...v, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy }));
    } else if (d.kind === 'move') {
      const dx = (e.clientX - d.sx) / view.k;
      const dy = (e.clientY - d.sy) / view.k;
      if (!d.moved && Math.hypot(dx, dy) < 3 / view.k) return;
      d.moved = true;
      setData(moveNodes(d.base, d.ids, Math.round(dx), Math.round(dy)));
    } else if (d.kind === 'resize') {
      setData(
        resizeNode(
          d.base,
          d.id,
          d.w + (e.clientX - d.sx) / view.k,
          d.h + (e.clientY - d.sy) / view.k,
        ),
      );
    } else {
      const w = toWorld(e.clientX, e.clientY);
      setLink((l) => (l ? { ...l, ...w } : l));
    }
  };
  const onUp = (e: RPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'move' && d.moved) commit(dataRef.current, d.base);
    else if (d.kind === 'resize') commit(dataRef.current, d.base);
    else if (d.kind === 'connect') {
      const w = toWorld(e.clientX, e.clientY);
      const target = nodeAt(w.x, w.y);
      setLink(null);
      if (target) {
        const r = addEdge(data, d.from, target.id);
        if (r) {
          commit(r.data);
          select([r.id]);
        }
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      select([...data.nodes.map((n) => n.id), ...data.edges.map((x) => x.id)]);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !readOnly) {
      e.preventDefault();
      removeSelected();
    } else if (e.key === 'Escape') {
      setSelection(new Set());
    }
  };

  const editEdgeLabel = async (id: string) => {
    if (readOnly) return;
    const current = data.edges.find((x) => x.id === id)?.label ?? '';
    const label = await dialog.prompt(t('canvas.edgeLabel'), current, t('canvas.label'));
    if (label !== null) commit(setEdgeLabel(data, id, label.trim()));
  };

  if (doc.status === 'loading') return <div className="note-loading muted">…</div>;
  if (doc.status === 'error')
    return (
      <div className="note-error" role="alert">
        {doc.error}
      </div>
    );
  if (error)
    return (
      <div className="note-error" role="alert">
        {t('canvas.invalid', { error })}
      </div>
    );

  const saveLabel = {
    saved: t('editor.saved'),
    dirty: t('editor.unsaved'),
    saving: t('editor.saving'),
    conflict: '',
    error: t('editor.saveError'),
  }[doc.save];
  const linkFrom = link ? data.nodes.find((n) => n.id === link.from) : undefined;

  return (
    <div className="note-view canvas-view">
      <div className="note-header">
        <span className="path" title={path}>
          {path.replace(/\.canvas$/, '')}
        </span>
        <span className={`save-state ${doc.save}`} aria-live="polite">
          {saveLabel}
        </span>
      </div>
      {doc.save === 'conflict' && (
        <div className="banner" role="alert">
          <span>{t('editor.conflict')}</span>
          <button onClick={() => void doc.reload()}>{t('editor.reload')}</button>
          <button onClick={() => void doc.overwrite()}>{t('editor.overwrite')}</button>
        </div>
      )}
      <div className="cv-toolbar" role="toolbar" aria-label={t('canvas.tools')}>
        <ToolButton label={t('canvas.addText')} onClick={() => addText()} disabled={readOnly}>
          ＋ {t('canvas.text')}
        </ToolButton>
        <ToolButton
          label={t('canvas.addNote')}
          onClick={() => void addNoteNode()}
          disabled={readOnly}
        >
          ▤ {t('canvas.note')}
        </ToolButton>
        <ToolButton
          label={t('canvas.addMedia')}
          onClick={() => void addMedia()}
          disabled={readOnly}
        >
          ▣ {t('canvas.media')}
        </ToolButton>
        <ToolButton label={t('canvas.addLink')} onClick={() => void addLink()} disabled={readOnly}>
          ↗ {t('canvas.link')}
        </ToolButton>
        <ToolButton label={t('canvas.addGroup')} onClick={addGroup} disabled={readOnly}>
          ▭ {t('canvas.group')}
        </ToolButton>
        <span className="cv-sep" />
        <ToolButton label={t('canvas.undo')} onClick={undo} disabled={!canUndo || readOnly}>
          ↶
        </ToolButton>
        <ToolButton label={t('canvas.redo')} onClick={redo} disabled={!canRedo || readOnly}>
          ↷
        </ToolButton>
        <span className="cv-sep" />
        <ToolButton label={t('canvas.zoomOut')} onClick={() => zoomCenter(1 / 1.25)}>
          −
        </ToolButton>
        <span className="cv-zoom" aria-live="off">
          {Math.round(view.k * 100)}%
        </span>
        <ToolButton label={t('canvas.zoomIn')} onClick={() => zoomCenter(1.25)}>
          ＋
        </ToolButton>
        <ToolButton label={t('canvas.fit')} onClick={fit}>
          ⤢
        </ToolButton>
        <span className="cv-sep" />
        <span className="cv-colors" role="group" aria-label={t('canvas.color')}>
          {Object.entries(PRESET_COLORS).map(([k, hex]) => (
            <button
              key={k}
              className="cv-swatch"
              title={`${t('canvas.color')} ${k}`}
              aria-label={`${t('canvas.color')} ${k}`}
              style={{ background: hex }}
              disabled={selection.size === 0 || readOnly}
              onClick={() => recolor(k)}
            />
          ))}
          <button
            className="icon"
            title={t('canvas.noColor')}
            aria-label={t('canvas.noColor')}
            disabled={selection.size === 0 || readOnly}
            onClick={() => recolor(undefined)}
          >
            ⌀
          </button>
        </span>
        <ToolButton
          label={t('canvas.delete')}
          onClick={removeSelected}
          disabled={selection.size === 0 || readOnly}
        >
          ✕
        </ToolButton>
      </div>
      <div
        className="cv-board"
        ref={board}
        tabIndex={0}
        role="application"
        aria-label={t('canvas.board')}
        onPointerDown={onBoardDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onKeyDown={onKeyDown}
        onDoubleClick={(e) => {
          if (e.target === e.currentTarget && !readOnly) addText(toWorld(e.clientX, e.clientY));
        }}
      >
        <div
          className="cv-layer"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
        >
          {drawOrder(data.nodes).map((n) => {
            const color = colorOf(n.color);
            const isSel = selection.has(n.id);
            return (
              <div
                key={n.id}
                className={`cv-node cv-${n.type}${isSel ? ' selected' : ''}`}
                data-node={n.id}
                style={{
                  left: n.x,
                  top: n.y,
                  width: n.width,
                  height: n.height,
                  ...(color ? { borderColor: color } : {}),
                }}
                onPointerDown={(e) => onNodeDown(e, n)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (!readOnly && (n.type === 'text' || n.type === 'group')) setEditing(n.id);
                }}
              >
                {n.type === 'group' &&
                  (editing === n.id ? (
                    <input
                      className="cv-group-input"
                      autoFocus
                      defaultValue={n.label ?? ''}
                      aria-label={t('canvas.label')}
                      onBlur={(e) => {
                        commit(setNodeField(data, n.id, 'label', e.target.value));
                        setEditing(null);
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                    />
                  ) : (
                    <div className="cv-group-label">{n.label}</div>
                  ))}
                {n.type === 'text' &&
                  (editing === n.id ? (
                    <textarea
                      className="cv-text-input"
                      autoFocus
                      defaultValue={n.text ?? ''}
                      aria-label={t('canvas.editText')}
                      onBlur={(e) => {
                        if (e.target.value !== (n.text ?? ''))
                          commit(setNodeField(data, n.id, 'text', e.target.value));
                        setEditing(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
                      }}
                    />
                  ) : n.text ? (
                    <MarkdownBlock text={n.text} vaultId={vaultId} path={path} />
                  ) : (
                    <div className="cv-placeholder muted">{t('canvas.empty')}</div>
                  ))}
                {n.type === 'file' && <FileBlock node={n} vaultId={vaultId} path={path} />}
                {n.type === 'link' && (
                  <a
                    className="cv-link"
                    href={n.url}
                    onClick={(e) => {
                      e.preventDefault();
                      if (n.url && isSafeExternalUrl(n.url)) openExternal(n.url);
                    }}
                  >
                    {n.url}
                  </a>
                )}
                {isSel && selection.size === 1 && !readOnly && (
                  <>
                    <div className="cv-resize" onPointerDown={(e) => onResizeDown(e, n)} />
                    {SIDES.map((s) => (
                      <div
                        key={s}
                        className={`cv-handle ${s}`}
                        title={t('canvas.connect')}
                        onPointerDown={(e) => onHandleDown(e, n, s)}
                      />
                    ))}
                  </>
                )}
              </div>
            );
          })}
          <svg className="cv-edges" width="1" height="1" overflow="visible">
            <defs>
              <marker
                id="cv-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
              </marker>
            </defs>
            {data.edges.map((e) => {
              const g = edgeGeometry(data, e);
              if (!g) return null;
              const stroke = colorOf(e.color) ?? 'var(--text-muted)';
              const isSel = selection.has(e.id);
              return (
                <g key={e.id} data-edge={e.id} className={isSel ? 'cv-edge selected' : 'cv-edge'}>
                  <path
                    d={g.d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={14}
                    onPointerDown={(ev) => {
                      ev.stopPropagation();
                      board.current?.focus();
                      select([e.id]);
                    }}
                    onDoubleClick={() => void editEdgeLabel(e.id)}
                  />
                  <path
                    d={g.d}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={isSel ? 3 : 2}
                    {...(e.toEnd === 'none' ? {} : { markerEnd: 'url(#cv-arrow)' })}
                    pointerEvents="none"
                  />
                  {e.label && (
                    <text x={g.mid.x} y={g.mid.y} textAnchor="middle" className="cv-edge-label">
                      {e.label}
                    </text>
                  )}
                </g>
              );
            })}
            {link && linkFrom && (
              <line
                x1={linkFrom.x + linkFrom.width / 2}
                y1={linkFrom.y + linkFrom.height / 2}
                x2={link.x}
                y2={link.y}
                className="cv-edge-draft"
              />
            )}
          </svg>
        </div>
        {data.nodes.length === 0 && <div className="cv-hint muted">{t('canvas.hint')}</div>}
      </div>
    </div>
  );
}
