/** Reads the realm roles out of an access token. The signature is not checked: the API does that. */
export function rolesFromAccessToken(token: string): string[] {
  const payload = token.split('.')[1];
  if (!payload) return [];
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as {
      realm_access?: { roles?: unknown };
    };
    const roles = claims.realm_access?.roles;
    return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}
