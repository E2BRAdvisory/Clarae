// Shared ESLint flat config for every TypeScript package in the workspace.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import { readFileSync } from 'node:fs';

// ---- Parity by construction (ADR-0045 §5) ---------------------------------------------------------
// Binding and event names are generated (web/src/workbench/core.gen.ts, packages/workbench/src/app/
// events.gen.ts): application code uses the typed client and `Events.<key>`, never the names. A name in
// a type (`EventPayloads['vault:locked']`) is allowed: the compiler checks it against the generated one.

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** The event names of the generated registry: the rule must not go blind when the file moves. */
const eventNames = (() => {
  const src = readFileSync(
    new URL('./packages/workbench/src/app/events.gen.ts', import.meta.url),
    'utf8',
  );
  const names = [...src.matchAll(/^ {2}\w+: '([a-z-]+:[a-z-]+)',$/gm)].map((m) => m[1]);
  if (names.length === 0) throw new Error('eslint.config.js: no event name in events.gen.ts');
  return names;
})();
const eventRE = `/^(?:${eventNames.map(escape).join('|')})$/`;
// A binding service ('VaultAPI') or a `Service.Method` key ('SyncAPI.Status').
const serviceRE = '/^[A-Z][A-Za-z]*API(?:\\.[A-Za-z]+)?$/';

const generatedNames = [
  {
    selector: `Literal[value=${serviceRE}]:not(TSLiteralType > Literal)`,
    message:
      'Binding names are generated: call the core through coreClient (web/src/workbench/core.gen.ts) or the facade of app/api.ts.',
  },
  {
    selector: `TemplateElement[value.cooked=${serviceRE}]`,
    message: 'Binding names are generated: use the typed client (core.gen.ts).',
  },
  {
    selector: `Literal[value=${eventRE}]:not(TSLiteralType > Literal)`,
    message:
      'Event names are generated from the Go registry: use Events.<key> (packages/workbench/src/app/events.ts).',
  },
  {
    selector: `TemplateElement[value.cooked=${eventRE}]`,
    message: 'Event names are generated from the Go registry: use Events.<key>.',
  },
];

const platformKind = '/^(?:web|desktop)$/';
const platformChecks = [
  {
    selector: `BinaryExpression[operator=/^[!=]==?$/]:matches([left.value=${platformKind}], [right.value=${platformKind}])`,
    message:
      'Do not test the platform kind: use a capability (useCan/can, packages/workbench/src/platform).',
  },
  {
    selector: `SwitchCase[test.value=${platformKind}]`,
    message:
      'Do not switch on the platform kind: use a capability (packages/workbench/src/platform).',
  },
  {
    selector:
      "MemberExpression[property.name='kind'][object.type='CallExpression'][object.callee.property.name='getState'][object.callee.object.name='usePlatform']",
    message:
      'The platform kind stays in packages/workbench/src/platform: read a capability instead.',
  },
  {
    selector: "CallExpression[callee.name='usePlatform'] MemberExpression[property.name='kind']",
    message:
      'The platform kind stays in packages/workbench/src/platform: read a capability instead.',
  },
  {
    // const { kind } = usePlatform.getState() / usePlatform((s) => s) / usePlatform()
    selector:
      "VariableDeclarator:matches([init.callee.object.name='usePlatform'], [init.callee.name='usePlatform']) > ObjectPattern > Property[key.name='kind']",
    message:
      'The platform kind stays in packages/workbench/src/platform: read a capability instead.',
  },
];

// Anywhere in the application: a `kind` compared with a platform kind.
const kindChecks = [
  {
    selector: `BinaryExpression[operator=/^[!=]==?$/]:matches([left.property.name='kind'][right.value=${platformKind}], [left.name='kind'][right.value=${platformKind}], [right.property.name='kind'][left.value=${platformKind}], [right.name='kind'][left.value=${platformKind}])`,
    message:
      'Do not test the platform kind outside packages/workbench/src/platform: use a capability.',
  },
];

