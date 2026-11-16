import type { Page } from '@playwright/test';
import { appOrigin, onWeb, openVault, skipOnWeb } from './support';
import { expect, test, uuid, vault, type Cloud } from './cloud';

// Applications (M18, track E): a `.webapp` file of the vault opens as a page in a tab. On the desktop
// the page runs in a native view placed above the tab (here a stand-in on the Wails mock records what
// the UI asks of it: `window.__mock.webview`); in the browser, and wherever the desktop has no such view,
// the tab is a card that opens the page in the system browser. The profile turns the function on
// (features.web_viewer, on by default since ADR-0060; a profile can turn it off). The explorer and the tabs
// show an application by its name, without `.webapp`.

const HOME = uuid(1);
const APP = `${JSON.stringify({ version: 1, url: 'https://example.com/docs' })}\n`;
const APP2 = `${JSON.stringify({ version: 1, url: 'https://example.org/' })}\n`;
const ORIGIN = 'https://example.com';

interface MockView {
  id: string;
  url: string;
  visible: boolean;
  focused: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

interface MockWindow {
  __mock: {
    config: Record<string, unknown>;
    emit(name: string, payload: unknown): void;
    webview: {
      views: Map<string, MockView>;
      log: string[];
      reserved: string[];
      cleared: string[];
      eventsBeforeOpenReply: [string, Record<string, unknown>][];
    };
  };
  __opened?: string[];
}

/** The profile turns applications on, as the cloud would push it to a vault. */
async function enableApplications(page: Page): Promise<void> {
  await page.evaluate(() => {
    const m = (window as unknown as MockWindow).__mock;
    const features = { ...(m.config['features'] as object), web_viewer: true };
    m.config = { ...m.config, version: 2, managed: true, features };
    m.emit('config:updated', m.config);
  });
}

/** The profile turns applications off (the flag is on unless it says otherwise). */
async function disableApplications(page: Page): Promise<void> {
  await page.evaluate(() => {
    const m = (window as unknown as MockWindow).__mock;
    const features = { ...(m.config['features'] as object), web_viewer: false };
    m.config = { ...m.config, version: 2, managed: true, features };
    m.emit('config:updated', m.config);
  });
}

/** A vault with applications on, on either target (the web gets the flag from a profile of the cloud). */
async function open(page: Page, cloud: Cloud, files: Record<string, string>): Promise<void> {
  if (onWeb()) {
    await cloud.openVault(
      page,
      {
        vaults: [vault(HOME, 'Home', 'shared')],
        config: { config: { features: { web_viewer: true } } },
      },
      { open: HOME, files },
    );
    return;
  }
  await openVault(page, files);
  await enableApplications(page);
}

const views = (page: Page): Promise<MockView[]> =>
  page.evaluate(() => [...(window as unknown as MockWindow).__mock.webview.views.values()]);
/** What the UI asked of the core, apart from the keys it reserves at start. */
const asked = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    (window as unknown as MockWindow).__mock.webview.log.filter(
      (l) => !l.startsWith('ReserveKeys'),
    ),
  );
const opens = async (page: Page): Promise<number> =>
  (await asked(page)).filter((l) => l.startsWith('Open ')).length;

/** The rectangle of the stage as fractions of the window: what the core is given. */
const stageBounds = (page: Page) =>
  page.locator('.browser-stage').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      x: r.left / window.innerWidth,
      y: r.top / window.innerHeight,
      width: r.width / window.innerWidth,
      height: r.height / window.innerHeight,
    };
  });

/** The id of the vault that is open (the mock keys its vaults by a hash of the path). */
const openVaultId = (page: Page): Promise<string> =>
  page.evaluate(
    () =>
      [
        ...(
          window as unknown as { __mock: { vaults: Map<string, { info: { id: string } }> } }
        ).__mock.vaults.values(),
      ][0]?.info.id as string,
  );

/** What the interface calls an application: the name of its file without `.webapp`. */
const shown = (file: string): string => file.replace(/\.webapp$/, '');
const tab = (page: Page, file: string) => page.locator('.tabbar .tab', { hasText: shown(file) });
const tree = (page: Page, file: string) => page.locator('.tree .node', { hasText: shown(file) });
/** A click in the explorer replaces the tab in front; with the modifier it opens a tab of its own. */
const inNewTab = (page: Page, name: string) =>
  tree(page, name).click({ modifiers: ['ControlOrMeta'] });

