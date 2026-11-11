import { describe, expect, it } from 'vitest';
import type { AIPromptContext } from '@milkdown/crepe/feature/ai';
import { createCoreProvider, newRequestId } from './provider';
import { drain, fakeCore } from './testing';

const ctx: AIPromptContext = {
  document: '# T\n\nhello\n',
  selection: 'hello',
  instruction: 'shout',
};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('the provider that bridges to the core', () => {
  it('sends the prompt of Crepe, yields the chunks in order and ends with the core', async () => {
    const core = fakeCore({
      onStart: (c) => {
        // the answer is already on its way when `start` resolves (the core runs it in the background)
        queueMicrotask(() => {
          c.chunk('HEL', 0);
          c.chunk('LO', 1);
          c.done();
        });
      },
    });
    const out = await drain(
      createCoreProvider(core, () => 'v1')(ctx, new AbortController().signal),
    );
    expect(out).toEqual(['HEL', 'LO']);
    expect(core.requests).toHaveLength(1);
    expect(core.requests[0]).toMatchObject({
      vaultId: 'v1',
      document: '# T\n\nhello\n',
      selection: 'hello',
      instruction: 'shout',
    });
    expect(core.requests[0]!.requestId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(core.listeners()).toBe(0);
    expect(core.cancelled).toEqual([]);
  });

  it('listens before it asks: events sent while start is running are not lost', async () => {
    const core = fakeCore({
      onStart: (c) => {
        c.chunk('a', 0); // synchronously, before start returns
        c.done();
      },
    });
    expect(
      await drain(createCoreProvider(core, () => 'v')(ctx, new AbortController().signal)),
    ).toEqual(['a']);
  });

  it('puts chunks that arrive out of order back in order, and ignores the other requests', async () => {
    const core = fakeCore({
      onStart: (c) => {
        queueMicrotask(() => {
          c.chunk('C', 2);
          c.chunk('other', 0, 'someone-else');
          c.chunk('A', 0);
          c.chunk('B', 1);
          c.done({}, 'someone-else'); // the end of another request is not ours
          c.done();
        });
      },
    });
    expect(
      await drain(createCoreProvider(core, () => 'v')(ctx, new AbortController().signal)),
    ).toEqual(['A', 'B', 'C']);
  });

  it('drains the chunks that came with the end', async () => {
    const core = fakeCore({
      onStart: (c) => {
        queueMicrotask(() => {
          c.done();
          c.chunk('late', 0); // the transport delivers them the other way round: still yielded, in order
        });
      },
    });
    expect(
      await drain(createCoreProvider(core, () => 'v')(ctx, new AbortController().signal)),
    ).toEqual(['late']);
  });

  it('throws the error of the core, after the text it did send', async () => {
    const core = fakeCore({
      onStart: (c) =>
        queueMicrotask(() => {
          c.chunk('partial', 0);
          c.done({ ok: false, error: 'the provider took too long to answer' });
        }),
    });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const t of createCoreProvider(core, () => 'v')(
          ctx,
          new AbortController().signal,
        ))
          seen.push(t);
      })(),
    ).rejects.toThrow('the provider took too long to answer');
    expect(seen).toEqual(['partial']);
    expect(core.listeners()).toBe(0);
  });

  it('rejects with the refusal of the core (a closed gate) and leaves nothing listening', async () => {
    const core = fakeCore({
      refuse: new Error(
        'ai-disabled: the AI assistant is switched off by the configuration profile',
      ),
    });
    await expect(
      drain(createCoreProvider(core, () => 'v')(ctx, new AbortController().signal)),
    ).rejects.toThrow(/^ai-disabled:/);
    expect(core.listeners()).toBe(0);
    expect(core.cancelled).toEqual([]); // nothing was started, nothing to cancel
  });

  it('cancels the request in the core when the signal aborts, and ends without throwing', async () => {
    const core = fakeCore();
    const ac = new AbortController();
    const seen: string[] = [];
    const run = (async () => {
      for await (const t of createCoreProvider(core, () => 'v')(ctx, ac.signal)) seen.push(t);
    })();
    await tick();
    core.chunk('one', 0);
    await tick();
    ac.abort();
    await run;
    expect(seen).toEqual(['one']);
    expect(core.cancelled).toEqual([core.lastId()]);
    expect(core.listeners()).toBe(0);
  });

  it('does nothing at all with a signal that is already aborted', async () => {
    const core = fakeCore();
    const ac = new AbortController();
    ac.abort();
    expect(await drain(createCoreProvider(core, () => 'v')(ctx, ac.signal))).toEqual([]);
    expect(core.requests).toEqual([]);
    expect(core.listeners()).toBe(0);
  });

  it('cancels when the consumer stops iterating before the end', async () => {
    const core = fakeCore({ onStart: (c) => queueMicrotask(() => c.chunk('first', 0)) });
    const iterator = createCoreProvider(core, () => 'v')(ctx, new AbortController().signal)[
      Symbol.asyncIterator
    ]();
    const first = await iterator.next();
    expect(first.value).toBe('first');
    await iterator.return?.();
    expect(core.cancelled).toEqual([core.lastId()]);
    expect(core.listeners()).toBe(0);
  });

  it('does not cancel a request that ended', async () => {
    const core = fakeCore({ onStart: (c) => queueMicrotask(() => c.done()) });
    await drain(createCoreProvider(core, () => 'v')(ctx, new AbortController().signal));
    expect(core.cancelled).toEqual([]);
  });

  it('gives each call its own id, in the form the core accepts', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRequestId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});
