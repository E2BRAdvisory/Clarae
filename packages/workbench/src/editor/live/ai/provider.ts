// The AI provider of the Live editor (ADR-0050): an `AsyncIterable` for Crepe's AI feature that
// carries the request to the core and the answer back, through AIAPI and the `ai:chunk` and `ai:done`
// events. The model, the key and the network are the core's: nothing here can reach a provider, and
// `@milkdown/crepe/llm-providers/*` (which can) is forbidden by ESLint.
import type { AIProvider } from '@milkdown/crepe/feature/ai';
import type { AiChunk, AiDone, AiPort } from './port';

let counter = 0;
/** A request id: letters, digits, `-` and `_` (what the core accepts), unique within the session. */
export function newRequestId(): string {
  const random =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `ai-${Date.now().toString(36)}-${(counter++).toString(36)}-${random}`.slice(0, 64);
}

/**
 * The provider for one vault. Each call is one request: it listens before it asks (the first chunk
 * may arrive before `start` resolves), yields the text in order, and ends with the answer of the core.
 * Aborting the signal, or stopping the iteration, cancels the request in the core. A request the core
 * refuses (a gate closed) or that fails rejects with its message, which Crepe reports through its
 * `onError` and which leaves the document as it was.
 */
export function createCoreProvider(port: AiPort, vaultId: () => string): AIProvider {
  return async function* coreProvider(context, signal) {
    if (signal.aborted) return;
    const requestId = newRequestId();
    // The chunks wait in order of `seq` (the transport keeps the order; this does not rely on it).
    const pending = new Map<number, string>();
    let next = 0;
    let done: AiDone | null = null;
    let wake: (() => void) | null = null;
    const poke = (): void => {
      const w = wake;
      wake = null;
      w?.();
    };
    const offChunk = port.onChunk((c: AiChunk) => {
      if (c.requestId !== requestId) return;
      pending.set(c.seq, c.text);
      poke();
    });
    const offDone = port.onDone((d: AiDone) => {
      if (d.requestId !== requestId) return;
      done = d;
      poke();
    });
    const onAbort = (): void => {
      void port.cancel(requestId).catch(() => undefined);
      poke();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    let started = false;
    try {
      await port.start({
        vaultId: vaultId(),
        requestId,
        document: context.document,
        selection: context.selection,
        instruction: context.instruction,
      });
      started = true;
      for (;;) {
        for (let text = pending.get(next); text !== undefined; text = pending.get(next)) {
          pending.delete(next++);
          yield text;
        }
        if (signal.aborted) return;
        // `done` follows the last chunk: once it is in and nothing is left to yield, the answer is complete.
        const end = done as AiDone | null;
        if (end) {
          if (end.error) throw new Error(end.error);
          return; // complete, or cancelled by the core (the app closing)
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          // an event that arrived since the checks above must not be waited for
          if (pending.has(next) || done || signal.aborted) poke();
        });
      }
    } finally {
      offChunk();
      offDone();
      signal.removeEventListener('abort', onAbort);
      // stopped before the end (the consumer left, or `start` itself threw after being accepted)
      if (started && !done && !signal.aborted) void port.cancel(requestId).catch(() => undefined);
    }
  };
}
