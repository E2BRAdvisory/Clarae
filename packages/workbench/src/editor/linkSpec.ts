// What a LinkSpec can say besides "a note": a `#tag` is the spec of a link that has no target and the
// tag as its alias (both editors send it when a tag is followed with Mod+click), and it asks for a search.
import type { LinkSpec } from './types';

/** The search a followed link stands for (`tag:#name`), or null when it points to a note. */
export function tagSearchOf(
  spec: Pick<LinkSpec, 'target' | 'heading' | 'block' | 'alias'>,
): string | null {
  if (spec.target || spec.heading || spec.block) return null;
  const name = /^#([\p{L}\p{N}_\-/]+)$/u.exec(spec.alias)?.[1];
  return name ? `tag:#${name}` : null;
}
