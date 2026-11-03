// The pictures of a presentation come from the vault only (ADR-0047): a path resolves like an embed
// from the .marp file, inline data:image URLs are kept, anything else (a web address) is dropped so
// that nothing is requested from the network. The preview holds cached blobs; an export inlines the
// bytes as data URLs, because a standalone file cannot reach the vault.
import { classify, loadMedia } from '../embeds/media';
import type { EmbedBackend } from '../embeds/hydrate';
import type { AssetResolver } from './engine';

const SCHEME = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

async function vaultImage(backend: EmbedBackend, from: string, ref: string): Promise<string> {
  const path = await backend.resolve(from, ref).catch(() => '');
  return path && classify(path) === 'image' ? path : '';
}

/** Pictures for the live preview: blob URLs of the attachment cache, released with the slides. */
export function previewAssets(backend: EmbedBackend, from: string): AssetResolver {
  return async (ref) => {
    if (/^data:image\//i.test(ref)) return { url: ref };
    if (SCHEME.test(ref)) return null;
    const path = await vaultImage(backend, from, ref);
    if (!path) return null;
    const h = await loadMedia(
      backend.vaultId ?? '',
      path,
      () => backend.readBinary(path),
      backend.stat?.(path),
    );
    return { url: h.url, release: h.release };
  };
}

/** Pictures for an export: data URLs, so that the file is complete on its own. */
export function exportAssets(backend: EmbedBackend, from: string): AssetResolver {
  return async (ref) => {
    if (/^data:image\//i.test(ref)) return { url: ref };
    if (SCHEME.test(ref)) return null;
    const path = await vaultImage(backend, from, ref);
    if (!path) return null;
    const bin = await backend.readBinary(path);
    return { url: `data:${bin.mime};base64,${bin.data}` };
  };
}
