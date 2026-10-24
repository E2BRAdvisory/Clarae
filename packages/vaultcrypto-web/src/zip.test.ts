import { describe, expect, it } from 'vitest';
import {
  ZipLimitError,
  ZipNameError,
  checkZipName,
  crc32,
  dosDateTime,
  zipStream,
  type ZipEntry,
} from './zip';
import { collect, readZip } from './zipreader.testutil';

const te = new TextEncoder();
const b = (s: string) => te.encode(s);

// Produced by `python3 -m zipfile` semantics (zipfile.ZipFile, ZIP_STORED): validates the reader.
const PYTHON_ZIP =
  'UEsDBBQAAAAAAMVrsVgtOwivDAAAAAwAAAAOAAAAZG9jcy9oZWxsby50eHRoZWxsbyB3b3JsZApQSwMEFAAACAAAxWuxWJRWi5MEAAAABAAAABAAAABjYWZmw6gv5pel5pysLm1kIyBva1BLAwQUAAAAAADFa7FYAAAAAAAAAAAAAAAACQAAAGVtcHR5LnR4dFBLAQIUAxQAAAAAAMVrsVgtOwivDAAAAAwAAAAOAAAAAAAAAAAAAACAAQAAAABkb2NzL2hlbGxvLnR4dFBLAQIUAxQAAAgAAMVrsViUVouTBAAAAAQAAAAQAAAAAAAAAAAAAACAATgAAABjYWZmw6gv5pel5pysLm1kUEsBAhQDFAAAAAAAxWuxWAAAAAAAAAAAAAAAAAkAAAAAAAAAAAAAAIABagAAAGVtcHR5LnR4dFBLBQYAAAAAAwADALEAAACRAAAAAAA=';

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

describe('test reader (validated against a Python-made ZIP)', () => {
  it('reads a known-good archive', () => {
    const z = readZip(fromB64(PYTHON_ZIP));
    expect(z.entries.map((e) => e.name)).toEqual(['docs/hello.txt', 'caffè/日本.md', 'empty.txt']);
    expect(new TextDecoder().decode(z.entries[0]?.data)).toBe('hello world\n');
    expect(new TextDecoder().decode(z.entries[1]?.data)).toBe('# ok');
    expect(z.entries[2]?.data.length).toBe(0);
    expect((z.entries[1]?.flags ?? 0) & 0x0800).toBe(0x0800); // python sets UTF-8 for non-ASCII
  });
});

