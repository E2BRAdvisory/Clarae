// Latency check of the sync endpoints against a running server (M2 exit criteria).
import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

export const options = {
  scenarios: {
    changes: { executor: 'constant-vus', vus: 8, duration: '30s', exec: 'changes' },
    commits: { executor: 'constant-vus', vus: 4, duration: '30s', exec: 'commits' },
  },
  thresholds: {
    'http_req_duration{endpoint:changes}': ['p(95)<200'],
    'http_req_duration{endpoint:commit}': ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

const base = `${__ENV.BASE_URL}/api/v1`;
const headers = { Authorization: `Bearer ${__ENV.TOKEN}`, 'Content-Type': 'application/json' };

export function changes() {
  const r = http.get(`${base}/vaults/${__ENV.VAULT_ID}/changes?since=0&limit=500`, {
    headers,
    tags: { endpoint: 'changes' },
  });
  check(r, { 'changes 200': (res) => res.status === 200 });
}

export function setup() {
  // One tiny blob every commit refers to.
  const body = 'k6 load payload';
  const digest = __ENV.BLOB_SHA256; // sha256 of the body, computed by the caller
  http.put(`${base}/vaults/${__ENV.VAULT_ID}/blobs/${digest}`, body, {
    headers: { Authorization: headers.Authorization, 'Content-Type': 'application/octet-stream' },
  });
  return { digest };
}

export function commits(data) {
  const ops = [];
  for (let i = 0; i < 50; i++) {
    ops.push({
      op_id: uuidv4(),
      op: 'create',
      file_id: uuidv4(),
      path: `k6/${uuidv4()}.md`,
      blob_hash: data.digest,
    });
  }
  const r = http.post(
    `${base}/vaults/${__ENV.VAULT_ID}/commit`,
    JSON.stringify({ device_id: __ENV.DEVICE_ID, ops }),
    { headers, tags: { endpoint: 'commit' } },
  );
  check(r, { 'commit 200': (res) => res.status === 200 });
}
