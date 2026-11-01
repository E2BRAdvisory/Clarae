// Rules of `node scripts/parity.mjs --check` (ADR-0037). Run with: node --test 'scripts/parity/*.test.mjs'
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { parse } from 'yaml';
import {
  BEGIN,
  END,
  check,
  consoleCalls,
  effectiveFeatures,
  parseBindings,
  parseOperations,
  parseRoutes,
  render,
  specCoverage,
  splice,
} from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const capabilities = {
  desktop: { localFolders: true, updater: true },
  web: { localFolders: false, updater: false },
};
const commands = [
  { id: 'note:new', group: 'file', requires: [], platforms: { desktop: true, web: true } },
  {
    id: 'update:check',
    group: 'file',
    requires: ['updater'],
    platforms: { desktop: true, web: false },
  },
];
const bindings = ['VaultAPI.WriteNote', 'UpdaterAPI.Check'];
const operations = [
  { operationId: 'healthz', method: 'get', path: '/healthz' },
  { operationId: 'listVaults', method: 'get', path: '/vaults' },
];
const routes = ['/vaults'];

/** A registry that passes every rule; each test breaks one thing. */
function registry() {
  return {
    version: 1,
    features: [
      {
        id: 'note.create',
        title: 'Creazione di note',
        desktop: { status: 'yes', commands: ['note:new'], bindings: ['VaultAPI.WriteNote'] },
        workbench: { status: 'yes' },
        tests: { desktop: ['a.test.ts'] },
      },
      {
        id: 'app.updater',
        title: 'Aggiornamento automatico',
        desktop: {
          status: 'yes',
          capability: 'updater',
          commands: ['update:check'],
          bindings: ['UpdaterAPI.Check'],
        },
        workbench: { status: 'exception', reason: 'servita dal cloud' },
      },
      {
        id: 'vault.list',
        title: 'Elenco dei vault',
        desktop: { status: 'yes' },
        workbench: { status: 'yes' },
        console: { status: 'yes', routes: ['/vaults'], operationIds: ['listVaults'] },
      },
    ],
    server_only: [{ operationId: 'healthz', reason: 'sonda' }],
  };
}

function run(reg, over = {}) {
  return check({
    registry: reg,
    commands,
    capabilities,
    bindings,
    operations,
    routes,
    exists: (p) => p === 'a.test.ts',
    ...over,
  });
}

