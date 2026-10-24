export type ByteUnit = 'KB' | 'MB' | 'GB' | 'TB';
export const BYTE_UNITS: ByteUnit[] = ['KB', 'MB', 'GB', 'TB'];

const FACTOR: Record<ByteUnit, number> = {
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
};

/** Bytes for a number typed in the given unit (binary steps, like formatBytes). */
export function toBytes(value: number, unit: ByteUnit): number {
  return Math.round(value * FACTOR[unit]);
}

/** The largest unit that represents `bytes` exactly (or KB with decimals), as input text. */
export function splitBytes(bytes: number): { value: string; unit: ByteUnit } {
  for (const unit of ['TB', 'GB', 'MB', 'KB'] as const) {
    if (bytes >= FACTOR[unit] && bytes % FACTOR[unit] === 0)
      return { value: String(bytes / FACTOR[unit]), unit };
  }
  return { value: String(Math.round((bytes / 1024) * 100) / 100), unit: 'KB' };
}

/** Parses the text of a byte-size input: a finite number >= 0, or undefined when invalid. */
export function parseAmount(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
