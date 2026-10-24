/** Public bootstrap document served by GET /api/v1/client-config. */
export interface ClientConfig {
  issuer: string;
  webClientId: string;
  audience: string;
}

export async function loadClientConfig(fetchFn: typeof fetch = fetch): Promise<ClientConfig> {
  const res = await fetchFn('/api/v1/client-config', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`client-config: ${res.status}`);
  const body = (await res.json()) as { issuer?: string; web_client_id?: string; audience?: string };
  if (!body.issuer || !body.web_client_id) throw new Error('client-config: incomplete document');
  return { issuer: body.issuer, webClientId: body.web_client_id, audience: body.audience ?? '' };
}
