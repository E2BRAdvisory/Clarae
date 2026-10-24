// Minimal streaming ZIP writer (STORE method) for the browser.
//
// Entries are written with a data descriptor (general purpose bit 3) so their size and CRC-32
// do not have to be known when the local header goes out, and with UTF-8 names (bit 11).
// Archive-level ZIP64 records (end of central directory, locator, offsets in the central
// directory) are emitted when the archive passes 4 GiB or 65535 entries. A single entry is
// limited to 4 GiB - 1 (no ZIP64 data descriptors): larger entries fail with ZipLimitError
// rather than producing a corrupt archive. Limits are injectable so tests can exercise them.

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;

const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

export class ZipNameError extends Error {
  constructor(name: string, reason: string) {
    super(`invalid zip entry name ${JSON.stringify(name)}: ${reason}`);
    this.name = 'ZipNameError';
  }
}

export class ZipLimitError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ZipLimitError';
  }
}

export interface ZipLimits {
  /** Largest single entry in bytes (default 4 GiB - 1). */
  entrySize: number;
  /** Offsets at or above this use ZIP64 extra fields (default 4 GiB - 1). */
  offset: number;
  /** Entry counts at or above this switch to ZIP64 end records (default 65535). */
  entries: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  entrySize: U32_MAX,
  offset: U32_MAX,
  entries: U16_MAX,
};

export interface ZipEntry {
  /** Forward-slash relative path, validated by {@link checkZipName}. */
  name: string;
  data: Uint8Array | AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  mtime?: Date;
}

/**
 * Returns why `name` must not go into an archive, or null when it is safe to extract:
 * relative, forward slashes only, no empty/`.`/`..` segments, no control characters.
 */
export function checkZipName(name: string): string | null {
  if (name === '') return 'empty';
  if (name.startsWith('/')) return 'absolute path';
  if (name.includes('\\')) return 'backslash';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'control character';
  if (/^[A-Za-z]:/.test(name)) return 'drive letter';
  for (const seg of name.split('/')) {
    if (seg === '') return 'empty segment';
    if (seg === '.' || seg === '..') return 'dot segment';
  }
  if (new TextEncoder().encode(name).length > U16_MAX) return 'name too long';
  return null;
}