async function command(page: Page, query: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+p');
  await page.getByPlaceholder('Type a command…').fill(query);
  await page.keyboard.press('Enter');
}

/** Opens the tab of an application and says yes to its origin; the view opens. */
async function showApp(page: Page, name = 'Docs.webapp', newTab = false): Promise<void> {
  if (newTab) await inNewTab(page, name);
  else await tree(page, name).click();
  await page.getByRole('button', { name: 'Open here' }).click();
  await expect.poll(() => views(page).then((v) => v.length)).toBeGreaterThan(0);
  // the mock's page has loaded (its state events come after the call that opened it)
  const stage = page.locator('.browser-stage');
  await expect(stage).toHaveAttribute('data-phase', 'open');
  await expect(stage).not.toHaveAttribute('aria-busy', 'true');
}

/** Every view is shown, or hidden, as the core was last told (there is at least one). */
const visible = (page: Page, want: boolean) =>
  expect
    .poll(() => views(page).then((v) => v.length > 0 && v.every((x) => x.visible === want)))
    .toBe(true);

test('an application is created from the ribbon and opens in its tab, after asking about its origin', async ({
  page,
  cloud,
}) => {
  await open(page, cloud, { 'Readme.md': '# Readme\n' });
  await page.locator('nav.ribbon').getByRole('button', { name: 'New application' }).click();
  const dialog = page.getByRole('dialog', { name: 'New application' });
  await dialog.getByLabel('Address').fill('example.com/docs');
  await dialog.getByLabel('Name').fill('Docs');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(tab(page, 'Docs.webapp')).toBeVisible();
  await expect(tree(page, 'Docs.webapp')).toBeVisible();

  if (onWeb()) {
    // no browser inside the tab: a card, and the button opens the page in a tab of the browser
    await expect(page.getByRole('heading', { name: 'Docs' })).toBeVisible();
    await expect(page.getByText('https://example.com/docs')).toBeVisible();
    await page
      .context()
      .route('https://example.com/**', (r) => r.fulfill({ contentType: 'text/html', body: 'ok' }));
    const popup = page.context().waitForEvent('page');
    await page.getByRole('button', { name: 'Open in the browser' }).click();
    const opened = await popup;
    expect(opened.url()).toBe('https://example.com/docs');
    await opened.close();
    return;
  }
  await expect(page.getByRole('heading', { name: 'Open https://example.com here?' })).toBeVisible();
  // nothing is loaded before the user agrees
  expect(await opens(page)).toBe(0);
  await page.getByRole('button', { name: 'Open here' }).click();
  await expect.poll(() => views(page).then((v) => v.length)).toBe(1);
  expect((await views(page))[0]).toMatchObject({ url: 'https://example.com/docs', visible: true });
});

test('an application is created from the empty pane too', async ({ page, cloud }) => {
  await open(page, cloud, {});
  await page
    .locator('.empty-pane')
    .getByRole('button', { name: /New application/ })
    .click();
  const dialog = page.getByRole('dialog', { name: 'New application' });
  await dialog.getByLabel('Address').fill('https://example.org/');
  await dialog.getByRole('button', { name: 'OK' }).click();
  // named after the site when no name is given
  await expect(tab(page, 'example.org.webapp')).toBeVisible();
});

