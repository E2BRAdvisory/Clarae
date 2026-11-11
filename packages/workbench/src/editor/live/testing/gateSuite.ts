// The A gate (criteria C1 to C4 of the plan, A-W3), measured on the corpus of testing/corpus.ts and
// asserted here. The suite is registered by src/test/conformance.test.ts, which `task conformance`
// runs: the criteria are blocking there. `yarn workspace @memobrain/workbench run live:metrics`
// prints the numbers.
//
//   C1  with every block forced dirty, extract() and the Reading HTML do not change
//   C1-edit  the real path of an edit (patchLines, spliceCode, composeContainer, writeNew) gives the
//       meaning of the forced one: Enter in every kind of block, typed characters (normal and
//       Markdown syntax), a newline, a character or a range deleted, a task ticked, and the
//       structural edits (a block pasted between two, a block deleted or duplicated, a paragraph
//       emptied, a block type changed, a paragraph lifted out of its quote or wrapped in one), and a character typed in a paragraph
//       far from the blocks that Reading prepares (a comment, an escaped `\\^[`, a lazy line)
//   C2  one character typed in a text node changes at most one line (>= 95%), and ticking a task of
//       a nested list of 200 items changes one line
//   C3  ten round trips are idempotent
//   C4  no block is dirty without input (load, selection, hover)
//
// The extract() comparisons of C1 and C1-edit leave the positions out (`line`, `start`, `end`, ...):
// a block written again can move what follows by a few characters, and the positions say where
// something is, not what. With the positions C1 is 1044/1065 on the non adversarial corpus; the 21
// files that differ differ only by offsets and lines (the log prints it as "strict extract"). The
// Markdown tree and the Reading HTML (whitespace collapsed) are compared on their own as well.
// The texts are compared with LF line ends: the index (Go) reads a CRLF file as the LF one, while
// `extract()` of the TS mirror keeps the `\r` in what it matches by line (a heading's closing `#`
// sequence stays in its text, no task is found), so a CRLF text would differ for that alone.
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLiveCore, type LiveCore } from '../headless';
import { formatGate, runGate, type Gate } from './metrics';

export function describeGate(): void {
  let core: LiveCore;
  let gate: Gate;

  beforeAll(async () => {
    core = await createLiveCore();
    gate = runGate(core);
  }, 600_000);
  afterAll(() => core.destroy());

  describe('A gate', () => {
    it('has the numbers (LIVE_METRICS=1 prints them, LIVE_METRICS=<file> writes them there)', () => {
      const out = process.env['LIVE_METRICS'];
      if (out) {
        console.log('\n' + formatGate(gate));
        if (out !== '1') writeFileSync(out, formatGate(gate) + '\n');
      }
      expect(gate.corpus.files).toBeGreaterThan(1000);
    });

    it('C1: the semantics survive a write of every block (non adversarial corpus: 100%)', () => {
      const c = gate.c1.nonAdversarial;
      expect(c.failures).toEqual([]);
      expect(c.extractSame).toBe(c.n);
      expect(c.htmlSame).toBe(c.n);
      expect(c.refused).toBe(0);
      expect(c.eolKept).toBe(c.n); // CRLF stays CRLF
    });

    it('C1: the whole corpus, adversarial examples included', () => {
      const c = gate.c1.all;
      // everything but the one example that opens in Source
      expect(c.extractSame).toBeGreaterThanOrEqual(c.n - 1);
      expect(c.htmlSame).toBeGreaterThanOrEqual(c.n - 1);
    });

    it('C1-edit: the edit path means what the forced path means (non adversarial corpus: 100%)', () => {
      const c = gate.c1edit;
      expect(c.failures).toEqual([]);
      expect(c.n).toBeGreaterThan(5000);
      expect(c.refused).toBe(0);
      expect(c.same).toBe(c.n);
      expect(c.treeSame).toBe(c.n);
      expect(c.extractSame).toBe(c.n);
      expect(c.htmlSame).toBe(c.n);
      // every kind of operation is in the sample
      for (const op of [
        'enter',
        'enter-item',
        'type',
        'newline',
        'delete-char',
        'delete-range',
        'tick',
        'paste-block',
        'delete-block',
        'dup-block',
        'clear-text',
        'block-type',
        'wrap-quote',
        'lift',
        'distant',
      ]) {
        expect(c.byOp[op], op).toBeGreaterThan(0);
      }
    });

    it('C2: a typed character changes at most one line in >= 95% of the cases', () => {
      const c = gate.c2.nonAdversarial;
      expect(c.n).toBeGreaterThan(3000);
      expect(c.pct).toBeGreaterThanOrEqual(95);
      expect(gate.c2.all.pct).toBeGreaterThanOrEqual(95);
    });

    it('C2: ticking a task of a nested list of 200 items changes one line', () => {
      expect(gate.c2.tick).toEqual({ first: 1, middle: 1, last: 1 });
    });

    it('C3: ten round trips are idempotent', () => {
      const c = gate.c3.nonAdversarial;
      expect(c.failures).toEqual([]);
      expect(c.idempotent).toBe(c.n);
    });

    it('C4: nothing is dirty without input', () => {
      const c = gate.c4.nonAdversarial;
      expect(c.failures).toEqual([]);
      expect(c.notIdentity + c.changedBySelection + c.changedByHover + c.dirtyAtEnd).toBe(0);
    });

    it('the layer keeps raw only what it has to: the real notes are edited in place', () => {
      for (const [name, r] of Object.entries(gate.raw)) {
        expect(r.files, name).toBeGreaterThan(0);
        expect(r.rawBlocks / r.blocks, name).toBeLessThan(0.2);
      }
    });
  });
}
