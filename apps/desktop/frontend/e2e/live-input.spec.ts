import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { appOrigin, expect, listVaultFiles, openVault, readVaultFile, test } from './support';

// The input of the Live mode on Milkdown (ADR-0049, A-W5b): what the user types, pastes and drops, and what
// the file says after it. It runs on both targets (desktop-mock, web-core) in a build with the engine
// switch on:
//   MEMOBRAIN_LIVE_ENGINE=milkdown yarn workspace @memobrain/web run e2e:workbench-ui e2e/live-input.spec.ts
// In the default build the Live mode is CodeMirror, whose selectors the other specs use, and this spec has
// nothing to look at.
test.skip(
  process.env['MEMOBRAIN_LIVE_ENGINE'] !== 'milkdown',
  'needs a build with the Milkdown Live editor (MEMOBRAIN_LIVE_ENGINE=milkdown)',
);

// A 1x1 PNG.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const live = (page: Page) => page.locator('.live-host .ProseMirror');
const popup = (page: Page) => page.locator('.mb-suggest:not([hidden])');

async function openNote(page: Page, note: string): Promise<void> {
  await openVault(page, {
    'Note.md': note,
    'Target.md': '# Target\n\nbody #topic\n',
    'Other.md': 'other #idea\n',
  });
  await page.locator('.tree .node', { hasText: 'Note' }).first().click();
  await expect(live(page)).toBeVisible();
}

/** The caret at the end of the last block of the note. */
async function toEnd(page: Page): Promise<void> {
  await live(page).click();
  await page.keyboard.press('ControlOrMeta+End');
}

const saved = async (page: Page, path = 'Note.md'): Promise<string> => {
  await expect(page.locator('.save-state')).toHaveText('Saved');
  return readVaultFile(page, path);
};

