// Browser-side export of a private (E2EE) vault: key envelopes, manifest and blobs come from
// the API (ciphertext only); everything else happens in packages/vaultcrypto-web.
import { ApiError, isProblem, type MemobrainClient } from '@memobrain/api-client';
import {
  DecryptError,
  MissingEnvelopeError,
  RecoveryKeyError,
  WeakKdfError,
  unlockVault,
  type Secret,
  type TreeItem,
  type Unlocked,
  type VaultSource,
} from '@memobrain/vaultcrypto-web';

export interface PrivateSession {
  keys: Unlocked;
  tree: TreeItem[];
  source: VaultSource;
  /** Sum of the manifest sizes (ciphertext, close to the plaintext size). */
  totalBytes: number;
}

function apiError(res: Response, error: unknown): ApiError {
  return new ApiError(
    res.status,
    isProblem(error) ? error : undefined,
    `${res.status} ${res.statusText}`.trim(),
  );
}

/** Reads the manifest and blobs through the API client (bearer token, problem errors). */
export function apiVaultSource(
  api: MemobrainClient,
  vaultId: string,
  prefetched?: TreeItem[],
): VaultSource {
  return {
    async tree(signal) {
      if (prefetched) return prefetched;
      const r = await api.GET('/vaults/{vaultId}/tree', {
        params: { path: { vaultId } },
        ...(signal ? { signal } : {}),
      });
      if (!r.response.ok || !r.data) throw apiError(r.response, r.error);
      return r.data.items;
    },
    async blob(hash, signal) {
      const r = await api.GET('/vaults/{vaultId}/blobs/{sha256}', {
        params: { path: { vaultId, sha256: hash } },
        parseAs: 'arrayBuffer',
        ...(signal ? { signal } : {}),
      });
      if (!r.response.ok) throw apiError(r.response, r.error);
      return new Uint8Array(r.data as unknown as ArrayBuffer);
    },
  };
}

/**
 * Step 1: fetch the envelopes, derive the KEK and unwrap the VMK (the server never sees the
 * secret), then load the manifest. The caller owns `keys` and must `wipe()` them.
 */
export async function openPrivateVault(
  api: MemobrainClient,
  vaultId: string,
  secret: Secret,
  signal?: AbortSignal,
): Promise<PrivateSession> {
  const env = await api.GET('/vaults/{vaultId}/key-envelopes', {
    params: { path: { vaultId } },
    ...(signal ? { signal } : {}),
  });
  if (!env.response.ok || !env.data) throw apiError(env.response, env.error);
  const keys = await unlockVault(env.data.items, secret, vaultId);
  try {
    const tree = await apiVaultSource(api, vaultId).tree(signal);
    return {
      keys,
      tree,
      source: apiVaultSource(api, vaultId, tree),
      totalBytes: tree.reduce((n, i) => n + i.size, 0),
    };
  } catch (err) {
    keys.wipe();
    throw err;
  }
}

export type UnlockFailure =
  'wrongSecret' | 'badRecoveryKey' | 'weakKdf' | 'noEnvelope' | 'derivation' | 'api';

/** Maps an unlock error to a user-facing category; `derivation` covers WASM/CSP/memory failures. */
export function classifyUnlockError(err: unknown): UnlockFailure {
  if (err instanceof DecryptError) return 'wrongSecret';
  if (err instanceof RecoveryKeyError) return 'badRecoveryKey';
  if (err instanceof WeakKdfError) return 'weakKdf';
  if (err instanceof MissingEnvelopeError) return 'noEnvelope';
  if (err instanceof ApiError) return 'api';
  return 'derivation';
}
