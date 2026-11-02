// Blob URLs of the SVG previews of drawings and canvases shown in <img> elements. Each new version of
// a file makes a new picture, so the URLs are bounded: the one of an older version of the same file
// (and part) is revoked when a newer one is made, the least recently used go beyond the limit, and a
// vault's go with it (shell/VaultView). An <img> keeps showing a picture already loaded.

interface Entry {
  url: string;
  vaultId: string;
  /** The file and the part shown: a newer version of the same slot replaces the entry. */
  slot: string;
}

export class PreviewUrls {
  /** By key (vault, version, part), least recently used first. */
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly limit = 64) {}

  /** The URL of a preview already made (and marks it as recently used). */
  get(vaultId: string, key: string): string | undefined {
    const k = `${vaultId}\u0000${key}`;
    const e = this.entries.get(k);
    if (!e) return undefined;
    this.entries.delete(k);
    this.entries.set(k, e);
    return e.url;
  }

  /** Makes the URL of `svg` for the version `key` of `slot`, replacing the slot's older version. */
  put(vaultId: string, slot: string, key: string, svg: string): string {
    const hit = this.get(vaultId, key);
    if (hit) return hit; // made meanwhile by another embed of the same version
    for (const [k, e] of this.entries) if (e.vaultId === vaultId && e.slot === slot) this.drop(k);
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    this.entries.set(`${vaultId}\u0000${key}`, { url, vaultId, slot });
    for (const k of this.entries.keys()) {
      if (this.entries.size <= this.limit) break;
      this.drop(k);
    }
    return url;
  }

  /** Revokes every preview of a vault (it was closed). */
  releaseVault(vaultId: string): void {
    for (const [k, e] of this.entries) if (e.vaultId === vaultId) this.drop(k);
  }

  get size(): number {
    return this.entries.size;
  }

  private drop(k: string): void {
    const e = this.entries.get(k);
    if (!e) return;
    this.entries.delete(k);
    URL.revokeObjectURL(e.url);
  }
}
