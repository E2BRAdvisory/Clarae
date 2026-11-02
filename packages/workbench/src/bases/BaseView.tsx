// Bases (M6-WP2): the tab view of a `.base` file and the shared renderer used by
// `![[x.base]]` embeds. The query runs in Go (internal/bases); this file only shows the result
// and sends edits back (view changes -> the .base YAML, cell edits -> the note frontmatter).
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../app/api';
import { followLink } from '../app/actions';
import { useAppStore } from '../state/store';
import { infoOf, useSync } from '../state/sync';
import { dialog } from '../ui/dialogs';
import { propKinds, ValueEditor, type PropKind } from '../workspace/NoteProperties';
import {
  availableColumns,
  cellText,
  sameProp,
  sortDirection,
  splitLink,
  toggleColumn,
  toggleSort,
} from './model';
import { useBase, type BaseState } from './useBase';
import type { BaseCell, BaseColumn, BaseInfo, BaseResult, BaseRow, BaseViewInfo } from './types';
import './bases.css';
import { Icon } from '../shell/icons';

interface BodyProps {
  vaultId: string;
  path: string;
  state: BaseState;
  readOnly: boolean;
  embedded: boolean;
}

/** A link cell: file.name points at a vault path, other links are resolved like wikilinks. */
function LinkCell({ cell, row, column }: { cell: BaseCell; row: BaseRow; column: BaseColumn }) {
  const { target, display } = splitLink(cell.v);
  const open = (newTab: boolean) => {
    if (column.id === 'file.name') useAppStore.getState().openNote(row.path, { newTab });
    else void followLink(row.path, { target, heading: '', block: '' }, newTab);
  };
  return (
    <a
      className="base-link"
      href="#"
      onClick={(e) => {
        e.preventDefault();
        open(e.metaKey || e.ctrlKey);
      }}
    >
      {display}
    </a>
  );
}

