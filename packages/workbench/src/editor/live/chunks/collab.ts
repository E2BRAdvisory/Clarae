// The collaboration chunk (A-D6, A-D12): the Yjs binding of the editor. It is fetched only by
// `attachCollab` (collab/attach.ts), that is only when the build constant, the `collab` flag AND a
// registered provider are all there: none of them is in a released build, so nothing loads this.
//
// With the binding on, the editor's history is Yjs's (`y-prosemirror` replaces it) and its nodes are
// rebuilt from the shared document: the identity of the blocks that the fidelity layer relies on
// (ADR-0049 section 4) does not hold in this mode. That is the reason the function is off, and why
// turning it on needs its own decision.
import type { Ctx } from '@milkdown/kit/ctx';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import { Doc } from 'yjs';
import type { CollabSession } from '../collab/attach';
import type { CollabProvider, CollabRoom } from '../collab/providers';

export { collab, collabServiceCtx };

/**
 * Binds a shared document to a created editor: joins the room through the provider, and connects the
 * editor to the document. `seed` becomes the content when the shared document is still empty once the
 * provider has synced it.
 */
export async function startCollab(
  ctx: Ctx,
  provider: CollabProvider,
  room: CollabRoom,
  seed = '',
  doc: Doc = new Doc(),
): Promise<CollabSession> {
  const connection = await provider.join(doc, room);
  try {
    const service = ctx.get(collabServiceCtx).bindDoc(doc);
    if (connection.awareness) service.setAwareness(connection.awareness);
    if (seed) service.applyTemplate(seed);
    service.connect();
    return {
      stop: async () => {
        try {
          service.disconnect();
        } finally {
          try {
            await connection.leave();
          } finally {
            doc.destroy();
          }
        }
      },
    };
  } catch (e) {
    await connection.leave();
    doc.destroy();
    throw e;
  }
}
