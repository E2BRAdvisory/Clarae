// When the AI assistant may be offered (ADR-0050): every gate must be open, and they are checked in
// this order, the cheap and local ones first, so that with the function off nothing is asked of the
// core at all. The core checks them again on its own account (AIAPI.Start refuses): this is what
// keeps the UI, and the lazy chunk, from existing while the function is inactive.
import { Feature } from '@clarae/api-client/features';
import { aiBuild } from './build';
import type { AiPort, AiStatus } from './port';
import { featureOn, useManaged } from '../../../state/managed';
import { can } from '../../../platform';
import { infoOf, useSync } from '../../../state/sync';

/** Where each condition comes from (the application's stores by default, replaced in tests). */
export interface AiGateDeps {
  /** The build constant. */
  build(): boolean;
  /** The feature flags in force (`features` of the Config Profile). */
  features(): Record<string, boolean>;
  /** The host's capability `aiAssistant`. */
  capable(): boolean;
  /** Whether the vault is a private (end-to-end encrypted) cloud vault. */
  privateVault(vaultId: string): boolean;
  port: AiPort;
}

/** Why the assistant is not offered: the first gate that is closed. */
export type AiClosed = 'build' | 'flag' | 'capability' | 'private-vault' | 'unavailable';

export type AiGate = { open: true; status: AiStatus } | { open: false; closed: AiClosed };

export function defaultGateDeps(port: AiPort): AiGateDeps {
  return {
    build: aiBuild,
    features: () => useManaged.getState().features,
    // `can` reads the capability by name: the consumer `task parity` looks for
    capable: () => can('aiAssistant'),
    privateVault: (vaultId) => {
      const info = infoOf(useSync.getState(), vaultId);
      return info.linked && info.kind === 'private';
    },
    port,
  };
}

/** Checks the gates for a vault. Asks the core (`Status`) only when the four local ones are open. */
export async function checkAi(vaultId: string, deps: AiGateDeps): Promise<AiGate> {
  if (!deps.build()) return { open: false, closed: 'build' };
  if (!featureOn(deps.features(), Feature.Ai)) return { open: false, closed: 'flag' };
  if (!deps.capable()) return { open: false, closed: 'capability' };
  if (deps.privateVault(vaultId)) return { open: false, closed: 'private-vault' };
  try {
    const status = await deps.port.status(vaultId);
    return status.available ? { open: true, status } : { open: false, closed: 'unavailable' };
  } catch {
    return { open: false, closed: 'unavailable' };
  }
}
