import type { Page } from '@playwright/test';
import { runCommand, answerPrompt } from './drawingHelpers';
import { expect, openVault, readVaultFile, listVaultFiles, test } from './support';

// Templates (ADR-0068): notes, drawings and presentations kept in .clarae/templates of the vault.
// They create new files, are applied to the open one, and are made from it.

const TPL = '.clarae/templates';
const SCENE = JSON.stringify({
  type: 'excalidraw',
  version: 2,
  elements: [
    {
      id: 'tpl-box',
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 120,
      height: 60,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
    },
  ],
  appState: {},
  files: {},
});

async function pick(page: Page, name: string): Promise<void> {
  await page
    .getByRole('listbox', { name: 'Choose a template' })
    .getByRole('button', { name, exact: true })
    .click();
}

test('a note is created from a template of the vault, with its variables filled in', async ({
  page,
}) => {
  await openVault(page, {
    'Readme.md': '# Readme\n',
    [`${TPL}/Meeting.md`]: '# {{title}}\n\nAttendees:\n',
    [`${TPL}/Board.excalidraw`]: SCENE,
  });
  await runCommand(page, 'New note from template');
  // Only the templates of notes are offered.
  await expect(
    page.getByRole('listbox', { name: 'Choose a template' }).getByRole('button'),
  ).toHaveCount(1);
  await pick(page, 'Meeting');
  await answerPrompt(page, 'Standup');
  await expect(page.locator('.note-view')).toContainText('Attendees');
  await expect.poll(() => readVaultFile(page, 'Standup.md')).toBe('# Standup\n\nAttendees:\n');
  // The templates are not among the notes of the explorer.
  await expect(page.locator('.tree .node', { hasText: 'Meeting' })).toHaveCount(0);
});

test('a drawing and a presentation are created from their templates', async ({ page }) => {
  await openVault(page, {
    'Readme.md': '# Readme\n',
    [`${TPL}/Board.excalidraw`]: SCENE,
    [`${TPL}/Talk.marp`]: '---\nmarp: true\n---\n\n# {{title}}\n\n---\n\n## Agenda\n',
  });
  await runCommand(page, 'New drawing from template');
  await pick(page, 'Board');
  await expect
    .poll(async () =>
      (await listVaultFiles(page)).filter((p) => /^Drawing .*\.excalidraw$/.test(p)),
    )
    .toHaveLength(1);
  const drawing =
    (await listVaultFiles(page)).find((p) => /^Drawing .*\.excalidraw$/.test(p)) ?? '';
  expect(await readVaultFile(page, drawing)).toContain('tpl-box');

  await runCommand(page, 'New presentation from template');
  await pick(page, 'Talk');
  await expect
    .poll(async () =>
      (await listVaultFiles(page)).filter((p) => p.endsWith('.marp') && !p.startsWith('.')),
    )
    .toHaveLength(1);
  const deck = (await listVaultFiles(page)).find((p) => /^Presentation .*\.marp$/.test(p)) ?? '';
  const text = await readVaultFile(page, deck);
  expect(text).toContain('## Agenda');
  expect(text).toMatch(/# Presentation \d{4}/);
});

test('"Apply template" adds the slides of a template to the open presentation', async ({
  page,
}) => {
  await openVault(page, {
    'Kickoff.marp': '---\nmarp: true\n---\n\n# Kick-off\n\n---\n\n## Plan\n',
    [`${TPL}/Closing.marp`]: '---\nmarp: true\ntheme: gaia\n---\n\n## Thanks\n',
  });
  await page.locator('.tree .node', { hasText: 'Kickoff' }).click();
  const editor = page.locator('.note-view .cm-content');
  await expect(editor).toContainText('# Kick-off');
  await editor.click();
  await runCommand(page, 'Apply template');
  await pick(page, 'Closing');
  await expect(editor).toContainText('## Thanks');
  // Its slides, not its frontmatter.
  await expect(editor).not.toContainText('theme: gaia');
  await expect.poll(() => readVaultFile(page, 'Kickoff.marp')).toContain('## Thanks');
});

test('the open note is saved as a template, and a template opens in a tab to be edited', async ({
  page,
}) => {
  await openVault(page, { 'Readme.md': '# Readme\n\nbody\n' });
  await page.locator('.tree .node', { hasText: 'Readme' }).click();
  await expect(page.locator('.note-view')).toContainText('body');
  await runCommand(page, 'Save as template');
  await answerPrompt(page, 'Starter');
  await expect(page.getByText('Template "Starter" saved.')).toBeVisible();
  await page.getByRole('button', { name: 'OK' }).click();
  expect(await readVaultFile(page, `${TPL}/Starter.md`)).toBe('# Readme\n\nbody\n');
  expect(await readVaultFile(page, 'Readme.md')).toBe('# Readme\n\nbody\n');

  await runCommand(page, 'Edit template');
  await page
    .getByRole('listbox', { name: 'Choose a template' })
    .getByRole('button', { name: /Starter/ })
    .click();
  await expect(page.locator('.note-view')).toContainText('body');
});

test('the templates of the old folder are imported into the templates folder', async ({ page }) => {
  await openVault(page, {
    'Readme.md': '# Readme\n',
    'Templates/Daily.md': '# {{title}}\n',
  });
  await runCommand(page, 'Import templates from the folder');
  await expect(page.getByText(/Move the notes, drawings and presentations/)).toBeVisible();
  await page.getByRole('button', { name: 'Move' }).click();
  await expect(page.getByText('1 template moved.')).toBeVisible();
  await page.getByRole('button', { name: 'OK' }).click();
  expect(await readVaultFile(page, `${TPL}/Daily.md`)).toBe('# {{title}}\n');
  expect(await readVaultFile(page, 'Templates/Daily.md')).toBe('');
  await expect(page.locator('.tree .node', { hasText: 'Daily' })).toHaveCount(0);
});
