import { expect, openVault, test } from './support';

// The slide of the full-screen Marp presentation fills the screen on one axis and is centered on the
// other, whatever the engine. In WebKit (WKWebView, Safari) the text of a slide stays in a corner at
// its natural size unless Marp's SVG polyfill is applied (WebKit bug 23113): this spec also runs
// there (the `webkit` project of playwright.config.ts, `E2E_WEBKIT=1`). With an interface zoom other
// than 100% (appearance settings: `zoom` on the root element) the presentation is still at actual size.

const DECK = '---\nmarp: true\ntheme: gaia\npaginate: true\n---\n\n# Kick-off\n\n---\n\n## Plan\n';

const TOLERANCE = 2;

for (const { zoom, ...size } of [
  { width: 1000, height: 800, zoom: 1 }, // wider than tall: the slide touches the sides, bars above and below
  { width: 1600, height: 600, zoom: 1 }, // the other way round: the slide touches top and bottom
  { width: 1000, height: 800, zoom: 1.5 }, // the interface zoom does not apply to the presentation
  { width: 1600, height: 600, zoom: 0.8 },
]) {
  test(`the current slide fills the screen and is centered at ${size.width}x${size.height}, interface zoom ${zoom * 100}%`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await openVault(page, { 'Kickoff.marp': DECK });
    // What applyAppearance does with the zoom of the appearance settings.
    const rootZoom = (): Promise<string> =>
      page.evaluate(() => getComputedStyle(document.documentElement).zoom);
    await page.evaluate((z) => document.documentElement.style.setProperty('zoom', String(z)), zoom);
    expect(Number(await rootZoom())).toBeCloseTo(zoom);
    await page.locator('.tree .node', { hasText: 'Kickoff' }).click();
    await expect(page.locator('.note-view .cm-content')).toContainText('# Kick-off');
    await page.getByRole('button', { name: 'Toggle right sidebar' }).click();
    await page.getByRole('tab', { name: 'Slides' }).click();
    await page.getByRole('button', { name: 'Start presentation' }).click();
    const show = page.locator('.marp-show');
    await expect(show).toBeVisible();
    const section = show.locator('div.marpit > svg.current section');
    await expect(section).toBeVisible();
    await expect(section).toContainText('Kick-off');

    const box = async (): Promise<{ x: number; y: number; w: number; h: number }> =>
      section.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      });
    const near = (a: number, b: number): boolean => Math.abs(a - b) <= TOLERANCE;
    // WebKit applies the polyfill on the next frames: wait for the slide to settle.
    await expect
      .poll(async () => {
        const b = await box();
        const fillsWidth = near(b.w, size.width);
        const fillsHeight = near(b.h, size.height);
        const centeredX = near(b.x + b.w / 2, size.width / 2);
        const centeredY = near(b.y + b.h / 2, size.height / 2);
        return (
          (fillsWidth || fillsHeight) &&
          centeredX &&
          centeredY &&
          b.w <= size.width + TOLERANCE &&
          b.h <= size.height + TOLERANCE
        );
      })
      .toBe(true);
    // The proportions of the slide (16:9) are kept.
    const b = await box();
    expect(Math.abs(b.w / b.h - 16 / 9)).toBeLessThan(0.02);
    expect(Number(await rootZoom())).toBe(1);
    // Ending the show gives the interface its zoom back.
    // (with the button: headless WebKit keeps Escape for its own full screen)
    await show.getByRole('button', { name: 'End presentation' }).click();
    await expect(show).toBeHidden();
    expect(Number(await rootZoom())).toBeCloseTo(zoom);
  });
}