describe('crc32', () => {
  it('matches the standard check value and is incremental', () => {
    expect(crc32(b('123456789'))).toBe(0xcbf43926);
    expect(crc32(b('6789'), crc32(b('12345')))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('dosDateTime', () => {
  it('encodes local time and clamps pre-1980 dates', () => {
    const d = dosDateTime(new Date(2024, 4, 17, 13, 30, 10));
    expect(d.date).toBe(((2024 - 1980) << 9) | (5 << 5) | 17);
    expect(d.time).toBe((13 << 11) | (30 << 5) | 5);
    expect(dosDateTime(new Date(1970, 0, 1)).date).toBe((1 << 5) | 1);
  });
});

describe('checkZipName', () => {
  it.each([
    ['a.md', null],
    ['dir/sub/é日本.md', null],
    ['', 'empty'],
    ['/abs', 'absolute path'],
    ['a/../b', 'dot segment'],
    ['..', 'dot segment'],
    ['./a', 'dot segment'],
    ['a//b', 'empty segment'],
    ['a/', 'empty segment'],
    ['a\\b', 'backslash'],
    ['C:/x', 'drive letter'],
    ['a\u0000b', 'control character'],
  ])('%j -> %s', (name, want) => {
    expect(checkZipName(name)).toBe(want);
  });
});

describe('zipStream', () => {
  it('writes readable STORE entries with CRC, UTF-8 names and descriptors', async () => {
    const when = new Date(2024, 4, 17, 13, 30, 10);
    const big = new Uint8Array(100_000).map((_, i) => i % 251);
    const out = await collect(
      zipStream([
        { name: 'docs/hello.txt', data: b('hello world\n'), mtime: when },
        { name: 'caffè/日本.md', data: b('# ok'), mtime: when },
        { name: 'empty.txt', data: new Uint8Array(0), mtime: when },
        { name: 'big.bin', data: big, mtime: when },
      ]),
    );
    const z = readZip(out);
    expect(z.zip64).toBe(false);
    expect(z.entries.map((e) => e.name)).toEqual([
      'docs/hello.txt',
      'caffè/日本.md',
      'empty.txt',
      'big.bin',
    ]);
    for (const e of z.entries) {
      expect(e.method).toBe(0);
      expect(e.flags & 0x0808).toBe(0x0808);
      expect(e.dosDate).toBe(dosDateTime(when).date);
      expect(e.dosTime).toBe(dosDateTime(when).time);
    }
    expect(new TextDecoder().decode(z.entries[1]?.data)).toBe('# ok');
    expect(z.entries[3]?.data).toEqual(big);
  });

  it('accepts async chunked data and an empty archive', async () => {
    async function* chunks() {
      await Promise.resolve();
      yield b('ab');
      yield b('cd');
      yield b('ef');
    }
    const z = readZip(await collect(zipStream([{ name: 'x.txt', data: chunks() }])));
    expect(new TextDecoder().decode(z.entries[0]?.data)).toBe('abcdef');
    expect(readZip(await collect(zipStream([]))).entries).toEqual([]);
  });

  it('is pull-based and stops the producer on cancel', async () => {
    let produced = 0;
    async function* entries(): AsyncGenerator<ZipEntry> {
      await Promise.resolve();
      for (let i = 0; i < 100; i++) {
        produced++;
        yield { name: `f${i}`, data: b('x') };
      }
    }
    const reader = zipStream(entries()).getReader();
    await reader.read();
    await reader.cancel();
    expect(produced).toBeLessThan(5);
  });

  it('rejects unsafe names with an error on the stream', async () => {
    await expect(collect(zipStream([{ name: '../evil', data: b('x') }]))).rejects.toBeInstanceOf(
      ZipNameError,
    );
    await expect(
      collect(zipStream([{ name: '/etc/passwd', data: b('x') }])),
    ).rejects.toBeInstanceOf(ZipNameError);
  });

  it('fails clearly when a single entry exceeds the entry limit', async () => {
    await expect(
      collect(zipStream([{ name: 'a', data: new Uint8Array(11) }], { entrySize: 10 })),
    ).rejects.toBeInstanceOf(ZipLimitError);
  });

  it('switches to ZIP64 end records when the entry count passes the limit', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: b(`n${i}`) }));
    const z = readZip(await collect(zipStream(entries, { entries: 3 })));
    expect(z.zip64).toBe(true);
    expect(z.entries.map((e) => new TextDecoder().decode(e.data))).toEqual([
      'n0',
      'n1',
      'n2',
      'n3',
      'n4',
    ]);
    // below the limit: plain archive
    expect(readZip(await collect(zipStream(entries, { entries: 6 }))).zip64).toBe(false);
  });

  it('uses ZIP64 extra fields for offsets past the offset limit', async () => {
    const entries = Array.from({ length: 4 }, (_, i) => ({
      name: `f${i}.txt`,
      data: b('0123456789'.repeat(3)),
    }));
    // each entry takes about 40 + 30 bytes: the later ones start beyond 100
    const z = readZip(await collect(zipStream(entries, { offset: 100 })));
    expect(z.zip64).toBe(true);
    expect(z.entries.map((e) => e.zip64Extra)).toEqual([false, false, true, true]);
    expect(z.entries.every((e) => e.data.length === 30)).toBe(true);
    expect(z.entries.filter((e) => e.zip64Extra).every((e) => e.versionNeeded === 45)).toBe(true);
  });
});
