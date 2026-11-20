import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, onWeb, openVault, skipOnWeb, test } from './support';

// The integrated terminal (M23, ADR-0064) on the Wails mock: the panel, its tabs, where it sits, the
// keys, a vault that is read-only, and the move to the separate window and back. The mock's shell echoes
// what is written (apps/desktop/internal/terminal is covered by the Go tests); xterm is the real one.
// The browser cannot start processes, so the workbench has no terminal there (registry exception).

interface MockTerminalSession {
  id: string;
  vaultId: string;
  cwd: string;
  seq: number;
  cols: number;
  rows: number;
}
interface MockWindow {
  __mock: {
    emit(name: string, payload: unknown): void;
    vaults: Map<string, { info: { id: string } }>;
    sync: { links: Map<string, Record<string, unknown>> };
    terminal: {
      mode: string;
      log: string[];
      sessions: Map<string, MockTerminalSession>;
      output(id: string, data: string): void;
      exit(id: string, code: number, reason: string): void;
      layout(mode: string): void;
    };
  };
}

const terminalButton = (page: Page) => page.getByRole('button', { name: /^Terminal/ });
const dock = (page: Page) => page.locator('.terminal-dock');
const tabs = (page: Page) => page.locator('.terminal-tab [role="tab"]');
/** What the front tab's screen shows (xterm's DOM renderer writes the rows as text). */
const screen = (page: Page) => page.locator('.terminal-view:not([hidden]) .xterm-rows');
const log = (page: Page) =>
  page.evaluate(() => (window as unknown as MockWindow).__mock.terminal.log);

/** Makes the vault in front read-only for the user, as a share lowered to viewer does. */
async function makeReadOnly(page: Page): Promise<string> {
  return page.evaluate(() => {
    const m = (window as unknown as MockWindow).__mock;
    const id = [...m.vaults.values()][0]!.info.id;
    m.sync.links.set(id, { ...(m.sync.links.get(id) ?? {}), linked: true, readOnly: true });
    m.emit('sync:status', { vaultId: id, phase: 'idle', lastSync: '', pending: 0, conflicts: 0 });
    return id;
  });
}