describe('check', () => {
  it('accepts a complete and consistent registry', () => {
    assert.deepEqual(run(registry()), []);
  });

  it('fails on a command no feature references', () => {
    const reg = registry();
    reg.features[0].desktop.commands = [];
    assert.deepEqual(run(reg), ['command note:new is not referenced by any feature']);
  });

  it('fails on a binding no feature references', () => {
    const reg = registry();
    reg.features[0].desktop.bindings = [];
    assert.deepEqual(run(reg), ['binding VaultAPI.WriteNote is not referenced by any feature']);
  });

  it('fails on an operation that is neither in a feature nor server_only', () => {
    const reg = registry();
    reg.server_only = [];
    assert.deepEqual(run(reg), [
      'operation healthz (GET /healthz) is not referenced by any feature nor listed in server_only',
    ]);
  });

  it('fails on references to things that do not exist', () => {
    const reg = registry();
    reg.features[0].desktop.commands.push('note:ghost');
    reg.features[0].desktop.bindings.push('VaultAPI.Ghost');
    reg.features[2].console.operationIds.push('ghostOp');
    reg.features[2].console.routes.push('/ghost');
    reg.features[0].tests.web = ['missing.spec.ts'];
    reg.server_only.push({ operationId: 'ghostProbe', reason: 'sonda' });
    const errors = run(reg);
    for (const e of [
      'feature note.create: desktop command note:ghost does not exist',
      // the workbench inherits the desktop's lists, so the dangling ones show up twice
      'feature note.create: workbench command note:ghost does not exist',
      'feature note.create: desktop binding VaultAPI.Ghost does not exist',
      'feature vault.list: console operation ghostOp is not in api/openapi.yaml',
      'feature vault.list: console route /ghost does not exist',
      'feature note.create: web test missing.spec.ts does not exist',
      'server_only: operation ghostProbe is not in api/openapi.yaml',
    ]) {
      assert.ok(errors.includes(e), `missing error: ${e}\n${errors.join('\n')}`);
    }
  });

  it('fails on a status other than yes without a reason', () => {
    const reg = registry();
    delete reg.features[1].workbench.reason;
    reg.features[2].console = { status: 'missing', reason: '  ' };
    assert.deepEqual(run(reg), [
      'feature app.updater: workbench is "exception" without a reason',
      'feature vault.list: console is "missing" without a reason',
      'operation listVaults (GET /vaults) is not referenced by any feature nor listed in server_only',
    ]);
  });

  it('fails when a surface says yes but the platform lacks what a command requires', () => {
    const reg = registry();
    reg.features[1].workbench = { status: 'yes' };
    const errors = run(reg);
    assert.ok(
      errors.includes(
        'feature app.updater: workbench is "yes" but needs capability updater, which web lacks',
      ),
    );
    assert.ok(
      errors.includes(
        'feature app.updater: workbench is "yes" but command update:check requires updater that web lacks',
      ),
    );
  });

  it('fails on duplicate ids and on console-only used for the console', () => {
    const reg = registry();
    reg.features.push({ ...reg.features[2], console: { status: 'console-only', reason: 'x y z' } });
    const errors = run(reg);
    assert.ok(errors.includes('feature vault.list: declared twice'));
    assert.ok(
      errors.includes(
        'feature vault.list: "console-only" describes desktop or workbench, not the console',
      ),
    );
  });

  it('fails when an operation is both server_only and part of a feature', () => {
    const reg = registry();
    reg.server_only.push({ operationId: 'listVaults', reason: 'sonda' });
    assert.deepEqual(run(reg), [
      'server_only: operation listVaults is also referenced by vault.list',
    ]);
  });
});

describe('effectiveFeatures', () => {
  it('gives the workbench the desktop lists it does not override', () => {
    const [f] = effectiveFeatures({
      features: [
        {
          id: 'x',
          title: 'xxx',
          desktop: { status: 'yes', commands: ['a:b'], bindings: ['S.M'], capability: 'updater' },
          workbench: { status: 'yes', bindings: [] },
        },
      ],
    });
    assert.deepEqual(f.workbench.commands, ['a:b']);
    assert.deepEqual(f.workbench.bindings, []);
    assert.equal(f.workbench.capability, 'updater');
    assert.equal(f.console, null);
  });
});

describe('inputs', () => {
  it('reads bindings, operations and nested routes', () => {
    assert.deepEqual(
      parseBindings([
        { service: 'VaultAPI', text: 'export function OpenVault(a:string):Promise<X>;\n' },
      ]),
      ['VaultAPI.OpenVault'],
    );
    assert.deepEqual(
      parseOperations({
        paths: { '/vaults': { get: { operationId: 'listVaults' }, parameters: [] } },
      }),
      [{ operationId: 'listVaults', method: 'get', path: '/vaults' }],
    );
    const tsx = `
      <Routes>
        <Route path="/auth/callback" element={<CallbackPage />} />
        <Route element={<RequireAuth />}>
          <Route index element={<Navigate to="/usage" replace />} />
          <Route path="usage" element={<UsagePage />} />
          <Route path="admin" element={<AdminLayout />}>
            <Route path="users/:id" element={<UserDetailPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Route>
      </Routes>`;
    assert.deepEqual(parseRoutes(tsx), ['/auth/callback', '/usage', '/admin', '/admin/users/:id']);
  });

  it('tells which operations the console calls', () => {
    const ops = [
      { operationId: 'listVaults', method: 'get', path: '/vaults' },
      { operationId: 'createVault', method: 'post', path: '/vaults' },
    ];
    assert.deepEqual([...consoleCalls(["client.GET('/vaults', {})"], ops)], ['listVaults']);
  });
});

