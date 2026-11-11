// The door to the core's AI assistant: the typed facade over the AIAPI bindings and its two events
// (wailsjs is generated, never edited). The port is an interface so that the provider and the gate
// are tested without a core; `aiPort` is the real one.
import * as AIAPI from '../../../../wailsjs/go/app/AIAPI';
import { api } from '../../../app/api';
import { Events, type EventPayloads } from '../../../app/events';

/** What the core says of the assistant for a vault (never the key). */
export interface AiStatus {
  available: boolean;
  /** The first closed gate: "build", "profile", "private-vault" or "not-configured"; empty when available. */
  reason: string;
  build: boolean;
  flag: boolean;
  private: boolean;
  configured: boolean;
  provider: string;
  model: string;
}

export interface AiRequest {
  vaultId: string;
  /** Chosen by the caller, which listens before it asks. */
  requestId: string;
  document: string;
  selection: string;
  instruction: string;
}

export type AiChunk = EventPayloads['ai:chunk'];
export type AiDone = EventPayloads['ai:done'];

export interface AiPort {
  status(vaultId: string): Promise<AiStatus>;
  /** Returns at once; the answer comes through `onChunk`, then `onDone`. Rejects with `"<code>: <text>"`. */
  start(req: AiRequest): Promise<void>;
  cancel(requestId: string): Promise<boolean>;
  onChunk(handler: (chunk: AiChunk) => void): () => void;
  onDone(handler: (done: AiDone) => void): () => void;
}

export const aiPort: AiPort = {
  status: (vaultId) => AIAPI.Status(vaultId),
  start: (req) => AIAPI.Start(req),
  cancel: (requestId) => AIAPI.Cancel(requestId),
  onChunk: (handler) => api.on(Events.aiChunk, handler),
  onDone: (handler) => api.on(Events.aiDone, handler),
};
