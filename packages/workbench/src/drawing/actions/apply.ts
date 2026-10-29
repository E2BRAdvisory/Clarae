import type { SceneElement, ScenePatch } from './types';

/**
 * Applies a patch, returning the new element list. Every touched element gets `version` + 1 and a
 * fresh `versionNonce`: that is what makes the change win the by-id merge against a stale copy.
 */
export function applyPatch(
  elements: readonly SceneElement[],
  patch: ScenePatch,
  nonce: () => number = () => Math.floor(Math.random() * 2 ** 31),
  now: number = Date.now(),
): SceneElement[] {
  const remove = new Set(patch.remove ?? []);
  const bump = (e: SceneElement, props: Record<string, unknown>): SceneElement => ({
    ...e,
    ...props,
    version: e.version + 1,
    versionNonce: nonce(),
    updated: now,
  });
  const out = elements.map((e) => {
    const props = patch.update?.[e.id];
    if (remove.has(e.id)) return bump(e, { ...props, isDeleted: true });
    return props ? bump(e, props) : e;
  });
  return [...out, ...(patch.add ?? [])];
}
