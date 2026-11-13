// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BRAND_MARK_PATHS } from './brand';

const svg = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../assets/brand/${name}`, import.meta.url)), 'utf8');
const paths = (source: string) => [...source.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);

describe('BrandMark', () => {
  it('draws the shapes of the vector sources in assets/brand', () => {
    for (const name of ['mark.svg', 'mark-on-dark.svg', 'icon.svg', 'safari-pinned-tab.svg']) {
      expect(paths(svg(name)), name).toEqual([...BRAND_MARK_PATHS]);
    }
  });
});