test('typing [[ offers the notes and a choice is written as a link', async ({ page }) => {
  const external: string[] = [];
  const origin = appOrigin();
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (!['data:', 'blob:'].includes(url.protocol) && url.origin !== origin) external.push(r.url());
  });
  await openNote(page, 'See\n');
  await toEnd(page);
  await page.keyboard.type(' [[Tar');
  await expect(popup(page)).toBeVisible();
  await expect(popup(page).getByRole('option', { name: /Target/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(popup(page)).toHaveCount(0);
  await expect(live(page).locator('[data-ofm="wikilink"]')).toHaveCount(1);
  expect(await saved(page)).toBe('See [[Target]]\n');
  // typing goes on after the link, outside it
  await page.keyboard.type(' and');
  expect(await saved(page)).toBe('See [[Target]] and\n');
  expect(external).toEqual([]);
});

test('[[ with a closing ]] typed by hand makes the link, and the file is not escaped', async ({
  page,
}) => {
  await openNote(page, 'See\n');
  await toEnd(page);
  await page.keyboard.type(' [[Nothing here]]');
  await page.keyboard.press('Escape');
  await expect(live(page).locator('[data-ofm="wikilink"]')).toHaveCount(1);
  expect(await saved(page)).toBe('See [[Nothing here]]\n');
});

test('#tag is completed and written as a tag, and so is a tag that is typed whole', async ({
  page,
}) => {
  await openNote(page, 'Tags:\n');
  await toEnd(page);
  await page.keyboard.type(' #to');
  await expect(popup(page).getByRole('option', { name: /topic/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.type(' #mine');
  await page.keyboard.press('Escape');
  expect(await saved(page)).toBe('Tags: #topic #mine\n');
});

test('the slash menu runs an item, and is silent in a code block', async ({ page }) => {
  await openNote(page, 'First\n\n```\ncode\n```\n');
  await live(page).getByText('First').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/call');
  await expect(popup(page).getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(live(page).locator('blockquote')).toHaveCount(1);
  expect(await saved(page)).toContain('> [!note]');

  await live(page).locator('.milkdown-code-block .cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' /');
  await page.waitForTimeout(300);
  await expect(popup(page)).toHaveCount(0);
});

test('Alt+Up and Alt+Down move a list item with what is nested in it', async ({ page }) => {
  await openNote(page, '- a\n  - a1\n- b\n- c\n');
  await live(page).getByText('b', { exact: true }).click();
  await page.waitForTimeout(150); // the editor takes the selection of the click from the browser a moment later
  await page.keyboard.press('Alt+ArrowUp');
  expect(await saved(page)).toBe('- b\n- a\n  - a1\n- c\n');
  await page.keyboard.press('Alt+ArrowDown');
  await page.keyboard.press('Alt+ArrowDown');
  expect(await saved(page)).toBe('- a\n  - a1\n- c\n- b\n');
});

test('Mod+Enter cycles a task, and the box of a custom state opens the task', async ({ page }) => {
  await openNote(page, '- plain\n- [/] half\n');
  await live(page).getByText('plain').click();
  await page.waitForTimeout(150);
  await page.keyboard.press('ControlOrMeta+Enter');
  expect(await saved(page)).toBe('- [ ] plain\n- [/] half\n');
  await page.keyboard.press('ControlOrMeta+Enter');
  expect(await saved(page)).toBe('- [x] plain\n- [/] half\n');
  await live(page).locator('.ofm-task-state').click();
  expect(await saved(page)).toBe('- [x] plain\n- [ ] half\n');
});

test('the box of a task is a checkbox that Space toggles, and keeps the focus', async ({
  page,
}) => {
  await openNote(page, '- [ ] one\n- [ ] two\n');
  const boxes = live(page).getByRole('checkbox', { name: 'Task' });
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(1)).toHaveAttribute('aria-checked', 'false');
  await boxes.nth(1).focus();
  await page.keyboard.press('Space');
  expect(await saved(page)).toBe('- [ ] one\n- [x] two\n');
  await expect(boxes.nth(1)).toHaveAttribute('aria-checked', 'true');
  await expect(boxes.nth(1)).toBeFocused();
  // a click of the mouse ticks it once
  await boxes.nth(0).click();
  expect(await saved(page)).toBe('- [x] one\n- [x] two\n');
});

test('Tab and Shift+Tab on the box of a task move the focus and write nothing', async ({
  page,
}) => {
  await openNote(page, '- [ ] one\n- [ ] two\n\npara\n');
  const boxes = live(page).getByRole('checkbox', { name: 'Task' });
  await expect(boxes).toHaveCount(2);
  // the caret is in the paragraph, the focus on the first box
  await live(page).getByText('para', { exact: true }).click();
  await page.waitForTimeout(150);
  await boxes.nth(0).focus();
  await page.keyboard.press('Tab');
  await expect(boxes.nth(1)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(boxes.nth(0)).toBeFocused();
  // (the text of the block as the DOM has it: a tab would be there, though the page folds it on screen)
  expect(
    await live(page)
      .locator('p', { hasText: 'para' })
      .evaluate((e) => e.textContent),
  ).toBe('para');
  expect(await readVaultFile(page, 'Note.md')).toBe('- [ ] one\n- [ ] two\n\npara\n');
});

test('a footnote reference typed in the text is written as typed, not escaped', async ({
  page,
}) => {
  await openNote(page, 'a\n\n[^1]: note\n');
  await live(page).getByText('a', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type('[^1] more');
  expect(await saved(page)).toBe('a[^1] more\n\n[^1]: note\n');
});

test('Tab sinks a list item and writes a tab character elsewhere, never spaces', async ({
  page,
}) => {
  await openNote(page, '- a\n- b\n\npara\n');
  await live(page).getByText('b', { exact: true }).click();
  await page.waitForTimeout(150);
  await page.keyboard.press('Tab');
  expect(await saved(page)).toBe('- a\n  - b\n\npara\n');
  await page.keyboard.press('Shift+Tab');
  expect(await saved(page)).toBe('- a\n- b\n\npara\n');
  // in the text of a paragraph: one tab character at the caret, not four spaces in the middle of a word
  await live(page).getByText('para', { exact: true }).click();
  await page.waitForTimeout(150);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(100);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(100);
  await page.keyboard.press('Tab');
  expect(await saved(page)).toBe('- a\n- b\n\npa\tra\n');
  await page.keyboard.press('Shift+Tab');
  expect(await saved(page)).toBe('- a\n- b\n\npara\n');
});

test('plain text pasted is Markdown that goes in as written: links and embeds stay', async ({
  page,
}) => {
  await openNote(page, 'See\n');
  await toEnd(page);
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', ' [[Target#H|al]] and ![[img.png|200]]');
    document
      .querySelector('.live-host .ProseMirror')
      ?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
  });
  expect(await saved(page)).toBe('See [[Target#H|al]] and ![[img.png|200]]\n');
});

test('the callout of the toolbar leaves the caret where the title is typed', async ({ page }) => {
  await openNote(page, 'text\n');
  await toEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/call');
  await expect(popup(page)).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Title');
  expect(await saved(page)).toBe('text\n\n> [!note] Title\n');
});

test('auto-pairing types the closing bracket, and typing it passes over it', async ({ page }) => {
  await openNote(page, 'x\n');
  await toEnd(page);
  await page.keyboard.type(' (a "b');
  await page.keyboard.type('")');
  expect(await saved(page)).toBe('x (a "b")\n');
});

test('a pasted image is stored and its embed goes where it was pasted', async ({ page }) => {
  await openNote(page, 'before after\n');
  await live(page).getByText('before after').click();
  await page.keyboard.press('Home');
  for (let i = 0; i < 'before'.length; i++) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150); // the editor takes the selection from the browser a moment later
  await live(page).evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, PNG);
  await expect(live(page).locator('.ofm-embed')).toHaveCount(1);
  const note = await saved(page);
  expect(note).toMatch(/^before!\[\[Pasted image \d{14}\.png\]\] after\n$/);
  expect((await listVaultFiles(page)).filter((p) => p.endsWith('.png'))).toHaveLength(1);
});

test('a dropped image is inserted at the drop point', async ({ page }) => {
  await openNote(page, 'first\n\nsecond\n');
  const second = live(page).getByText('second');
  const box = await second.boundingBox();
  if (!box) throw new Error('no box');
  await live(page).evaluate(
    (el, { b64, x, y }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], 'pic.png', { type: 'image/png' }));
      el.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: data,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { b64: PNG, x: box.x + box.width - 2, y: box.y + box.height / 2 },
  );
  await expect(live(page).locator('.ofm-embed')).toHaveCount(1);
  expect(await saved(page)).toBe('first\n\nsecond![[pic.png]]\n');
});

test('a URL pasted over a selection links it, and rich HTML becomes Markdown', async ({ page }) => {
  await openNote(page, 'say hello now\n');
  await live(page).getByText('say hello now').dblclick(); // selects a word
  await page.waitForTimeout(150);
  const word = await page.evaluate(() => window.getSelection()?.toString().trim());
  await live(page).evaluate((el, url) => {
    const data = new DataTransfer();
    data.setData('text/plain', url);
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, 'https://example.org/x');
  expect(await saved(page)).toBe(
    'say hello now\n'.replace(word ?? '', `[${word}](https://example.org/x)`),
  );

  await toEnd(page);
  await live(page).evaluate((el) => {
    const data = new DataTransfer();
    data.setData('text/html', '<p>and <strong>bold</strong></p>');
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  expect(await saved(page)).toMatch(/and \*\*bold\*\*\n$/);
});

test('the open popup has no accessibility violation', async ({ page }) => {
  await openNote(page, 'See\n');
  await toEnd(page);
  await page.keyboard.type(' [[');
  await expect(popup(page)).toBeVisible();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .include('.mb-suggest')
      .analyze();
    const blocking = results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => ({ rule: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
    expect(blocking, JSON.stringify(blocking)).toEqual([]);
  }
});

test('a rule typed at the start of the text of a task keeps the task: the box stays on its item', async ({
  page,
}) => {
  await openNote(page, '- [ ] a\n- [x] b\n');
  await live(page).getByText('a', { exact: true }).click();
  await page.keyboard.press('Home');
  await page.keyboard.type('---');
  // the rule goes after the text of the task (a task has no text before its box), the second task is as it was
  expect(await saved(page)).toBe('- [ ] a\n\n  ---\n- [x] b\n');
  await expect(live(page).locator('[role="checkbox"]')).toHaveCount(2);
  await expect(live(page).locator('[role="checkbox"]').first()).toHaveAttribute(
    'aria-label',
    'Task: a',
  );
});

test('the name of a wikilink does not take `%%`, and Enter in it leaves the link', async ({
  page,
}) => {
  await openNote(page, 'see\n');
  await toEnd(page);
  await page.keyboard.type(' [[ab');
  await page.keyboard.press('Escape');
  await page.keyboard.type('%%');
  await page.keyboard.press('Enter');
  // the caret is after the link: what is typed next is outside it, and the note has one paragraph
  await page.keyboard.type(' end');
  expect(await saved(page)).toBe('see [[ab%]] end\n');
  await expect(live(page).locator('[data-ofm="wikilink"]')).toHaveCount(1);
  await expect(live(page).locator('p')).toHaveCount(1);
});
