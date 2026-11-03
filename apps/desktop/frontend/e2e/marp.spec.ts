import type { Page } from '@playwright/test';
import {
  appOrigin,
  expect,
  listVaultFiles,
  onWeb,
  openVault,
  readVaultFile,
  test,
} from './support';

// Marp presentations (ADR-0047): the split view (source editor, live slide preview), presenting,
// creating one and exporting it, all without a request outside the app.

const DECK = '---\nmarp: true\ntheme: gaia\npaginate: true\n---\n\n# Kick-off\n\n---\n\n## Plan\n';

const slideCount = (page: Page): Promise<number> =>
  page
    .getByTestId('marp-slides')
    .evaluate((el) => el.shadowRoot?.querySelectorAll('div.marpit > svg').length ?? 0);

function watchNetwork(page: Page): string[] {
  const external: string[] = [];
  const origin = appOrigin();
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol !== 'data:' && u.protocol !== 'blob:' && u.origin !== origin)
      external.push(r.url());
  });
  return external;
}

test('a presentation: source and slides side by side, live, presented, offline', async ({
  page,
}) => {
  const external = watchNetwork(page);
  await openVault(page, { 'Talks/Kickoff.marp': DECK });
  await page.locator('.tree .node', { hasText: 'Talks' }).click();
  await page.locator('.tree .node', { hasText: 'Kickoff.marp' }).click();

  await expect(page.locator('.marp-split .cm-content')).toContainText('# Kick-off');
  await expect.poll(() => slideCount(page)).toBe(2);

  // Typing a separator and a title adds a slide, and the file is saved.
  await page.locator('.marp-split .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n\n---\n\n## Budget\n');
  await expect.poll(() => slideCount(page)).toBe(3);
  await expect.poll(() => readVaultFile(page, 'Talks/Kickoff.marp')).toContain('## Budget');

  // Presenting: one slide fills the window until Escape.
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await expect(page.getByTestId('marp-slides')).toHaveClass(/presenting/);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('marp-slides')).not.toHaveClass(/presenting/);

  expect(external).toEqual([]);
});

test('a new presentation starts from the Marp template', async ({ page }) => {
  await openVault(page, { 'Readme.md': '# Readme\n' });
  await page.keyboard.press('ControlOrMeta+p');
  await page.keyboard.type('New presentation');
  await page.keyboard.press('Enter');
  await expect.poll(() => slideCount(page)).toBe(2);
  const deck = (await listVaultFiles(page)).find((p) => p.endsWith('.marp')) ?? '';
  expect(deck).toMatch(/^Presentation \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.marp$/);
  expect(await readVaultFile(page, deck)).toContain('marp: true');
});

test('exporting to HTML gives one self-contained file', async ({ page }) => {
  await openVault(page, { 'Kickoff.marp': DECK });
  await page.locator('.tree .node', { hasText: 'Kickoff.marp' }).click();
  await expect.poll(() => slideCount(page)).toBe(2);
  if (onWeb()) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'HTML', exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^Kickoff.*\.html$/);
  } else {
    await page.getByRole('button', { name: 'HTML', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('The presentation was saved');
    const html = await page.evaluate(
      () =>
        (window as unknown as { __mock: { htmlExports: { html: string }[] } }).__mock.htmlExports[0]
          ?.html ?? '',
    );
    expect(html).toContain('<div class="marpit">');
    expect(html).not.toMatch(/<script|@import|https?:\/\/fonts/);
  }
});
