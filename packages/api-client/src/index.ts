// Typed client for the MemoBrain Notes Cloud API, generated from api/openapi.yaml
// (`yarn workspace @memobrain/api-client run gen`). Used by the Web UI.
import createOpenApiClient, { type ClientOptions, type Middleware } from 'openapi-fetch';
import type { components, paths } from './gen/schema';

export type Paths = paths;
export type Schemas = components['schemas'];
export type Problem = Schemas['Problem'];
export type ErrorCode = Schemas['ErrorCode'];

export interface MemobrainClientOptions extends ClientOptions {
  /**
   * Returns the bearer token, or undefined when signed out. It is called before every request (never
   * cached by the client), so it must return the session's current token, renewed when it is about to
   * expire: a client kept for a long time (an export loop) then keeps working past a token's lifetime.
   */
  getAccessToken?: () => Promise<string | undefined> | string | undefined;
}

/** Creates a client bound to `/api/v1` with bearer authentication. */
export function createClient(options: MemobrainClientOptions = {}) {
  const { getAccessToken, baseUrl = '/api/v1', ...rest } = options;
  const client = createOpenApiClient<paths>({ baseUrl, ...rest });
  if (getAccessToken) {
    const auth: Middleware = {
      async onRequest({ request }) {
        const token = await getAccessToken();
        if (token) request.headers.set('Authorization', `Bearer ${token}`);
        return request;
      },
    };
    client.use(auth);
  }
  return client;
}

export type MemobrainClient = ReturnType<typeof createClient>;

/** True when a response body is an RFC 9457 problem document from the API. */
export function isProblem(body: unknown): body is Problem {
  return (
    typeof body === 'object' &&
    body !== null &&
    'code' in body &&
    'status' in body &&
    typeof (body as { code: unknown }).code === 'string'
  );
}

/** Error thrown by {@link unwrap}: carries the HTTP status and the RFC 9457 application `code`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | 'UNKNOWN';
  readonly requestId: string | undefined;
  readonly problem: Problem | undefined;

  constructor(status: number, problem: Problem | undefined, fallback: string) {
    super(problem?.detail || problem?.title || fallback);
    this.name = 'ApiError';
    this.status = status;
    this.code = problem?.code ?? 'UNKNOWN';
    this.requestId = problem?.request_id;
    this.problem = problem;
  }
}

interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/**
 * Resolves an openapi-fetch call to its payload, or throws an {@link ApiError}
 * (also for network-level failures of the body, e.g. a 502 HTML page).
 * 204 responses resolve to `undefined`.
 */
export async function unwrap<T>(call: Promise<FetchResult<T>>): Promise<T> {
  const { data, error, response } = await call;
  if (response.ok) return data as T;
  throw new ApiError(
    response.status,
    isProblem(error) ? error : undefined,
    `${response.status} ${response.statusText}`.trim(),
  );
}
