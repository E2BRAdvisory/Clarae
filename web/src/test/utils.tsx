import { render, type RenderResult } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import { createClient, type NodusClient } from '@nodus/api-client';
import { TestApp } from '../App';
import type { AuthService, AuthUser } from '../auth/types';

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (call: RecordedCall) => unknown;
/** Keys are "METHOD /path" below /api/v1. A function may return a Response, anything else is sent as JSON. */
export type Routes = Record<string, unknown>;

export function problem(status: number, code: string, detail = ''): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title: code, status, code, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

export interface MockApi {
  client: NodusClient;
  calls: RecordedCall[];
  routes: Routes;
  called: (method: string, path: string) => RecordedCall[];
}

/** An api-client bound to an in-memory fetch: the real client, middleware and error handling run. */
export function mockApi(routes: Routes): MockApi {
  const calls: RecordedCall[] = [];
  const table = { ...routes };
  const fetchFn = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const text = await req.text();
    const call: RecordedCall = {
      method: req.method,
      path: url.pathname.replace(/^\/api\/v1/, ''),
      query: url.searchParams,
      body: text ? (JSON.parse(text) as unknown) : undefined,
    };
    calls.push(call);
    const entry = table[`${call.method} ${call.path}`];
    if (entry === undefined)
      return problem(404, 'NOT_FOUND', `no mock for ${call.method} ${call.path}`);
    const out = typeof entry === 'function' ? (entry as Handler)(call) : entry;
    if (out instanceof Response) return out;
    if (out === undefined || out === null) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = createClient({ baseUrl: 'http://localhost/api/v1', fetch: fetchFn });
  return {
    client,
    calls,
    routes: table,
    called: (m: string, p: string) => calls.filter((c) => c.method === m && c.path === p),
  };
}

export interface FakeAuth extends AuthService {
  signIn: Mock<(returnTo: string) => Promise<void>>;
  completeSignIn: Mock<() => Promise<string>>;
  signOut: Mock<() => Promise<void>>;
}

export function fakeAuth(user: Partial<AuthUser> | null = {}): FakeAuth {
  const full: AuthUser | null = user && {
    sub: 'u1',
    name: 'Alice',
    roles: [],
    accessToken: 'tok',
    ...user,
  };
  const service: FakeAuth = {
    getUser: () => Promise.resolve(full),
    signIn: vi.fn(() => Promise.resolve()),
    completeSignIn: vi.fn(() => Promise.resolve('/')),
    signOut: vi.fn(() => Promise.resolve()),
    onUserChange: () => () => {},
  };
  return service;
}

export function renderApp(opts: {
  path: string;
  routes?: Routes;
  user?: Partial<AuthUser> | null;
  auth?: AuthService;
}): RenderResult & { api: MockApi; auth: AuthService } {
  const api = mockApi({ 'GET /me': { id: 'u1', username: 'alice' }, ...opts.routes });
  const auth = opts.auth ?? fakeAuth(opts.user === undefined ? {} : opts.user);
  const view = render(
    <TestApp auth={auth} client={api.client} router={{ initialEntries: [opts.path] }} />,
  );
  return { ...view, api, auth };
}
