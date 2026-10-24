// Mock of TemplatesAPI and ComposerAPI (daily notes, templates, composer) for unit and UI tests.
// It supports the date tokens YYYY, YY, MM, DD, HH, mm, ss and [literals]; the real formatter
// (all Moment tokens, Italian names) lives in Go and is tested there.
import { extract } from '@nodus/markdown';
import type {
  DailyOptions,
  ExtractOptions,
  ExtractResult,
  MergePlan,
  MergeResult,
  NoteResult,
  TemplateInfo,
  UniqueOptions,
} from '../../app/api';
import type { MockVault } from './index';

interface Ctx {
  vaultOf: (id: string) => MockVault;
  resolve: (v: MockVault, from: string, target: string) => string;
  changed: (id: string, paths: string[]) => void;
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

export function notesMock({ vaultOf, resolve, changed }: Ctx) {
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
    v.files.set(path, content);
    changed(id, [path]);
  };

  const TemplatesAPI = {
    ReadSettings: (id: string): Promise<string> =>
      Promise.resolve(vaultOf(id).files.get('.nodus/daily.json') ?? ''),
    WriteSettings: (id: string, content: string): Promise<void> => {
      vaultOf(id).files.set('.nodus/daily.json', content);
      return Promise.resolve();
    },
    List: (id: string, folder: string): Promise<TemplateInfo[]> => {
      const f = (folder || 'Templates').replace(/\/+$/, '');
      return Promise.resolve(
        [...vaultOf(id).files.keys()]
          .filter((p) => p.endsWith('.md') && p.startsWith(f + '/'))
          .sort()
          .map((p) => ({ name: stem(p), path: p, source: 'vault' as const, ref: p, library: '' })),
      );
    },
    Expand: (id: string, ref: string, title: string): Promise<string> => {
      try {
        return Promise.resolve(expandMock(readTemplate(vaultOf(id), ref), title));
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
      changed(id, [path]);
      const link = `[[${stem(path)}]]`;
      return Promise.resolve({ path, link: o.embed ? '!' + link : link });
    },
  };

  return { TemplatesAPI, ComposerAPI };
}
