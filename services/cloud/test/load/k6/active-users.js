// k6 load test: N simulated active users (default 1000) that poll `changes`
// and commit small files, against the cloud API (Appendix A: p95 changes
// < 200 ms, p95 commit (<= 50 ops) < 500 ms at 1,000 active users).
//
// Tokens come from a file written by the TEST-ONLY helper
// `TestServeLoadEnv` (services/cloud/test/integration/loadenv_test.go), which
// runs the API with a fake OIDC issuer. See docs/perf/README.md.
//
//   k6 run -e TOKENS=/path/tokens.json services/cloud/test/load/k6/active-users.js
//
// Options (env): TOKENS (required), USERS (default 1000), DURATION (default
// 5m), RAMP (default 1m), POLL_SECONDS (default 10, a client polls roughly
// this often), COMMIT_SECONDS (default 30), BATCH_VUS (default 5; VUs that send
// 50-op batches to check the batch p95).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { sha256 } from 'k6/crypto';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const cfg = JSON.parse(open(__ENV.TOKENS));
const users = new SharedArray('users', () => cfg.users);
const base = `${cfg.base_url}`;

const USERS = Number(__ENV.USERS || 1000);
const DURATION = __ENV.DURATION || '5m';
const RAMP = __ENV.RAMP || '1m';
const POLL = Number(__ENV.POLL_SECONDS || 10);
const COMMIT = Number(__ENV.COMMIT_SECONDS || 30);
const BATCH_VUS = Number(__ENV.BATCH_VUS || 5);

const commitOps = new Counter('commit_ops');
const conflicts = new Counter('commit_conflicts');
const changesItems = new Trend('changes_items');

export const options = {
  scenarios: {
    active_users: {
      executor: 'ramping-vus',
      stages: [
        { duration: RAMP, target: USERS },
        { duration: DURATION, target: USERS },
      ],
      exec: 'activeUser',
    },
    batch50: {
      executor: 'constant-vus',
      vus: BATCH_VUS,
      duration: DURATION,
      startTime: RAMP,
      exec: 'batchUser',
    },
  },
  thresholds: {
    'http_req_duration{endpoint:changes}': ['p(95)<200'],
    'http_req_duration{endpoint:commit}': ['p(95)<500'],
    'http_req_duration{endpoint:commit_batch50}': ['p(95)<500'],
    'http_req_failed{endpoint:changes}': ['rate<0.01'],
    'http_req_failed{endpoint:commit}': ['rate<0.01'],
    'http_req_failed{endpoint:commit_batch50}': ['rate<0.01'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function headers(u, json) {
  return {
    Authorization: `Bearer ${u.token}`,
    'Content-Type': json ? 'application/json' : 'application/octet-stream',
  };
}

// Per-VU state: the change cursor and the files this user may modify.
const state = { cursor: 0, files: [] };

function putBlob(u, text) {
  const digest = sha256(text, 'hex');
  const r = http.put(`${base}/vaults/${u.vault_id}/blobs/${digest}`, text, {
    headers: headers(u, false),
    tags: { endpoint: 'blob_put' },
  });
  check(r, { 'blob stored': (res) => res.status === 204 || res.status === 200 });
  return digest;
}

function commit(u, ops, tag) {
  const r = http.post(
    `${base}/vaults/${u.vault_id}/commit`,
    JSON.stringify({ device_id: u.device_id, ops }),
    {
      headers: headers(u, true),
      tags: { endpoint: tag },
    },
  );
  const ok = check(r, { 'commit 200': (res) => res.status === 200 });
  if (!ok) return [];
  commitOps.add(ops.length);
  return r.json('results') || [];
}

function poll(u) {
  const r = http.get(`${base}/vaults/${u.vault_id}/changes?since=${state.cursor}&limit=500`, {
    headers: headers(u, true),
    tags: { endpoint: 'changes' },
  });
  if (check(r, { 'changes 200': (res) => res.status === 200 })) {
    const body = r.json();
    changesItems.add((body.items || []).length);
    if (typeof body.next_seq === 'number') state.cursor = body.next_seq;
  }
}

// A typical user: edits a file now and then (a create or a modify of a file they own) and polls.
export function activeUser() {
  const u = users[(__VU - 1) % users.length];
  if (__ITER === 0) sleep(Math.random() * POLL);
  poll(u);
  if (__ITER % Math.max(1, Math.round(COMMIT / POLL)) === 0) {
    const text = `note ${uuidv4()} from k6`;
    const digest = putBlob(u, text);
    let op;
    if (state.files.length > 0 && Math.random() < 0.3) {
      const f = state.files[Math.floor(Math.random() * state.files.length)];
      op = { op_id: uuidv4(), op: 'modify', file_id: f.id, base_rev: f.rev, blob_hash: digest };
    } else {
      op = {
        op_id: uuidv4(),
        op: 'create',
        file_id: uuidv4(),
        path: `k6/${uuidv4()}.md`,
        blob_hash: digest,
      };
    }
    for (const res of commit(u, [op], 'commit')) {
      if (res.status === 'accepted') {
        const known = state.files.find((f) => f.id === res.file_id) || null;
        if (known) known.rev = res.rev;
        else if (state.files.length < 20)
          state.files.push({ id: res.file_id || op.file_id, rev: res.rev });
      } else if (res.status === 'conflict') {
        conflicts.add(1);
      }
    }
  }
  sleep(POLL * (0.8 + Math.random() * 0.4));
}

// A user importing a folder: 50 creates in one commit (the largest batch the spec talks about).
export function batchUser() {
  const u = users[(__VU - 1) % users.length];
  const digest = putBlob(u, 'k6 batch payload');
  const ops = [];
  for (let i = 0; i < 50; i++) {
    ops.push({
      op_id: uuidv4(),
      op: 'create',
      file_id: uuidv4(),
      path: `k6batch/${uuidv4()}.md`,
      blob_hash: digest,
    });
  }
  commit(u, ops, 'commit_batch50');
  sleep(5 + Math.random() * 5);
}
