// Two editors on one Yjs document in memory (ADR-0050): the binding the chunk puts on the editor
// converges, with no network, whatever the flag says. It runs on the real Live pipeline (the schema and
// the Markdown layer of the application), not on a bare ProseMirror.
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyUpdate, Doc, encodeStateAsUpdate } from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { installDomShims } from '../domShims';
import { addSchemaFeatures } from '../headless';
import { installLive } from '../kit';
import { loadCollab } from '../chunks';
import type { CollabProvider, CollabRoom } from './providers';

vi.setConfig({ testTimeout: 30_000 });

interface Peer {
  ctx: Ctx;
  doc: Doc;
  stop(): Promise<void>;
  /** The text of the document as the editor shows it, block by block. */
  blocks(): string[];
  type(text: string, at?: 'end' | 'start'): void;
  destroy(): Promise<void>;
}

const REMOTE = Symbol('remote');
const hosts: HTMLElement[] = [];
const peers: Peer[] = [];
const room: CollabRoom = { vaultId: 'v', path: 'Note.md' };

/** A provider that is the other peers' side of an in-memory relay, which can be cut and mended. */
class Relay {
  private readonly docs = new Set<Doc>();
  connected = true;
  provider(): CollabProvider {
    return {
      id: 'in-memory',
      join: (doc) => {
        this.docs.add(doc);
        const awareness = new Awareness(doc);
        const push = (update: Uint8Array, origin: unknown): void => {
          if (origin === REMOTE || !this.connected) return;
          for (const other of this.docs) if (other !== doc) applyUpdate(other, update, REMOTE);
        };
        doc.on('update', push);
        this.sync();
        return {
          awareness,
          leave: () => {
            doc.off('update', push);
            this.docs.delete(doc);
            awareness.destroy();
          },
        };
      },
    };
  }
  /** Brings every document to what all of them know (what a reconnection does). */
  sync(): void {
    for (const a of this.docs)
      for (const b of this.docs) if (a !== b) applyUpdate(b, encodeStateAsUpdate(a), REMOTE);
  }
}

async function peer(relay: Relay, seed: string): Promise<Peer> {
  installDomShims();
  const host = document.body.appendChild(document.createElement('div'));
  hosts.push(host);
  const builder = addSchemaFeatures(new CrepeBuilder({ root: host, defaultValue: '' }));
  installLive(builder.editor);
  const { collab, startCollab } = await loadCollab();
  builder.editor.use(collab);
  await builder.create();
  let ctx!: Ctx;
  builder.editor.action((c) => void (ctx = c));
  const doc = new Doc();
  const session = await startCollab(ctx, relay.provider(), room, seed, doc);
  const view = () => ctx.get(editorViewCtx);
  const p: Peer = {
    ctx,
    doc,
    stop: () => session.stop(),
    blocks: () => {
      const out: string[] = [];
      view().state.doc.forEach((n) => out.push(n.textContent));
      return out;
    },
    type: (text, at = 'end') => {
      const v = view();
      const last = v.state.doc.lastChild;
      const pos = at === 'start' ? 1 : v.state.doc.content.size - (last ? 1 : 0);
      v.dispatch(v.state.tr.insertText(text, pos));
    },
    destroy: async () => {
      await session.stop().catch(() => undefined);
      await builder.destroy();
    },
  };
  peers.push(p);
  return p;
}

afterEach(async () => {
  for (const p of peers.splice(0)) await p.destroy();
  for (const h of hosts.splice(0)) h.remove();
});

describe('two editors on one shared document', () => {
  it('the second one receives the note the first one seeded', async () => {
    const relay = new Relay();
    const a = await peer(relay, 'Hello world\n\nSecond paragraph\n');
    const b = await peer(relay, '');
    expect(a.blocks()).toEqual(['Hello world', 'Second paragraph']);
    expect(b.blocks()).toEqual(a.blocks());
  });

  it('an edit of one is in the other, both ways, with nothing sent to the network', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const relay = new Relay();
      const a = await peer(relay, 'Hello\n');
      const b = await peer(relay, '');
      a.type(' from A');
      expect(b.blocks()).toEqual(['Hello from A']);
      b.type('!');
      expect(a.blocks()).toEqual(['Hello from A!']);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('edits made apart, at both ends of a paragraph, meet in one text when the peers reconnect', async () => {
    const relay = new Relay();
    const a = await peer(relay, 'middle\n');
    const b = await peer(relay, '');
    expect(b.blocks()).toEqual(['middle']);
    relay.connected = false;
    a.type('start-', 'start');
    b.type('-end');
    expect(a.blocks()).toEqual(['start-middle']);
    expect(b.blocks()).toEqual(['middle-end']);
    relay.connected = true;
    relay.sync();
    expect(a.blocks()).toEqual(['start-middle-end']);
    expect(b.blocks()).toEqual(a.blocks());
    // and the two Yjs documents hold the same state
    expect(encodeStateAsUpdate(a.doc)).toEqual(encodeStateAsUpdate(b.doc));
  });

  it('stopping unbinds the editor, which goes on as a plain one', async () => {
    const relay = new Relay();
    const a = await peer(relay, 'Hello\n');
    const b = await peer(relay, '');
    await b.stop();
    a.type(' alone');
    expect(b.blocks()).toEqual(['Hello']);
    b.type('!');
    expect(b.blocks()).toEqual(['Hello!']);
    expect(a.blocks()).toEqual(['Hello alone']);
  });
});
