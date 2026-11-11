// Autocomplete of [[wikilinks]] (notes, aliases, #headings, #^blocks), #tags and frontmatter property
// names in CodeMirror. The links and tags come from the engine in completionEngine.ts (shared with the
// Live editor); the property names are Source only, because the frontmatter is not part of Live.
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete';
import { splitFrontmatter } from '@memobrain/markdown';
import {
  tagCandidates,
  wikilinkCandidates,
  type Candidate,
  type CandidateSet,
  type CompletionOptions,
} from './completionEngine';

export {
  linkTextFor,
  type CompletionBackend,
  type CompletionOptions,
  type LinkFormat,
} from './completionEngine';

function closing(context: CompletionContext, to: number): string {
  return context.state.doc.sliceString(to, to + 2) === ']]' ? '' : ']]';
}

/** The text of the line in front of the caret: what the engine reads. */
function textBefore(context: CompletionContext): string {
  const line = context.state.doc.lineAt(context.pos);
  return line.text.slice(0, context.pos - line.from);
}

function toResult(
  set: CandidateSet,
  context: CompletionContext,
  apply: (c: Candidate) => Completion['apply'],
): CompletionResult {
  const before = textBefore(context);
  return {
    from: context.pos - before.length + set.from,
    filter: false,
    options: set.options.map<Completion>((c) => {
      const how = apply(c);
      return {
        label: c.label,
        ...(c.displayLabel !== undefined ? { displayLabel: c.displayLabel } : {}),
        ...(c.detail !== undefined ? { detail: c.detail } : {}),
        type: c.type,
        ...(how !== undefined ? { apply: how } : {}),
      };
    }),
  };
}

function wikilinkSource(o: CompletionOptions): CompletionSource {
  return async (context): Promise<CompletionResult | null> => {
    const set = await wikilinkCandidates(textBefore(context), o);
    if (!set) return null;
    return toResult(
      set,
      context,
      (c) => (view, _c, a, b) =>
        view.dispatch({ changes: { from: a, to: b, insert: c.insert + closing(context, b) } }),
    );
  };
}

function tagSource(o: CompletionOptions): CompletionSource {
  return async (context): Promise<CompletionResult | null> => {
    const set = await tagCandidates(textBefore(context), context.explicit, o);
    return set ? toResult(set, context, () => undefined) : null;
  };
}

function propertySource(o: CompletionOptions): CompletionSource {
  return async (context): Promise<CompletionResult | null> => {
    const fm = splitFrontmatter(context.state.doc.toString());
    if (fm.lines === 0) return null;
    const line = context.state.doc.lineAt(context.pos);
    if (line.number < 2 || line.number >= fm.lines) return null;
    const m = context.matchBefore(/^[\w-]*$/);
    if (!m || line.text.slice(0, context.pos - line.from).includes(':')) return null;
    if (m.from !== line.from) return null;
    const items = await o.backend.suggest('properties', m.text, '');
    return {
      from: m.from,
      filter: false,
      options: items.map<Completion>((s) => ({
        label: s.label,
        detail: s.detail,
        type: 'property',
        apply: (view, _c, a, b) =>
          view.dispatch({ changes: { from: a, to: b, insert: `${s.label}: ` } }),
      })),
    };
  };
}

export function ofmCompletionSources(o: CompletionOptions): CompletionSource[] {
  return [wikilinkSource(o), tagSource(o), propertySource(o)];
}
