import { expect, test, type Page } from '@playwright/test';

interface MockWindow {
  __mock: {
    vaults: Map<string, { info: { id: string }; files: Map<string, string> }>;
    emit(name: string, payload: unknown): void;
  };
}

async function openVault(page: Page, files: Record<string, string>): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder as vault' }).click();
  await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible();
  await page.evaluate((seed) => {
    const w = window as unknown as MockWindow;
    const v = [...w.__mock.vaults.values()][0];
    if (!v) throw new Error('vault not open');
    for (const [p, c] of Object.entries(seed)) v.files.set(p, c);
    w.__mock.emit('vault:file-changed', { vaultId: v.info.id, paths: Object.keys(seed) });
  }, files);
}

test('the graph view opens from the keyboard, lays out in a worker and draws the notes', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol !== 'data:' && u.protocol !== 'blob:' && u.origin !== 'http://localhost:5199')
      external.push(r.url());
  });
  await openVault(page, {
    'Alpha.md': '[[Beta]] [[Gamma]]',
    'Beta.md': '[[Gamma]]',
    'Gamma.md': 'end',
    'Solo.md': 'alone',
  });
  await page.keyboard.press('ControlOrMeta+Shift+g');
  const canvas = page.getByTestId('graph-canvas');
  await expect(canvas).toBeVisible();
  await expect(page.getByText('4 nodes, 3 links')).toBeVisible();
  // Something was painted: the canvas is not a single flat colour.
  await expect
    .poll(async () =>
      canvas.evaluate((c: HTMLCanvasElement) => {
        const ctx = c.getContext('2d');
        if (!ctx) return 0;
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const seen = new Set<number>();
        for (let i = 0; i < d.length; i += 4 * 97)
          seen.add((d[i] ?? 0) * 65536 + (d[i + 1] ?? 0) * 256 + (d[i + 2] ?? 0));
        return seen.size;
      }),
    )
    .toBeGreaterThan(1);
  // Filters apply: hide orphans.
  await page.getByLabel('Orphans').uncheck();
  await expect(page.getByText('3 nodes, 3 links')).toBeVisible();
  // Keyboard: focus the canvas, move to the first node, open it.
  await canvas.focus();
  await page.keyboard.press(']');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: /\.?(Alpha|Beta|Gamma)/ }).first()).toBeVisible();
  expect(external).toEqual([]);
});
