import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { appOrigin, expect, openVault, readVaultFile, test } from './support';
import { runCommand } from './drawingHelpers';

// The Live mode on Milkdown (ADR-0049, A-W5a): links, embeds, images, callouts, math, diagrams, tags and
// the pointer. It runs on both targets (desktop-mock, web-core) in a build with the engine switch on:
//   MEMOBRAIN_LIVE_ENGINE=milkdown yarn workspace @memobrain/web run e2e:workbench-ui e2e/live-views.spec.ts
// In the default build the Live mode is CodeMirror, whose selectors the other specs use, and this
// spec has nothing to look at.
test.skip(
  process.env['MEMOBRAIN_LIVE_ENGINE'] !== 'milkdown',
  'needs a build with the Milkdown Live editor (MEMOBRAIN_LIVE_ENGINE=milkdown)',
);

// A 1x1 PNG.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const NOTE = [
  'Intro line',
  '',
  'See [[Target|the target]], [[Missing note]], #topic and ==marked==.',
  '',
  '> [!warning]- Careful',
  '> text under the fold',
  '',
  '> [!tip] Open one',
  '> text in the open',
  '',
  'Math $a+b$ here',
  '',
  '$$',
  'x^2',
  '$$',
  '',
  '![[Pic.png|40]]',
  '',
  '![the alt](Pic.png)',
  '',
  'end',
  '',
].join('\n');

async function openNote(page: Page, note = NOTE): Promise<void> {
  await openVault(
    page,
    { 'Note.md': note, 'Target.md': '# Target\n\nbody of the target\n' },
    { 'Pic.png': PNG },
  );
  await page.locator('.tree .node', { hasText: 'Note' }).first().click();
  await expect(live(page)).toBeVisible();
  await expect(live(page).locator('[data-ofm="wikilink"]').first()).toBeVisible();
}

/** The Live editor (the CodeMirror one stays under it while it loads, with the same name). */
const live = (page: Page) => page.locator('.live-host .ProseMirror');

/** What the user reads in an element: hidden text left out. */
const read = (el: ReturnType<Page['locator']>) => el.evaluate((e) => (e as HTMLElement).innerText);

test('the note shows its links, callouts, math, embeds and images in place of their syntax', async ({
  page,
}) => {
  const external: string[] = [];
  const origin = appOrigin();
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (!['data:', 'blob:'].includes(url.protocol) && url.origin !== origin) external.push(r.url());
  });
  await openNote(page);
  const editor = live(page);

  // the alias is the link, and a note that does not exist is marked
  const links = editor.locator('.ofm-wikilink');
  expect(await read(links.first())).toBe('the target');
  await expect(editor.locator('.ofm-wikilink.ofm-unresolved')).toHaveCount(1);
  expect(await read(editor.locator('.ofm-wikilink.ofm-unresolved'))).toBe('Missing note');
  await expect(links.first()).not.toHaveClass(/ofm-unresolved/);
  await expect(editor.locator('span[data-ofm="tag"]')).toHaveText('#topic');
  await expect(editor.locator('mark[data-ofm="highlight"]')).toHaveText('marked');

  // a callout is a box with its title; the folded one hides its body until it is opened
  const folded = editor.locator('blockquote.ofm-callout-warning');
  await expect(folded.locator('.ofm-callout-icon svg')).toBeVisible();
  expect(await read(folded)).toContain('Careful');
  expect(await read(folded)).not.toContain('text under the fold');
  const open = editor.locator('blockquote.ofm-callout-tip');
  expect(await read(open)).toContain('Open one');
  expect(await read(open)).toContain('text in the open');
  await folded.getByRole('button', { name: 'Show or hide the content of the callout' }).click();
  expect(await read(folded)).toContain('text under the fold');

  // math, in the line and as a block, an embedded image and an image of the vault
  await expect(editor.locator('.katex:visible')).toHaveCount(2);
  await expect(editor.locator('.ofm-embed-render img')).toBeVisible();
  await expect(editor.locator('.ofm-image-body img')).toBeVisible();
  expect(external).toEqual([]);
});

