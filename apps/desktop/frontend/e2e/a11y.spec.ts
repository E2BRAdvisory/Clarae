import AxeBuilder from '@axe-core/playwright';
import { appendFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { openDrawing, runCommand, scene, shape } from './drawingHelpers';

// Automated WCAG 2.1 A/AA scan of the app chrome on the Wails mock, light and dark.
// CodeMirror's content DOM is excluded from the scan (documented in docs/qa/a11y-desktop.md);
// the editor surface is covered by the manual screen reader checklist. Excalidraw's own canvas
// and toolbars are excluded too; MemoBrain's chrome around it (header, export dialog, tools
// panel, slideshow bar, tool dialogs) is scanned.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function scan(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(TAGS)
    .exclude('.cm-content')
    .exclude('.excalidraw')
    .analyze();
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

for (const theme of ['light', 'dark'] as const) {
  test.describe(`desktop axe, ${theme}`, () => {
    test('shell with a note open, sidebar panels and status bar', async ({ page }) => {
      await openVault(page, theme);
      await page.keyboard.press('ControlOrMeta+n');
      await expect(page.getByLabel('Note editor')).toBeVisible();
      await scan(page, 'shell');
      for (const tab of ['Files', 'Search', 'Tags', 'Outline']) {
        const t = page.getByRole('tab', { name: tab });
        if (await t.count()) {
          await t.first().click();
          await scan(page, `sidebar ${tab}`);
        }
      }
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

      await page.getByRole('button', { name: 'Export' }).click();
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