describe('render', () => {
  it('produces the marked block and splices it into the document', () => {
    const block = render({
      registry: registry(),
      commands,
      bindings,
      operations,
      calledByWebTests: (b) => b === 'VaultAPI.WriteNote',
      calledByConsole: new Set(['listVaults']),
    });
    assert.ok(block.startsWith(BEGIN) && block.endsWith(END));
    assert.match(
      block,
      /\| `update:check` \| file \| no \(needs `updater`\) \| `app.updater` \| servita dal cloud \|/,
    );
    assert.match(block, /\| `healthz` \| GET `\/healthz` \| server_only: sonda \| — \|/);
    assert.match(block, /Workbench: yes 2, exception 1\./);
    const doc = `# T\n\n${BEGIN}\nold\n${END}\n\ntail\n`;
    assert.equal(splice(doc, block), `# T\n\n${block}\n\ntail\n`);
  });
});

describe('the real registry', () => {
  it('matches its JSON Schema', () => {
    const schema = JSON.parse(
      readFileSync(join(root, 'shared/parity/features.schema.json'), 'utf8'),
    );
    const reg = parse(readFileSync(join(root, 'shared/parity/features.yaml'), 'utf8'));
    const validate = new Ajv({ allErrors: true }).compile(schema);
    assert.ok(validate(reg), JSON.stringify(validate.errors, null, 2));
  });

  it('is rejected by the schema without a reason or with an unknown status', () => {
    const schema = JSON.parse(
      readFileSync(join(root, 'shared/parity/features.schema.json'), 'utf8'),
    );
    const validate = new Ajv({ allErrors: true }).compile(schema);
    const reg = registry();
    delete reg.features[1].workbench.reason;
    assert.equal(validate(reg), false);
    const other = registry();
    other.features[0].desktop.status = 'maybe';
    assert.equal(validate(other), false);
  });
});

describe('specCoverage (the e2e matrix)', () => {
  const specs = [
    { file: 'e2e/both.spec.ts', text: "test('a', () => {});\ntest('b', () => {});\n" },
    {
      file: 'e2e/mock-only.spec.ts',
      text: "skipOnWeb(\n  'mounts',\n  'drives the mock',\n);\ntest('a', () => {});\n",
    },
    {
      file: 'e2e/partial.spec.ts',
      text: "test('a', () => {\n  skipOnWeb('drawing.export', \"reads the mock's exports\");\n});\ntest('b', () => {});\n",
    },
    { file: 'e2e/bench.spec.ts', text: "test.skip(!N, 'set N');\ntest('x', () => {});\n" },
    { file: 'e2e/typo.spec.ts', text: "skipOnWeb('no.such', 'why');\n" },
  ];
  const { rows, errors } = specCoverage(specs, ['mounts', 'drawing.export']);
  const by = Object.fromEntries(rows.map((r) => [r.file, r]));

  it('tells full, partial and skipped specs apart', () => {
    assert.equal(by['e2e/both.spec.ts'].web, 'yes');
    assert.equal(by['e2e/both.spec.ts'].tests, 2);
    assert.equal(by['e2e/mock-only.spec.ts'].web, 'no');
    assert.deepEqual(by['e2e/mock-only.spec.ts'].skips, [
      { feature: 'mounts', reason: 'drives the mock', scope: 'file' },
    ]);
    assert.equal(by['e2e/partial.spec.ts'].web, 'partial (1 of 2 skipped)');
    assert.equal(by['e2e/partial.spec.ts'].skips[0].reason, "reads the mock's exports");
    assert.equal(by['e2e/bench.spec.ts'].desktop, 'opt-in');
    assert.equal(by['e2e/bench.spec.ts'].web, 'opt-in');
  });

  it('refuses a feature id that is not in the registry', () => {
    assert.deepEqual(errors, [
      "e2e/typo.spec.ts: skipOnWeb names 'no.such', which is not a feature of the registry",
    ]);
  });
});
