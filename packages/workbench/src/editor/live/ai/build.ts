// The build constant of the AI assistant (ADR-0050, the second gate next to the `ai` flag of the
// Config Profile). It is "1" only in a build made for it (`MEMOBRAIN_AI=1`, like `MEMOBRAIN_E2E`), and
// absent otherwise: a released build is made without it, so a profile cannot switch the function on.
// The Go core has its own constant (internal/ai buildEnabled) and refuses on its own account: this one
// only keeps the UI from asking, and the chunk from being fetched.
//
// Read lazily and guarded: a bundle whose build does not define `import.meta.env` must read "off", not
// throw.
export function aiBuild(): boolean {
  try {
    return import.meta.env.MEMOBRAIN_AI === '1';
  } catch {
    return false;
  }
}
