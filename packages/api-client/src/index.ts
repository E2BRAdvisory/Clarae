// Typed client for the Nodus Cloud API, generated from api/openapi.yaml
// (`yarn workspace @nodus/api-client run gen`). Used by the Web UI.
import createOpenApiClient, { type ClientOptions, type Middleware } from 'openapi-fetch';
import type { components, paths } from './gen/schema';

export type Paths = paths;
export type Schemas = components['schemas'];
export type Problem = Schemas['Problem'];
export type ErrorCode = Schemas['ErrorCode'];

export interface NodusClientOptions extends ClientOptions {
  /** Returns the current bearer token, or undefined when signed out. */
  getAccessToken?: () => Promise<string | undefined> | string | undefined;
}

/** Creates a client bound to `/api/v1` with bearer authentication. */
export function createClient(options: NodusClientOptions = {}) {
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

export type NodusClient = ReturnType<typeof createClient>;

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
