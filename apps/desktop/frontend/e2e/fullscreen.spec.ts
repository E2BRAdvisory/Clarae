import { expect, test } from './support';
import { openDrawing, scene, shape } from './drawingHelpers';

test('a presenting drawing covers the whole window', async ({ page }) => {
  await openDrawing(page, scene([shape('a', 0, 0, 100, 60)]));
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  const box = await page.locator('.drawing-canvas.presenting').boundingBox();
  const vp = page.viewportSize()!;
  expect(box).toMatchObject({ x: 0, y: 0, width: vp.width, height: vp.height });
});
