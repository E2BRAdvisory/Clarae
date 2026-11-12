import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { runCommand } from './drawingHelpers';
import { expect, openVault, proseMirror, readVaultFile, test } from './support';

// The frame of the Live mode on Milkdown (ADR-0049, A-W5c): folding, the settings that follow the
// application while a note is open, and the colours of the code blocks in both themes. It runs on both
// targets (desktop-mock, web-core) in a build with the engine switch on:
//   MEMOBRAIN_LIVE_ENGINE=milkdown yarn workspace @memobrain/web run e2e:workbench-ui live-frame
// (find and go to line, which both engines have, are in editor-find.spec.ts).
test.skip(
  process.env['MEMOBRAIN_LIVE_ENGINE'] !== 'milkdown',
  'needs a build with the Milkdown Live editor (MEMOBRAIN_LIVE_ENGINE=milkdown)',
);

const NOTE = [
  '# Alpha',
  '',
  'under alpha',
  '',
  '## Beta',
  '',
  'under beta',
  '',
  '# Gamma',
  '',
  '- parent',
  '  - child',
  '- sibling',
  '',
  '> quote line',
  '>',
  '> quote second',
  '',
  '```js',
  'const answer = 42; // the answer',
  'function f(x) { return "s" + x; }',
  '```',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '| 3 | 4 |',
  '',
  'end',
  '',
].join('\n');

async function openNote(page: Page, note = NOTE): Promise<void> {
  await openVault(page, { 'Note.md': note });
  await page.locator('.tree .node', { hasText: 'Note' }).first().click();
  await expect(proseMirror(page)).toBeVisible();
  await expect(proseMirror(page).locator('h1').first()).toBeVisible();
}

const file = (page: Page) => readVaultFile(page, 'Note.md');

/** Puts the caret where a click lands: the editor takes the selection of the click from the browser a moment later. */
async function clickCaret(page: Page, target: Locator): Promise<void> {
  await target.click();
  await page.waitForTimeout(150);
}

test('a heading folds from the chevron the pointer shows, and opens from its own', async ({
  page,
}) => {
  await openNote(page);
  const ed = proseMirror(page);
  await expect(ed.getByText('under alpha')).toBeVisible();
  await ed.locator('h1', { hasText: 'Alpha' }).hover();
  const hover = page.locator('.live-fold-hover');
  await expect(hover).toBeVisible();
  await hover.click();
  // what Alpha holds is gone from the page, Gamma (its sibling) is not
  await expect(ed.getByText('under alpha')).toBeHidden();
  await expect(ed.getByText('under beta')).toBeHidden();
  await expect(ed.locator('h1', { hasText: 'Gamma' })).toBeVisible();
  const chevron = ed.locator('.live-fold-chevron');
  await expect(chevron).toHaveCount(1);
  await expect(chevron).toHaveAttribute('aria-expanded', 'false');
  await expect(chevron).toHaveAccessibleName('Unfold');
  await chevron.click();
  await expect(ed.getByText('under alpha')).toBeVisible();
  await expect(ed.locator('.live-fold-chevron')).toHaveCount(0);
  // folding is no edit: the note is what it was
  expect(await file(page)).toBe(NOTE);
});

test('the keys of the Source editor fold and open', async ({ page }) => {
  await openNote(page);
  const ed = proseMirror(page);
  await clickCaret(page, ed.locator('h1', { hasText: 'Alpha' }));
  await page.keyboard.press('Control+Shift+[');
  await expect(ed.getByText('under alpha')).toBeHidden();
  await page.keyboard.press('Control+Shift+]');
  await expect(ed.getByText('under alpha')).toBeVisible();
  await page.keyboard.press('Control+Shift+[');
  await expect(ed.getByText('under alpha')).toBeHidden();
  // all: the headings fold but the one the caret is under (Alpha holds it), and all open again
  await page.keyboard.press('Control+Shift+]');
  await clickCaret(page, ed.getByText('under alpha'));
  await page.keyboard.press('Control+Alt+[');
  await expect(ed.locator('.live-fold-chevron').first()).toBeVisible();
  await expect(ed.getByText('under alpha')).toBeVisible();
  await expect(ed.getByText('under beta')).toBeHidden();
  await page.keyboard.press('Control+Alt+]');
  await expect(ed.locator('.live-fold-chevron')).toHaveCount(0);
  await expect(ed.getByText('under beta')).toBeVisible();
  expect(await file(page)).toBe(NOTE);
});

