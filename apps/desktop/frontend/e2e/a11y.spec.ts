import AxeBuilder from '@axe-core/playwright';
import { appendFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, liveEngine, onWeb, openVault as openVaultOn, proseMirror, test } from './support';
import { openDrawing, runCommand, scene, shape } from './drawingHelpers';

// Automated WCAG 2.1 A/AA scan of the app chrome on the Wails mock, light and dark.
// CodeMirror's content DOM is excluded from the scan (documented in docs/qa/a11y-desktop.md);
// the editor surface is covered by the manual screen reader checklist. The Live editor of the Milkdown
// build is scanned whole (a rich note, below): its DOM is HTML like the chrome's, and ProseMirror is not excluded. Excalidraw's own canvas
// and toolbars are excluded too; MemoBrain's chrome around it (header, export dialog, tools
// panel, slideshow bar, tool dialogs) is scanned.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function scan(page: Page, label: string, opts: { editor?: boolean } = {}) {
  const builder = new AxeBuilder({ page }).withTags(TAGS).exclude('.excalidraw');
  // the Live editor of Milkdown is scanned with its content; CodeMirror's is not
  const results = await (opts.editor ? builder : builder.exclude('.cm-content')).analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  // AXE_REPORT=<file> appends every violation (any impact) as JSON lines, for triage.
  const report = process.env['AXE_REPORT'];
  if (report) {
    for (const v of results.violations) {
      appendFileSync(
        report,
        JSON.stringify({
          where: label,
          rule: v.id,
          impact: v.impact,
          nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
        }) + '\n',
      );
    }
  }
  const summary = blocking.map((v) => ({
    where: label,
    rule: v.id,
    impact: v.impact,
    nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' ')),
  }));
  expect(summary, JSON.stringify(summary, null, 2)).toEqual([]);
}

async function openVault(page: Page, theme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  if (onWeb()) {
    // The web has no welcome screen: the console opens the vault (scanned in web/e2e).
    await openVaultOn(page);
    return;
  }
  await page.goto('/');
  await scan(page, 'welcome');
  await page.getByRole('button', { name: 'Open folder as vault' }).click();
  await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible();
}

async function command(page: Page, query: string) {
  await page.keyboard.press('ControlOrMeta+p');
  await page.getByPlaceholder('Type a command…').fill(query);
  await page.keyboard.press('Enter');
}

// What a note can hold, one of each: lists (bullets, numbers, nested), tasks, a callout, a table, code,
// a formula and an embed. No tag, wikilink or external link: their colour is the one of the CodeMirror
// Live Preview too (contrast of the accent on the page, tracked apart).
const RICH = [
  '# Rich note',
  '',
  'A paragraph with **bold** and *italic* text.',
  '',
  '- a bullet',
  '  - a nested bullet',
  '- another bullet',
  '',
  '1. the first',
  '2. the second',
  '   1. a nested number',
  '',
  '- [ ] an open task',
  '- [x] a done task',
  '',
  '> [!note] A callout',
  '> with its body',
  '',
  '| Name | Value |',
  '| --- | --- |',
  '| one | 1 |',
  '| two | 2 |',
  '',
  '```ts',
  'const answer = 42;',
  '```',
  '',
  '$$',
  'x^2 + y^2',
  '$$',
  '',
  '![[Target]]',
  '',
].join('\n');

