// The build constant of real-time collaboration (ADR-0050, the second gate next to the `collab` flag of
// the Config Profile). It is "1" only in a build made for it (`CLARAE_COLLAB=1`, like
// `CLARAE_E2E`), and absent otherwise: a released build is made without it, so a profile cannot
// switch the function on.
//
// Read lazily and guarded: a bundle whose build does not define `import.meta.env` must read "off", not
// throw.
export function collabBuild(): boolean {
  try {
    return import.meta.env.CLARAE_COLLAB === '1';
  } catch {
    return false;
  }
}
