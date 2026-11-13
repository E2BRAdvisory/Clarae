import { readFile } from 'node:fs/promises';
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

// Marp presentations (ADR-0047, ADR-0048): the source editor at full width, the Slideshow tab with
// a card per slide, presenting full screen, creating one and exporting it, all without a request
// outside the app.

const DECK = '---\nmarp: true\ntheme: gaia\npaginate: true\n---\n\n# Kick-off\n\n---\n\n## Plan\n';

const cardTitles = (page: Page): Promise<string[]> =>
  page.getByTestId('marp-card').locator('.title').allTextContents();

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

async function openDeck(page: Page, files: Record<string, string>, path: string): Promise<void> {
  await openVault(page, files);
  const dir = path.includes('/') ? path.split('/')[0] : '';
  if (dir) await page.locator('.tree .node', { hasText: dir }).click();
  await page.locator('.tree .node', { hasText: path.split('/').pop() ?? path }).click();
  await expect(page.locator('.note-view .cm-content')).toContainText('# Kick-off');
  await openSlidesTab(page);
}

async function openSlidesTab(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Toggle right sidebar' }).click();
  await page.getByRole('tab', { name: 'Slides' }).click();
}

test('a presentation: the source at full width, no split view and no mode buttons', async ({
  page,
}) => {
  const external = watchNetwork(page);
  await openDeck(page, { 'Talks/Kickoff.marp': DECK }, 'Talks/Kickoff.marp');
  await expect(page.locator('.marp-split, .marp-pane, [data-testid="marp-slides"]')).toHaveCount(0);
  await expect(page.locator('.mode-toggle')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Live', exact: true })).toBeHidden();
  await expect(page.getByText('Open a Markdown note to present it.')).toHaveCount(0);

  // The Slideshow tab shows a card per slide, and follows the text typed in the editor.
  await expect(page.getByTestId('marp-card')).toHaveCount(2);
  expect(await cardTitles(page)).toEqual(['1. Kick-off', '2. Plan']);
  await page.locator('.note-view .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n\n---\n\n## Budget\n');
  await expect(page.getByTestId('marp-card')).toHaveCount(3);
  await expect(page.getByText('Slideshow · 3 of 3 slides included')).toBeVisible();
  await expect.poll(() => readVaultFile(page, 'Talks/Kickoff.marp')).toContain('## Budget');
  expect(external).toEqual([]);
});

test('moving a slide in the Slideshow tab changes the source, and undo brings it back', async ({
  page,
}) => {
  await openDeck(page, { 'Kickoff.marp': DECK }, 'Kickoff.marp');
  await expect(page.getByTestId('marp-card')).toHaveCount(2);
  await expect(page.getByTestId('marp-card').first().locator('.slide-thumb')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move down' }).first()).toBeEnabled();
  await page.getByRole('button', { name: 'Move down' }).first().click();
  await expect.poll(() => cardTitles(page)).toEqual(['1. Plan', '2. Kick-off']);
  await expect
    .poll(() => readVaultFile(page, 'Kickoff.marp'))
    .toMatch(/## Plan[\s\S]*---[\s\S]*# Kick-off/);
  await page.locator('.note-view .cm-content').click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => cardTitles(page)).toEqual(['1. Kick-off', '2. Plan']);
});

test('a slide left out is marked in the file and skipped by the presentation', async ({ page }) => {
  await openDeck(page, { 'Kickoff.marp': DECK + '\n---\n\n## Budget\n' }, 'Kickoff.marp');
  await expect(page.getByTestId('marp-card')).toHaveCount(3);
  await expect(page.getByTestId('marp-card').nth(1).locator('.slide-thumb')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Leave out of the presentation' }).nth(1),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Leave out of the presentation' }).nth(1).click();
  await expect(page.getByText('Slideshow · 2 of 3 slides included')).toBeVisible();
  await expect(page.getByTestId('marp-card').nth(1)).toHaveClass(/excluded/);
  await expect.poll(() => readVaultFile(page, 'Kickoff.marp')).toContain('<!-- clarae: hidden -->');

  await page.getByRole('button', { name: 'Start presentation' }).click();
  const show = page.locator('.marp-show');
  await expect(show).toBeVisible();
  await expect(show.getByText('1 / 2')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(show.getByText('2 / 2')).toBeVisible(); // Budget: Plan is skipped
  await page.keyboard.press('Escape');
  await expect(show).toHaveCount(0);
});

test('presenting full screen: keys move through the slides and Escape ends it', async ({
  page,
}) => {
  const external = watchNetwork(page);
  await openDeck(page, { 'Kickoff.marp': DECK }, 'Kickoff.marp');
  await expect(page.getByTestId('marp-card')).toHaveCount(2);
  await page.getByRole('button', { name: 'Start presentation' }).click();
  const show = page.locator('.marp-show');
  await expect(show).toBeVisible();
  await expect(show.getByText('1 / 2')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(show.getByText('2 / 2')).toBeVisible();
  await page.keyboard.press('ArrowRight'); // the last one: stays
  await expect(show.getByText('2 / 2')).toBeVisible();
  await page.keyboard.press('Home');
  await expect(show.getByText('1 / 2')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(show).toHaveCount(0);

  // Presenting from a card, and with the command of the palette.
  await page.getByRole('button', { name: 'Start from this slide' }).nth(1).click();
  await expect(show.getByText('2 / 2')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(show).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+p');
  await page.keyboard.type('Present the slides');
  await page.keyboard.press('Enter');
  await expect(show).toBeVisible();
  await expect(show.getByText('1 / 2')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(show).toHaveCount(0);
  expect(external).toEqual([]);
});

test('a new presentation starts from the Marp template', async ({ page }) => {
  await openVault(page, { 'Readme.md': '# Readme\n' });
  await page.keyboard.press('ControlOrMeta+p');
  await page.keyboard.type('New presentation');
  await page.keyboard.press('Enter');
  await openSlidesTab(page);
  await expect(page.getByTestId('marp-card')).toHaveCount(2);
  const deck = (await listVaultFiles(page)).find((p) => p.endsWith('.marp')) ?? '';
  expect(deck).toMatch(/^Presentation \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.marp$/);
  expect(await readVaultFile(page, deck)).toContain('marp: true');
});

test('exporting to HTML (the command of the palette) gives one self-contained file', async ({
  page,
}) => {
  await openDeck(page, { 'Kickoff.marp': DECK }, 'Kickoff.marp');
  await expect(page.getByTestId('marp-card')).toHaveCount(2);
  const exportHtml = async (): Promise<void> => {
    await page.keyboard.press('ControlOrMeta+p');
    await page.keyboard.type('Export the presentation to HTML');
    await page.keyboard.press('Enter');
  };
  if (onWeb()) {
    const download = page.waitForEvent('download');
    await exportHtml();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^Kickoff.*\.html$/);
  } else {
    await exportHtml();
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

test('the ribbon offers the exports of a presentation, and only those', async ({ page }) => {
  await openDeck(page, { 'Kickoff.marp': DECK, 'Note.md': '# Note\n' }, 'Kickoff.marp');
  const ribbon = page.getByRole('navigation', { name: 'Quick actions' });
  const exportNames = async (): Promise<string[]> =>
    (
      await ribbon
        .getByRole('button')
        .evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label') ?? ''))
    ).filter((n) => /export/i.test(n));
  expect(await exportNames()).toEqual([
    'Export the presentation to HTML',
    'Export the presentation to PDF',
    'Export the presentation to PowerPoint (PPTX)',
  ]);
  await page.locator('.tree .node', { hasText: /^Note$/ }).click();
  await expect(ribbon.getByRole('button', { name: 'Export to PDF' })).toBeEnabled();
  expect(await exportNames()).toEqual(['Export to PDF', 'Export as image', 'Export to HTML']);
});

test('the ribbon exports to HTML and to an editable PPTX, leaving out the hidden slides', async ({
  page,
}) => {
  const external = watchNetwork(page);
  const deck = `${DECK}\n---\n\n<!-- clarae: hidden -->\n\n## Secret\n\n---\n\n## Budget\n\n<!-- Mention the budget -->\n`;
  await openDeck(page, { 'Kickoff.marp': deck }, 'Kickoff.marp');
  await expect(page.getByTestId('marp-card')).toHaveCount(4);
  const ribbon = page.getByRole('navigation', { name: 'Quick actions' });

  // HTML.
  let html: string;
  if (onWeb()) {
    const download = page.waitForEvent('download');
    await ribbon.getByRole('button', { name: 'Export the presentation to HTML' }).click();
    const file = await download;
    html = await readFile((await file.path()) ?? '', 'utf8');
    await expect(page.getByRole('dialog')).toContainText('The presentation was saved');
    await page.getByRole('button', { name: 'OK' }).click();
  } else {
    await ribbon.getByRole('button', { name: 'Export the presentation to HTML' }).click();
    await expect(page.getByRole('dialog')).toContainText('The presentation was saved');
    await page.getByRole('button', { name: 'OK' }).click();
    html = await page.evaluate(
      () =>
        (
          window as unknown as { __mock: { htmlExports: { html: string }[] } }
        ).__mock.htmlExports.at(-1)?.html ?? '',
    );
  }
  expect(html).toContain('Budget');
  expect(html).not.toContain('Secret');

  // PPTX: a valid ZIP of the Office format, three slides (not four), with the notes.
  let pptx: Buffer;
  if (onWeb()) {
    const download = page.waitForEvent('download');
    await ribbon
      .getByRole('button', { name: 'Export the presentation to PowerPoint (PPTX)' })
      .click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^Kickoff.*\.pptx$/);
    pptx = await readFile((await file.path()) ?? '');
  } else {
    await ribbon
      .getByRole('button', { name: 'Export the presentation to PowerPoint (PPTX)' })
      .click();
    await expect(page.getByRole('dialog')).toContainText('The presentation was saved');
    const saved = await page.evaluate(
      () =>
        (
          window as unknown as {
            __mock: { fileExports: { name: string; mime: string; base64: string }[] };
          }
        ).__mock.fileExports.at(-1) ?? null,
    );
    expect(saved?.mime).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    expect(saved?.name).toMatch(/^Kickoff/);
    pptx = Buffer.from(saved?.base64 ?? '', 'base64');
  }
  expect(pptx.subarray(0, 2).toString()).toBe('PK');
  const names = pptx.toString('latin1');
  expect(names).toContain('[Content_Types].xml');
  expect(names).toContain('ppt/presentation.xml');
  expect(names).toContain('ppt/slides/slide3.xml');
  expect(names).not.toContain('ppt/slides/slide4.xml');
  expect(names).toContain('ppt/notesSlides/notesSlide3.xml');
  expect(external).toEqual([]);
});
