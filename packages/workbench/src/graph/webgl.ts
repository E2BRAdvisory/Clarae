// What the 3D graph needs from the device: WebGL2, and one of the few contexts a page may hold
// (browsers drop the oldest beyond about sixteen, and each one takes GPU memory).
let supported: boolean | undefined;

/** Whether this device draws WebGL2 (asked once: the answer does not change in a session). */
export function webgl2Available(): boolean {
  if (supported === undefined) {
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      supported = !!gl;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      supported = false;
    }
  }
  return supported;
}

/** 3D graphs alive at once; the next one is drawn in 2D. */
export const MAX_3D_SURFACES = 4;
let live = 0;

/** Takes one of the 3D slots; the function returned gives it back. Null when all are taken. */
export function acquire3D(): (() => void) | null {
  if (live >= MAX_3D_SURFACES) return null;
  live++;
  let held = true;
  return () => {
    if (held) live--;
    held = false;
  };
}
