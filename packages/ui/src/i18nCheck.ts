// Shared consistency checks for the i18n resource pairs (en/it) of the Web UI and the desktop
// client. Pure functions with no Node dependency: the tests feed them the JSON resources and the
// source files (read with the test runner's `import.meta.glob(..., { query: '?raw' })`).

export type Resource = { [key: string]: string | Resource };

const PLURAL = /_(zero|one|two|few|many|other)$/;

/** Flattens nested resources into dotted keys (leaf strings only). */
export function flatten(res: Resource, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(res)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(key, v);
    else for (const [ck, cv] of flatten(v, key)) out.set(ck, cv);
  }
  return out;
}

/** Interpolation variables of a message: `{{name}}` and `{{name, format}}` give `name`. */
export function placeholders(msg: string): string[] {
  const names = new Set<string>();
  for (const m of msg.matchAll(/\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g)) names.add(m[1] as string);
  return [...names].sort();
}

/** `files_one` -> { base: 'files', suffix: 'one' }; non-plural keys give suffix ''. */
export function pluralParts(key: string): { base: string; suffix: string } {
  const m = PLURAL.exec(key);
  return m ? { base: key.slice(0, m.index), suffix: m[1] as string } : { base: key, suffix: '' };
}

export interface Findings {
  missingInIt: string[];
  missingInEn: string[];
  empty: string[];
  placeholderMismatch: string[];
  pluralMismatch: string[];
  /** Italian plural sets must contain `one` and `other` (and may add `many`). */
  italianPluralIncomplete: string[];
}

export function comparePair(en: Resource, it: Resource): Findings {
  const a = flatten(en);
  const b = flatten(it);
  const f: Findings = {
    missingInIt: [...a.keys()].filter((k) => !b.has(k)),
    missingInEn: [...b.keys()].filter((k) => !a.has(k)),
    empty: [],
    placeholderMismatch: [],
    pluralMismatch: [],
    italianPluralIncomplete: [],
  };
  for (const [lang, m] of [
    ['en', a],
    ['it', b],
  ] as const) {
    for (const [k, v] of m) if (v.trim() === '') f.empty.push(`${lang}:${k}`);
  }
  for (const [k, v] of a) {
    const other = b.get(k);
    if (other === undefined) continue;
    if (placeholders(v).join('|') !== placeholders(other).join('|')) {
      f.placeholderMismatch.push(
        `${k}: en{${placeholders(v).join(',')}} it{${placeholders(other).join(',')}}`,
      );
    }
  }
  const groups = (m: Map<string, string>): Map<string, Set<string>> => {
    const g = new Map<string, Set<string>>();
    for (const k of m.keys()) {
      const { base, suffix } = pluralParts(k);
      if (!suffix) continue;
      (g.get(base) ?? g.set(base, new Set()).get(base))?.add(suffix);
    }
    return g;
  };
  const ga = groups(a);
  const gb = groups(b);
  for (const [base, en_] of ga) {
    const it_ = gb.get(base);
    if (!it_) continue; // reported as missing keys already
    // English needs one/other; Italian may add "many" (CLDR) on top of the same two.
    const norm = (s: Set<string>): string =>
      [...s]
        .filter((x) => x !== 'many')
        .sort()
        .join('|');
    if (norm(en_) !== norm(it_)) f.pluralMismatch.push(base);
  }
  for (const [base, set] of gb) {
    if (!set.has('one') || !set.has('other')) f.italianPluralIncomplete.push(base);
  }
  return f;
}

export interface UsageOptions {
  /** Keys or `prefix.*` patterns that are built dynamically and must not be reported as unused. */
  allow?: string[];
}

export interface Usage {
  /** Static keys passed to t() that do not exist in the resources. */
  missing: string[];
  /** Resource keys no source file refers to. */
  unused: string[];
}

const KEY_LITERAL = /^[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)+$/;

/**
 * Static scan: a key is "used" when it appears as a string literal anywhere in the sources
 * (as a t() argument, as a `titleKey` value, ...) or when a template literal with a static
 * prefix and a `${...}` tail names it. t() calls with a static key that is not in the resources
 * are reported as missing.
 */
export function checkUsage(
  en: Resource,
  sources: Record<string, string>,
  opts: UsageOptions = {},
): Usage {
  const keys = new Set([...flatten(en).keys()].map((k) => pluralParts(k).base));
  const literals = new Set<string>();
  const prefixes = new Set<string>();
  const called = new Set<string>();
  for (const [file, src] of Object.entries(sources)) {
    if (/\.test\.[tj]sx?$/.test(file)) continue;
    // Quote-delimited literals shaped like a key (matched individually: pairing quotes across a
    // whole file breaks on apostrophes in comments and text).
    for (const m of src.matchAll(/['"`]([a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)+)['"`]/g)) {
      const s = m[1] as string;
      if (KEY_LITERAL.test(s)) literals.add(s);
    }
    // Files with a scoped helper `const t = (key) => i18next.t(`scope.${key}`)`: calls are
    // relative to that scope.
    const scope =
      /\bconst t = \([^)]*\)[^=]*=>\s*i18n(?:ext)?\.t\(\s*`([A-Za-z0-9_.-]+)\.\$\{key\}`/.exec(
        src,
      )?.[1];
    for (const m of src.matchAll(/`([A-Za-z0-9_.-]+)\$\{/g)) {
      if (!(scope && m[1] === `${scope}.`)) prefixes.add(m[1] as string);
    }
    for (const m of src.matchAll(/\bt\(\s*(['"`])([A-Za-z0-9_.-]+)\1/g)) {
      const k = scope ? `${scope}.${m[2] as string}` : (m[2] as string);
      called.add(k);
      if (scope) literals.add(k);
    }
  }
  const allow = opts.allow ?? [];
  const isAllowed = (k: string): boolean =>
    allow.some((p) => (p.endsWith('*') ? k.startsWith(p.slice(0, -1)) : k === p));
  const missing = [...called].filter((k) => !keys.has(k) && !isNamespace(keys, k)).sort();
  const unused = [...keys]
    .filter(
      (k) =>
        !literals.has(k) &&
        ![...prefixes].some((p) => k.startsWith(p)) &&
        !isAllowed(k) &&
        // a literal naming a parent object (t(`a.${x}`) style lists) uses all its children
        ![...literals].some((l) => k.startsWith(l + '.')),
    )
    .sort();
  return { missing, unused };
}

function isNamespace(keys: Set<string>, k: string): boolean {
  for (const x of keys) if (x.startsWith(k + '.')) return true;
  return false;
}

/**
 * A host's resources with the shared ones of @memobrain/ui (`common` namespace, ADR-0043) laid over
 * them, as i18next resolves them with `fallbackNS`: for the usage scan of a host.
 */
export function withShared(host: Resource, shared: Resource): Resource {
  const out: Resource = { ...host };
  for (const [k, v] of Object.entries(shared)) {
    const mine = out[k];
    out[k] =
      typeof v !== 'string' && mine !== undefined && typeof mine !== 'string'
        ? withShared(mine, v)
        : (mine ?? v);
  }
  return out;
}

/** Keys a host defines although the shared resources have them (the host's copy would win). */
export function overlap(host: Resource, shared: Resource): string[] {
  const mine = flatten(host);
  return [...flatten(shared).keys()].filter((k) => mine.has(k)).sort();
}