test('the explorer creates an application in the chosen folder, by name, and opens it', async ({
  page,
  cloud,
}) => {
  await open(page, cloud, { 'Projects/Plan.md': '# Plan\n', 'Readme.md': '# Readme\n' });
  const rows = () => page.locator('.tree .node').allTextContents();
  const dialogFor = async () => {
    const dialog = page.getByRole('dialog', { name: 'New application' });
    await expect(dialog).toBeVisible();
    return dialog;
  };

  // the toolbar button, with the folder in focus
  await tree(page, 'Projects').click();
  await page.locator('.sidebar .toolbar').getByRole('button', { name: 'New application' }).click();
  let dialog = await dialogFor();
  await dialog.getByLabel('Address').fill('https://example.com/docs');
  await dialog.getByLabel('Name').fill('Wiki');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(tab(page, 'Wiki')).toBeVisible();
  // inside the folder (its children come before what follows it), and named without `.webapp`
  await expect.poll(rows).toEqual(['Projects', 'Plan', 'Wiki', 'Readme']);
  expect((await rows()).join('|')).not.toContain('.webapp');

  // the menu of the empty space: the top of the vault
  await page.locator('.tree').click({ button: 'right', position: { x: 20, y: 300 } });
  await page.getByRole('menuitem', { name: 'New application' }).click();
  dialog = await dialogFor();
  await dialog.getByLabel('Address').fill('https://example.org/');
  await dialog.getByLabel('Name').fill('Top');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(tab(page, 'Top')).toBeVisible();
  await expect.poll(rows).toEqual(['Projects', 'Plan', 'Wiki', 'Readme', 'Top']);

  // the menu of a folder
  await tree(page, 'Projects').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New application' }).click();
  dialog = await dialogFor();
  await dialog.getByLabel('Address').fill('https://example.net/');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(tab(page, 'example.net')).toBeVisible();
  // sorted by name inside the folder
  await expect.poll(rows).toEqual(['Projects', 'example.net', 'Plan', 'Wiki', 'Readme', 'Top']);
});

test('the quick switcher finds an application by its name and opens it in its tab', async ({
  page,
  cloud,
}) => {
  await open(page, cloud, {
    'Status board.webapp': APP,
    'Readme.md': '# Readme\n',
    'Status.txt': 'not something the switcher opens',
  });
  await page.keyboard.press('ControlOrMeta+o');
  const input = page.getByRole('combobox', { name: 'Find a file or create a note…' });
  await input.fill('status');
  // the kind is in the name of the option; a text file is not listed
  await expect(page.getByRole('option', { name: /Status board, Application/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Status\.txt|Status, / })).toHaveCount(0);
  await input.press('Enter');
  await expect(tab(page, 'Status board.webapp')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Find a file or create a note…' })).toBeHidden();

  if (onWeb()) {
    // no browser inside the tab: the card, which opens the page in a tab of the browser
    await expect(page.getByRole('heading', { name: 'Status board' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open in the browser' })).toBeVisible();
    return;
  }
  // the application's own tab, with the question about the origin, and not the system's application
  await expect(page.getByRole('heading', { name: 'Open https://example.com here?' })).toBeVisible();
  expect(await opens(page)).toBe(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { __mock: { systemOpens: string[] } }).__mock.systemOpens,
    ),
  ).toEqual([]);
});

test('an address that is not http or https is refused, and nothing is written', async ({
  page,
  cloud,
}) => {
  await open(page, cloud, { 'Readme.md': '# Readme\n' });
  await page.locator('nav.ribbon').getByRole('button', { name: 'New application' }).click();
  const dialog = page.getByRole('dialog', { name: 'New application' });
  await dialog.getByLabel('Address').fill('javascript:alert(1)');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Only http and https');
  await dialog.getByLabel('Address').fill('file:///etc/passwd');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Only http and https');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.tabbar .tab')).toHaveCount(0);
  // nothing was written: the explorer lists the note alone
  await expect(page.locator('.tree .node')).toHaveCount(1);
});

