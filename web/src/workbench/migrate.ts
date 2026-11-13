/**
 * Moves a folder of the browser's Origin Private File System to a new name, so that an interruption
 * (a closed tab, a crash, a full disk) can never leave two copies that disagree and never loses the
 * original. The workbench uses it to take the storage a 1.x profile holds under the old names to
 * the names of 1.5 (storage.ts migrateAccountStorage); it runs on the workbench page, under the
 * workbench Web Locks, before the core starts, so nothing holds the files.
 *
 * Browsers that can move a folder (`FileSystemHandle.move`) do it in one step. The others get a
 * copy: the destination is built next to the source, compared with it, declared complete by a
 * marker file written last, and only then is the source removed. Two marker files, siblings of the
 * destination in its parent folder, say where an interrupted run stopped:
 *
 *   <to>.migrating   written before the first byte is copied
 *   <to>.migrated    written after the copy was verified; from here the destination is the truth
 *
 * and the next run, given a source that is still there, decides from them:
 *
 *   no destination                      copy
 *   destination, `.migrated`            the copy is complete: remove the source (finish)
 *   destination, `.migrating` only      an unfinished copy: remove it and copy again
 *   destination, no marker              a storage of its own (it was created, not migrated): both
 *                                       stay as they are and the destination is used, as
 *                                       adoptLegacyCopies does ("kept")
 *
 * A source that is gone means the move happened (the markers, if any are left, are removed).
 */

export type Dir = FileSystemDirectoryHandle & {
  entries(): AsyncIterable<[string, FileSystemHandle]>;
  move?(parent: FileSystemDirectoryHandle, name: string): Promise<void>;
};

type WritableHandle = FileSystemFileHandle & {
  createWritable?(): Promise<{
    write(data: Blob | string): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
  }>;
};

export type MoveOutcome =
  /** The source is not there (nothing to do, or already moved). */
  | 'none'
  /** Moved or copied now. */
  | 'moved'
  /** An earlier run had copied it completely: the source is removed now. */
  | 'finished'
  /** The destination is a storage of its own: neither was touched. */
  | 'kept';

const errName = (e: unknown): string => (e as { name?: string }).name ?? '';

/** A folder of `parent`, or null when there is none (or a file of that name). */
export async function childDir(parent: Dir, name: string): Promise<Dir | null> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch (e) {
    if (errName(e) === 'NotFoundError' || errName(e) === 'TypeMismatchError') return null;
    throw e;
  }
}

async function fileExists(parent: Dir, name: string): Promise<boolean> {
  try {
    await parent.getFileHandle(name);
    return true;
  } catch (e) {
    if (errName(e) === 'NotFoundError' || errName(e) === 'TypeMismatchError') return false;
    throw e;
  }
}

async function writeText(parent: Dir, name: string, text: string): Promise<void> {
  const f = (await parent.getFileHandle(name, { create: true })) as WritableHandle;
  if (!f.createWritable) throw new Error('this browser cannot write files from the page');
  const w = await f.createWritable();
  await w.write(text);
  await w.close();
}

async function dropEntry(parent: Dir, name: string, recursive = false): Promise<void> {
  try {
    await parent.removeEntry(name, { recursive });
  } catch (e) {
    if (errName(e) !== 'NotFoundError') throw e;
  }
}

async function copyTree(from: Dir, to: Dir): Promise<void> {
  for await (const [name, h] of from.entries()) {
    if (h.kind === 'directory') {
      await copyTree(h as Dir, await to.getDirectoryHandle(name, { create: true }));
      continue;
    }
    const file = await (h as FileSystemFileHandle).getFile();
    const out = (await to.getFileHandle(name, { create: true })) as WritableHandle;
    if (!out.createWritable) throw new Error('this browser cannot write files from the page');
    const w = await out.createWritable();
    try {
      await w.write(file);
      await w.close();
    } catch (e) {
      await w.abort?.().catch(() => undefined);
      throw e;
    }
  }
}

/** Whether two folders hold the same names, kinds and file sizes, all the way down. */
export async function sameTree(a: Dir, b: Dir): Promise<boolean> {
  const seen = new Set<string>();
  for await (const [name, h] of a.entries()) {
    seen.add(name);
    if (h.kind === 'directory') {
      const other = await childDir(b, name);
      if (!other || !(await sameTree(h as Dir, other))) return false;
      continue;
    }
    let other: File;
    try {
      other = await (await b.getFileHandle(name)).getFile();
    } catch {
      return false;
    }
    if ((await (h as FileSystemFileHandle).getFile()).size !== other.size) return false;
  }
  for await (const [name] of b.entries()) if (!seen.has(name)) return false;
  return true;
}

/**
 * Moves the folder `fromName` of `fromParent` to `toName` of `toParent` (see the module comment).
 * Rejects when it cannot finish (a full disk, a folder held by another tab); the source is then
 * intact and the next call resumes.
 */
export async function moveFolder(
  fromParent: Dir,
  fromName: string,
  toParent: Dir,
  toName: string,
): Promise<MoveOutcome> {
  const migrating = `${toName}.migrating`;
  const migrated = `${toName}.migrated`;
  const src = await childDir(fromParent, fromName);
  if (!src) {
    // Moved by an earlier run that stopped before it cleaned up its markers.
    await dropEntry(toParent, migrated);
    await dropEntry(toParent, migrating);
    return 'none';
  }
  const dst = await childDir(toParent, toName);
  if (dst) {
    if (await fileExists(toParent, migrated)) {
      await dropEntry(fromParent, fromName, true);
      await dropEntry(toParent, migrated);
      await dropEntry(toParent, migrating);
      return 'finished';
    }
    if (!(await fileExists(toParent, migrating))) return 'kept';
    await dropEntry(toParent, toName, true); // an unfinished copy
  }

  await writeText(toParent, migrating, '');
  if (typeof src.move === 'function') {
    try {
      await src.move(toParent, toName);
      await dropEntry(toParent, migrating);
      return 'moved';
    } catch {
      // Not supported for folders here, or refused: nothing was moved (it is atomic). Copy instead.
      await dropEntry(toParent, toName, true).catch(() => undefined);
    }
  }
  const out = (await toParent.getDirectoryHandle(toName, { create: true })) as Dir;
  await copyTree(src, out);
  if (!(await sameTree(src, out))) throw new Error(`the copy of ${fromName} does not match it`);
  await writeText(toParent, migrated, '');
  await dropEntry(fromParent, fromName, true);
  await dropEntry(toParent, migrated);
  await dropEntry(toParent, migrating);
  return 'moved';
}

/** Removes the marker files of a move to `toName` (when its destination is removed with the rest). */
export async function dropMoveMarkers(toParent: Dir, toName: string): Promise<void> {
  await dropEntry(toParent, `${toName}.migrated`);
  await dropEntry(toParent, `${toName}.migrating`);
}
