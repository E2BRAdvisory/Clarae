// A note of about 150 kB, opened and edited: what the layer costs. The limits are generous (they
// catch a quadratic step, not a slow machine); the numbers are printed when LIVE_METRICS is set.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLiveCore, type LiveCore } from '../headless';
import { LiveSession } from './session';
import { posAfter, tx } from '../testing/helpers';

let core: LiveCore;
beforeAll(async () => {
  core = await createLiveCore();
});
afterAll(() => core.destroy());

function bigNote(): string {
  const parts: string[] = ['---\ntitle: Big\ntags: [perf]\n---\n'];
  for (let i = 0; i < 600; i++) {
    parts.push(
      `## Section ${i}\n\nParagraph ${i} with a [[Link ${i}]], a #tag${i % 7}, some **bold** and _emphasis_, and a ^b${i}\n`,
      `- item ${i} a\n- [ ] task ${i} b\n  - nested ${i} c\n`,
      `| a | b |\n| - | - |\n| ${i} | x [[T${i}]] |\n`,
      '```ts\nconst a = 1;\nconst b = 2;\n```\n',
      `> [!note] Callout ${i}\n> body ${i} %%comment%%\n`,
    );
  }
  return parts.join('\n');
}

describe('a note of about 150 kB', () => {
  it('opens, composes and saves within limits', () => {
    const raw = bigNote();
    expect(raw.length).toBeGreaterThan(100_000);
    const t0 = performance.now();
    const r = LiveSession.open(core, raw);
    const open = performance.now() - t0;
    if (!r.ok) throw new Error(r.reason);
    const { session } = r;
    const t1 = performance.now();
    const same = session.text(session.doc);
    const identity = performance.now() - t1;
    expect(same).toBe(raw);
    const at = posAfter(session.doc, 'Paragraph 450 with');
    const doc = tx(session.doc).insertText('!', at).doc;
    const t2 = performance.now();
    const out = session.text(doc);
    const edit = performance.now() - t2;
    expect(out).toBe(raw.replace('Paragraph 450 with', 'Paragraph 450 with!'));
    if (process.env['LIVE_METRICS']) {
      console.log(
        `perf ${Math.round(raw.length / 1024)} kB: open ${open.toFixed(0)} ms, identity ${identity.toFixed(1)} ms, one edit ${edit.toFixed(1)} ms`,
      );
    }
    // jsdom builds the views of 600 code blocks and tables here: a browser needs a fraction of it
    expect(open).toBeLessThan(15_000);
    expect(identity).toBeLessThan(50);
    expect(edit).toBeLessThan(500);
  }, 60_000);
});