test.describe('on the desktop', () => {
  skipOnWeb('terminal', 'the browser cannot start processes: the workbench has no terminal');

  test('opens from the ribbon below the editor, with a shell; + adds a tab, × closes it, the last one closes the panel', async ({
    page,
  }) => {
    await openVault(page);
    await expect(terminalButton(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(dock(page)).toHaveCount(0);

    await terminalButton(page).click();
    await expect(terminalButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(dock(page)).toBeVisible();
    await expect(tabs(page)).toHaveCount(1);
    await expect(screen(page)).toContainText('$');
    // below the workspace, spanning its width
    const work = (await page.locator('.workspace').boundingBox())!;
    const panel = (await dock(page).boundingBox())!;
    expect(panel.y).toBeGreaterThanOrEqual(work.y + work.height - 1);

    // the screen takes the keyboard: what is typed reaches the shell and is echoed
    await page.keyboard.type('ls');
    await expect(screen(page)).toContainText('ls');
    await page.keyboard.press('Enter');
    expect(await log(page)).toEqual(
      expect.arrayContaining(['Write term-1 "l"', 'Write term-1 "s"']),
    );

    await page.getByRole('button', { name: 'New terminal' }).click();
    await expect(tabs(page)).toHaveCount(2);
    const closes = page.locator('.terminal-tab .close');
    await closes.last().click();
    await expect(tabs(page)).toHaveCount(1);
    await closes.first().click();
    await expect(dock(page)).toBeHidden();
    await expect(terminalButton(page)).toHaveAttribute('aria-pressed', 'false');
    expect(await log(page)).toEqual(expect.arrayContaining(['Close term-1', 'Close term-2']));
  });

  test('hides and shows again with its tabs and what they showed', async ({ page }) => {
    await openVault(page);
    await terminalButton(page).click();
    await expect(screen(page)).toContainText('$'); // the screen exists and has the keyboard
    await page.keyboard.type('echo hi');
    await expect(screen(page)).toContainText('echo hi');
    await terminalButton(page).click();
    await expect(dock(page)).toBeHidden();
    await expect(terminalButton(page)).toHaveAttribute('aria-pressed', 'false');
    await terminalButton(page).click();
    await expect(dock(page)).toBeVisible();
    await expect(tabs(page)).toHaveCount(1); // no second shell
    await expect(screen(page)).toContainText('echo hi');
    expect((await log(page)).filter((l) => l.startsWith('Open'))).toHaveLength(1);
  });

  test('a position chosen in the tab bar stays after a reload, and the splitter changes the size', async ({
    page,
  }) => {
    await openVault(page);
    await terminalButton(page).click();
    await page.getByRole('combobox', { name: 'Position of the terminal' }).selectOption('left');
    const work = (await page.locator('.workspace').boundingBox())!;
    const panel = (await dock(page).boundingBox())!;
    expect(panel.x + panel.width).toBeLessThanOrEqual(work.x + 1);

    const before = (await dock(page).boundingBox())!.width;
    const sep = page.getByRole('separator', { name: 'Resize the terminal' });
    await sep.focus();
    await page.keyboard.press('Shift+ArrowRight');
    expect((await dock(page).boundingBox())!.width).toBeGreaterThan(before);
    const box = (await sep.boundingBox())!;
    const grown = (await dock(page).boundingBox())!.width;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    expect((await dock(page).boundingBox())!.width).toBeGreaterThan(grown + 40);

    const stored = await page.evaluate(() => localStorage.getItem('clarae.terminal.dock'));
    expect(JSON.parse(stored ?? '{}')).toMatchObject({ position: 'left' });

    await page.reload();
    await page.getByRole('button', { name: 'Open folder as vault' }).click();
    await terminalButton(page).click();
    await expect(page.locator('.terminal-layout')).toHaveClass(/left/);
    await expect(page.getByRole('combobox', { name: 'Position of the terminal' })).toHaveValue(
      'left',
    );
  });

  test('Ctrl+` shows and hides the terminal, Ctrl+Shift+` opens a tab even with the panel closed', async ({
    page,
  }) => {
    await openVault(page);
    await page.keyboard.press('Control+Backquote');
    await expect(dock(page)).toBeVisible();
    await expect(tabs(page)).toHaveCount(1);
    // the key works from inside the terminal too: it is the application's, not the shell's
    await page.keyboard.press('Control+Backquote');
    await expect(dock(page)).toBeHidden();
    await page.keyboard.press('Control+Shift+Backquote');
    await expect(dock(page)).toBeVisible();
    await expect(tabs(page)).toHaveCount(2);
    // another Ctrl key is the shell's: Ctrl+R goes to it and opens nothing of the application
    await page.keyboard.press('Control+r');
    await expect.poll(async () => (await log(page)).some((l) => l.includes('\\u0012'))).toBe(true);
  });

  test('a vault that is read-only keeps the button and + off, and a session of it ends with a notice', async ({
    page,
  }) => {
    await openVault(page);
    await terminalButton(page).click();
    await expect(tabs(page)).toHaveCount(1);
    const id = await makeReadOnly(page);
    await page.evaluate((vaultId) => {
      const m = (window as unknown as MockWindow).__mock;
      for (const s of m.terminal.sessions.values())
        if (s.vaultId === vaultId) m.terminal.exit(s.id, 129, 'read-only');
    }, id);
    await expect(
      page.getByText('The vault became read-only: the session was closed.'),
    ).toBeVisible();
    await expect(tabs(page)).toHaveCount(1); // stays until it is closed
    const plus = page.getByRole('button', { name: 'New terminal' });
    await expect(plus).toBeDisabled();
    await expect(plus).toHaveAttribute('title', /read-only/);
    await page.locator('.terminal-tab .close').click();
    await expect(dock(page)).toBeHidden();
    const button = page.getByRole('button', { name: /^Terminal: this vault is read-only/ });
    await expect(button).toBeDisabled();
    await page.keyboard.press('Control+Backquote');
    await expect(dock(page)).toBeHidden();
  });

  test('moves to the window of its own and back, and the screen is redrawn from the snapshot', async ({
    page,
  }) => {
    await openVault(page);
    await terminalButton(page).click();
    await expect(screen(page)).toContainText('$');
    await page.keyboard.type('one');
    await expect(screen(page)).toContainText('one');

    await page.getByRole('button', { name: 'Undock terminal' }).click();
    await expect(dock(page)).toBeHidden();
    await expect(terminalButton(page)).toHaveAttribute('aria-pressed', 'true'); // it is open, elsewhere
    expect(await log(page)).toContain('Undock');
    // the other window shows output meanwhile; this page ignores it
    await page.evaluate(() => {
      const t = (window as unknown as MockWindow).__mock.terminal;
      t.output([...t.sessions.keys()][0]!, '\r\nwhile away');
    });
    // from the main window the terminal's button brings the window forward, it does not start another shell
    await terminalButton(page).click();
    expect((await log(page)).filter((l) => l === 'Undock')).toHaveLength(2);
    expect((await log(page)).filter((l) => l.startsWith('Open'))).toHaveLength(1);

    // the core says the panel is back: the tabs are listed again and each redrawn from its snapshot
    await page.evaluate(() => (window as unknown as MockWindow).__mock.terminal.layout('docked'));
    await expect(dock(page)).toBeVisible();
    await expect(tabs(page)).toHaveCount(1);
    await expect(screen(page)).toContainText('one');
    await expect(screen(page)).toContainText('while away');
    const text = (await screen(page).innerText()).replace(/\s+/g, ' ');
    expect(text.split('while away')).toHaveLength(2); // once
    expect(await log(page)).toEqual(expect.arrayContaining(['List', 'Snapshot term-1']));
    // and it takes the size of the panel again
    expect((await log(page)).some((l) => /^Resize term-1 \d+x\d+$/.test(l))).toBe(true);
    await expect(terminalButton(page)).toHaveAttribute('aria-pressed', 'true');
  });

  test('the page of the separate window shows the sessions of the core and docks back', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as { __CLARAE_TERMINAL__: unknown }).__CLARAE_TERMINAL__ = {
        mode: 'detached',
        sessions: [
          {
            id: 'term-7',
            vaultId: 'vault-7',
            cwd: '/work/notes',
            title: 'notes',
            output: 'hello from the shell\r\n',
          },
          { id: 'term-8', vaultId: '', cwd: '/home/mock', title: 'mock' },
        ],
      };
    });
    await page.goto('/terminal.html');
    await expect(page.locator('.terminal-window')).toBeVisible();
    await expect(page).toHaveTitle('Clarae notanda — Terminal');
    await expect(tabs(page)).toHaveCount(2);
    await expect(page.getByRole('combobox')).toHaveCount(0); // no position here
    await page.getByRole('tab', { name: 'notes' }).click();
    await expect(screen(page)).toContainText('hello from the shell');
    // a new tab opens in the vault of the front tab
    await page.getByRole('button', { name: 'New terminal' }).click();
    await expect(tabs(page)).toHaveCount(3);
    expect((await log(page)).some((l) => l.startsWith('Open vault-7 '))).toBe(true);
    // a locked vault covers its tabs: nothing is shown, the processes go on
    await page.getByRole('tab', { name: 'notes' }).click();
    await page.evaluate(() => {
      const m = (window as unknown as MockWindow).__mock;
      // the core says the vault is locked (SyncAPI.Info), as it is while its sync is paused too
      m.sync.links.set('vault-7', { linked: true, kind: 'private', locked: true });
      m.emit('vault:locked', { vaultId: 'vault-7', reason: 'manual', pending: 0, conflicts: 0 });
    });
    await expect(page.getByText(/This vault is locked/)).toBeVisible();
    await page.getByRole('tab', { name: 'mock' }).first().click();
    await expect(page.getByText(/This vault is locked/)).toBeHidden();

    await page.getByRole('button', { name: 'Dock to Clarae' }).click();
    await expect.poll(() => log(page)).toContain('Dock');
    await expect(tabs(page)).toHaveCount(0); // the main window has the panel now
  });

  test('the separate window docks back when its last tab closes', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __CLARAE_TERMINAL__: unknown }).__CLARAE_TERMINAL__ = {
        mode: 'detached',
        sessions: [{ id: 'term-7', cwd: '/work/notes', title: 'notes' }],
      };
    });
    await page.goto('/terminal.html');
    await expect(tabs(page)).toHaveCount(1);
    await page.locator('.terminal-tab .close').click();
    await expect.poll(() => log(page)).toEqual(expect.arrayContaining(['Close term-7', 'Dock']));
  });

  test('the font of Settings > Appearance is the terminal’s, live, and MesloLGS NF by default', async ({
    page,
  }) => {
    const family = () =>
      page.evaluate(
        () => getComputedStyle(document.querySelector('.xterm-rows') as Element).fontFamily,
      );
    await openVault(page);
    await terminalButton(page).click();
    await expect(screen(page)).toContainText('$');
    expect(await family()).toContain('MesloLGS NF');
    expect(await family()).toContain('monospace'); // the fallbacks follow it

    await page.keyboard.press('ControlOrMeta+,');
    await page.getByRole('button', { name: 'Appearance' }).click();
    const field = page.getByLabel('Terminal font', { exact: true });
    await expect(field).toHaveValue('MesloLGS NF');
    await field.fill('Fira "Code"');
    await expect.poll(family).toContain('Fira Code');
    expect(await family()).not.toContain('MesloLGS');
    // the size is measured again and told to the core
    await expect
      .poll(async () => (await log(page)).filter((l) => l.startsWith('Resize term-1')).length)
      .toBeGreaterThan(0);
    await field.fill('');
    await expect.poll(family).toContain('MesloLGS NF');
  });

  test('the font size of Settings > Appearance is the terminal’s, live, 13 by default', async ({
    page,
  }) => {
    const size = () =>
      page.evaluate(
        () => getComputedStyle(document.querySelector('.xterm-rows') as Element).fontSize,
      );
    const resizes = async () =>
      (await log(page)).filter((l) => l.startsWith('Resize term-1')).length;
    await openVault(page);
    await terminalButton(page).click();
    await expect(screen(page)).toContainText('$');
    expect(await size()).toBe('13px');

    await page.keyboard.press('ControlOrMeta+,');
    await page.getByRole('button', { name: 'Appearance' }).click();
    const field = page.getByLabel('Terminal font size');
    await expect(field).toHaveValue('13');
    const before = await resizes();
    await field.fill('20');
    await expect.poll(size).toBe('20px');
    // the cells are bigger: the columns and rows are measured again and told to the core
    await expect.poll(resizes).toBeGreaterThan(before);
    await field.fill('99'); // kept in range
    await expect.poll(size).toBe('32px');
    await field.fill('');
    await expect.poll(size).toBe('13px');
  });

  test('the panel passes the accessibility scan, light and dark', async ({ page }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.goto('/');
      await page.getByRole('button', { name: 'Open folder as vault' }).click();
      await terminalButton(page).click();
      await expect(screen(page)).toContainText('$');
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .include('.terminal-dock')
        .analyze();
      const blocking = results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => ({ rule: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
      expect(blocking, `${scheme}: ${JSON.stringify(blocking)}`).toEqual([]);
    }
  });
});

test('the workbench in the browser has no terminal: no button, and its keys do nothing', async ({
  page,
}) => {
  test.skip(!onWeb(), 'the desktop has a terminal (above)');
  await openVault(page);
  await expect(page.getByRole('button', { name: /^Terminal/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
  await page.keyboard.press('Control+Backquote');
  await page.keyboard.press('Control+Shift+Backquote');
  await expect(page.locator('.terminal-dock')).toHaveCount(0);
  await expect(page.locator('.terminal-layout')).toHaveCount(0);
});
