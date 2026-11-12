import type { Locator, Page } from '@playwright/test';
import {
  appOrigin,
  dragAndDrop,
  expect,
  openVault,
  proseMirror,
  readVaultFile,
  test,
} from './support';

// The chrome around the document of the Live mode on Milkdown (ADR-0049, M16-UX1): the handle of the blocks
// ("+" and drag), the toolbar over a selection, the tooltip of a link and the placeholder, and the slash menu
// the "+" opens. It runs on both targets (desktop-mock, web-core).
// The file is what each test ends on: none of the chrome may touch what the user did not edit.
const NOTE = [
  '# Title',
  '',
  'first paragraph',
  '',
  'second __paragraph__',
  '',
  'last block',
  '',
].join('\n');

async function openNote(page: Page, note = NOTE): Promise<void> {
  await openVault(page, { 'Note.md': note });
  await page.locator('.tree .node', { hasText: 'Note' }).first().click();
  await expect(proseMirror(page)).toBeVisible();
  // the whole note is drawn (its last block is in the document) before a test looks at it
  await expect(proseMirror(page).locator('p, table, .milkdown-code-block').last()).toBeVisible();
}

const file = async (page: Page): Promise<string> => {
  await expect(page.locator('.save-state')).toHaveText('Saved');
  return readVaultFile(page, 'Note.md');
};

const handle = (page: Page): Locator => page.locator('.live-host .milkdown-block-handle');
const popup = (page: Page): Locator => page.locator('.mb-suggest:not([hidden])');

/** The first word of a block, selected (a double click at its start: Home and End are not the caret's on every platform). */
async function selectFirstWord(block: Locator): Promise<void> {
  await block.dblclick({ position: { x: 12, y: 10 } });
}

/** The pointer on a block, and the handle that comes to it. */
async function overBlock(page: Page, block: Locator): Promise<void> {
  await block.hover();
  await expect(handle(page)).toHaveAttribute('data-show', 'true');
}

test('the handle follows the pointer, has names, and stays clear of the chevron of the fold', async ({
  page,
}) => {
  await openNote(page);
  const ed = proseMirror(page);
  const title = ed.locator('h1');
  await overBlock(page, title);
  await expect(handle(page).getByRole('button', { name: 'Add a block below' })).toBeVisible();
  // the grip is the pointer's alone (a screen reader does not see it: Alt+Up/Down move a block)
  await expect(handle(page).getByTitle('Drag to move the block')).toBeVisible();
  // the chevron of the fold is at the same block: the two do not overlap
  await title.hover();
  const chevron = page.locator('.live-fold-hover');
  await expect(chevron).toBeVisible();
  const h = await handle(page).boundingBox();
  const c = await chevron.boundingBox();
  expect(h && c && h.x + h.width <= c.x + 1).toBe(true);
  // the handle is in the margin of the text, not on the text
  const t = await title.boundingBox();
  expect(h && t && h.x + h.width <= t.x).toBe(true);
  // it goes with the pointer to the next block, at the height of its first line
  const para = ed.getByText('first paragraph');
  await overBlock(page, para);
  await expect
    .poll(async () => {
      const [hb, pb] = [await handle(page).boundingBox(), await para.boundingBox()];
      return (
        !!hb && !!pb && hb.y + hb.height / 2 >= pb.y && hb.y + hb.height / 2 <= pb.y + pb.height + 8
      );
    })
    .toBe(true);
  expect(await file(page)).toBe(NOTE);
});