test('with the flag of the profile off there is no way to create an application', async ({
  page,
}) => {
  skipOnWeb(
    'webapp.embedded',
    'the card for a profile that turns the browser off needs a desktop that has one; the web has the other card',
  );
  await openVault(page, { 'Docs.webapp': APP });
  await disableApplications(page);
  await expect(
    page.locator('nav.ribbon').getByRole('button', { name: 'New application' }),
  ).toHaveCount(0);
  await expect(
    page.locator('.sidebar .toolbar').getByRole('button', { name: 'New application' }),
  ).toHaveCount(0);
  await expect(
    page.locator('.empty-pane').getByRole('button', { name: /New application/ }),
  ).toHaveCount(0);
  // a file that is there opens as a card, and never as a view
  await tree(page, 'Docs.webapp').click();
  await expect(page.getByText(/turned off by the configuration profile/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open in the browser' })).toBeVisible();
  expect(await asked(page)).toEqual([]);
});

test('the view takes the rectangle of its placeholder, as fractions of the window', async ({
  page,
  cloud,
}) => {
  skipOnWeb('webapp.embedded', 'the browser has no native view to put a page in');
  await open(page, cloud, { 'Docs.webapp': APP });
  await showApp(page);
  await visible(page, true);
  const stage = await stageBounds(page);
  const view = (await views(page))[0] as MockView;
  expect(view.bounds.x).toBeCloseTo(stage.x, 3);
  expect(view.bounds.y).toBeCloseTo(stage.y, 3);
  expect(view.bounds.width).toBeCloseTo(stage.width, 3);
  expect(view.bounds.height).toBeCloseTo(stage.height, 3);

  // the layout changes, the view follows: the sidebar closes
  await page.keyboard.press('ControlOrMeta+Shift+l');
  await expect
    .poll(async () => ((await views(page))[0] as MockView).bounds.width)
    .toBeGreaterThan(view.bounds.width + 0.05);
  const wider = await stageBounds(page);
  const after = (await views(page))[0] as MockView;
  expect(after.bounds.x).toBeCloseTo(wider.x, 3);
  expect(after.bounds.width).toBeCloseTo(wider.width, 3);

  // and the window: the numbers stay fractions of it
  await page.setViewportSize({ width: 900, height: 600 });
  await expect
    .poll(async () => {
      const b = ((await views(page))[0] as MockView).bounds;
      const s = await stageBounds(page);
      return Math.abs(b.width - s.width) + Math.abs(b.height - s.height) + Math.abs(b.x - s.x);
    })
    .toBeLessThan(0.002);
});

test('the zoom of the application does not change where the view is placed', async ({
  page,
  cloud,
}) => {
  skipOnWeb('webapp.embedded', 'the browser has no native view to put a page in');
  await open(page, cloud, { 'Docs.webapp': APP });
  await showApp(page);
  await visible(page, true);
  // what the pixels say: the box of the stage on screen, as fractions of the window
  const onScreen = async () => {
    const box = (await page.locator('.browser-stage').boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const win = page.viewportSize() as { width: number; height: number };
    return {
      x: box.x / win.width,
      y: box.y / win.height,
      width: box.width / win.width,
      height: box.height / win.height,
    };
  };
  for (const zoom of ['1.5', '0.8', '1']) {
    // the setting of Appearance > Zoom is a `zoom` of the root element
    await page.evaluate((z) => document.documentElement.style.setProperty('zoom', z), zoom);
    await expect
      .poll(async () => {
        const v = ((await views(page))[0] as MockView).bounds;
        const s = await onScreen();
        return (
          Math.abs(v.x - s.x) +
          Math.abs(v.y - s.y) +
          Math.abs(v.width - s.width) +
          Math.abs(v.height - s.height)
        );
      })
      .toBeLessThan(0.004);
  }
});

test('the view hides under the command palette, a dialog and a menu, and comes back', async ({
  page,
  cloud,
}) => {
  skipOnWeb('webapp.embedded', 'the browser has no native view to put a page in');
  await open(page, cloud, { 'Docs.webapp': APP, 'Readme.md': '# Readme\n' });
  await showApp(page);
  await visible(page, true);

  // the command palette, which the application does not know about
  await page.keyboard.press('ControlOrMeta+p');
  await expect(page.getByPlaceholder('Type a command…')).toBeVisible();
  await visible(page, false);
  await page.keyboard.press('Escape');
  await visible(page, true);

  // a dialog: the form of a new application
  await command(page, 'New application');
  await expect(page.getByRole('dialog', { name: 'New application' })).toBeVisible();
  await visible(page, false);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await visible(page, true);

  // a context menu over the tab
  await tab(page, 'Docs.webapp').click({ button: 'right' });
  await expect(page.getByRole('menuitem').first()).toBeVisible();
  await visible(page, false);
  await page.keyboard.press('Escape');
  await visible(page, true);

  // the quick switcher
  await page.keyboard.press('ControlOrMeta+o');
  await expect(page.getByRole('combobox', { name: 'Find a file or create a note…' })).toBeVisible();
  await visible(page, false);
  await page.keyboard.press('Escape');
  await visible(page, true);
});

test('the view hides while a tab or a splitter is dragged', async ({ page, cloud }) => {
  skipOnWeb('webapp.embedded', 'the browser has no native view to put a page in');
  await open(page, cloud, { 'Docs.webapp': APP, 'Readme.md': '# Readme\n' });
  await showApp(page);
  await visible(page, true);
  // a tab being dragged (HTML5 drag and drop)
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await tab(page, 'Docs.webapp').dispatchEvent('dragstart', { dataTransfer: dt });
  await visible(page, false);
  await tab(page, 'Docs.webapp').dispatchEvent('dragend', { dataTransfer: dt });
  await visible(page, true);
  // a splitter
  await page.keyboard.press('ControlOrMeta+\\');
  const bar = page.locator('.resizer').first();
  await expect(bar).toBeAttached();
  const box = (await bar.boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.move(box.x + box.width / 2, box.y + 60);
  await page.mouse.down();
  await visible(page, false);
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + 60);
  await page.mouse.up();
  await visible(page, true);
});

test('a tab that is not shown hides its view and keeps its page; closing the tab closes the view', async ({
  page,
  cloud,
}) => {
  skipOnWeb('webapp.embedded', 'the browser has no native view to put a page in');
  await open(page, cloud, { 'Docs.webapp': APP, 'Readme.md': '# Readme\n' });
  await showApp(page);
  await visible(page, true);
  // another tab in front
  await inNewTab(page, 'Readme');
  await expect(tab(page, 'Readme')).toBeVisible();
  await visible(page, false);
  expect((await asked(page)).some((l) => l.startsWith('Close '))).toBe(false);
  // back: the same view, not another one
  await tab(page, 'Docs.webapp').click();
  await visible(page, true);
  expect(await opens(page)).toBe(1);
  // the tab is closed: the view too
  await tab(page, 'Docs.webapp').click({ button: 'middle' });
  await expect.poll(() => views(page).then((v) => v.length)).toBe(0);
  expect((await asked(page)).some((l) => l.startsWith('Close '))).toBe(true);
});

test('a restored layout loads only the tab that is shown, the others when they are activated', async ({
  page,
  cloud,
}) => {
  skipOnWeb('webapp.embedded', 'the browser has no native view to put a page in');
  void cloud;
  // a vault whose last session left two applications open, the second in front; their origins were confirmed
  await page.goto('/');
  await page.evaluate(
    async ({ apps, layout }) => {
      const w = window as unknown as MockWindow & {
        go: { app: { VaultAPI: { OpenVault(p: string): Promise<{ id: string }> } } };
      };
      const info = await w.go.app.VaultAPI.OpenVault('/mock/vault');
      const v = (
        w.__mock as unknown as { vaults: Map<string, { files: Map<string, string> }> }
      ).vaults.get(info.id);
      for (const [path, text] of Object.entries(apps)) v?.files.set(path, text);
      v?.files.set('.clarae/workspace.json', layout);
      localStorage.setItem(
        `clarae.webapp.origins.${info.id}`,
        JSON.stringify(['https://example.com', 'https://example.org']),
      );
      const features = { web_viewer: true };
      w.__mock.config = { ...w.__mock.config, version: 2, managed: true, features };
      w.__mock.emit('config:updated', w.__mock.config);
    },
    {
      apps: { 'Docs.webapp': APP, 'Other.webapp': APP2 },
      layout: JSON.stringify({
        layout: {
          root: {
            kind: 'pane',
            id: 'p1',
            tabs: [
              { id: 't1', path: 'Docs.webapp', mode: 'live' },
              { id: 't2', path: 'Other.webapp', mode: 'live' },
            ],
            active: 't2',
          },
          activePane: 'p1',
        },
      }),
    },
  );
  await page.getByRole('button', { name: 'Open folder as vault' }).click();
  await expect(page.locator('.tabbar .tab')).toHaveCount(2);
  // one view, for the tab that is shown; the other tab has loaded nothing
  await expect.poll(() => opens(page)).toBe(1);
  await page.waitForTimeout(500);
  expect(await opens(page)).toBe(1);
  expect((await views(page))[0]?.url).toBe('https://example.org/');
  // the other loads when the user goes to it; the first one is hidden, not closed
  await tab(page, 'Docs.webapp').click();
  await expect.poll(() => opens(page)).toBe(2);
  await expect
    .poll(() => views(page).then((v) => v.map((x) => `${x.url}:${x.visible}`).sort()))
    .toEqual(['https://example.com/docs:true', 'https://example.org/:false']);
});

test('where the desktop has no embedded browser the tab is a card that opens the system browser', async ({
  page,
}) => {
  skipOnWeb(
    'webapp.embedded',
    'the web never has an embedded browser: its card is covered by the first specs',
  );
  await page.addInitScript(() => {
    (window as unknown as { __CLARAE_WEBVIEW__: unknown }).__CLARAE_WEBVIEW__ = {
      available: false,
    };
  });
  await openVault(page, { 'Docs.webapp': APP });
  await enableApplications(page);
  await page.evaluate(() => {
    const w = window as unknown as MockWindow & {
      runtime: { BrowserOpenURL: (u: string) => void };
    };
    w.__opened = [];
    w.runtime.BrowserOpenURL = (u) => w.__opened?.push(u);
  });
  await tree(page, 'Docs.webapp').click();
  await expect(page.getByRole('heading', { name: 'Docs' })).toBeVisible();
  await expect(page.getByText(/browser inside the tab is not available/)).toBeVisible();
  await expect(page.locator('.browser-stage')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open in the browser' }).click();
  expect(await page.evaluate(() => (window as unknown as MockWindow).__opened)).toEqual([
    'https://example.com/docs',
  ]);
  // the core was never asked to open anything, and the navigation commands do not exist
  expect((await asked(page)).filter((l) => l.startsWith('Open '))).toEqual([]);
  await page.keyboard.press('ControlOrMeta+p');
  await page.getByPlaceholder('Type a command…').fill('Application');
  await expect(page.getByRole('option', { name: /Application: reload/ })).toHaveCount(0);
  await expect(
    page.getByRole('option', { name: /Open the application in the browser/ }),
  ).toHaveCount(1);
});

test('a tab left while its view is still being made does not leave the page over the other tab', async ({
  page,
  cloud,
}) => {
  skipOnWeb('webapp.embedded', 'the browser has no native view to put a page in');
  await open(page, cloud, { 'Docs.webapp': APP, 'Readme.md': '# Readme\n' });
  // the native view takes a moment to be made
  await page.evaluate(() => {
    const api = (window as unknown as { go: { app: { WebViewAPI: Record<string, unknown> } } }).go
      .app.WebViewAPI;
    const original = api['Open'] as (...a: unknown[]) => Promise<unknown>;
    api['Open'] = (...a: unknown[]) => new Promise((r) => setTimeout(() => r(original(...a)), 400));
    const m = window as unknown as { __mock: { vaults: Map<string, { info: { id: string } }> } };
    const id = [...m.__mock.vaults.values()][0]?.info.id;
    localStorage.setItem(`clarae.webapp.origins.${id}`, JSON.stringify(['https://example.com']));
  });
  await inNewTab(page, 'Readme');
  await inNewTab(page, 'Docs.webapp');
  await expect(page.locator('.browser-stage')).toBeVisible();
  await tab(page, 'Readme').click(); // before Open answers
  await expect(page.locator('.browser-stage')).toHaveCount(0);
  await expect.poll(() => views(page).then((v) => v.length)).toBe(1);
  await visible(page, false);
  // back on the tab, the same view is shown
  await tab(page, 'Docs.webapp').click();
  await visible(page, true);
  expect(await opens(page)).toBe(1);
});

test('what a view says before Open answers is not lost', async ({ page, cloud }) => {
  skipOnWeb('webapp.embedded', 'the browser has no native view to put a page in');
  await open(page, cloud, { 'Docs.webapp': APP });
  await page.evaluate(() => {
    (window as unknown as MockWindow).__mock.webview.eventsBeforeOpenReply = [
      [
        'webview:load-error',
        {
          url: 'https://example.com/docs',
          message: 'The certificate is not trusted',
          code: -1202,
          certificate: true,
        },
      ],
    ];
  });
  await tree(page, 'Docs.webapp').click();
  await page.getByRole('button', { name: 'Open here' }).click();
  await expect(page.getByRole('alert')).toContainText('The certificate of the site is not valid');
  await visible(page, false);
});

test('closing the vault ends the views, and the core says so', async ({ page, cloud }) => {
  skipOnWeb('webapp.embedded', 'the browser has no native view to put a page in');
  await open(page, cloud, { 'Docs.webapp': APP });
  await showApp(page);
  await visible(page, true);
  await command(page, 'Close vault');
  await expect(page.getByRole('button', { name: 'Open folder as vault' })).toBeVisible();
  await expect.poll(() => views(page).then((v) => v.length)).toBe(0);
  // the vault was closed, and so was its view: nothing is asked of a view of a vault that is gone
  await page.waitForTimeout(300);
  expect((await asked(page)).filter((l) => l.startsWith('Open ')).length).toBe(1);
});

test('the keys of the application are reserved, and the core hands them back', async ({
  page,
  cloud,
}) => {
  skipOnWeb('webapp.embedded', 'the browser has no native view to put a page in');
  await open(page, cloud, { 'Docs.webapp': APP });
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as MockWindow).__mock.webview.reserved.length),
    )
    .toBeGreaterThan(10);
  const reserved = await page.evaluate(
    () => (window as unknown as MockWindow).__mock.webview.reserved,
  );
  expect(reserved).toEqual(expect.arrayContaining([expect.stringMatching(/^(cmd|ctrl)\+p$/)]));
  // the keys of the editors stay with the page
  expect(reserved).not.toContain('cmd+b');
  expect(reserved).not.toContain('ctrl+b');
  await showApp(page);
  const accelerator = reserved.find((a) => /^(cmd|ctrl)\+p$/.test(a)) as string;
  await page.evaluate((a) => {
    const m = (window as unknown as MockWindow).__mock;
    const v = [...m.webview.views.values()][0] as MockView;
    m.emit('webview:key', { viewId: v.id, vaultId: '', accelerator: a });
  }, accelerator);
  await expect(page.getByPlaceholder('Type a command…')).toBeVisible();
});

test('the bar navigates the page, and shows what the page says as text', async ({
  page,
  cloud,
}) => {
  skipOnWeb('webapp.embedded', 'the browser has no native view to put a page in');
  await open(page, cloud, { 'Docs.webapp': APP });
  await showApp(page);
  const send = (name: string, payload: Record<string, unknown>) =>
    page.evaluate(
      ([n, p]) => {
        const m = (window as unknown as MockWindow).__mock;
        const v = [...m.webview.views.values()][0] as MockView;
        m.emit(n, { viewId: v.id, vaultId: '', ...(p as object) });
      },
      [name, payload] as const,
    );
  // vaultId: the real one, read from the mock
  const vaultId = await openVaultId(page);
  const state = (extra: Record<string, unknown>) =>
    send('webview:state', {
      vaultId,
      url: 'https://example.com/docs/page-2',
      title: '<img src=x onerror="window.__pwned=1">',
      loading: false,
      canGoBack: true,
      canGoForward: false,
      ...extra,
    });
  await state({});
  await expect(page.locator('.browser-url')).toHaveText('https://example.com/docs/page-2');
  await page.getByRole('button', { name: 'Back' }).click();
  await expect.poll(async () => (await asked(page)).some((l) => l.startsWith('Back '))).toBe(true);
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect
    .poll(async () => (await asked(page)).some((l) => l.startsWith('Reload ')))
    .toBe(true);
  await send('webview:blocked', {
    vaultId,
    url: 'file:///etc/passwd',
    reason: 'scheme',
    mainFrame: true,
  });
  await send('webview:download', { vaultId, url: 'https://example.com/<b>x</b>.zip' });
  await send('webview:permission', { vaultId, permission: 'camera', origin: ORIGIN });
  const notices = page.getByRole('list', { name: 'Messages of the page' });
  await expect(notices).toContainText('A navigation was blocked: file:///etc/passwd');
  await expect(notices).toContainText('<b>x</b>.zip');
  await expect(notices).toContainText('asked for the permission “camera”: denied');
  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
  ).toBeUndefined();
  await expect(page.locator('.browser-view img, .browser-view b')).toHaveCount(0);
});