test('a click on an embed or a diagram takes the caret into its source', async ({ page }) => {
  await openNote(page, NOTE + '\n```mermaid\ngraph TD\nA-->B\n```\n');
  const editor = live(page);
  await editor.locator('.ofm-embed-render img').click();
  await expect(editor.locator('.ofm-embed')).toHaveClass(/ofm-active/);
  await expect(editor.locator('.ofm-embed .ofm-wl-text')).toBeVisible();
  await editor.getByText('end', { exact: true }).click();
  await expect(editor.locator('.ofm-embed')).not.toHaveClass(/ofm-active/);

  await expect(editor.locator('.ofm-drawn.ofm-mermaid')).toBeVisible();
  await editor.locator('.ofm-drawn.ofm-mermaid').click();
  await expect(editor.locator('.ofm-drawn.ofm-mermaid')).toHaveCount(0);
  await expect(editor.locator('.milkdown-code-block').last()).toBeVisible();
});

test('Mod+click follows a link and searches a tag; a plain click shows the source of the link', async ({
  page,
}) => {
  await openNote(page);
  const editor = live(page);
  const link = editor.locator('.ofm-wikilink').first();

  await link.click();
  await expect(link).toHaveClass(/ofm-active/);
  await expect(page.getByRole('tab', { name: /Target/ })).toHaveCount(0);

  await page.locator('.ofm-callout-tip').click(); // the caret away: the link is a link again
  await expect(link).not.toHaveClass(/ofm-active/);
  await link.click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByRole('tab', { name: /Target/ })).toBeVisible();

  // the link opened in this tab: back to the note
  await page.locator('.tree .node', { hasText: 'Note' }).first().click();
  await expect(editor.locator('span[data-ofm="tag"]')).toBeVisible();
  await editor.locator('span[data-ofm="tag"]').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByPlaceholder(/^Search…/)).toHaveValue('tag:#topic');
});

test('the page preview opens from the pointer with the modifier and from the keyboard', async ({
  page,
}) => {
  await openNote(page);
  const link = live(page).locator('.ofm-wikilink').first();
  const preview = page.locator('.page-preview');

  await link.hover();
  await page.waitForTimeout(600);
  await expect(preview).toHaveCount(0); // not without the modifier
  await page.keyboard.down('ControlOrMeta');
  await link.hover({ position: { x: 4, y: 4 } });
  await link.hover({ position: { x: 6, y: 6 } });
  await expect(preview).toBeVisible({ timeout: 10_000 });
  await expect(preview.locator('.page-preview-body')).toContainText('body of the target');
  await page.keyboard.up('ControlOrMeta');
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);

  // from the keyboard: the caret in the link, then the command
  await link.click();
  await expect(link).toHaveClass(/ofm-active/); // the caret is in the editor's state
  await runCommand(page, 'preview link under cursor');
  await expect(preview).toBeVisible({ timeout: 10_000 });
  await expect(preview.locator('.page-preview-body')).toContainText('body of the target');
});

test('looking and folding write nothing, and an edit is written where it was made', async ({
  page,
}) => {
  await openNote(page);
  const editor = live(page);
  const saveState = page.locator('.save-state');

  await editor.locator('.ofm-wikilink').first().click();
  await editor
    .getByRole('button', { name: 'Show or hide the content of the callout' })
    .first()
    .click();
  await page.waitForTimeout(1500);
  await expect(saveState).toHaveText('Saved');
  expect(await readVaultFile(page, 'Note.md')).toBe(NOTE);

  // typing in the intro line changes that line and nothing else
  await editor.getByText('Intro line').click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await expect(saveState).toHaveText('Saved');
  expect(await readVaultFile(page, 'Note.md')).toBe(NOTE.replace('Intro line', 'Intro line!'));
});

test('the callouts have no accessibility violation of their own', async ({ page }) => {
  await openNote(page);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .include('.ofm-callout')
      .analyze();
    const blocking = results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => ({ rule: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
    expect(blocking, JSON.stringify(blocking)).toEqual([]);
  }
});
