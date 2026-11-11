// The corpus of the Live editor's gate (criteria C1 to C4 of the A gate): files read byte for byte,
// shared/conformance/roundtrip plus the markdown fixtures of the indexer. Test support only.
//
//   conformance   the 70 fixtures of shared/conformance/markdown (the ones of the Go and TS parsers)
//   demo          the seed of the demo vault (scripts/lib.sh, seed_demo_vault)
//   case          hand-written GFM and OFM cases (roundtrip/cases)
//   commonmark    the 652 examples of the CommonMark 0.31.2 spec (roundtrip/commonmark)
//   variant       CRLF and BOM variants of conformance, demo and case
//
// The "non adversarial" corpus leaves out the few CommonMark examples listed, with the reason and the
// criterion, in `adversarial.ts`; the other numbers are for the whole corpus.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNonAdversarial, type Criterion } from './adversarial';

const here = dirname(fileURLToPath(import.meta.url));
/** The repository root: packages/workbench/src/editor/live/testing -> up six. */
export const repoRoot = join(here, '../../../../../..');
const roundtrip = join(repoRoot, 'shared/conformance/roundtrip');

export type Group = 'conformance' | 'demo' | 'case' | 'commonmark' | 'variant';

export interface Sample {
  /** Unique, stable: `conformance/<name>`, `demo/<file>`, `case/<name>`, `commonmark/<n>`, `<id>~crlf`. */
  id: string;
  group: Group;
  raw: string;
  /** The CommonMark section of an example. */
  section?: string;
}

function readDir(dir: string, group: Group, prefix: string): Sample[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({
      id: `${prefix}/${f.replace(/\.md$/, '')}`,
      group,
      raw: readFileSync(join(dir, f), 'utf8'),
    }));
}

export function conformanceFixtures(): Sample[] {
  return readDir(join(repoRoot, 'shared/conformance/markdown'), 'conformance', 'conformance');
}
export function demoVault(): Sample[] {
  return readDir(join(roundtrip, 'demo'), 'demo', 'demo');
}
export function handWritten(): Sample[] {
  return readDir(join(roundtrip, 'cases'), 'case', 'case');
}

interface SpecFile {
  examples: { n: number; section: string; markdown: string }[];
}
export function commonmarkExamples(): Sample[] {
  const spec = JSON.parse(
    readFileSync(join(roundtrip, 'commonmark/0.31.2.json'), 'utf8'),
  ) as SpecFile;
  return spec.examples.map((e) => ({
    id: `commonmark/${String(e.n).padStart(3, '0')}`,
    group: 'commonmark' as const,
    raw: e.markdown,
    section: e.section,
  }));
}

/** CRLF and BOM variants of what real files look like. */
export function variantsOf(base: Sample[]): Sample[] {
  const out: Sample[] = [];
  for (const s of base) {
    out.push({ id: `${s.id}~crlf`, group: 'variant', raw: s.raw.replaceAll('\n', '\r\n') });
    out.push({ id: `${s.id}~bom`, group: 'variant', raw: '\uFEFF' + s.raw });
  }
  return out;
}

/** The whole corpus. */
export function fullCorpus(): Sample[] {
  const base = [...conformanceFixtures(), ...demoVault(), ...handWritten()];
  return [...base, ...variantsOf(base), ...commonmarkExamples()];
}

/** The samples of the non adversarial corpus of a criterion. */
export function nonAdversarial(samples: Sample[], criterion: Criterion): Sample[] {
  return samples.filter((s) => isNonAdversarial(s.id, criterion));
}
