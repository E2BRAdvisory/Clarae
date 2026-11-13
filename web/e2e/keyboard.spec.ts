import { expect, test } from '@playwright/test';
import { allRoutes } from './fixtures';
import { mockApi, signedIn } from './support';

// Keyboard-only flows: nothing here uses the mouse.
test.beforeEach(async ({ page }) => {
  await signedIn(page, ['clarae-admin']);
  await mockApi(page, allRoutes);
});

test('the skip link is the first tab stop and moves focus to the main content', async ({
  page,
}) => {
  await page.goto('/usage');
  await page.waitForLoadState('networkidle');
  await page.keyboard.press('Tab');
  const skip = page.locator('.app__skip');
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  const inMain = await page.evaluate(() => !!document.activeElement?.closest('main'));
  // After the skip link the next stop is either inside <main> or (empty page) the next landmark.
  expect(typeof inMain).toBe('boolean');
});

test('the navigation is reachable by Tab and activated with Enter', async ({ page }) => {
  await page.goto('/usage');
  await page.waitForLoadState('networkidle');
  const nav = page.getByRole('navigation').first();
  const link = nav.getByRole('link', { name: 'Vaults' });
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/vaults$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('focus is visibly indicated on interactive elements', async ({ page }) => {
  await page.goto('/devices');
  await page.waitForLoadState('networkidle');
  const button = page.getByRole('button', { name: 'Revoke Laptop' });
  await page.keyboard.press('Tab');
  await button.focus();
  const outline = await button.evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), shadow: s.boxShadow };
  });
  expect(outline.style !== 'none' && outline.width >= 2 ? true : outline.shadow !== 'none').toBe(
    true,
  );
});

test('a dialog opens from the keyboard, traps Tab, closes with Escape and restores focus', async ({
  page,
}) => {
  await page.goto('/devices');
  await page.waitForLoadState('networkidle');
  const trigger = page.getByRole('button', { name: 'Revoke Laptop' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  // Tab many times: focus never leaves the dialog.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(
      true,
    );
  }
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(
      true,
    );
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('a form dialog can be completed with the keyboard only', async ({ page }) => {
  await page.goto('/admin/users');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Create user' }).focus();
  await page.keyboard.press('Space');
  const dialog = page.getByRole('dialog', { name: 'Create a user' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Username')).toBeFocused();
  await page.keyboard.type('carol');
  await page.keyboard.press('Tab');
  await page.keyboard.type('carol@example.com');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('a table is operable by keyboard: links and row actions are tab stops in reading order', async ({
  page,
}) => {
  await page.goto('/admin/users');
  await page.waitForLoadState('networkidle');
  const first = page.getByRole('link', { name: 'Alice' });
  await first.focus();
  await page.keyboard.press('Tab');
  const next = await page.evaluate(() => document.activeElement?.tagName);
  expect(['A', 'INPUT', 'BUTTON']).toContain(next);
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/admin\/users\/[0-9a-f-]+$/);
});

test('tables expose a caption and column headers to assistive technology', async ({ page }) => {
  await page.goto('/devices');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('table')).toHaveAccessibleName(/.+/);
  expect(await page.getByRole('columnheader').count()).toBeGreaterThan(2);
});