test('the "+" adds a block below and opens the menu of the slash there, with its groups', async ({
  page,
}) => {
  await openNote(page);
  const ed = proseMirror(page);
  await overBlock(page, ed.getByText('first paragraph'));
  await handle(page).getByRole('button', { name: 'Add a block below' }).click();
  await expect(popup(page)).toBeVisible();
  // the headings of the groups, the options in the same list, an icon on each
  await expect(popup(page).locator('.mb-suggest-group')).toHaveText([
    'Text',
    'Lists',
    'Advanced',
    'Vault',
  ]);
  await expect(popup(page).getByRole('option')).toHaveCount(18);
  await expect(popup(page).locator('.mb-suggest-icon svg')).toHaveCount(18);
  // typing narrows it, Enter makes the empty block what the item says
  await page.keyboard.type('callo');
  await expect(popup(page).getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(popup(page)).toHaveCount(0);
  await page.keyboard.type('Heads up');
  expect(await file(page)).toBe(
    [
      '# Title',
      '',
      'first paragraph',
      '',
      '> [!note] Heads up',
      '',
      'second __paragraph__',
      '',
      'last block',
      '',
    ].join('\n'),
  );
});

test('Escape closes the menu of the "+" and leaves the empty block to write in', async ({
  page,
}) => {
  await openNote(page);
  const ed = proseMirror(page);
  await overBlock(page, ed.getByText('last block'));
  await handle(page).getByRole('button', { name: 'Add a block below' }).click();
  await expect(popup(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup(page)).toHaveCount(0);
  // the placeholder says what the block is for
  await expect(ed.locator('.crepe-placeholder')).toHaveAttribute(
    'data-placeholder',
    'Write, or press / for commands',
  );
  await page.keyboard.type('after');
  expect(await file(page)).toBe(`${NOTE}\nafter\n`);
});

test('a block dragged by the handle moves, and the others are written as they were', async ({
  page,
}) => {
  await openNote(page);
  const ed = proseMirror(page);
  const last = ed.getByText('last block');
  await overBlock(page, last);
  const grip = handle(page).getByTitle('Drag to move the block');
  // the plugin of the blocks selects the block the pointer is down on, then the drag starts
  await grip.dispatchEvent('mousedown');
  const first = await ed.getByText('first paragraph').boundingBox();
  const box = await ed.boundingBox();
  if (!first || !box) throw new Error('no layout');
  await dragAndDrop(grip, ed, { x: first.x - box.x + 20, y: first.y - box.y + 2 });
  await expect(ed.locator('p').first()).toHaveText('last block');
  expect(await file(page)).toBe(
    ['# Title', '', 'last block', '', 'first paragraph', '', 'second __paragraph__', ''].join('\n'),
  );
});

test('the toolbar shows over a selection, names its buttons with the shortcuts of the application, and formats', async ({
  page,
}) => {
  await openNote(page);
  const ed = proseMirror(page);
  const toolbar = page.getByRole('toolbar', { name: 'Format the selection' });
  await expect(toolbar).toBeHidden();
  await selectFirstWord(ed.getByText('first paragraph'));
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole('button')).toHaveCount(7);
  // the shortcuts are the registry's: bold is Mod-b, highlight Mod-Shift-h
  await expect(toolbar.getByRole('button', { name: 'Bold' })).toHaveAttribute(
    'title',
    /^Bold \((Ctrl\+B|⌘B)\)$/,
  );
  await expect(toolbar.getByRole('button', { name: 'Highlight' })).toHaveAttribute(
    'title',
    /^Highlight \((Ctrl\+Shift\+H|⌘⇧H)\)$/,
  );
  await toolbar.getByRole('button', { name: 'Bold' }).click();
  await expect(ed.locator('strong').first()).toHaveText('first');
  await toolbar.getByRole('button', { name: 'Highlight' }).click();
  // (the strong is written the way the file writes it: `__`)
  expect(await file(page)).toBe(NOTE.replace('first paragraph', '__==first==__ paragraph'));
  // the keyboard does the same (the buttons are for the pointer), and the file gets back
  await page.keyboard.press('ControlOrMeta+Shift+h');
  await page.keyboard.press('ControlOrMeta+b');
  expect(await file(page)).toBe(NOTE);
});

test('the tooltip of a link edits and removes it', async ({ page }) => {
  await openNote(page, 'See [the page](https://example.com) now\n');
  const ed = proseMirror(page);
  const preview = page.locator('.milkdown-link-preview');
  await ed.getByText('the page').click();
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('https://example.com');
  // the buttons have names for a screen reader
  await expect(preview.locator('.button .live-sr')).toHaveText([
    'Copy link',
    'Edit link',
    'Remove link',
  ]);
  await preview.locator('.link-edit-button').click();
  const input = page.locator('.milkdown-link-edit .input-area');
  await expect(input).toBeVisible();
  await expect(input).toHaveAccessibleName('Paste link…');
  await input.fill('https://example.org/new');
  await input.press('Enter');
  expect(await file(page)).toBe('See [the page](https://example.org/new) now\n');
  await ed.getByText('the page').click();
  await expect(preview).toBeVisible();
  await preview.locator('.link-remove-button').click();
  await expect(ed.locator('a')).toHaveCount(0);
  expect(await file(page)).toBe('See the page now\n');
});

test('the placeholder is on the empty block with the caret, never in a table or a code block', async ({
  page,
}) => {
  await openNote(page, ['| a | b |', '| - | - |', '| 1 | 2 |', '', '```js', '```', ''].join('\n'));
  const ed = proseMirror(page);
  await expect(ed.locator('.crepe-placeholder')).toHaveCount(0);
  await ed.getByRole('cell').last().click();
  await expect(ed.locator('.crepe-placeholder')).toHaveCount(0);
  await ed.locator('.milkdown-code-block .cm-content').click();
  await expect(ed.locator('.crepe-placeholder')).toHaveCount(0);
});

test('a read-only editor shows none of the controls', async ({ page }) => {
  await openNote(page);
  const ed = proseMirror(page);
  // the editor takes this from the vault; the styles that hide the controls are what is tried here
  await page.locator('.live-host').evaluate((el) => (el.dataset['readonly'] = 'true'));
  await ed.getByText('first paragraph').hover();
  await expect(handle(page)).toBeHidden();
  await selectFirstWord(ed.getByText('first paragraph'));
  await expect(page.getByRole('toolbar', { name: 'Format the selection' })).toBeHidden();
  expect(await file(page)).toBe(NOTE);
});

test('the chrome asks nothing of the network, and the margins follow the width of the pane', async ({
  page,
}) => {
  const external: string[] = [];
  const origin = appOrigin();
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (!['data:', 'blob:'].includes(url.protocol) && url.origin !== origin) external.push(r.url());
  });
  await openNote(page);
  const ed = proseMirror(page);
  await overBlock(page, ed.getByText('first paragraph'));
  await selectFirstWord(ed.getByText('first paragraph'));
  await expect(page.getByRole('toolbar', { name: 'Format the selection' })).toBeVisible();
  // a narrow window: the handle gives its room to the text
  await page.setViewportSize({ width: 420, height: 800 });
  await expect(page.locator('.live-host')).toHaveAttribute('data-size', /compact|narrow/);
  await ed.getByText('first paragraph').hover();
  await expect(ed).toHaveCSS('padding-left', /^(84|28)px$/);
  expect(external).toEqual([]);
});
