import type { Page } from '@playwright/test';
import { expect, test, appOrigin, openVault } from './support';
import AxeBuilder from '@axe-core/playwright';

const DECK = [
  '---',
  'slide-transition: fade',
  'slide-numbers: true',
  '---',
  '# Opening',
  '',
  'Note: greet everybody',
  '',
  '---',
  '',
  '# Middle',
  '',
  '- one',
  '- two',
  '',
  '---',
  '',
  '# Closing',
  '',
].join('\n');

async function openDeck(page: Page): Promise<void> {
  await openVault(page, { 'Deck.md': DECK });
  await page.locator('.tree .node', { hasText: 'Deck' }).click();
  await expect(page.getByLabel('Note editor')).toContainText('Opening');
}

test('present a note from the command palette: slides, presenter view, no network', async ({
  page,
}) => {
  const external: string[] = [];
  const origin = appOrigin();
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol !== 'data:' && u.protocol !== 'blob:' && u.origin !== origin)
      external.push(r.url());
  });
  await openDeck(page);

  await page.keyboard.press('ControlOrMeta+p');
  await page.getByPlaceholder('Type a command…').fill('start presentation');
  await page.keyboard.press('Enter');

  const show = page.getByRole('dialog', { name: 'Presentation' });
  await expect(show).toBeVisible();
  await expect(show.getByRole('heading', { name: 'Opening' })).toBeVisible();
  await expect(show.locator('.slide-number')).toHaveText('Slide 1 of 3');

  await page.keyboard.press('ArrowRight');
  await expect(show.getByRole('heading', { name: 'Middle' })).toBeVisible();
  await expect(show.getByRole('listitem')).toHaveCount(2);

  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('p');
  await expect(show.getByText('greet everybody')).toBeVisible();
  await expect(show.getByRole('heading', { name: 'Middle' })).toBeVisible(); // the next slide

  await page.keyboard.press('Escape');
  await expect(show).toBeHidden();
  expect(external).toEqual([]);
});

test('the Slides tab lists the slides and starts the presentation at the one chosen', async ({
  page,
}) => {
  await openDeck(page);
  await page.keyboard.press('ControlOrMeta+p');
  await page.getByPlaceholder('Type a command…').fill('show slides');
  await page.keyboard.press('Enter');

  await expect(page.getByLabel('Transition')).toHaveValue('fade');
  const thumbs = page.getByRole('button', { name: /^Slide \d/ });
  await expect(thumbs).toHaveCount(3);

  await thumbs.nth(2).click();
  const show = page.getByRole('dialog', { name: 'Presentation' });
  await expect(show.getByRole('heading', { name: 'Closing' })).toBeVisible();
});

test('the presentation and the Slides tab have no accessibility violations', async ({ page }) => {
  await openDeck(page);
  await page.keyboard.press('ControlOrMeta+p');
  await page.getByPlaceholder('Type a command…').fill('show slides');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /^Slide \d/ })).toHaveCount(3);
  const tab = await new AxeBuilder({ page }).include('.sidebar.right').analyze();
  expect(tab.violations.map((v) => v.id)).toEqual([]);

  await page.getByRole('button', { name: 'Start presentation' }).click();
  await expect(page.getByRole('dialog', { name: 'Presentation' })).toBeVisible();
  const show = await new AxeBuilder({ page }).include('.deck-show').analyze();
  expect(show.violations.map((v) => v.id)).toEqual([]);
});