test('a refused certificate has no way around it', async ({ page, cloud }) => {
  skipOnWeb('webapp.embedded', 'the browser has no native view to put a page in');
  await open(page, cloud, { 'Docs.webapp': APP });
  await showApp(page);
  const vaultId = await openVaultId(page);
  await page.evaluate((vid) => {
    const m = (window as unknown as MockWindow).__mock;
    const v = [...m.webview.views.values()][0] as MockView;
    m.emit('webview:load-error', {
      viewId: v.id,
      vaultId: vid,
      url: 'https://example.com/docs',
      message: 'The certificate is not trusted',
      code: -1202,
      certificate: true,
    });
  }, vaultId);
  const card = page.getByRole('alert');
  await expect(card).toContainText('The certificate of the site is not valid');
  await expect(card.getByRole('button')).toHaveText(['Open in the browser', 'Try again']);
  await visible(page, false);
  await card.getByRole('button', { name: 'Try again' }).click();
  await visible(page, true);
});

test('clearing the data of the applications closes the views and asks about the origins again', async ({
  page,
  cloud,
}) => {
  skipOnWeb('webapp.embedded', 'the browser has no native view to put a page in');
  await open(page, cloud, { 'Docs.webapp': APP });
  await showApp(page);
  await command(page, 'Clear the data of the applications');
  const dialog = page.getByRole('dialog', { name: 'Clear the data of the applications' });
  await expect(dialog).toContainText('stored on this device');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(
    await page.evaluate(() => (window as unknown as MockWindow).__mock.webview.cleared),
  ).toEqual([]);
  await command(page, 'Clear the data of the applications');
  await page.getByRole('dialog').getByRole('button', { name: 'Clear data' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as MockWindow).__mock.webview.cleared.length),
    )
    .toBe(1);
  // the view ended, and the origin is asked about again
  await expect(page.getByRole('button', { name: 'Open here' })).toBeVisible();
  await expect.poll(() => views(page).then((v) => v.length)).toBe(0);
  await page.getByRole('button', { name: 'Open here' }).click();
  await expect.poll(() => views(page).then((v) => v.length)).toBe(1);
});

