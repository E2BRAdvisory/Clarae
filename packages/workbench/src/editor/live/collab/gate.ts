// When collaboration may be offered (ADR-0050): every gate must be open, and they are checked in this
// order, all of them local and synchronous, so that with the function off nothing is loaded and nothing
// is asked of anyone. The flag of a profile alone opens nothing: a build without the constant, or
// without a registered provider (there is none), keeps it closed.
import { Feature } from '@memobrain/api-client/features';
import { useManaged, featureOn } from '../../../state/managed';
import { collabBuild } from './build';
import { collabProviders, type CollabProvider, type CollabRoom } from './providers';

/** Where each condition comes from (the application's stores by default, replaced in tests). */
export interface CollabGateDeps {
  /** The build constant. */
  build(): boolean;
  /** The feature flags in force (`features` of the Config Profile). */
  features(): Record<string, boolean>;
  /** The providers registered. */
  providers(): readonly CollabProvider[];
}

/** Why collaboration is not offered: the first gate that is closed. */
export type CollabClosed = 'build' | 'flag' | 'provider' | 'room';

export type CollabGate =
  { open: true; provider: CollabProvider } | { open: false; closed: CollabClosed };

export function defaultCollabDeps(): CollabGateDeps {
  return {
    build: collabBuild,
    features: () => useManaged.getState().features,
    providers: collabProviders,
  };
}

/** Checks the gates for a note (`room` is where it is shared; a note without one cannot be). */
export function checkCollab(room: CollabRoom | undefined, deps: CollabGateDeps): CollabGate {
  if (!deps.build()) return { open: false, closed: 'build' };
  if (!featureOn(deps.features(), Feature.Collab)) return { open: false, closed: 'flag' };
  const provider = deps.providers()[0];
  if (!provider) return { open: false, closed: 'provider' };
  if (!room) return { open: false, closed: 'room' };
  return { open: true, provider };
}