test('items, quotes, code blocks and tables fold too', async ({ page }) => {
  await openNote(page);
  const ed = proseMirror(page);
  // the nested list of an item
  await ed.getByText('parent', { exact: true }).hover();
  await page.locator('.live-fold-hover').click();
  await expect(ed.getByText('child', { exact: true })).toBeHidden();
  await expect(ed.getByText('sibling')).toBeVisible();
  await ed.locator('.live-fold-chevron').click();
  await expect(ed.getByText('child', { exact: true })).toBeVisible();
  // a quote
  await ed.getByText('quote line').hover();
  await page.locator('.live-fold-hover').click();
  await expect(ed.getByText('quote second')).toBeHidden();
  await ed.locator('.live-fold-chevron').click();
  // a code block keeps its header
  // the chevron is on the first line of the block: its header, for a code block
  await ed.locator('.milkdown-code-block').hover({ position: { x: 24, y: 8 } });
  await page.locator('.live-fold-hover').click();
  await expect(ed.locator('.milkdown-code-block .cm-content')).toBeHidden();
  await expect(ed.locator('.milkdown-code-block')).toBeVisible();
  await ed.locator('.live-fold-chevron').click();
  await expect(ed.locator('.milkdown-code-block .cm-content')).toBeVisible();
  // a table keeps its header row
  await ed.locator('.milkdown-table-block').hover({ position: { x: 24, y: 8 } });
  await page.locator('.live-fold-hover').click();
  await expect(ed.getByText('3', { exact: true })).toBeHidden();
  await expect(ed.locator('.milkdown-table-block')).toBeVisible();
  expect(await file(page)).toBe(NOTE);
});

test('a fold stays on its block while the note is edited above it', async ({ page }) => {
  await openNote(page);
  const ed = proseMirror(page);
  await clickCaret(page, ed.locator('h1', { hasText: 'Gamma' }));
  await page.keyboard.press('Control+Shift+[');
  await expect(ed.getByText('sibling')).toBeHidden();
  await clickCaret(page, ed.getByText('under alpha'));
  await page.keyboard.press('End');
  await page.keyboard.type(' and more');
  await expect(ed.getByText('sibling')).toBeHidden();
  await expect.poll(() => file(page)).toContain('under alpha and more');
});

async function openEditorSettings(page: Page): Promise<void> {
  await runCommand(page, 'Open settings');
  await page.getByRole('button', { name: 'Editor', exact: true }).click();
}

