// The registries as scripts/parity.mjs sees them (ADR-0037, ADR-0045 §2). The script runs this file
// with CLARAE_PARITY_OUT=<file> and reads back, for every command and every declarative action
// (commands/actions.ts), its id, feature and the platforms that offer it (its `requires`, and an
// action's `excludes`, evaluated with configurePlatform). It reads the capabilities of each
// platform from the core's declaration instead (shared/parity/capabilities.gen.json, ADR-0045 §1).
// Without the variable it only checks that the declarations are sound.
import { afterEach, describe, expect, it } from 'vitest';
import { capabilitiesFor, configurePlatform, type PlatformKind } from '../platform';
import { FEATURE_IDS } from '../parity/features.gen';
import { actions, isActionAvailable } from './actions';
import { commands, isAvailable, isEnabled } from './registry';

const PLATFORMS: PlatformKind[] = ['desktop', 'web'];

// The package is typed for the browser (no @types/node): the two Node APIs used here, declared.
declare const process: { env: Record<string, string | undefined> };
type WriteFile = (path: string, data: string) => void;
const nodeFs = 'node:fs';

afterEach(() => configurePlatform());

function availableOn(kind: PlatformKind): Set<string> {
  configurePlatform({ kind });
  return new Set([
    ...commands.filter(isAvailable).map((c) => c.id),
    ...actions.filter(isActionAvailable).map((a) => a.id),
  ]);
}

describe('command requirements', () => {
  it('name only capabilities the platform layer knows', () => {
    const known = Object.keys(capabilitiesFor('desktop'));
    for (const c of commands) for (const r of c.requires ?? []) expect(known, c.id).toContain(r);
    for (const a of actions)
      for (const r of [...(a.requires ?? []), ...(a.excludes ?? [])])
        expect(known, a.id).toContain(r);
  });

  it('name features of the registry, and an action never takes the id of a command', () => {
    // The type already refuses an unknown feature; this catches a stale features.gen.ts at runtime.
    for (const x of [...commands, ...actions]) expect(FEATURE_IDS, x.id).toContain(x.feature);
    const ids = new Set(commands.map((c) => c.id));
    for (const a of actions) expect(ids.has(a.id), a.id).toBe(false);
    expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
  });

  it('keep a command off a platform that lacks the capability, whatever enabled says', () => {
    expect(availableOn('desktop').has('update:check')).toBe(true);
    expect(availableOn('web').has('update:check')).toBe(false);
    const cmd = commands.find((c) => c.id === 'update:check');
    expect(cmd && isEnabled(cmd)).toBe(false); // still on the web
  });

  it('writes the registry for scripts/parity.mjs when asked', async () => {
    const on = Object.fromEntries(PLATFORMS.map((k) => [k, availableOn(k)]));
    const platforms = (id: string) =>
      Object.fromEntries(PLATFORMS.map((k) => [k, on[k]?.has(id) ?? false]));
    const rows = commands.map((c) => ({
      id: c.id,
      group: c.group,
      feature: c.feature,
      hidden: !!c.hidden,
      requires: [...(c.requires ?? [])],
      platforms: platforms(c.id),
    }));
    const actionRows = actions.map((a) => ({
      id: a.id,
      feature: a.feature,
      requires: [...(a.requires ?? [])],
      excludes: [...(a.excludes ?? [])],
      platforms: platforms(a.id),
    }));
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    const out = process.env.CLARAE_PARITY_OUT;
    if (out) {
      const { writeFileSync } = (await import(/* @vite-ignore */ nodeFs)) as {
        writeFileSync: WriteFile;
      };
      writeFileSync(out, JSON.stringify({ commands: rows, actions: actionRows }, null, 2));
    }
  });
});
