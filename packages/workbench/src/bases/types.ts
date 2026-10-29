// Shapes returned by BasesAPI (Go: internal/bases + app/bindings_bases.go), as plain data.

export interface BaseCell {
  /** Value kind: text, number, checkbox, date, datetime, list, link, duration, null, error. */
  k: string;
  v?: unknown;
  e?: string;
}

export interface BaseColumn {
  id: string;
  /** Frontmatter key (note properties only). */
  key: string;
  name: string;
  kind: string;
  editable: boolean;
  formula: boolean;
}

export interface BaseRow {
  path: string;
  hash: string;
  cells: BaseCell[];
}

export interface BaseGroup {
  key: BaseCell;
  start: number;
  count: number;
}

export interface BaseResult {
  view: string;
  type: string;
  columns: BaseColumn[];
  rows: BaseRow[];
  groups: BaseGroup[];
  total: number;
  summaries: BaseCell[];
  notices: string[];
}

export interface BaseChip {
  text: string;
  /** A plain expression of the top-level "and" list: the UI may remove it. */
  simple: boolean;
  index: number;
  error?: string;
}

export interface SortSpec {
  property: string;
  direction: 'ASC' | 'DESC';
}

export interface BaseViewInfo {
  name: string;
  type: string;
  supported: boolean;
  notice: string;
  order: string[];
  sort: SortSpec[];
  groupBy: SortSpec | null;
  limit: number;
  filters: BaseChip[];
  baseFilters: BaseChip[];
}

export interface BaseFormula {
  name: string;
  expr: string;
  error: string;
}

export interface BaseInfo {
  path: string;
  hash: string;
  parseError: string;
  views: BaseViewInfo[];
  formulas: BaseFormula[];
  notices: string[];
}

/** Changes to one view; mirrors bases.ViewPatch in Go. */
export interface ViewPatch {
  order?: string[];
  sort?: SortSpec[];
  groupBy?: SortSpec;
  clearGroupBy?: boolean;
  limit?: number;
  addFilter?: string;
  removeFilter?: number;
  renameView?: string;
  setDisplayFor?: string;
  displayName?: string;
}
