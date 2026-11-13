import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeOpfs, type FakeDir, type FakeOpfsOptions } from '../test/fakeOpfs';
import { childDir, moveFolder, sameTree, type Dir } from './migrate';

let root: FakeDir;
let options: FakeOpfsOptions;
let restore: () => void;
beforeEach(() => {
  ({ root, options, restore } = installFakeOpfs());
});
afterEach(() => restore());

const dir = (path: string): Promise<FakeDir & Dir> =>
  root.mkdir(path) as unknown as Promise<FakeDir & Dir>;
const move = async (from: string, to: string) => {
  const [fp, fn] = [from.split('/').slice(0, -1).join('/'), from.split('/').pop() as string];
  const [tp, tn] = [to.split('/').slice(0, -1).join('/'), to.split('/').pop() as string];
  return moveFolder(await dir(fp), fn, await dir(tp), tn);
};

/** A folder with a nested file, an empty folder and a file with several bytes. */
async function tree(at: string, tag = 'x') {
  await root.write(`${at}/a.txt`, `alpha ${tag}`);
  await root.write(`${at}/sub/b.txt`, `beta ${tag}`);
  await root.write(`${at}/sub/deeper/c.txt`, `héllo ${tag}`);
  await root.mkdir(`${at}/empty`);
}

describe('moveFolder', () => {
  for (const native of [true, false]) {
    describe(
      native ? 'where folders can be moved' : 'where they cannot (copy, check, remove)',
      () => {
        beforeEach(() => {
          options.move = native;
        });

        it('moves everything and leaves nothing behind, markers included', async () => {
          await tree('p/old');
          expect(await move('p/old', 'p/new')).toBe('moved');
          expect(root.has('p/old')).toBe(false);
          expect(root.read('p/new/sub/deeper/c.txt')).toBe('héllo x');
          expect(root.has('p/new/empty')).toBe(true);
          expect(root.names()).toEqual(['p']);
          expect((await dir('p')).names()).toEqual(['new']); // no `new.migrating`, no `new.migrated`
        });

        it('does nothing when there is nothing to move', async () => {
          expect(await move('p/old', 'p/new')).toBe('none');
          expect(root.has('p/new')).toBe(false);
        });

        it('is a no-op the second time', async () => {
          await tree('p/old');
          await move('p/old', 'p/new');
          expect(await move('p/old', 'p/new')).toBe('none');
          expect(root.read('p/new/a.txt')).toBe('alpha x');
        });
      },
    );
  }

  describe('after an interruption', () => {
    beforeEach(() => {
      options.move = false;
    });

    it('resumes a copy that stopped half-way, from the intact original', async () => {
      await tree('p/old');
      options.writesLeft = 3; // the marker and two files, then the disk is full
      await expect(move('p/old', 'p/new')).rejects.toThrow();
      // The original is whole; the destination is partial and marked as such.
      expect(root.read('p/old/sub/deeper/c.txt')).toBe('héllo x');
      expect(root.has('p/new')).toBe(true);
      expect(root.has('p/new.migrating')).toBe(true);
      expect(root.has('p/new.migrated')).toBe(false);

      options.writesLeft = null;
      expect(await move('p/old', 'p/new')).toBe('moved');
      expect(root.has('p/old')).toBe(false);
      expect(root.read('p/new/a.txt')).toBe('alpha x');
      expect(root.read('p/new/sub/b.txt')).toBe('beta x');
      expect(root.read('p/new/sub/deeper/c.txt')).toBe('héllo x');
      expect((await dir('p')).names()).toEqual(['new']);
    });

    it('never keeps a partial copy next to an original that changed meanwhile', async () => {
      await tree('p/old');
      options.writesLeft = 2;
      await expect(move('p/old', 'p/new')).rejects.toThrow();
      options.writesLeft = null;
      await root.write('p/old/a.txt', 'alpha edited'); // changed between the two runs
      await move('p/old', 'p/new');
      expect(root.read('p/new/a.txt')).toBe('alpha edited');
    });

    it('finishes when the copy was complete and only the removal of the original is left', async () => {
      await tree('p/old', 'old');
      await tree('p/new', 'copied'); // the verified copy, declared complete
      await root.write('p/new.migrating', '');
      await root.write('p/new.migrated', '');
      expect(await move('p/old', 'p/new')).toBe('finished');
      expect(root.has('p/old')).toBe(false);
      expect(root.read('p/new/a.txt')).toBe('alpha copied'); // not copied again
      expect((await dir('p')).names()).toEqual(['new']);
    });

    it('cleans the markers a move left when it stopped right after the original was gone', async () => {
      await tree('p/new');
      await root.write('p/new.migrating', '');
      expect(await move('p/old', 'p/new')).toBe('none');
      expect((await dir('p')).names()).toEqual(['new']);
      expect(root.read('p/new/a.txt')).toBe('alpha x');
    });

    it('fails, intact, when the original cannot be removed (held by another tab)', async () => {
      await tree('p/old');
      (await dir('p/old/sub')).hold();
      await expect(move('p/old', 'p/new')).rejects.toThrow();
      expect(root.has('p/old/a.txt')).toBe(true);
      // The copy is complete and marked: the next run finishes it once the tab is gone.
      expect(root.has('p/new.migrated')).toBe(true);
    });
  });

  it('keeps both when the destination is a storage of its own (no marker says it is a copy)', async () => {
    options.move = false;
    await tree('p/old', 'old');
    await tree('p/new', 'own');
    expect(await move('p/old', 'p/new')).toBe('kept');
    expect(root.read('p/old/a.txt')).toBe('alpha old');
    expect(root.read('p/new/a.txt')).toBe('alpha own');
  });

  it('copies byte-for-byte what it is given, files of any size', async () => {
    options.move = false;
    await root.write('p/old/big.bin', 'é'.repeat(5000));
    await root.write('p/old/zero.bin', '');
    await move('p/old', 'p/new');
    expect(root.read('p/new/big.bin')).toBe('é'.repeat(5000));
    expect(root.read('p/new/zero.bin')).toBe('');
  });
});

describe('sameTree', () => {
  const same = async (a: string, b: string): Promise<boolean> =>
    sameTree(
      (await childDir(root as unknown as Dir, a))!,
      (await childDir(root as unknown as Dir, b))!,
    );

  it('compares names, kinds and sizes all the way down', async () => {
    await tree('a');
    await tree('b');
    expect(await same('a', 'b')).toBe(true);
    await root.write('b/sub/extra.txt', '1');
    expect(await same('a', 'b')).toBe(false);
    await tree('c');
    await root.write('c/a.txt', 'a longer text'); // another size
    expect(await same('a', 'c')).toBe(false);
  });
});