// ---- CRC-32 ------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Incremental CRC-32 (IEEE): `crc32(chunk, previous)`; start from 0. */
export function crc32(data: Uint8Array, previous = 0): number {
  let c = ~previous >>> 0;
  for (let i = 0; i < data.length; i++)
    c = (CRC_TABLE[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return ~c >>> 0;
}

// ---- helpers -------------------------------------------------------------------

/** MS-DOS date/time of a local-time Date; years before 1980 clamp to 1980-01-01. */
export function dosDateTime(d: Date): { time: number; date: number } {
  const year = d.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.min(year, 2107) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

class Out {
  private parts: number[] = [];
  u16(v: number): this {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  u32(v: number): this {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  u64(v: number): this {
    this.u32(v % 0x100000000);
    return this.u32(Math.floor(v / 0x100000000));
  }
  bytes(b: Uint8Array): this {
    for (const x of b) this.parts.push(x);
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

interface Central {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

function isAsync(x: unknown): x is AsyncIterable<Uint8Array> {
  return typeof x === 'object' && x !== null && Symbol.asyncIterator in x;
}

/**
 * Lazily serializes the entries into ZIP chunks. Pulling drives the entry producer, so memory
 * stays bounded by one entry (plus whatever the producer buffers).
 */
export async function* zipChunks(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
  limits: Partial<ZipLimits> = {},
): AsyncGenerator<Uint8Array, void> {
  const lim = { ...DEFAULT_ZIP_LIMITS, ...limits };
  const central: Central[] = [];
  let offset = 0;

  for await (const entry of entries) {
    const problem = checkZipName(entry.name);
    if (problem) throw new ZipNameError(entry.name, problem);
    const name = new TextEncoder().encode(entry.name);
    const { time, date } = dosDateTime(entry.mtime ?? new Date());
    const startOffset = offset;

    const header = new Out()
      .u32(SIG_LOCAL)
      .u16(20)
      .u16(FLAG_DESCRIPTOR | FLAG_UTF8)
      .u16(0) // STORE
      .u16(time)
      .u16(date)
      .u32(0) // crc, size and compressed size follow in the descriptor
      .u32(0)
      .u32(0)
      .u16(name.length)
      .u16(0)
      .bytes(name)
      .done();
    yield header;
    offset += header.length;

    let crc = 0;
    let size = 0;
    const pieces = isAsync(entry.data)
      ? entry.data
      : entry.data instanceof Uint8Array
        ? [entry.data]
        : entry.data;
    for await (const piece of pieces) {
      size += piece.length;
      if (size > lim.entrySize)
        throw new ZipLimitError(`entry ${JSON.stringify(entry.name)} exceeds the supported size`);
      crc = crc32(piece, crc);
      yield piece;
    }
    offset += size;

    const descriptor = new Out().u32(SIG_DESCRIPTOR).u32(crc).u32(size).u32(size).done();
    yield descriptor;
    offset += descriptor.length;
    central.push({ name, crc, size, offset: startOffset, time, date });
  }

  // ---- central directory ----
  const cdStart = offset;
  let cdSize = 0;
  for (const e of central) {
    const big = e.offset >= lim.offset;
    const extra = big ? new Out().u16(0x0001).u16(8).u64(e.offset).done() : new Uint8Array(0);
    const rec = new Out()
      .u32(SIG_CENTRAL)
      .u16((3 << 8) | 45) // made by: Unix, 4.5
      .u16(big ? 45 : 20)
      .u16(FLAG_DESCRIPTOR | FLAG_UTF8)
      .u16(0)
      .u16(e.time)
      .u16(e.date)
      .u32(e.crc)
      .u32(e.size)
      .u32(e.size)
      .u16(e.name.length)
      .u16(extra.length)
      .u16(0) // comment
      .u16(0) // disk
      .u16(0) // internal attrs
      .u32(((0o100644 << 16) | 0) >>> 0) // external attrs: regular file 0644
      .u32(big ? U32_MAX : e.offset)
      .bytes(e.name)
      .bytes(extra)
      .done();
    yield rec;
    cdSize += rec.length;
  }
  offset += cdSize;

  const count = central.length;
  const zip64 = count >= lim.entries || cdStart >= lim.offset || cdSize >= lim.offset;
  if (zip64) {
    const eocd64Offset = offset;
    const tail = new Out()
      .u32(SIG_EOCD64)
      .u64(44)
      .u16((3 << 8) | 45)
      .u16(45)
      .u32(0)
      .u32(0)
      .u64(count)
      .u64(count)
      .u64(cdSize)
      .u64(cdStart)
      .u32(SIG_LOCATOR64)
      .u32(0)
      .u64(eocd64Offset)
      .u32(1)
      .done();
    yield tail;
  }
  yield new Out()
    .u32(SIG_EOCD)
    .u16(0)
    .u16(0)
    .u16(zip64 ? U16_MAX : count)
    .u16(zip64 ? U16_MAX : count)
    .u32(zip64 ? U32_MAX : cdSize)
    .u32(zip64 ? U32_MAX : cdStart)
    .u16(0)
    .done();
}

/**
 * ZIP archive as a pull-based stream: nothing is produced until the consumer reads, and
 * cancelling the stream stops the entry producer. A failing producer errors the stream.
 */
export function zipStream(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
  limits: Partial<ZipLimits> = {},
): ReadableStream<Uint8Array> {
  const it = zipChunks(entries, limits);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const r = await it.next();
        if (r.done) controller.close();
        else controller.enqueue(r.value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await it.return(undefined);
    },
  });
}
