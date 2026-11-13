/**
 * The names the browser workbench used up to 1.4 (before the rebrand, ADR-0052) for what it keeps
 * in the browser. A profile used with 1.x holds its data under these names, and a 1.4 tab may
 * still be open during a deploy, so 1.5 reads them (migrating what it must, never writing them)
 * and speaks them on the lock and the channel a 1.4 tab listens to. This is the only place that
 * names them, apart from the unnamed set of 1.3 and earlier (storage.ts LEGACY_FS, LEGACY_SQLITE),
 * which is adopted in place and keeps its folders. Dropped in 2.0.
 *
 * Changing one of these strings makes the data of an existing profile unreachable: legacyNames.test.ts
 * pins them.
 */

/** The salt of accountKey up to 1.4: it names `accounts/<key>` in OPFS and the markers' suffix. */
export const LEGACY_ACCOUNT_SALT = 'memobrain/workbench-account';

/** The folder of the core's data inside the core's file system up to 1.4 (`<fs>/memobrain/data`). */
export const LEGACY_DATA_ROOT = 'memobrain';

/** The IndexedDB database of the device registration up to 1.4. */
export const LEGACY_DEVICE_DB = 'memobrain-device';

/** The localStorage key of the markers: `<key>@<account key>` in 1.4, bare up to 1.3. */
export const LEGACY_MARKERS_KEY = 'memobrain.workbench.vaults';

/** The Web Lock of a workbench page and the channel of the console up to 1.4. */
export const LEGACY_WORKBENCH_LOCK = 'memobrain-workbench';
export const LEGACY_WORKBENCH_CHANNEL = 'memobrain-workbench';

/** The scratch folders of the core's file system up to 1.4 (clear text of private vaults). */
export const LEGACY_SCRATCH_DIRS = ['/tmp/memobrain-downloads', '/tmp/memobrain-uploads'];

/** The localStorage keys of the console's preferences up to 1.4. */
export const LEGACY_THEME_KEY = 'memobrain.web.theme';
export const LEGACY_LANG_KEY = 'memobrain.web.lang';
