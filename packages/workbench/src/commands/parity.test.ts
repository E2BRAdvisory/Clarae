// The registry as scripts/parity.mjs sees it (ADR-0037). The script runs this file with
// MEMOBRAIN_PARITY_OUT=<file> and reads back the capabilities of each platform and, for every
// command, its id, group and the platforms that offer it (its `requires` evaluated with
// configurePlatform). Without the variable it only checks that the declarations are sound.
import { afterEach, describe, expect, it } from 'vitest';
import { capabilitiesFor, configurePlatform, type PlatformKind } from '../platform';
import { commands, isAvailable, isEnabled } from './registry';

const PLATFORMS: PlatformKind[] = ['desktop', 'web'];

// The package is typed for the browser (no @types/node): the two Node APIs used here, declared.
declare const process: { env: Record<string, string | undefined> };
type WriteFile = (path: string, data: string) => void;
const nodeFs = 'node:fs';

afterEach(() => configurePlatform());

function availableOn(kind: PlatformKind): Set<string> {
  configurePlatform({ kind });
  return new Set(commands.filter(isAvailable).map((c) => c.id));
}

describe('command requirements', () => {
  it('name only capabilities the platform layer knows', () => {
    const known = Object.keys(capabilitiesFor('desktop'));
    for (const c of commands) for (const r of c.requires ?? []) expect(known, c.id).toContain(r);
  });

  it('keep a command off a platform that lacks the capability, whatever enabled says', () => {
    expect(availableOn('desktop').has('update:check')).toBe(true);
    expect(availableOn('web').has('update:check')).toBe(false);
    const cmd = commands.find((c) => c.id === 'update:check');
    expect(cmd && isEnabled(cmd)).toBe(false); // still on the web
  });

  it('writes the registry for scripts/parity.mjs when asked', async () => {
    const on = Object.fromEntries(PLATFORMS.map((k) => [k, availableOn(k)]));
    const rows = commands.map((c) => ({
      id: c.id,
      group: c.group,
      hidden: !!c.hidden,
      requires: [...(c.requires ?? [])],
      platforms: Object.fromEntries(PLATFORMS.map((k) => [k, on[k]?.has(c.id) ?? false])),
    }));
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    const out = process.env.MEMOBRAIN_PARITY_OUT;
    const capabilities = Object.fromEntries(PLATFORMS.map((k) => [k, capabilitiesFor(k)]));
    if (out) {
      const { writeFileSync } = (await import(/* @vite-ignore */ nodeFs)) as {
        writeFileSync: WriteFile;
      };
      writeFileSync(out, JSON.stringify({ capabilities, commands: rows }, null, 2));
    }
  });
});