// The browser host: bindings go through the typed client, only the bridge calls the core by name.
const rawCoreCalls = [
  {
    selector: "CallExpression[callee.property.name='callWithin']",
    message: 'Call the core through coreClient(core, ms) (web/src/workbench/core.gen.ts).',
  },
  {
    selector: "CallExpression[callee.object.name='core'][callee.property.name='call']",
    message: 'Call the core through coreClient(core, ms) (web/src/workbench/core.gen.ts).',
  },
  {
    selector: 'MemberExpression[computed=true][property.value=/^(?:call|callWithin)$/]',
    message: 'Call the core through coreClient(core, ms) (web/src/workbench/core.gen.ts).',
  },
];

// ---- The cloud lifecycle goes through the CloudPort (ADR-0045 §7) ---------------------------------
// Vaults, devices, usage, shares, grants, invitations, mounts, directory and groups are managed by
// the components of @memobrain/cloud-features over a CloudPort: RestCloudPort in the console,
// CoreCloudPort in the desktop and the workbench. The hosts never call those APIs themselves, so a
// function cannot drift on one surface. What only the console does (the ZIP export of VaultExport:
// /vaults/{vaultId}/tree, /blobs, /key-envelopes, /export.zip, /exports) is not part of the port and
// stays allowed: the forbidden paths are listed one by one, the others pass.

/** The REST operations of the port (paths of api/openapi.yaml). */
const portPath =
  '(?:vaults(?:\\/\\{vaultId\\}(?::restore)?)?|me\\/(?:devices(?:\\/\\{deviceId\\})?|usage|groups)|shares(?:\\/\\{shareId\\}(?::accept|:decline|\\/grants\\/.*)?)?|shared-with-me|directory\\/(?:users|groups))';
const consoleRestCalls = [
  {
    // api.GET('/vaults'), client.POST('/shares', …): the two paths that are also console routes.
    // (Also `const { GET } = api`, `api.request('get', …)` and a template without placeholders.)
    selector:
      'CallExpression:matches([callee.property.name=/^(?:GET|POST|PUT|PATCH|DELETE|request)$/], [callee.name=/^(?:GET|POST|PUT|PATCH|DELETE)$/]) > :matches(Literal[value=/^\\/(?:vaults|shares)$/], TemplateLiteral[expressions.length=0][quasis.0.value.cooked=/^\\/(?:vaults|shares)$/]).arguments',
    message:
      'The cloud vault lifecycle goes through the CloudPort (useCloudPort, @memobrain/cloud-features), not through the REST client (ADR-0045 §7).',
  },
  {
    // Any other path of the port, in a call or kept in a variable first.
    selector: `:matches(Literal[value=/^\\/${portPath}$/], TemplateLiteral[expressions.length=0] > TemplateElement[value.cooked=/^\\/${portPath}$/]):not([value=/^\\/(?:vaults|shares)$/], [value.cooked=/^\\/(?:vaults|shares)$/]):not(TSLiteralType > Literal)`,
    message:
      'This is a REST path of the CloudPort: use the port (@memobrain/cloud-features), not the REST client (ADR-0045 §7).',
  },
  {
    // fetch('/api/v1/shares?scope=received'), `${base}/api/v1/me/devices`
    selector: `:matches(Literal[value=/\\/api\\/v1\\/${portPath}(?:[/?:]|$)/], TemplateElement[value.cooked=/\\/api\\/v1\\/${portPath}(?:[/?:]|$)/])`,
    message:
      'The cloud vault lifecycle goes through the CloudPort, not through fetch (ADR-0045 §7).',
  },
];