// The view of a list item is updated in place when the item changes: the marker is read again each time.
test('a bullet that becomes a task is a checkbox for the accessibility tree, and a task that becomes a bullet is not', async ({
  page,
}) => {
  test.skip(
    liveEngine() !== 'milkdown',
    'needs a build with the Milkdown Live editor (MEMOBRAIN_LIVE_ENGINE=milkdown)',
  );
  await openVaultOn(page, { 'Note.md': '- foo\n- bar\n' });
  await page.locator('.tree .node', { hasText: 'Note' }).first().click();
  const editor = proseMirror(page);
  await expect(editor).toBeVisible();
  await expect(editor.locator('li.list-item')).toHaveCount(2);
  await expect(editor.getByRole('checkbox')).toHaveCount(0);
  // `[ ] ` typed at the start of the first item makes it a task
  await editor.getByText('foo').click();
  await page.keyboard.press('Home');
  await page.keyboard.type('[ ] ');
  const box = editor.getByRole('checkbox', { name: 'Task: foo' });
  await expect(box).toHaveCount(1);
  await expect(box).toBeVisible();
  await expect(editor.getByRole('checkbox')).toHaveCount(1);
  // the marker of the other item is still the list's to say
  await expect(editor.locator('.label-wrapper[aria-hidden="true"]')).toHaveCount(1);
  // and back to a bullet (open, done, plain): no checkbox is left, and the glyph is hidden again
  await command(page, 'Toggle task');
  await expect(editor.getByRole('checkbox', { name: 'Task: foo' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await command(page, 'Toggle task');
  await expect(editor.getByRole('checkbox')).toHaveCount(0);
  await expect(editor.locator('.label-wrapper[aria-hidden="true"]')).toHaveCount(2);
});

for (const theme of ['light', 'dark'] as const) {
  test.describe(`desktop axe, ${theme}`, () => {
    test('the Live editor on a rich note, ProseMirror included', async ({ page }) => {
      test.skip(
        liveEngine() !== 'milkdown',
        'needs a build with the Milkdown Live editor (MEMOBRAIN_LIVE_ENGINE=milkdown)',
      );
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await openVaultOn(page, { 'Rich.md': RICH, 'Target.md': '# Target\n\nthe embedded note\n' });
      await page.locator('.tree .node', { hasText: 'Rich' }).first().click();
      const editor = proseMirror(page);
      await expect(editor).toBeVisible();
      // everything the note holds is drawn before the scan
      await expect(editor.locator('li.list-item')).toHaveCount(8);
      await expect(editor.getByRole('table')).toBeVisible();
      await expect(editor.locator('[role="checkbox"]')).toHaveCount(2);
      // the lists are lists for the accessibility tree, and the boxes tell which task they are
      await expect(
        editor.locator('ul > div[role="listitem"], ol > div[role="listitem"]'),
      ).toHaveCount(8);
      await expect(editor.locator('[role="checkbox"]').first()).toHaveAttribute(
        'aria-label',
        'Task: an open task',
      );
      await page.waitForTimeout(600);
      await scan(page, `live editor (${theme})`, { editor: true });
    });

    test('shell with a note open, sidebar panels and status bar', async ({ page }) => {
      await openVault(page, theme);
      await page.keyboard.press('ControlOrMeta+n');
      await expect(page.getByLabel('Note editor')).toBeVisible();
      await scan(page, 'shell');
      // The optional status bar (ADR-0035) stays on for the scans of the sidebar panels.
      await command(page, 'toggle status bar');
      await expect(page.getByRole('status', { name: 'Status bar' })).toBeVisible();
      await scan(page, 'status bar');
      await page.keyboard.press('ControlOrMeta+Shift+r');
      for (const tab of [
        'Files',
        'Outline',
        'Properties',
        'Tags',
        'Links',
        'Slides',
        'Statistics',
      ]) {
        const t = page.getByRole('tab', { name: tab });
        if (await t.count()) {
          await t.first().click();
          await scan(page, `sidebar ${tab}`);
        }
      }
      // Search is opened from the header / hotkey and shows as a tab only while active.
      await page.keyboard.press('ControlOrMeta+Shift+f');
      await expect(page.getByRole('tab', { name: 'Search' })).toBeVisible();
      await scan(page, 'sidebar Search');
    });

    test('tab menu with a locked tab, and the vault menu', async ({ page }) => {
      await openVault(page, theme);
      await page.keyboard.press('ControlOrMeta+n');
      await expect(page.getByLabel('Note editor')).toBeVisible();
      await page.getByRole('tab', { name: /Untitled/ }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Lock tab' }).click();
      const locked = page.getByRole('tab', { name: /\(locked\)/ });
      await expect(locked).toBeVisible();
      await locked.click({ button: 'right' });
      await expect(page.getByRole('menu')).toBeVisible();
      await scan(page, 'tab menu (locked tab)');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /Switch vault/ }).click();
      await expect(page.getByRole('menu')).toBeVisible();
      await scan(page, 'vault menu');
    });

    test('command palette and quick switcher', async ({ page }) => {
      await openVault(page, theme);
      await page.keyboard.press('ControlOrMeta+p');
      await expect(page.getByPlaceholder('Type a command…')).toBeVisible();
      await scan(page, 'palette');
      await page.keyboard.press('Escape');
      await page.keyboard.press('ControlOrMeta+o');
      await expect(page.getByPlaceholder('Find or create a note…')).toBeVisible();
      await scan(page, 'switcher');
    });

    const dialogs: [string, string][] = [
      ['settings', 'Open settings'],
      ['hotkeys settings', 'Open hotkeys settings'],
      ['sync connect wizard', 'Connect vault to the cloud'],
      ['sharing and invitations', 'Sharing and invitations'],
      ['import wizard', 'Import…'],
      ['graph view', 'Open graph view'],
      ['new base', 'New base'],
    ];
    for (const [name, query] of dialogs) {
      test(`entry point: ${name}`, async ({ page }) => {
        await openVault(page, theme);
        await page.keyboard.press('ControlOrMeta+n'); // a note, so note-scoped commands are enabled
        await command(page, query);
        await page.waitForTimeout(400);
        await scan(page, name);
      });
    }

    test('drawing: header, export dialog, tools panel, slideshow and formula dialog', async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await openDrawing(
        page,
        scene([
          shape('f1', 0, 0, 400, 300, { name: 'Slide 1' }, 'frame'),
          shape('r', 20, 20, 80, 80),
        ]),
      );
      await scan(page, 'drawing');

      await page.getByRole('button', { name: 'Export', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await scan(page, 'drawing export dialog');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);

      await runCommand(page, 'open the tools panel');
      await expect(page.getByRole('dialog', { name: 'Drawing tools' })).toBeVisible();
      await scan(page, 'drawing tools panel');
      await page.keyboard.press('Escape');

      await runCommand(page, 'insert a LaTeX formula');
      await expect(page.getByRole('dialog', { name: 'Insert a LaTeX formula' })).toBeVisible();
      await scan(page, 'drawing formula dialog');
      await page.keyboard.press('Escape');

      await runCommand(page, 'insert a diagram from Mermaid text');
      await expect(page.getByRole('dialog', { name: 'Text to diagram (Mermaid)' })).toBeVisible();
      await scan(page, 'drawing mermaid dialog');
      await page.keyboard.press('Escape');

      await runCommand(page, 'describe the drawing as text');
      await expect(page.getByRole('dialog', { name: 'Description of the drawing' })).toBeVisible();
      await scan(page, 'drawing description');
      await page.keyboard.press('Escape');

      await runCommand(page, 'start the slideshow');
      await expect(page.getByRole('toolbar', { name: 'Slideshow' })).toBeVisible();
      await scan(page, 'drawing slideshow');
    });

    test('recovery view and history for a note', async ({ page }) => {
      await openVault(page, theme);
      await page.keyboard.press('ControlOrMeta+n');
      await page.getByLabel('Note editor').fill('hello');
      await expect(page.locator('.save-state')).toHaveText('Saved');
      await command(page, 'File recovery');
      await page.waitForTimeout(400);
      await scan(page, 'recovery');
    });
  });
}
