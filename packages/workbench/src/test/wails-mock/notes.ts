// Mock of TemplatesAPI and ComposerAPI (daily notes, templates, composer) for unit and UI tests.
// It supports the date tokens YYYY, YY, MM, DD, HH, mm, ss and [literals]; the real formatter
// (all Moment tokens, Italian names) lives in Go and is tested there.
import { extract } from '@clarae/markdown';
import type {
  DailyOptions,
  ExtractOptions,
  ExtractResult,
  MergePlan,
  MergeResult,
  NoteResult,
  TemplateInfo,
  TemplateKind,
  TemplateMigration,
  UniqueOptions,
} from '../../app/api';
import type { MockVault } from './index';

interface Ctx {
  vaultOf: (id: string) => MockVault;
  resolve: (v: MockVault, from: string, target: string) => string;
  changed: (id: string, paths: string[], created?: readonly string[]) => void;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
const stem = (p: string): string => p.replace(/^.*\//, '').replace(/\.md$/, '');

function fmt(d: Date, layout: string): string {
  return layout.replace(
    /\[([^\]]*)\]|YYYY|YY|MM|DD|HH|mm|ss/g,
    (m, lit: string | undefined) =>
      lit ??
      {
        YYYY: pad(d.getFullYear(), 4),
        YY: pad(d.getFullYear() % 100),
        MM: pad(d.getMonth() + 1),
        DD: pad(d.getDate()),
        HH: pad(d.getHours()),
        mm: pad(d.getMinutes()),
        ss: pad(d.getSeconds()),
      }[m] ??
      m,
  );
}

export function expandMock(src: string, title: string, now = new Date()): string {
  return src.replace(
    /\{\{\s*(date|time|title)\s*(?::([^{}\n]*))?\}\}/g,
    (m, name: string, layout: string | undefined) => {
      if (name === 'title') return layout ? m : title;
      const f = (layout ?? '').trim();
      return fmt(now, f || (name === 'date' ? 'YYYY-MM-DD' : 'HH:mm'));
    },
  );
}

const join = (folder: string, name: string): string => {
  const f = folder.replace(/^\/+|\/+$/g, '');
  return f ? `${f}/${name}` : name;
};

/** The templates folder of a vault, as the core lists it (ADR-0068). */
export const TEMPLATES_DIR = '.clarae/templates';
const EXT: Record<TemplateKind, string> = {
  note: '.md',
  drawing: '.excalidraw',
  presentation: '.marp',
};
const kindOf = (p: string): TemplateKind | null =>
  (Object.keys(EXT) as TemplateKind[]).find((k) => p.toLowerCase().endsWith(EXT[k])) ?? null;
const nameOf = (p: string): string => p.replace(/^.*\//, '').replace(/\.[^./]+$/, '');

export function notesMock({ vaultOf, resolve, changed }: Ctx) {
  /** daily.json as the core reads it for the migration: every key, the unknown ones included. */
  const daily = (v: MockVault): Record<string, unknown> => {
    try {
      const o: unknown = JSON.parse(v.files.get('.clarae/daily.json') ?? '{}');
      return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const migrationOf = (v: MockVault, ignoreDone: boolean): TemplateMigration => {
    const d = daily(v);
    const plan: TemplateMigration = {
      folder: '',
      files: [],
      moved: 0,
      paths: {},
      skipped: [],
      blocked: '',
      done: false,
    };
    if (d['templatesMigrated'] === true && !ignoreDone) return { ...plan, done: true };
    const named = [d['templatesFolder'], d['templatesMigratedFrom']].find(
      (x): x is string => typeof x === 'string' && x.replace(/^\/+|\/+$/g, '') !== '',
    );
    const folder = (named ?? 'Templates').replace(/^\/+|\/+$/g, '');
    const files = [...v.files.keys()]
      .filter((p) => p.startsWith(folder + '/') && kindOf(p) !== null)
      .sort();
    return { ...plan, folder, files };
  };

  const readTemplate = (v: MockVault, ref: string): string => {
    if (!ref) return '';
    const p = ref.replace(/^library:/, '');
    const text = v.files.get(p);
    if (text === undefined) throw new Error('not-found: no such file');
    return text;
  };
  const create = (id: string, path: string, ref: string, now: Date): void => {
    const v = vaultOf(id);
    let content = '';
    try {
      content = expandMock(readTemplate(v, ref), stem(path), now);
    } catch {
      /* a missing template creates an empty note */
    }
    const existed = v.files.has(path);
    v.files.set(path, content);
    changed(id, [path], existed ? [] : [path]);
  };

  const TemplatesAPI = {
    ReadSettings: (id: string): Promise<string> =>
      Promise.resolve(vaultOf(id).files.get('.clarae/daily.json') ?? ''),
    WriteSettings: (id: string, content: string): Promise<void> => {
      vaultOf(id).files.set('.clarae/daily.json', content);
      return Promise.resolve();
    },
    List: (id: string): Promise<TemplateInfo[]> =>
      Promise.resolve(
        [...vaultOf(id).files.keys()]
          .filter((p) => p.startsWith(TEMPLATES_DIR + '/'))
          .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
          .flatMap((p) => {
            const kind = kindOf(p);
            if (!kind) return [];
            const rel = p.slice(TEMPLATES_DIR.length + 1);
            return [
              {
                name: nameOf(p),
                path: p,
                rel,
                kind,
                source: 'vault' as const,
                ref: p,
                library: '',
              },
            ];
          }),
      ),
    Create: (
      id: string,
      name: string,
      kind: TemplateKind,
      content: string,
    ): Promise<TemplateInfo> => {
      const v = vaultOf(id);
      const ext = EXT[kind];
      if (!ext) return Promise.reject(new Error(`invalid: unknown kind of template "${kind}"`));
      const base = (name.toLowerCase().endsWith(ext) ? name.slice(0, -ext.length) : name)
        .replace(/[\\/:*?"<>|]/g, ' ')
        .trim();
      const title = base || 'Untitled';
      let rel = title + ext;
      for (let n = 2; v.files.has(`${TEMPLATES_DIR}/${rel}`); n++) rel = `${title} ${n}${ext}`;
      const path = `${TEMPLATES_DIR}/${rel}`;
      v.files.set(path, content);
      changed(id, [path], [path]);
      return Promise.resolve({
        name: nameOf(path),
        path,
        rel,
        kind,
        source: 'vault' as const,
        ref: path,
        library: '',
      });
    },
    MigrationPlan: (id: string): Promise<TemplateMigration> =>
      Promise.resolve(migrationOf(vaultOf(id), false)),
    Migrate: (id: string): Promise<TemplateMigration> => {
      const v = vaultOf(id);
      const plan = migrationOf(v, true);
      const refs = new Map<string, string>();
      for (const from of plan.files) {
        const to = `${TEMPLATES_DIR}/${from.slice(plan.folder.length + 1)}`;
        if (v.files.has(to)) {
          plan.skipped.push(from);
          continue;
        }
        v.files.set(to, v.files.get(from) ?? '');
        v.files.delete(from);
        refs.set(from, to);
        plan.paths[from] = to;
        plan.moved++;
        changed(id, [from, to], [to]);
      }
      const d = daily(v);
      for (const [k, val] of Object.entries(d))
        if (typeof val === 'string' && refs.has(val)) d[k] = refs.get(val);
      if (plan.moved > 0) {
        delete d['templatesFolder'];
        d['templatesMigratedFrom'] = plan.folder;
      }
      d['templatesMigrated'] = true;
      v.files.set('.clarae/daily.json', JSON.stringify(d, null, 2));
      return Promise.resolve({ ...plan, done: true });
    },
    DeclineMigration: (id: string): Promise<void> => {
      const v = vaultOf(id);
      v.files.set(
        '.clarae/daily.json',
        JSON.stringify({ ...daily(v), templatesMigrated: true }, null, 2),
      );
      return Promise.resolve();
    },
    Expand: (id: string, ref: string, title: string): Promise<string> => {
      try {
        const text = readTemplate(vaultOf(id), ref);
        // A drawing has no variables: the core returns it as it is.
        return Promise.resolve(kindOf(ref) === 'drawing' ? text : expandMock(text, title));
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
    OpenDaily: (id: string, o: DailyOptions): Promise<NoteResult> => {
      const v = vaultOf(id);
      const now = new Date();
      const day = o.date ? new Date(`${o.date}T${fmt(now, 'HH:mm:ss')}`) : now;
      const path = join(o.folder, fmt(day, o.format || 'YYYY-MM-DD') + '.md');
      if (v.files.has(path)) return Promise.resolve({ path, created: false });
      create(id, path, o.template, day);
      return Promise.resolve({ path, created: true });
    },
    DailyAdjacent: (
      path: string,
      folder: string,
      format: string,
      _lang: string,
      delta: number,
    ): Promise<string> => {
      const f = folder.replace(/^\/+|\/+$/g, '');
      const rel = f ? (path.startsWith(f + '/') ? path.slice(f.length + 1) : '') : path;
      const m = /^(\d{4})-(\d{2})-(\d{2})\.md$/.exec(rel);
      if (!m || (format && format !== 'YYYY-MM-DD')) return Promise.resolve('');
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + delta);
      return Promise.resolve(fmt(d, 'YYYY-MM-DD'));
    },
    NewUnique: (id: string, o: UniqueOptions): Promise<NoteResult> => {
      const v = vaultOf(id);
      const now = new Date();
      const base = fmt(now, o.format || 'YYYYMMDDHHmm');
      let path = join(o.folder, base + '.md');
      for (let n = 2; v.files.has(path); n++) path = join(o.folder, `${base} ${n}.md`);
      create(id, path, o.template, now);
      return Promise.resolve({ path, created: true });
    },
    CreateFromTemplate: (id: string, dir: string, name: string, ref: string): Promise<string> => {
      const v = vaultOf(id);
      let path = join(dir, name.replace(/\.md$/, '') + '.md');
      for (let n = 2; v.files.has(path); n++)
        path = join(dir, `${name.replace(/\.md$/, '')} ${n}.md`);
      create(id, path, ref, new Date());
      return Promise.resolve(path);
    },
  };

  /** Link edits that redirect links to `source` onto `target` (simple form: the note's name). */
  const redirects = (v: MockVault, source: string, target: string) => {
    const out: { path: string; start: number; end: number }[] = [];
    for (const [p, content] of v.files) {
      if (!p.endsWith('.md') || p === source) continue;
      for (const l of extract(stem(p), content).links) {
        if (l.kind === 'external' || !l.target) continue;
        if (resolve(v, p, l.target) === source)
          out.push({ path: p, start: l.targetStart, end: l.targetEnd });
      }
    }
    return { target, edits: out };
  };

  const planOf = (v: MockVault, source: string, target: string): MergePlan => {
    const { edits } = redirects(v, source, target);
    return { source, target, links: edits.length, notes: new Set(edits.map((e) => e.path)).size };
  };

  const ComposerAPI = {
    PlanMerge: (id: string, source: string, target: string): Promise<MergePlan> => {
      if (source === target)
        return Promise.reject(new Error('invalid: a note cannot be merged into itself'));
      return Promise.resolve(planOf(vaultOf(id), source, target));
    },
    ApplyMerge: (id: string, source: string, target: string, sep: string): Promise<MergeResult> => {
      const v = vaultOf(id);
      const plan = planOf(v, source, target);
      const body = (v.files.get(source) ?? '').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
      const head = sep === 'rule' ? '---\n\n' : sep === 'none' ? '' : `## ${stem(source)}\n\n`;
      const merged = `${(v.files.get(target) ?? '').trimEnd()}\n\n${head}${body}\n`;
      v.files.set(target, merged);
      const { edits } = redirects(v, source, target);
      const byFile = new Map<string, typeof edits>();
      for (const e of edits) byFile.set(e.path, [...(byFile.get(e.path) ?? []), e]);
      for (const [p, list] of byFile) {
        let c = v.files.get(p) ?? '';
        for (const e of [...list].sort((a, b) => b.start - a.start))
          c = c.slice(0, e.start) + stem(target) + c.slice(e.end);
        v.files.set(p, c);
      }
      v.files.delete(source);
      changed(id, [source, target, ...byFile.keys()]);
      return Promise.resolve({ ...plan, trashed: true });
    },
    SuggestTitle: (selection: string): Promise<string> =>
      Promise.resolve(
        (selection.split('\n').find((l) => l.trim()) ?? 'Untitled')
          .replace(/^[#>\-*\s]+/, '')
          .trim() || 'Untitled',
      ),
    Extract: (id: string, o: ExtractOptions): Promise<ExtractResult> => {
      const v = vaultOf(id);
      const dir = o.dir || (o.sourcePath.includes('/') ? o.sourcePath.replace(/\/[^/]*$/, '') : '');
      const title = o.title.trim() || 'Untitled';
      let path = join(dir, title + '.md');
      for (let n = 2; v.files.has(path); n++) path = join(dir, `${title} ${n}.md`);
      const fm = o.carryFrontmatter
        ? (/^---\n[\s\S]*?\n---\n/.exec(v.files.get(o.sourcePath) ?? '')?.[0] ?? '')
        : '';
      v.files.set(path, fm + o.selection.trimEnd() + '\n');
      changed(id, [path], [path]);
      const link = `[[${stem(path)}]]`;
      return Promise.resolve({ path, link: o.embed ? '!' + link : link });
    },
  };

  return { TemplatesAPI, ComposerAPI };
}
