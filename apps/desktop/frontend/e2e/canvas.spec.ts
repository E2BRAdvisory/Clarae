import type { Page } from '@playwright/test';
import { appOrigin, expect, listVaultFiles, openVault, readVaultFile, test } from './support';

const MAP = JSON.stringify({
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 200, height: 100, text: 'Alpha **bold**' },
    { id: 'b', type: 'text', x: 400, y: 0, width: 200, height: 100, text: 'Beta' },
    { id: 'f', type: 'file', x: 0, y: 250, width: 300, height: 160, file: 'Plan.md' },
  ],
  edges: [],
});

interface Canvas {
  nodes: { id: string; type: string; text?: string; x: number }[];
  edges: { fromNode: string; toNode: string; label?: string }[];
}
const canvasOf = async (page: Page, path: string): Promise<Canvas> =>
  JSON.parse((await readVaultFile(page, path)) || '{}') as Canvas;

test('a canvas: cards, connections, labels, undo and autosave, all offline', async ({ page }) => {
  const external: string[] = [];
  const origin = appOrigin();
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol !== 'data:' && u.protocol !== 'blob:' && u.origin !== origin)
      external.push(r.url());
  });
  await openVault(page, { 'Map.canvas': MAP, 'Plan.md': '# Plan\n\nthe plan body\n' });
  await page.locator('.tree .node', { hasText: 'Map' }).click();

  const node = (id: string) => page.locator(`[data-node="${id}"]`);
  await expect(node('a')).toContainText('Alpha');
  await expect(node('a').locator('strong')).toHaveText('bold');
  await expect(node('f')).toContainText('the plan body'); // a note card embeds the note

  // Connect A to B by dragging from A's right handle onto B.
  await node('a').click();
  const handle = node('a').locator('.cv-handle.right');
  const hb = (await handle.boundingBox())!;
  const bb = (await node('b').boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await canvasOf(page, 'Map.canvas')).edges.length).toBe(1);
  expect((await canvasOf(page, 'Map.canvas')).edges[0]).toMatchObject({
    fromNode: 'a',
    toNode: 'b',
  });

  // Label the connection.
  // A straight edge has an empty bounding box, which Playwright will not click: send the event.
  await page.locator('[data-edge] path').first().dispatchEvent('dblclick');
  await page.locator('#dialog-input').fill('depends on');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await canvasOf(page, 'Map.canvas')).edges[0]?.label)
    .toBe('depends on');
  await expect(page.locator('.cv-edge-label')).toHaveText('depends on');

  // Undo removes the label, then the edge.
  await page.getByRole('application', { name: 'Canvas' }).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await canvasOf(page, 'Map.canvas')).edges.length).toBe(0);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await canvasOf(page, 'Map.canvas')).edges.length).toBe(1);

  // A new text card, written in place.
  await page.getByRole('button', { name: 'Add a text card' }).click();
  await page.getByLabel('Card text').fill('Brand new idea');
  await page.keyboard.press('Escape');
  await expect
    .poll(async () =>
      (await canvasOf(page, 'Map.canvas')).nodes.some((n) => n.text === 'Brand new idea'),
    )
    .toBe(true);

  // Drag B to the right: the file keeps the new position.
  const before = (await canvasOf(page, 'Map.canvas')).nodes.find((n) => n.id === 'b')!.x;
  const b2 = (await node('b').boundingBox())!;
  await page.mouse.move(b2.x + 50, b2.y + 30);
  await page.mouse.down();
  await page.mouse.move(b2.x + 150, b2.y + 30, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => (await canvasOf(page, 'Map.canvas')).nodes.find((n) => n.id === 'b')!.x)
    .toBeGreaterThan(before);

  await expect(page.locator('.save-state')).toHaveText('Saved', { timeout: 10_000 });
  expect(external).toEqual([]);
});

test('a canvas embedded in a note renders as a picture', async ({ page }) => {
  await openVault(page, {
    'Map.canvas': MAP,
    'Plan.md': '# Plan',
    'Note.md': '![[Map.canvas|400]]\n',
  });
  await page.locator('.tree .node', { hasText: 'Note' }).click();
  await page.getByRole('button', { name: 'Reading' }).click();
  const img = page.locator('img.embed-canvas');
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute('width', '400');
});

test('New canvas from the palette creates the file and embeds it in the open note', async ({
  page,
}) => {
  await openVault(page, { 'Host.md': 'hello\n' });
  await page.locator('.tree .node', { hasText: 'Host' }).click();
  await page.getByLabel('Note editor').click();
  await page.keyboard.press('ControlOrMeta+p');
  await page.getByPlaceholder('Type a command…').fill('new canvas');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: /Canvas \d{4}/ })).toBeVisible();
  await expect(page.getByRole('application', { name: 'Canvas' })).toBeVisible();
  await expect
    .poll(async () => (await listVaultFiles(page)).filter((p) => p.endsWith('.canvas')).length)
    .toBe(1);
});

test('a canvas goes full screen and Escape leaves it', async ({ page }) => {
  await openVault(page, { 'Map.canvas': MAP, 'Plan.md': '# Plan\n' });
  await page.locator('.tree .node', { hasText: 'Map' }).click();
  await page.getByRole('button', { name: 'Full screen' }).click();
  const vp = page.viewportSize()!;
  await expect(page.locator('.canvas-view.fullscreen')).toBeVisible();
  expect(await page.locator('.canvas-view.fullscreen').boundingBox()).toMatchObject({
    x: 0,
    y: 0,
    width: vp.width,
    height: vp.height,
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('.canvas-view.fullscreen')).toHaveCount(0);
});

test('a link in a canvas card does not navigate the app away', async ({ page }) => {
  const map = JSON.stringify({
    nodes: [
      {
        id: 'l',
        type: 'text',
        x: 0,
        y: 0,
        width: 320,
        height: 120,
        text: 'See [the site](https://example.com/page) and [the plan](Plan.md)',
      },
    ],
    edges: [],
  });
  await openVault(page, { 'Links.canvas': map, 'Plan.md': '# Plan\n\nthe plan body\n' });
  await page.locator('.tree .node', { hasText: 'Links' }).click();
  const card = page.locator('[data-node="l"]');
  await expect(card.getByRole('link', { name: 'the site' })).toBeVisible();

  // Nothing leaves the page: no navigation of the main frame and no request to the external site.
  const before = page.url();
  let navigations = 0;
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) navigations++;
  });
  const external: string[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith('https://example.com')) external.push(r.url());
  });
  await card.getByRole('link', { name: 'the site' }).click();
  await card.getByRole('link', { name: 'the plan' }).click();
  await page.waitForTimeout(500);
  expect(page.url()).toBe(before);
  expect(navigations).toBe(0);
  expect(external).toEqual([]);
  await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible();
});
