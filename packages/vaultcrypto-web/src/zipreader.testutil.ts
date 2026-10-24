// Independent minimal ZIP reader for tests (central directory based, ZIP64 aware, STORE only).
// It deliberately shares no code with zip.ts, not even the CRC.

export interface ReadEntry {
  name: string;
  data: Uint8Array;
  flags: number;
  method: number;
  crc: number;
  dosTime: number;
  dosDate: number;
  zip64Extra: boolean;
  versionNeeded: number;
}

export interface ReadZip {
  entries: ReadEntry[];
  zip64: boolean;
}

function crc32Ref(b: Uint8Array): number {
  let crc = 0xffffffff;
  for (const x of b) {
    crc ^= x;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const r = stream.getReader();
  for (;;) {
    const { value, done } = await r.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function readZip(zip: Uint8Array): ReadZip {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);
  const u64 = (o: number) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 0x100000000;

  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end of central directory');
  let count = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  let cdOffset = u32(eocd + 16);
  let zip64 = false;
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (u32(loc) !== 0x07064b50) throw new Error('zip64 locator missing');
    const rec = u64(loc + 8);
    if (u32(rec) !== 0x06064b50) throw new Error('zip64 eocd missing');
    count = u64(rec + 32);
    cdOffset = u64(rec + 48);
    zip64 = true;
  }
  const entries: ReadEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (u32(p) !== 0x02014b50) throw new Error(`bad central header at ${p}`);
    const versionNeeded = u16(p + 6);
    const flags = u16(p + 8);
    const method = u16(p + 10);
    const dosTime = u16(p + 12);
    const dosDate = u16(p + 14);
    const crc = u32(p + 16);
    let csize = u32(p + 20);
    const usize = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    let lho = u32(p + 42);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(
      zip.subarray(p + 46, p + 46 + nameLen),
    );
    let zip64Extra = false;
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = u16(e);
      const len = u16(e + 2);
      if (id === 1) {
        zip64Extra = true;
        // fields appear only for the 0xFFFFFFFF ones, in order: usize, csize, offset
        let q = e + 4;
        if (usize === 0xffffffff) q += 8;
        if (csize === 0xffffffff) {
          csize = u64(q);
          q += 8;
        }
        if (lho === 0xffffffff) lho = u64(q);
      }
      e += 4 + len;
    }
    if (u32(lho) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const dataStart = lho + 30 + u16(lho + 26) + u16(lho + 28);
    const data = zip.slice(dataStart, dataStart + csize);
    if (crc32Ref(data) !== crc) throw new Error(`crc mismatch for ${name}`);
    if (data.length !== usize) throw new Error(`size mismatch for ${name}`);
    entries.push({ name, data, flags, method, crc, dosTime, dosDate, zip64Extra, versionNeeded });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, zip64 };
}
