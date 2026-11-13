// The assistant on the real editor, with a fake core in place of the model: the answer streams into
// the document, is reviewed as a diff, and on accept or reject only the blocks it touched differ from
// the file (the fidelity layer of A-W3 writes the rest back byte for byte).
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { runAICmd } from '@milkdown/crepe/feature/ai';
import { commandsCtx } from '@milkdown/kit/core';
import { acceptAllDiffsCmd, clearDiffReviewCmd, diffPluginKey } from '@milkdown/kit/plugin/diff';
import { streamingPluginKey } from '@milkdown/kit/plugin/streaming';
import { TextSelection } from '@milkdown/kit/prose/state';
import { Feature } from '@clarae/api-client/features';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAi } from '../chunks';
import { emojiAsTyped } from '../chunks/emoji';
import { LiveSession } from '../fidelity/session';
import { addSchemaFeatures } from '../headless';
import { installDomShims } from '../domShims';
import { installLive } from '../kit';
import { captureSurface, type EditorSurface } from '../surface';
import { posAfter } from '../testing/helpers';
import { changedLines } from '../testing/metrics';
import { attachAi } from './feature';
import type { AiGateDeps } from './gate';
import { fakeCore, type FakeCore } from './testing';

vi.setConfig({ testTimeout: 30_000 });

const RAW = [
  '# Title',
  '',
  'First paragraph.',
  '',
  '*   odd list a',
  '*   odd list b',
  '',
  'Second paragraph to shout.',
  '',
  '| a|b |',
  '|--|--|',
  '|1 |2|',
  '',
  'Last.',
  '',
].join('\n');

const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await wait(5);
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

interface Rig {
  builder: CrepeBuilder;
  surface: EditorSurface;
  session: LiveSession;
  core: FakeCore;
  host: HTMLElement;
  attached: boolean;
}
const rigs: Rig[] = [];

async function rig(core: FakeCore, deps: Partial<AiGateDeps> = {}): Promise<Rig> {
  installDomShims();
  const host = document.body.appendChild(document.createElement('div'));
  const builder = addSchemaFeatures(new CrepeBuilder({ root: host, defaultValue: '' }));
  installLive(builder.editor).use(emojiAsTyped);
  const load = vi.fn(loadAi);
  const attached = await attachAi(builder, {
    vaultId: 'v1',
    load,
    deps: {
      build: () => true,
      features: () => ({ [Feature.Ai]: true }),
      capable: () => true,
      privateVault: () => false,
      port: core,
      ...deps,
    },
  });
  const surfaceOf = captureSurface(builder.editor);
  await builder.create();
  const surface = surfaceOf();
  const opened = LiveSession.open(surface, RAW);
  if (!opened.ok) throw new Error('refused ' + opened.reason);
  const r = { builder, surface, session: opened.session, core, host, attached };
  rigs.push(r);
  return r;
}

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.builder.destroy();
    r.host.remove();
  }
});

/** Selects the text of the paragraph that holds `text` (what the user does before asking). */
function select(r: Rig, text: string): void {
  const { view } = r.surface;
  const to = posAfter(view.state.doc, text);
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, to - text.length, to)),
  );
}

const ask = (r: Rig, instruction: string) =>
  r.builder.editor.action((ctx) => ctx.get(commandsCtx).call(runAICmd.key, { instruction }));
const reviewing = (r: Rig) => !!diffPluginKey.getState(r.surface.view.state)?.active;
const streaming = (r: Rig) => !!streamingPluginKey.getState(r.surface.view.state)?.active;

const scripted = (chunks: string[]) =>
  fakeCore({
    onStart: (c) =>
      queueMicrotask(() => {
        chunks.forEach((t, i) => c.chunk(t, i));
        c.done();
      }),
  });

describe('the assistant on the Live editor, with a fake core', () => {
  it('streams an answer for the selection, shows it as a diff, and on accept writes only that block', async () => {
    const r = await rig(scripted(['SECOND PARAGRAPH', ' TO SHOUT.']));
    expect(r.attached).toBe(true);
    select(r, 'Second paragraph to shout.');
    expect(ask(r, 'shout')).toBe(true);
    await until(() => reviewing(r), 'the diff review');

    // what the core got: the prompt of Crepe, with the selection
    const req = r.core.requests[0]!;
    expect(req).toMatchObject({ vaultId: 'v1', instruction: 'shout' });
    expect(req.selection.trim()).toBe('Second paragraph to shout.'); // as markdown, with its line end
    expect(req.document).toContain('First paragraph.');

    // nothing is final yet: the review is open, the file text is still the one the user has
    expect(r.core.listeners()).toBe(0);
    r.builder.editor.action((ctx) => ctx.get(commandsCtx).call(acceptAllDiffsCmd.key));
    expect(reviewing(r)).toBe(false);

    const out = r.session.text(r.surface.view.state.doc);
    // The blocks the answer did not touch are the file, byte for byte (a dirty list or table would be
    // written again in the form of the serializer); the touched block carries the answer.
    expect(out).toContain('*   odd list a\n*   odd list b\n');
    expect(out).toContain('| a|b |\n|--|--|\n|1 |2|\n');
    expect(out).toContain('# Title\n\nFirst paragraph.\n');
    expect(out).toContain('SECOND PARAGRAPH TO SHOUT.');
    expect(out).not.toContain('Second paragraph to shout.');
    expect(out).toBe(RAW.replace('Second paragraph to shout.', 'SECOND PARAGRAPH TO SHOUT.'));
    expect(changedLines(RAW, out)).toBe(1); // one touched block, one line of the file
  });

  it('on reject the note is the file, byte for byte', async () => {
    const r = await rig(scripted(['SECOND PARAGRAPH TO SHOUT.']));
    select(r, 'Second paragraph to shout.');
    ask(r, 'shout');
    await until(() => reviewing(r), 'the diff review');
    r.builder.editor.action((ctx) =>
      ctx.get(commandsCtx).call(clearDiffReviewCmd.key, { reject: true }),
    );
    await until(() => !reviewing(r), 'the end of the review');
    expect(r.session.text(r.surface.view.state.doc)).toBe(RAW);
  });

  it('a failed answer leaves the document as it was', async () => {
    const core = fakeCore({
      onStart: (c) =>
        queueMicrotask(() => {
          c.chunk('SECOND', 0);
          c.done({ ok: false, error: 'the provider took too long to answer' });
        }),
    });
    const r = await rig(core);
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => void errors.push(a));
    select(r, 'Second paragraph to shout.');
    ask(r, 'shout');
    await until(() => !streaming(r) && core.listeners() === 0, 'the end of the request');
    spy.mockRestore();
    expect(reviewing(r)).toBe(false);
    expect(r.session.text(r.surface.view.state.doc)).toBe(RAW);
    expect(errors.length).toBeGreaterThan(0); // Crepe reported it (onError)
  });

  it('with a gate closed the feature is not there: no provider, no request, nothing to ask', async () => {
    for (const over of [
      { build: () => false },
      { features: () => ({}) },
      { capable: () => false },
      { privateVault: () => true },
    ] as Partial<AiGateDeps>[]) {
      const core = scripted(['x']);
      const r = await rig(core, over);
      expect(r.attached).toBe(false);
      select(r, 'Second paragraph to shout.');
      // Crepe's command does not exist without the feature: nothing is asked, nothing reaches the core
      expect(() => ask(r, 'shout')).toThrow();
      expect(core.requests).toEqual([]);
      expect(core.statusCalls).toEqual([]);
      expect(r.session.text(r.surface.view.state.doc)).toBe(RAW);
    }
  });
});