function Cell({
  cell,
  row,
  column,
  state,
  editable,
}: {
  cell: BaseCell;
  row: BaseRow;
  column: BaseColumn;
  state: BaseState;
  editable: boolean;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  if (cell.k === 'error')
    return (
      <span className="base-error" title={cell.e}>
        {t('bases.cellError')}
      </span>
    );
  if (editable && editing) {
    const kind = (propKinds.includes(column.kind as PropKind) ? column.kind : 'text') as PropKind;
    return (
      <span className="base-editor" onBlur={() => setEditing(false)}>
        <ValueEditor
          kind={kind}
          value={cell.v ?? (kind === 'list' ? [] : kind === 'checkbox' ? false : '')}
          onCommit={(v) => {
            setEditing(false);
            void state.setCell(row.path, column.key, row.hash, v);
          }}
        />
      </span>
    );
  }
  let body: React.ReactNode;
  if (cell.k === 'link' && cell.v !== undefined && cell.v !== null)
    body = <LinkCell cell={cell} row={row} column={column} />;
  else if (cell.k === 'list' && Array.isArray(cell.v))
    body = (
      <>
        {cell.v.map((x, i) => (
          <span className="base-chip" key={i}>
            {cellText({ k: 'text', v: x })}
          </span>
        ))}
      </>
    );
  else if (cell.k === 'checkbox' && editable)
    body = (
      <input
        type="checkbox"
        checked={cell.v === true}
        onChange={(e) => void state.setCell(row.path, column.key, row.hash, e.target.checked)}
      />
    );
  else body = cellText(cell);
  return (
    <span
      className={`base-cell k-${cell.k}`}
      title={cellText(cell)}
      onDoubleClick={() => editable && cell.k !== 'checkbox' && setEditing(true)}
    >
      {body}
    </span>
  );
}

function canEdit(col: BaseColumn, row: BaseRow, readOnly: boolean): boolean {
  return col.editable && !col.formula && !readOnly && row.path.toLowerCase().endsWith('.md');
}

function BaseTable({ state, readOnly, embedded }: BodyProps) {
  const { t } = useTranslation();
  const res = state.result as BaseResult;
  const view = (state.info as BaseInfo).views[state.viewIndex] as BaseViewInfo;
  const groupAt = new Map(res.groups.map((g) => [g.start, g]));
  const hasSummary = res.summaries.length > 0;
  return (
    <table className="base-table">
      <thead>
        <tr>
          {res.columns.map((c) => {
            const dir = sortDirection(view, c.id);
            return (
              <th
                key={c.id}
                className={embedded ? '' : 'sortable'}
                aria-sort={dir === 'ASC' ? 'ascending' : dir === 'DESC' ? 'descending' : 'none'}
                onClick={() =>
                  !embedded && !readOnly && void state.patchView(toggleSort(view, c.id))
                }
              >
                {c.name}
                {dir && (
                  <span className="sort-ind">
                    <Icon name={dir === 'ASC' ? 'sortUp' : 'sortDown'} size={16} />
                  </span>
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {res.rows.map((row, i) => {
          const g = groupAt.get(i);
          return (
            <FragmentRows key={row.path + ':' + i}>
              {g && (
                <tr className="base-group">
                  <td colSpan={res.columns.length}>
                    {g.key.k === 'null' ? t('bases.noValue') : cellText(g.key)}{' '}
                    <span className="muted">({g.count})</span>
                  </td>
                </tr>
              )}
              <tr>
                {res.columns.map((c, j) => (
                  <td key={c.id}>
                    <Cell
                      cell={row.cells[j] as BaseCell}
                      row={row}
                      column={c}
                      state={state}
                      editable={canEdit(c, row, readOnly)}
                    />
                  </td>
                ))}
              </tr>
            </FragmentRows>
          );
        })}
      </tbody>
      {hasSummary && (
        <tfoot>
          <tr>
            {res.summaries.map((s, j) => (
              <td key={j}>{cellText(s)}</td>
            ))}
          </tr>
        </tfoot>
      )}
    </table>
  );
}

function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function BaseCards({ state, readOnly }: BodyProps) {
  const { t } = useTranslation();
  const res = state.result as BaseResult;
  const groupAt = new Map(res.groups.map((g) => [g.start, g]));
  const cards: React.ReactNode[] = [];
  res.rows.forEach((row, i) => {
    const g = groupAt.get(i);
    if (g)
      cards.push(
        <h4 className="base-group-title" key={'g' + i}>
          {g.key.k === 'null' ? t('bases.noValue') : cellText(g.key)}{' '}
          <span className="muted">({g.count})</span>
        </h4>,
      );
    cards.push(
      <div className="base-card" key={row.path + ':' + i}>
        {res.columns.map((c, j) => {
          const cell = row.cells[j] as BaseCell;
          if (j > 0 && cell.k === 'null') return null;
          return (
            <div className={j === 0 ? 'base-card-title' : 'base-card-field'} key={c.id}>
              {j > 0 && <span className="base-card-label">{c.name}</span>}
              <Cell
                cell={cell}
                row={row}
                column={c}
                state={state}
                editable={canEdit(c, row, readOnly)}
              />
            </div>
          );
        })}
      </div>,
    );
  });
  return <div className="base-cards">{cards}</div>;
}

function Filters({
  view,
  state,
  readOnly,
}: {
  view: BaseViewInfo;
  state: BaseState;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  return (
    <div className="base-filters">
      {view.baseFilters.map((c, i) => (
        <span className="base-filter readonly" key={'b' + i} title={t('bases.baseFilter')}>
          {c.text}
        </span>
      ))}
      {view.filters.map((c, i) => (
        <span className={`base-filter${c.error ? ' invalid' : ''}`} key={i} title={c.error ?? ''}>
          {c.text}
          {c.simple && !readOnly && (
            <button
              className="icon"
              aria-label={t('bases.removeFilter')}
              onClick={() => void state.patchView({ removeFilter: c.index })}
            >
              <Icon name="close" size={16} />
            </button>
          )}
        </span>
      ))}
      {!readOnly && (
        <input
          className="base-filter-input"
          value={draft}
          placeholder={t('bases.addFilter')}
          aria-label={t('bases.addFilter')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !draft.trim()) return;
            void state.patchView({ addFilter: draft.trim() }).then(() => setDraft(''));
          }}
        />
      )}
    </div>
  );
}

function ColumnChooser({
  vaultId,
  view,
  info,
  state,
}: {
  vaultId: string;
  view: BaseViewInfo;
  info: BaseInfo;
  state: BaseState;
}) {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<string[]>([]);
  useEffect(() => {
    void api.properties
      .keys(vaultId)
      .then((k) => setKeys(k.map((x) => x.key)))
      .catch(() => undefined);
  }, [vaultId]);
  const options = availableColumns(info, keys);
  const order = view.order.length ? view.order : ['file.name'];
  return (
    <details className="base-menu">
      <summary>{t('bases.columns')}</summary>
      <div className="base-menu-body">
        {options.map((o) => (
          <label key={o.id}>
            <input
              type="checkbox"
              checked={order.some((x) => sameProp(x, o.id))}
              onChange={() => void state.patchView({ order: toggleColumn(order, o.id) })}
            />{' '}
            {o.label}
          </label>
        ))}
      </div>
    </details>
  );
}

function GroupBy({
  view,
  state,
  columns,
}: {
  view: BaseViewInfo;
  state: BaseState;
  columns: BaseColumn[];
}) {
  const { t } = useTranslation();
  return (
    <label className="base-group-select">
      {t('bases.groupBy')}{' '}
      <select
        value={view.groupBy?.property ?? ''}
        onChange={(e) =>
          void state.patchView(
            e.target.value
              ? { groupBy: { property: e.target.value, direction: 'ASC' } }
              : { clearGroupBy: true },
          )
        }
      >
        <option value="">{t('bases.none')}</option>
        {columns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Raw YAML fallback for what the UI cannot edit (complex filters, formulas...). */
function YamlEditor({
  vaultId,
  path,
  onClose,
}: {
  vaultId: string;
  path: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [hash, setHash] = useState('');
  useEffect(() => {
    void api.vault.readNote(vaultId, path).then((n) => {
      setText(n.content);
      setHash(n.hash);
    });
  }, [vaultId, path]);
  const save = async () => {
    try {
      await api.vault.writeNote(vaultId, path, text, hash);
      onClose();
    } catch (e) {
      await dialog.error(e);
    }
  };
  return (
    <div className="base-yaml">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        aria-label={t('bases.yaml')}
      />
      <div className="row-controls">
        <button onClick={() => void save()}>{t('bases.saveYaml')}</button>
        <button onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </div>
  );
}

function Notices({ items }: { items: string[] }) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  return (
    <details className="base-notices">
      <summary>{t('bases.notices', { count: items.length })}</summary>
      <ul>
        {items.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
    </details>
  );
}

function BaseBody(props: BodyProps) {
  const { t } = useTranslation();
  const { state, embedded } = props;
  const { info, result } = state;
  if (state.error && !result)
    return <div className="base-error-box">{t('bases.loadError', { message: state.error })}</div>;
  if (!info || (state.loading && !result))
    return <div className="muted pad">{t('bases.loading')}</div>;
  const view = info.views[state.viewIndex];
  if (!view || !result) return <div className="muted pad">{t('bases.noViews')}</div>;
  if (!view.supported)
    return (
      <div className="base-unsupported">
        {t('bases.unsupportedView', { name: view.name, type: view.type })}
      </div>
    );
  return (
    <>
      {!embedded && <Notices items={result.notices} />}
      {view.type === 'cards' ? <BaseCards {...props} /> : <BaseTable {...props} />}
      <div className="base-footer muted">
        {t('bases.count', { shown: result.rows.length, total: result.total })}
      </div>
    </>
  );
}

/** The tab of a `.base` file. */
export function BaseView({ vaultId, path }: { vaultId: string; path: string }) {
  const { t } = useTranslation();
  const readOnly = useSync((s) => infoOf(s, vaultId).readOnly);
  const state = useBase({ vaultId, path, thisPath: path });
  const [yaml, setYaml] = useState(false);
  const { info } = state;
  const view = info?.views[state.viewIndex];
  const closeYaml = useCallback(() => {
    setYaml(false);
    state.reload();
  }, [state]);
  return (
    <div className="base-view">
      <div className="base-toolbar">
        <strong className="base-title">
          {path
            .split('/')
            .pop()
            ?.replace(/\.base$/, '')}
        </strong>
        {info && info.views.length > 0 && (
          <select
            aria-label={t('bases.view')}
            value={state.viewIndex}
            onChange={(e) => state.selectView(Number(e.target.value))}
          >
            {info.views.map((v, i) => (
              <option key={i} value={i}>
                {v.name}
              </option>
            ))}
          </select>
        )}
        {info && view?.supported && (
          <>
            <ColumnChooser vaultId={vaultId} view={view} info={info} state={state} />
            {!readOnly && state.result && (
              <GroupBy view={view} state={state} columns={state.result.columns} />
            )}
          </>
        )}
        <button className="base-yaml-btn" onClick={() => setYaml(!yaml)}>
          {t('bases.editYaml')}
        </button>
      </div>
      {info && view?.supported && !yaml && (
        <Filters view={view} state={state} readOnly={readOnly} />
      )}
      {yaml ? (
        <YamlEditor vaultId={vaultId} path={path} onClose={closeYaml} />
      ) : (
        <BaseBody
          vaultId={vaultId}
          path={path}
          state={state}
          readOnly={readOnly}
          embedded={false}
        />
      )}
    </div>
  );
}

/** A base inside a note: `![[x.base]]` shows its first view, `![[x.base#View]]` the named one. */
export function BaseEmbed({
  vaultId,
  path,
  viewName,
  thisPath,
  isAlive,
  onDetached,
  onOpen,
}: {
  vaultId: string;
  path: string;
  viewName: string;
  thisPath: string;
  isAlive: () => boolean;
  onDetached: () => void;
  onOpen: () => void;
}) {
  const readOnly = useSync((s) => infoOf(s, vaultId).readOnly);
  const state = useBase({ vaultId, path, thisPath, viewName, isAlive, onDetached });
  const title =
    path
      .split('/')
      .pop()
      ?.replace(/\.base$/, '') ?? path;
  const view = state.info?.views[state.viewIndex];
  return (
    <div className="base-view embedded">
      <div className="base-toolbar">
        <a
          className="base-title"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onOpen();
          }}
        >
          {title}
          {view ? ` · ${view.name}` : ''}
        </a>
      </div>
      <BaseBody vaultId={vaultId} path={path} state={state} readOnly={readOnly} embedded />
    </div>
  );
}
