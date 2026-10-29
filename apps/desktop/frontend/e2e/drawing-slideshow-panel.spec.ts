// The Slideshow tab of the right sidebar for a drawing: the frames as slides.
import { expect, test, type Page } from '@playwright/test';
import { openDrawing, savedDrawing, scene, shape, waitSaved } from './drawingHelpers';

const frames = () =>
  scene([
    shape('f1', 0, 0, 400, 300, { name: 'Intro' }, 'frame'),
    shape('f2', 500, 0, 400, 300, { name: 'Details' }, 'frame'),
  ]);

async function openTab(page: Page) {
  await page.getByRole('button', { name: 'Toggle right sidebar' }).click();
  await page.getByRole('tab', { name: 'Slides' }).click();
}

test('the Slideshow tab lists the frames and reorders, excludes and annotates them', async ({
  page,
}) => {
  await openDrawing(page, frames());
  await openTab(page);
  await expect(page.getByText('Frame slideshow · 2 of 2 included')).toBeVisible();
  const cards = page.locator('.slide-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('1. Details'); // natural name order

  await cards.nth(0).getByRole('button', { name: 'Move down' }).click();
  await expect(cards.nth(0)).toContainText('1. Intro');

  await cards.nth(1).getByRole('button', { name: 'Leave out of the presentation' }).click();
  await expect(page.getByText('Frame slideshow · 1 of 2 included')).toBeVisible();

  await cards.nth(0).click();
  await page.getByPlaceholder('Add presenter notes for this slide…').fill('say hello');
  await waitSaved(page);
  const saved = (await savedDrawing(page)).elements;
  const memo = (id: string) =>
    (saved.find((e) => e.id === id) as { customData?: { memobrain?: Record<string, unknown> } })
      .customData?.memobrain;
  expect(memo('f1')).toMatchObject({ slide: 1, notes: 'say hello' });
  expect(memo('f2')).toMatchObject({ slide: 2, slideHidden: true });
});

test('Play starts the presentation from the included slides', async ({ page }) => {
  await openDrawing(page, frames());
  await openTab(page);
  await page.getByRole('button', { name: 'Start presentation' }).click();
  await expect(page.locator('.slideshow-bar')).toContainText('1 / 2');
});
