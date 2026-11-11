// What jsdom lacks and the views of Crepe need: an IntersectionObserver (the code block view) and the
// layout of a Range (the virtual cursor, on every selection change). Found by the A-W0 spike; nothing
// else was needed. Installed by test/setup.ts for every test, and by the headless editor.
export function installDomShims(): void {
  const g = globalThis as Record<string, unknown>;
  g['IntersectionObserver'] ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
    const rect = {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON() {},
    };
    Range.prototype.getClientRects = () => ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: [][Symbol.iterator],
    });
    Range.prototype.getBoundingClientRect = () => rect;
  }
}
