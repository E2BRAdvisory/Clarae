// Collaboration on the Live editor, off (ADR-0050, A-D12). `attachCollab` is what the editor's assembly
// calls before it creates the editor: with every gate open it loads the `collab` chunk and adds the
// plugin; with any gate closed it returns null having loaded nothing, so the chunk is never fetched.
// `start` then binds the shared document once the editor exists.
import type { Editor } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { loadCollab } from '../chunks';
import { checkCollab, defaultCollabDeps, type CollabClosed, type CollabGateDeps } from './gate';
import type { CollabRoom } from './providers';

export interface AttachCollabOptions {
  /** Where the note is shared. */
  room: CollabRoom | undefined;
  /** Replaces where the conditions come from (tests). */
  deps?: CollabGateDeps;
  /** Loads the chunk (tests count the calls). */
  load?: typeof loadCollab;
  /** Called with the reason when collaboration is not attached. */
  onClosed?: (closed: CollabClosed) => void;
}

/** A started collaboration: stopping it unbinds the document and leaves the room. */
export interface CollabSession {
  stop(): Promise<void>;
}

export interface CollabAttachment {
  /** Binds the shared document to the created editor; `seed` is the note's text for an empty document. */
  start(ctx: Ctx, seed: string): Promise<CollabSession>;
}

/** Adds the plugin to an editor that is not created yet; resolves to what starts it, or null when closed. */
export async function attachCollab(
  editor: Pick<Editor, 'use'>,
  o: AttachCollabOptions,
): Promise<CollabAttachment | null> {
  const gate = checkCollab(o.room, o.deps ?? defaultCollabDeps());
  if (!gate.open) {
    o.onClosed?.(gate.closed);
    return null;
  }
  const { collab, startCollab } = await (o.load ?? loadCollab)();
  editor.use(collab);
  const room = o.room as CollabRoom;
  return { start: (ctx, seed) => startCollab(ctx, gate.provider, room, seed) };
}
