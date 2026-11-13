import { describe, expect, it } from 'vitest';
import { rolesFromAccessToken } from './jwt';

function token(payload: object): string {
  const b64 = (o: object) =>
    btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

describe('rolesFromAccessToken', () => {
  it('reads realm roles', () => {
    expect(rolesFromAccessToken(token({ realm_access: { roles: ['clarae-admin', 'x'] } }))).toEqual(
      ['clarae-admin', 'x'],
    );
  });
  it('is empty for tokens without roles or malformed ones', () => {
    expect(rolesFromAccessToken(token({}))).toEqual([]);
    expect(rolesFromAccessToken('garbage')).toEqual([]);
    expect(rolesFromAccessToken('a.!!!.c')).toEqual([]);
  });
});