test('the settings reach the open editor: type size, wrapping, line width, spell check, folding', async ({
  page,
}) => {
  await openNote(page);
  const ed = proseMirror(page);
  await expect(ed).toHaveCSS('font-size', '15px');
  // the line of text is 712px wide, and the margins of a wide pane (handle of the blocks and chevron at the
  // left, 112px; 56px at the right) are inside the box
  await expect(ed).toHaveCSS('max-width', '880px');
  await expect(ed).toHaveAttribute('spellcheck', 'true');
  await openEditorSettings(page);
  await page.getByLabel('Editor font size').fill('22');
  await page.getByLabel('Readable line width').uncheck();
  await page.getByLabel('Spell check').uncheck();
  await page.getByLabel('Wrap long lines').uncheck();
  await page.getByLabel('Fold headings').uncheck();
  await page.keyboard.press('Escape');
  await expect(ed).toHaveCSS('font-size', '22px');
  await expect(ed).toHaveCSS('max-width', 'none');
  await expect(ed).toHaveCSS('white-space', 'pre');
  await expect(ed).toHaveAttribute('spellcheck', 'false');
  // folding is off: the pointer shows no chevron and the key does nothing
  await ed.locator('h1', { hasText: 'Alpha' }).hover();
  await expect(page.locator('.live-fold-hover')).toBeHidden();
  await clickCaret(page, ed.locator('h1', { hasText: 'Alpha' }));
  await page.keyboard.press('Control+Shift+[');
  await expect(ed.getByText('under alpha')).toBeVisible();
  // and back
  await openEditorSettings(page);
  await page.getByLabel('Editor font size').fill('15');
  await page.getByLabel('Readable line width').check();
  await page.getByLabel('Wrap long lines').check();
  await page.getByLabel('Fold headings').check();
  await page.keyboard.press('Escape');
  await expect(ed).toHaveCSS('font-size', '15px');
  // the line of text is 712px wide, and the margins of a wide pane (handle of the blocks and chevron at the
  // left, 112px; 56px at the right) are inside the box
  await expect(ed).toHaveCSS('max-width', '880px');
  await expect(ed).toHaveCSS('white-space', /pre-wrap|break-spaces/);
  await clickCaret(page, ed.locator('h1', { hasText: 'Alpha' }));
  await page.keyboard.press('Control+Shift+[');
  await expect(ed.getByText('under alpha')).toBeHidden();
});

/** The colours of the syntax tokens of the first code block and the contrast of each against its surface. */
async function codeColours(page: Page) {
  return page.evaluate(() => {
    const parse = (c: string): [number, number, number] => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c) as RegExpExecArray;
      return [Number(m[1]), Number(m[2]), Number(m[3])];
    };
    const lum = ([r, g, b]: [number, number, number]): number => {
      const f = (v: number): number => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const block = document.querySelector('.milkdown-code-block .cm-editor') as HTMLElement;
    const surface = parse(getComputedStyle(block).backgroundColor);
    const colours = new Map<string, number>();
    for (const span of Array.from(block.querySelectorAll<HTMLElement>('.cm-line span'))) {
      const colour = getComputedStyle(span).color;
      const [hi, lo] = [lum(parse(colour)), lum(surface)].sort((a, b) => b - a) as [number, number];
      colours.set(colour, (hi + 0.05) / (lo + 0.05));
    }
    return { surface: getComputedStyle(block).backgroundColor, colours: [...colours] };
  });
}

test('the code blocks are highlighted from the language chunk, in the light and the dark theme', async ({
  page,
}) => {
  await openNote(page);
  const ed = proseMirror(page);
  const block = ed.locator('.milkdown-code-block');
  await block.scrollIntoViewIfNeeded();
  const seen: Record<string, string[]> = {};
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // the parser of the language is fetched on first use, and the theme follows the page
    await expect
      .poll(
        async () => {
          const { colours } = await codeColours(page);
          return colours.length > 2 && colours.every(([, ratio]) => ratio >= 4.5);
        },
        { timeout: 15_000, message: `the code of the ${scheme} theme reads on its surface` },
      )
      .toBe(true);
    seen[scheme] = (await codeColours(page)).colours.map(([c]) => c).sort();
  }
  // the dark theme has its own palette
  expect(seen['dark']).not.toEqual(seen['light']);
});

test('the frame has no accessibility violation: find bar, chevrons and code, in both themes', async ({
  page,
}) => {
  await openNote(page);
  const ed = proseMirror(page);
  await clickCaret(page, ed.locator('h1', { hasText: 'Alpha' }));
  await page.keyboard.press('Control+Shift+[');
  await page.keyboard.press('ControlOrMeta+f');
  await page.getByRole('textbox', { name: 'Find', exact: true }).fill('answer');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .include('.live-host')
      // Crepe draws a list as a `div` between the `ul` and its `li`, which these two rules do not accept
      // (ADR-0049 section 9; the screen reader pass of A-W8 looks at the lists)
      .disableRules(['list', 'listitem'])
      .analyze();
    const blocking = results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => ({ rule: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
    expect(blocking, `${scheme}: ${JSON.stringify(blocking)}`).toEqual([]);
  }
});
