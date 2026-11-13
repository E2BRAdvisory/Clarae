import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { allRoutes, G, P, U1 } from './fixtures';
import { mockApi, signedIn } from './support';

// Automated WCAG 2.1 A/AA scan of every route and of the main dialogs, in both themes.
// Fails on serious or critical violations; minor/moderate ones are only attached to the report.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const routes: [string, string][] = [
  ['usage', '/usage'],
  ['vaults', '/vaults'],
  ['devices', '/devices'],
  ['shares', '/shares'],
  ['admin storage', '/admin/storage'],
  ['admin limits', '/admin/limits'],
  ['admin users', '/admin/users'],
  ['admin user detail', `/admin/users/${U1}`],
  ['admin groups', '/admin/groups'],
  ['admin group detail', `/admin/groups/${G}`],
  ['admin config', '/admin/config'],
  ['admin config detail', `/admin/config/${P}`],
  ['admin audit', '/admin/audit'],
  ['not found', '/does-not-exist'],
];

const themes = ['light', 'dark'] as const;

async function prepare(page: Page, theme: (typeof themes)[number]) {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.addInitScript((t) => window.localStorage.setItem('clarae.web.theme', t), theme);
  await signedIn(page, ['clarae-admin']);
  await mockApi(page, allRoutes);
}

async function scan(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  const summary = blocking.map((v) => ({
    rule: v.id,
    impact: v.impact,
    nodes: v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} :: ${n.failureSummary ?? ''}`),
  }));
  expect(summary, JSON.stringify(summary, null, 2)).toEqual([]);
}

for (const theme of themes) {
  test.describe(`axe, ${theme} theme`, () => {
    for (const [name, path] of routes) {
      test(`route: ${name}`, async ({ page }) => {
        await prepare(page, theme);
        await page.goto(path);
        await expect(page.locator('main')).toBeVisible();
        await page.waitForLoadState('networkidle');
        await scan(page);
      });
    }

    const dialogs: [string, string, string][] = [
      ['vault ZIP (shared)', '/vaults', 'Download ZIP: Notes'],
      ['vault unlock (private)', '/vaults', 'Download ZIP, decrypted in your browser: Secrets'],
      ['revoke share', '/shares', 'Revoke Project X'],
      ['create user', '/admin/users', 'Create user'],
      ['revoke device', '/devices', 'Revoke Laptop'],
    ];
    for (const [name, path, button] of dialogs) {
      test(`dialog: ${name}`, async ({ page }) => {
        await prepare(page, theme);
        await page.goto(path);
        await page.getByRole('button', { name: button }).first().click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await scan(page);
      });
    }

    test('dialog: quota (user detail)', async ({ page }) => {
      await prepare(page, theme);
      await page.goto(`/admin/users/${U1}`);
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: /quota/i }).first().click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await scan(page);
    });
  });
}

test('reflows at 320 px without horizontal page scroll', async ({ page }) => {
  await prepare(page, 'light');
  await page.setViewportSize({ width: 320, height: 640 });
  for (const [, path] of routes) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
  }
});

test('html lang follows the UI language', async ({ page }) => {
  await prepare(page, 'light');
  await page.goto('/usage');
  await expect(page.locator('html')).toHaveAttribute('lang', /^(en|it)/);
});
