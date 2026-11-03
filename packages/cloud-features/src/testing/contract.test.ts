import { describe, expect, it } from 'vitest';
import { contractFetch, operationOf } from './contract';
import { fakeCloudApi } from './fakeCloud';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const get = (path: string) => new Request(`http://cloud.test/api/v1${path}`);

describe('contractFetch', () => {
  it('matches a request to its operation, with the path parameters', () => {
    expect(operationOf('POST', '/vaults/v1:restore')).toMatchObject({
      op: { id: 'restoreVault' },
      params: { vaultId: 'v1' },
    });
    expect(operationOf('GET', '/shared-with-me')?.op.id).toBe('listSharedWithMe');
    expect(operationOf('GET', '/nowhere')).toBeNull();
  });

  it('records an answer that breaks the contract and a path outside it', async () => {
    const cloud = contractFetch((req) =>
      Promise.resolve(
        new URL(req.url).pathname.endsWith('/me/usage')
          ? json(200, { used_bytes: 'a lot' })
          : json(418, {}),
      ),
    );
    await cloud.fetch(get('/me/usage'));
    await cloud.fetch(get('/nowhere'));
    await cloud.fetch(get('/me/groups'));
    expect(cloud.calls).toEqual(['GET getMyUsage', 'GET listMyGroups']);
    expect(cloud.problems).toHaveLength(3);
    expect(cloud.problems[0]).toMatch(/^getMyUsage: response 200/);
    expect(cloud.problems[1]).toMatch(/not an operation of api\/openapi.yaml/);
    // 418 is not declared: the `default` answer (a problem document) applies, and {} is not one.
    expect(cloud.problems[2]).toMatch(/^listMyGroups: response 418/);
  });

  it('refuses a request body that breaks the contract without calling the fake', async () => {
    let called = false;
    const cloud = contractFetch(() => {
      called = true;
      return Promise.resolve(json(201, {}));
    });
    const res = await cloud.fetch(
      new Request('http://cloud.test/api/v1/vaults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Team', kind: 'public' }),
      }),
    );
    expect(res.status).toBe(400);
    expect(called).toBe(false);
    expect(cloud.problems[0]).toMatch(/^createVault: request/);
  });

  it('finds nothing to say about the fake cloud of the suites', async () => {
    const cloud = contractFetch(
      fakeCloudApi({
        vaults: [{ name: 'Team', kind: 'shared' }],
        usage: { used_bytes: 1, quota_bytes: 10, level: 'ok' },
      }).fetch,
    );
    for (const path of ['/vaults', '/me/usage', '/me/devices', '/shared-with-me', '/me/groups'])
      expect((await cloud.fetch(get(path))).ok).toBe(true);
    expect(cloud.problems).toEqual([]);
  });
});
