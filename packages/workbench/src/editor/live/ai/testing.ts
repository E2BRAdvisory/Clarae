// A fake core for the tests of the AI assistant: the port of `port.ts` over a scripted answer. It is
// to the provider what `ai.Fake` is to the Go service: no network, the same events, in the same order.
import type { AiChunk, AiDone, AiPort, AiRequest, AiStatus } from './port';

export const openStatus = (over: Partial<AiStatus> = {}): AiStatus => ({
  available: true,
  reason: '',
  build: true,
  flag: true,
  private: false,
  configured: true,
  provider: 'openai',
  model: 'm',
  ...over,
});

export interface FakeCore extends AiPort {
  requests: AiRequest[];
  cancelled: string[];
  statusCalls: string[];
  /** Listeners currently registered (a provider must leave none behind). */
  listeners(): number;
  /** The id of the last request. */
  lastId(): string;
  chunk(text: string, seq: number, requestId?: string): void;
  done(over?: Partial<AiDone>, requestId?: string): void;
}

export interface FakeCoreOptions {
  status?: AiStatus | Error;
  /** Rejects `start` with this error (a gate of the core closed). */
  refuse?: Error;
  /** Runs when `start` is called, before it resolves: it may emit events. */
  onStart?: (core: FakeCore, req: AiRequest) => void;
}

export function fakeCore(o: FakeCoreOptions = {}): FakeCore {
  const chunkHandlers = new Set<(c: AiChunk) => void>();
  const doneHandlers = new Set<(d: AiDone) => void>();
  const core: FakeCore = {
    requests: [],
    cancelled: [],
    statusCalls: [],
    listeners: () => chunkHandlers.size + doneHandlers.size,
    lastId: () => core.requests[core.requests.length - 1]?.requestId ?? '',
    status(vaultId) {
      core.statusCalls.push(vaultId);
      const s = o.status ?? openStatus();
      return s instanceof Error ? Promise.reject(s) : Promise.resolve(s);
    },
    start(req) {
      core.requests.push(req);
      if (o.refuse) return Promise.reject(o.refuse);
      o.onStart?.(core, req);
      return Promise.resolve();
    },
    cancel(id) {
      core.cancelled.push(id);
      return Promise.resolve(true);
    },
    onChunk(h) {
      chunkHandlers.add(h);
      return () => chunkHandlers.delete(h);
    },
    onDone(h) {
      doneHandlers.add(h);
      return () => doneHandlers.delete(h);
    },
    chunk(text, seq, requestId = core.lastId()) {
      for (const h of [...chunkHandlers]) h({ requestId, seq, text });
    },
    done(over = {}, requestId = core.lastId()) {
      for (const h of [...doneHandlers])
        h({ requestId, ok: true, cancelled: false, error: '', ...over });
    },
  };
  return core;
}

/** A provider run to the end, as the text it yielded (or the error it threw). */
export async function drain(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const t of iterable) out.push(t);
  return out;
}
