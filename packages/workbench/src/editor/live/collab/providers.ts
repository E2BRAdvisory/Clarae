// Where a collaborative note gets its peers from (ADR-0050). The editor does not know a transport: a
// provider is given the shared document of a note and syncs it with whoever else has it open (a
// WebSocket relay, a peer-to-peer channel). THERE IS NONE IN THE BUILD: nothing here, and nothing in
// the application, registers one, so the function stays off even for a profile that says `collab: true`
// in a build made with the constant. A provider is a decision of its own (it needs a server, and
// accepting it deviates from A-05 and D-04), made with an ADR before the first one is added.
//
// Only types are imported from Yjs here: this module is in the editor chunk, the library is in the
// `collab` chunk and must stay there.
import type { Awareness } from 'y-protocols/awareness';
import type { Doc } from 'yjs';

/** The note a shared document belongs to. */
export interface CollabRoom {
  vaultId: string;
  /** The path of the note in the vault. */
  path: string;
}

/** What a provider hands back once it joined a room. */
export interface CollabConnection {
  /** The cursors and the names of the peers; without it nobody else's cursor is drawn. */
  awareness?: Awareness;
  /** Stops syncing and frees the transport. */
  leave(): void | Promise<void>;
}

export interface CollabProvider {
  readonly id: string;
  /** Starts syncing `doc` (a Yjs document that is empty or already holds the note) with the peers of `room`. */
  join(doc: Doc, room: CollabRoom): CollabConnection | Promise<CollabConnection>;
}

const registered: CollabProvider[] = [];

/**
 * Registers a provider; returns what takes it away. No code of the application calls this: it is the
 * seam for a provider that a later decision adds, and for the tests.
 */
export function registerCollabProvider(provider: CollabProvider): () => void {
  registered.push(provider);
  return () => {
    const i = registered.indexOf(provider);
    if (i >= 0) registered.splice(i, 1);
  };
}

/** The providers registered now (none in the build). */
export function collabProviders(): readonly CollabProvider[] {
  return registered;
}
