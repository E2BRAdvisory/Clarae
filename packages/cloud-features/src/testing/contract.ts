/// <reference types="node" />
// The REST contract (api/openapi.yaml) for the fakes of the cloud, in Node: a request is matched to
// an operation of the document, its JSON body and every JSON answer are validated against the
// schemas of that operation. Shared by the Playwright mock of the cloud (web/e2e/cloudMock.ts) and by
// the run of the shared suites on the Go core compiled to WebAssembly
// (packages/workbench/src/cloud/CoreCloudPort.core.test.tsx), so a fake that drifts from the contract,
// or a client that sends what the contract does not allow, fails a test (ADR-0045 §4, §7).
// Node only (it reads the document from disk): imported as @clarae/cloud-features/testing/contract,
// never from the package's index.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { parse } from 'yaml';

type Json = Record<string, unknown>;

/** An operation of the document, with the pattern of its path. */
export interface Operation {
  id: string;
  method: string;
  path: string;
  re: RegExp;
  /** Names of the path parameters, in order. */
  params: string[];
  op: Json;
}

interface Contract {
  doc: Json;
  ops: Operation[];
  ajv: Ajv.Ajv;
}

// Not `new URL(…, import.meta.url)`: Vite rewrites that pattern into an asset URL.
const openapiPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../api/openapi.yaml',
);
let contract: Contract | null = null;

/** The document and its operations (read once). */
export function loadContract(): Contract {
  if (contract) return contract;
  const doc = parse(readFileSync(openapiPath, 'utf8')) as Json;
  const ops: Operation[] = [];
  for (const [path, item] of Object.entries(doc['paths'] as Record<string, Json>)) {
    for (const method of ['get', 'put', 'post', 'patch', 'delete']) {
      const op = item[method] as Json | undefined;
      if (!op) continue;
      const params: string[] = [];
      // `{vaultId}:restore` and `/blobs:check`: the colon is a literal of the path.
      const re = new RegExp(
        '^' +
          path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, (_, name: string) => {
            params.push(name);
            return '([^/:]+)';
          }) +
          '$',
      );
      ops.push({
        id: op['operationId'] as string,
        method: method.toUpperCase(),
        path,
        re,
        params,
        op,
      });
    }
  }
  // OpenAPI 3.1 schemas are JSON Schema; formats such as int64 are annotations here.
  const ajv = new Ajv({
    allErrors: true,
    unknownFormats: 'ignore',
    nullable: true,
    validateSchema: false,
    logger: false,
  });
  ajv.addSchema(doc, 'openapi');
  contract = { doc, ops, ajv };
  return contract;
}

/** The operation of a request (path below /api/v1), with its path parameters, or null. */
export function operationOf(
  method: string,
  path: string,
): { op: Operation; params: Record<string, string> } | null {
  for (const op of loadContract().ops) {
    if (op.method !== method) continue;
    const m = op.re.exec(path);
    if (m)
      return {
        op,
        params: Object.fromEntries(op.params.map((n, i) => [n, decodeURIComponent(m[i + 1]!)])),
      };
  }
  return null;
}

/** The JSON schema of a request body or of a response of an operation, if it has one. */
export function jsonSchemaOf(holder: Json | undefined): Json | null {
  if (!holder) return null;
  const c = loadContract();
  let h = holder;
  if (typeof h['$ref'] === 'string') {
    // #/components/responses/X
    const path = h['$ref'].slice(2).split('/');
    h = path.reduce<Json>((o, k) => o[k] as Json, c.doc);
  }
  const content = h['content'] as Record<string, Json> | undefined;
  const schema =
    content?.['application/json']?.['schema'] ?? content?.['application/problem+json']?.['schema'];
  return (schema as Json | undefined) ?? null;
}

/** The schema of the request body of an operation, if it takes JSON. */
export const requestSchemaOf = (op: Operation): Json | null =>
  jsonSchemaOf(op.op['requestBody'] as Json | undefined);

/**
 * The declared answer of an operation for a status (or its `default`), or undefined when the
 * status is not one of its responses.
 */
export function responseOf(op: Operation, status: number): Json | undefined {
  const responses = op.op['responses'] as Record<string, Json>;
  return responses[String(status)] ?? responses['default'];
}

/** Validates a value against a schema of the document: null, or the errors in words. */
export function validate(schema: Json, value: unknown): string | null {
  const c = loadContract();
  // Local refs of the document resolve inside the "openapi" schema added above.
  const rooted = JSON.parse(
    JSON.stringify(schema).replace(/"\$ref":"#\//g, '"$ref":"openapi#/'),
  ) as object;
  const ok = c.ajv.validate(rooted, value);
  return ok ? null : c.ajv.errorsText(c.ajv.errors, { dataVar: 'body' });
}

/** A fetch that answers through `handler` and checks both sides against the contract. */
export interface ContractFetch {
  fetch: (req: Request) => Promise<Response>;
  /** "METHOD operationId" of every request served, in order. */
  calls: string[];
  /** Contract violations and requests outside the document (empty when all is well). */
  problems: string[];
}

const problem = (status: number, code: string, detail: string): Response =>
  new Response(JSON.stringify({ type: 'about:blank', title: detail, status, code, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });

/**
 * Wraps a fake of the cloud (a Request → Response handler, such as fakeCloudApi's) with the
 * contract: a path outside the document is a problem and a 404; a request body that does not
 * validate is a problem and a 400 (the handler is not called); a status the operation does not
 * declare, or a JSON answer that does not validate, is a problem (the answer still goes back).
 * `ignore` lists paths that are not REST operations (the notification stream).
 */
export function contractFetch(
  handler: (req: Request) => Promise<Response>,
  { basePath = '/api/v1', ignore = ['/events'] }: { basePath?: string; ignore?: string[] } = {},
): ContractFetch {
  const calls: string[] = [];
  const problems: string[] = [];
  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.startsWith(basePath)
      ? url.pathname.slice(basePath.length)
      : url.pathname;
    if (ignore.includes(path)) return problem(404, 'NOT_FOUND', `${path} is not served`);
    const match = operationOf(req.method, path);
    if (!match) {
      problems.push(`${req.method} ${path}: not an operation of api/openapi.yaml`);
      return problem(404, 'NOT_FOUND', 'unknown path');
    }
    const { op } = match;
    calls.push(`${op.method} ${op.id}`);
    const reqSchema = requestSchemaOf(op);
    if (reqSchema) {
      const text = await req.clone().text();
      let body: unknown;
      try {
        body = JSON.parse(text || 'null');
      } catch {
        problems.push(`${op.id}: the request body is not JSON`);
      }
      const err = validate(reqSchema, body);
      if (err) {
        problems.push(`${op.id}: request ${err}`);
        return problem(400, 'VALIDATION_FAILED', err);
      }
    }
    const res = await handler(req);
    const declared = responseOf(op, res.status);
    if (!declared)
      problems.push(`${op.id}: status ${res.status} is not a response of the operation`);
    else if ((res.headers.get('Content-Type') ?? '').includes('json')) {
      const schema = jsonSchemaOf(declared);
      const text = await res.clone().text();
      const err = schema && text ? validate(schema, JSON.parse(text)) : null;
      if (err) problems.push(`${op.id}: response ${res.status} ${err}`);
    }
    return res;
  };
  return { fetch, calls, problems };
}
