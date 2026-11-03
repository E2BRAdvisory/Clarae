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
  UNVERIFIED,
  capabilityUses,
  check,
  consoleActions,
  consoleCalls,
  coreSpecs,
  effectiveFeatures,
  isWorkbenchProof,
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
const WB = 'web/e2e/workbench.spec.ts';
const MATRIX = 'apps/desktop/frontend/e2e/cloud-vaults.spec.ts';
/** A spec of the e2e matrix that runs on the web, and one skipped there for vault.list. */
const matrix = [
  { file: MATRIX, tests: 2, desktop: 'yes', web: 'yes', skips: [] },
  {
    file: 'apps/desktop/frontend/e2e/mock-only.spec.ts',
    tests: 1,
    desktop: 'yes',
    web: 'no',
    skips: [{ feature: 'vault.list', reason: 'drives the mock', scope: 'file' }],
  },
];
const files = new Set(['a.test.ts', WB, MATRIX, 'apps/desktop/frontend/e2e/mock-only.spec.ts']);

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
        tests: { desktop: ['a.test.ts'], workbench: [WB] },
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
        console: {
          status: 'yes',
          routes: ['/vaults'],
          operationIds: ['listVaults'],
          actions: ['sign-out'],
        },
        tests: { desktop: [MATRIX], workbench: [MATRIX] },
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
    exists: (p) => files.has(p),
    core: new Set([WB]),
    matrix,
    consoleOperations: new Set(['listVaults']),
    consoleActions: ['sign-out'],
    capabilityUses: new Set(['localFolders']),
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
    reg.features[0].tests.workbench.push('missing.spec.ts');
    reg.server_only.push({ operationId: 'ghostProbe', reason: 'sonda' });
    const errors = run(reg);
    for (const e of [
      'feature note.create: desktop command note:ghost does not exist',
      // the workbench inherits the desktop's lists, so the dangling ones show up twice
      'feature note.create: workbench command note:ghost does not exist',
      'feature note.create: desktop binding VaultAPI.Ghost does not exist',
      'feature vault.list: console operation ghostOp is not in api/openapi.yaml',
      'feature vault.list: console route /ghost does not exist',
      'feature note.create: workbench test missing.spec.ts does not exist',
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
      'console route /vaults is not cited by any feature',
      "operation listVaults, which the console calls, is not cited by any feature's console",
      'console action sign-out is not cited by any feature',
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

  it('refuses a workbench "yes" without a proof on the WebAssembly core', () => {
    const reg = registry();
    // A unit test of the web host is a workbench test, not a proof on the core.
    files.add('web/src/workbench/guard.test.ts');
    reg.features[0].tests.workbench = ['web/src/workbench/guard.test.ts'];
    const errors = run(reg);
    assert.equal(errors.length, 1);
    assert.match(
      errors[0],
      /^feature note\.create: workbench is "yes" without a test on the WebAssembly core/,
    );
    // The same feature, honestly partial, passes.
    reg.features[0].workbench = { status: 'partial', reason: `${UNVERIFIED}: nessun test` };
    assert.deepEqual(run(reg), []);
  });

  it('does not count a matrix spec that is skipped on the web for the feature', () => {
    const reg = registry();
    reg.features[2].tests.desktop = ['apps/desktop/frontend/e2e/mock-only.spec.ts'];
    reg.features[2].tests.workbench = ['apps/desktop/frontend/e2e/mock-only.spec.ts'];
    assert.deepEqual(run(reg), [
      'feature vault.list: apps/desktop/frontend/e2e/mock-only.spec.ts is skipped on the web (skipOnWeb) and the workbench is "yes": name an alternative test on the WebAssembly core in tests.workbench',
    ]);
    const partial = registry();
    partial.features[2].tests.workbench = [MATRIX];
    const skipped = [
      {
        ...matrix[0],
        web: 'partial (1 of 2 skipped)',
        skips: [{ feature: 'vault.list', reason: 'mock', scope: 'test' }],
      },
    ];
    assert.match(run(partial, { matrix: skipped })[0], /workbench is "yes" without a test/);
  });

  it('refuses "not verified on the web" once a proof exists', () => {
    const reg = registry();
    reg.features[0].workbench = { status: 'partial', reason: `${UNVERIFIED}: nessun test` };
    assert.deepEqual(run(reg), [
      `feature note.create: workbench is "partial" (${UNVERIFIED}) but ${WB} proves it on the WebAssembly core: set it to "yes"`,
    ]);
  });

  it('wants a spec of the matrix on the desktop too', () => {
    const reg = registry();
    reg.features[2].tests.desktop = [];
    assert.deepEqual(run(reg), [
      `feature vault.list: ${MATRIX} is a spec of the e2e matrix: list it in tests.desktop too (it runs on the desktop mock as well)`,
    ]);
  });

  it('refuses a test filed under the wrong surface', () => {
    const reg = registry();
    files.add('web/src/pages/Vaults.test.tsx');
    reg.features[2].tests.workbench.push('web/src/pages/Vaults.test.tsx');
    assert.deepEqual(run(reg), [
      'feature vault.list: web/src/pages/Vaults.test.tsx is not a workbench test',
    ]);
  });

  it('wants every console route, called operation and action cited', () => {
    const errors = run(registry(), {
      routes: ['/vaults', '/admin'],
      consoleOperations: new Set(['listVaults', 'healthz']),
      consoleActions: ['sign-out', 'forget-browser'],
    });
    assert.deepEqual(errors, [
      'console route /admin is not cited by any feature',
      "operation healthz, which the console calls, is not cited by any feature's console",
      'console action forget-browser is not cited by any feature',
    ]);
    assert.deepEqual(run(registry(), { consoleActions: [] }), [
      'feature vault.list: console action sign-out is not a data-action of the console',
    ]);
  });

  it('refuses a capability that nothing reads', () => {
    assert.deepEqual(run(registry(), { capabilityUses: new Set() }), [
      'capability localFolders has no consumer (can, useCan or Command.requires)',
    ]);
  });

  it('needs every input, so that no rule passes on nothing', () => {
    assert.throws(() => run(registry(), { matrix: undefined }), /input matrix is missing/);
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

describe('proofs and consumers', () => {
  it('tells the browser specs that run the core', () => {
    const core = coreSpecs([
      { file: 'web/e2e/workbench.spec.ts', text: 'await page.goto(`/vaults/${v}/open?local`);' },
      { file: 'web/e2e/vaults.spec.ts', text: "await page.route('**/vaults/new/open**', f);" },
      { file: 'web/e2e-cloud/web-sync.spec.ts', text: 'await openVault(page);' },
      { file: 'web/e2e/admin.spec.ts', text: "await page.goto('/admin');" },
    ]);
    assert.deepEqual([...core].sort(), [
      'web/e2e-cloud/web-sync.spec.ts',
      'web/e2e/workbench.spec.ts',
    ]);
  });

  it('counts a matrix spec only where it runs on the web for the feature', () => {
    const evidence = { core: new Set(), matrix };
    assert.equal(isWorkbenchProof(MATRIX, 'vault.list', evidence), true);
    assert.equal(
      isWorkbenchProof('apps/desktop/frontend/e2e/mock-only.spec.ts', 'x', evidence),
      false,
    );
    const bench = [{ file: 'b.spec.ts', tests: 1, desktop: 'opt-in', web: 'opt-in', skips: [] }];
    assert.equal(isWorkbenchProof('b.spec.ts', 'x', { core: new Set(), matrix: bench }), false);
    assert.equal(isWorkbenchProof('web/src/workbench/guard.test.ts', 'x', evidence), false);
  });

  it('reads the capabilities the UI uses and the console actions', () => {
    assert.deepEqual(
      [...capabilityUses(["const a = useCan('multiVault');", "if (can( 'osTrash' )) x();"])].sort(),
      ['multiVault', 'osTrash'],
    );
    assert.deepEqual(
      consoleActions(['<Button data-action="sign-out" />', '<select data-action="theme">']),
      ['sign-out', 'theme'],
    );
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
      specs: matrix,
      core: new Set([WB]),
    });
    assert.ok(block.startsWith(BEGIN) && block.endsWith(END));
    assert.match(
      block,
      /\| `update:check` \| file \| no \(needs `updater`\) \| `app.updater` \| servita dal cloud \|/,
    );
    assert.match(block, /\| `healthz` \| GET `\/healthz` \| server_only: sonda \| — \|/);
    assert.match(block, /Workbench: yes 2, exception 1\./);
    // Tests by surface, the proofs on the core in bold.
    assert.match(block, /D: `a\.test\.ts` · W: \*\*`workbench\.spec\.ts`\*\*/);
    assert.match(block, /2 funzioni hanno almeno una prova sul core/);
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