// In the workbench's settings and sharing panels the cloud lifecycle goes through CoreCloudPort
// (packages/workbench/src/cloud): its bindings are never called by the panels themselves.
const cloudBindings = '/^(?:\\w*CloudVaults?|devices|revokeDevice|usage)$/';
const workbenchCloudCalls = [
  {
    selector: "MemberExpression[object.name='api'][property.name='sharing']",
    message:
      'Sharing goes through CoreCloudPort (packages/workbench/src/cloud/CoreCloudPort.ts), the CloudPort of the workbench (ADR-0045 §7).',
  },
  {
    selector: `MemberExpression[object.object.name='api'][object.property.name='sync'][property.name=${cloudBindings}]`,
    message:
      'Cloud vaults, devices and usage go through CoreCloudPort, the CloudPort of the workbench (ADR-0045 §7).',
  },
  {
    selector:
      "MemberExpression[object.name='api'][computed=true], VariableDeclarator[init.name='api'] > ObjectPattern, VariableDeclarator > MemberExpression.init[object.name='api'][property.name=/^(?:sync|sharing)$/]",
    message:
      'Do not alias the binding facade here: name the binding (api.sync.<method>), or use CoreCloudPort for the cloud lifecycle (ADR-0045 §7).',
  },
  {
    // window.go.app.SharingAPI.…: the bindings without the facade.
    selector: "MemberExpression[object.property.name='app'][property.name=/^[A-Z]\\w*API$/]",
    message:
      'Call the core through the facade of app/api.ts or CoreCloudPort, not window.go (ADR-0045 §7).',
  },
  {
    selector: 'ImportDeclaration[source.value=/wailsjs\\/go\\/app\\//]',
    message:
      'Call the core through the facade of app/api.ts or CoreCloudPort, not the generated modules.',
  },
];

const appSources = [
  'packages/*/src/**/*.{ts,tsx}',
  'apps/desktop/frontend/src/**/*.{ts,tsx}',
  'web/src/**/*.{ts,tsx}',
];
const testSources = ['**/*.test.{ts,tsx}'];
const uiSources = [
  'packages/workbench/src/**/*.{ts,tsx}',
  'apps/desktop/frontend/src/**/*.{ts,tsx}',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      // Local scratch (git-ignored): e2e-matrix/e2e-mixed builds and module copies, perf datasets.
      '.dev/**',
      '.perf/**',
      '**/dist-*/**',
      '**/dist/**',
      '**/dist-e2e/**',
      'build/wasm/**',
      '**/build/bin/**',
      '**/wailsjs/**',
      '**/*.gen.ts',
      '**/src/gen/**',
      'apps/desktop/frontend/dist/**',
      '**/test-results/**',
      'services/cloud/test/load/**',
      '**/playwright-report/**',
      // Local copies of the repository made by tooling (git-ignored, not part of the workspace).
      '.delta/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  // ADR-0045 §5. One `no-restricted-syntax` per file (a later block replaces an earlier one): the UI
  // gets both lists, the rest of the application code the generated names only.
  {
    files: appSources,
    ignores: [...testSources, ...uiSources],
    rules: { 'no-restricted-syntax': ['error', ...generatedNames, ...kindChecks] },
  },
  {
    // The console (everything of web/src but the workbench's host).
    files: ['web/src/**/*.{ts,tsx}'],
    ignores: [...testSources, 'web/src/workbench/**'],
    rules: {
      'no-restricted-syntax': ['error', ...generatedNames, ...kindChecks, ...consoleRestCalls],
    },
  },
  {
    files: ['web/src/workbench/**/*.{ts,tsx}'],
    ignores: [...testSources, 'web/src/workbench/bridge.ts'],
    rules: { 'no-restricted-syntax': ['error', ...generatedNames, ...kindChecks, ...rawCoreCalls] },
  },
  {
    files: uiSources,
    ignores: [...testSources, 'packages/workbench/src/platform/**'],
    rules: { 'no-restricted-syntax': ['error', ...generatedNames, ...platformChecks] },
  },
  {
    files: [
      'packages/workbench/src/settings/**/*.{ts,tsx}',
      'packages/workbench/src/sharing/**/*.{ts,tsx}',
    ],
    ignores: testSources,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...generatedNames,
        ...platformChecks,
        ...workbenchCloudCalls,
      ],
    },
  },
  {
    files: ['packages/workbench/src/platform/**/*.{ts,tsx}'],
    ignores: testSources,
    rules: { 'no-restricted-syntax': ['error', ...generatedNames] },
  },
  prettier,
);