test('the address is changed from the bar, and the view follows the file', async ({
  page,
  cloud,
}) => {
  skipOnWeb('webapp.embedded', 'the browser has no native view to put a page in');
  await open(page, cloud, { 'Docs.webapp': APP });
  await showApp(page);
  await page.getByRole('button', { name: 'Change address' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change the address' });
  await expect(dialog.getByLabel('Address')).toHaveValue('https://example.com/docs');
  await dialog.getByLabel('Address').fill('https://example.com/other');
  await dialog.getByRole('button', { name: 'OK' }).click();
  // the origin is the same: no new question, the view goes to the new address
  await expect
    .poll(async () => (await asked(page)).some((l) => l.endsWith(' https://example.com/other')))
    .toBe(true);
  expect(await opens(page)).toBe(1);
});

test('nothing is requested outside the origin of the application, and no frame is ever created', async ({
  page,
  cloud,
}) => {
  const outside: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol.startsWith('http') && u.origin !== appOrigin()) outside.push(r.url());
  });
  await open(page, cloud, { 'Docs.webapp': APP });
  await page.locator('nav.ribbon').getByRole('button', { name: 'New application' }).click();
  const dialog = page.getByRole('dialog', { name: 'New application' });
  await dialog.getByLabel('Address').fill('https://tracker.example/pixel');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(tab(page, 'tracker.example.webapp')).toBeVisible();
  await tree(page, 'Docs.webapp').click();
  if (!onWeb()) await page.getByRole('button', { name: 'Open here' }).click();
  await page.waitForTimeout(500);
  expect(outside).toEqual([]);
  await expect(page.locator('iframe')).toHaveCount(0);
});
