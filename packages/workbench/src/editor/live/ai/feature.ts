// The AI feature of the Live editor, inactive (ADR-0050, A-D11). `attachAi` is what the editor's
// assembly calls before it creates the editor: it adds Crepe's AI feature, with the provider that
// reaches the core, only when every gate is open (build constant, `ai` flag, capability, a vault that
// is not private, and the core's own `Status`). With any gate closed it returns false having loaded
// nothing: the `live-ai` chunk is not fetched, no UI is drawn, no call is made to the core beyond
// what the gate itself needs.
import type { CrepeBuilder } from '@milkdown/crepe/builder';
import { loadAi } from '../chunks';
import { checkAi, defaultGateDeps, type AiClosed, type AiGateDeps } from './gate';
import { aiPort } from './port';
import { createCoreProvider } from './provider';

export interface AttachAiOptions {
  vaultId: string;
  /** Replaces where the conditions come from (tests). */
  deps?: AiGateDeps;
  /** Loads the chunk (tests count the calls). */
  load?: typeof loadAi;
  /** Called with the reason when the assistant is not attached. */
  onClosed?: (closed: AiClosed) => void;
}

/** Attaches the assistant to a builder that is not created yet; resolves to whether it did. */
export async function attachAi(
  builder: Pick<CrepeBuilder, 'addFeature'>,
  o: AttachAiOptions,
): Promise<boolean> {
  const deps = o.deps ?? defaultGateDeps(aiPort);
  const gate = await checkAi(o.vaultId, deps);
  if (!gate.open) {
    o.onClosed?.(gate.closed);
    return false;
  }
  const { ai } = await (o.load ?? loadAi)();
  builder.addFeature(ai, {
    provider: createCoreProvider(deps.port, () => o.vaultId),
    // The user reviews the change as a diff and accepts or rejects it: nothing is written without that.
    diffReviewOnEnd: true,
  });
  // The toolbar over a selection (chrome/) adds an "Ask AI" button when this flag is set, and looks the
  // provider's configuration up with a copy of the slice that is its own (the entries of Crepe's package are
  // bundled apart, so it is not the one the assistant sets): with the flag the toolbar cannot be drawn. The
  // assistant has the toolbar without its button; the flag is the only thing the toolbar reads of it.
  builder.addFeature((editor) =>
    editor.config((ctx) => {
      ctx
        .use<string[], 'FeaturesCtx'>('FeaturesCtx')
        .update((flags) => flags.filter((f) => f !== 'ai'));
    }),
  );
  return true;
}
