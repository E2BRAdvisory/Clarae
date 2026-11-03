// Pure logic of the parity check (ADR-0037): parsing of the inputs, validation of the feature
// registry (shared/parity/features.yaml) against what exists, and rendering of the generated part
// of docs/web-workbench-parity.md. No file system or process access here: scripts/parity.mjs
// gathers the inputs, scripts/parity/lib.test.mjs exercises the rules.

/** Statuses of a surface; `console-only` applies to desktop and workbench only. */
export const STATUSES = ['yes', 'partial', 'exception', 'console-only', 'missing'];

/** The two client surfaces and the platform (configurePlatform kind) each one runs on. */
export const CLIENTS = [
  { surface: 'desktop', platform: 'desktop' },
  { surface: 'workbench', platform: 'web' },
];

/**
 * The surfaces of the tests of a feature (ADR-0045 §4) and where their files may live:
 *  - desktop: the UI (packages/workbench), the e2e specs on the Wails mock and the Go core;
 *  - workbench: the web host (web/src/workbench), the browser specs (web/e2e*) and the specs of the
 *    e2e matrix (apps/desktop/frontend/e2e, which run on the WebAssembly core too);
 *  - console: the console (web/src outside the workbench, web/e2e, the REST adapter of
 *    packages/cloud-features);
 *  - cloud: services/cloud.
 */
export const TEST_SURFACES = {
  desktop: /^(?!web\/|services\/)/,
  workbench:
    /^(web\/(e2e|e2e-cloud|e2e-mixed|e2e-security)\/|web\/src\/workbench\/|apps\/desktop\/frontend\/e2e\/)/,
  console: /^(web\/(e2e|e2e-security)\/|web\/src\/(?!workbench\/)|packages\/cloud-features\/)/,
  cloud: /^services\/cloud\//,
};

/**
 * How a workbench `partial` that only lacks a proof begins its reason: the check refuses it once a
 * proof exists (the status must then be `yes`).
 */
export const UNVERIFIED = 'non verificata sul web';

/** Browser specs that always run the workbench on the core, against a real cloud. */
const REAL_CLOUD_SPECS = /^web\/(e2e-cloud|e2e-mixed)\/.+\.spec\.ts$/;
/** A browser spec that opens the workbench page (`/vaults/<id>/open`) runs the WebAssembly core. */
const OPENS_WORKBENCH = /\.goto\(\s*[`'"][^`'"]*\/vaults\/[^`'"]*\/open\b/;

/**
 * The browser specs of web/e2e* that run the WebAssembly core: [{ file, text }] → Set of files.
 * The specs of web/e2e-cloud and web/e2e-mixed always do; the others when they open the workbench
 * page (a console spec that only intercepts the address does not).
 */
export function coreSpecs(specs) {
  return new Set(
    specs
      .filter((s) => REAL_CLOUD_SPECS.test(s.file) || OPENS_WORKBENCH.test(s.text))
      .map((s) => s.file),
  );
}

/**
 * Whether a test of `tests.workbench` proves the feature `featureId` on the WebAssembly core: a
 * browser spec that runs the core (`core`: coreSpecs), or a spec of the e2e matrix (`matrix`: the
 * rows of specCoverage) that runs on web-core for that feature: not skipped at file level, not an
 * opt-in benchmark, and without a skipOnWeb naming the feature (a spec whose tests of the feature
 * are skipped is not a proof of it, even when its other tests run).
 */
export function isWorkbenchProof(file, featureId, { core, matrix }) {
  if (core.has(file)) return true;
  const row = matrix.find((r) => r.file === file);
  if (!row || row.desktop === 'opt-in' || row.web === 'opt-in' || row.web === 'no') return false;
  return !row.skips.some((s) => s.feature === featureId);
}

/** The capabilities the UI reads: `can('x')`, `useCan('x')` in the given sources. */
export function capabilityUses(sources) {
  const used = new Set();
  for (const text of sources)
    for (const m of text.matchAll(/\b(?:useCan|can)\(\s*['"](\w+)['"]\s*\)/g)) used.add(m[1]);
  return used;
}

/**
 * The actions of the console marked `data-action="<id>"` in its sources (no duplicates). The
 * workbench declares its actions instead (defineAction, packages/workbench/src/commands/actions.ts),
 * read at runtime with the commands; the console keeps this marker until it adopts them.
 */
export function consoleActions(sources) {
  const out = new Set();
  for (const text of sources)
    for (const m of text.matchAll(/\bdata-action="([a-z][a-z0-9-]*)"/g)) out.add(m[1]);
  return [...out].sort();
}

// ---- inputs -----------------------------------------------------------------------------------

/** Methods of the generated Wails bindings: [{ service, text }] → ["Service.Method"]. */
export function parseBindings(files) {
  const out = [];
  for (const { service, text } of files) {
    for (const m of text.matchAll(/^export function (\w+)\(/gm)) out.push(`${service}.${m[1]}`);
  }
  return out;
}

const METHODS = ['get', 'put', 'post', 'patch', 'delete', 'head', 'options'];

/** Operations of an OpenAPI document (already parsed): [{ operationId, method, path }]. */
export function parseOperations(doc) {
  const out = [];
  for (const [path, item] of Object.entries(doc?.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method];
      if (op?.operationId) out.push({ operationId: op.operationId, method, path });
    }
  }
  return out;
}

/**
 * Full paths of the console routes declared with react-router's <Route> elements, nested routes
 * included ("admin" inside "/" → "/admin/users"). Index and catch-all routes are left out.
 */
export function parseRoutes(tsx) {
  const routes = [];
  const stack = [''];
  for (const m of tsx.matchAll(/<Route\b|<\/Route>/g)) {
    if (m[0] === '</Route>') {
      stack.pop();
      continue;
    }
    // The opening tag ends at the first ">" outside JSX expressions (element={<Page />}).
    let i = m.index + m[0].length;
    let depth = 0;
    for (; i < tsx.length; i++) {
      const ch = tsx[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
    }
    const attrs = tsx.slice(m.index + m[0].length, i);
    const selfClosing = attrs.trimEnd().endsWith('/');
    const path = /\bpath="([^"]*)"/.exec(attrs.replace(/\{[^{}]*\}/g, ''))?.[1];
    const parent = stack[stack.length - 1] ?? '';
    let full = parent;
    if (path !== undefined) {
      full = path.startsWith('/') ? path : `${parent.replace(/\/$/, '')}/${path}`;
      if (path !== '*') routes.push(full);
    }
    if (!selfClosing) stack.push(full);
  }
  return [...new Set(routes)];
}

/**
 * The operations the console calls: openapi-fetch calls such as `.GET('/vaults/{vaultId}/tree'`
 * in the given sources, matched against the method and path of each operation.
 */
export function consoleCalls(sources, operations) {
  const seen = new Set();
  for (const text of sources) {
    for (const m of text.matchAll(/\.(GET|PUT|POST|PATCH|DELETE)\(\s*'([^']+)'/g)) {
      seen.add(`${m[1].toLowerCase()} ${m[2]}`);
    }
  }
  return new Set(
    operations.filter((o) => seen.has(`${o.method} ${o.path}`)).map((o) => o.operationId),
  );
}

// ---- the registry -----------------------------------------------------------------------------

const list = (v) => (Array.isArray(v) ? v : []);

/**
 * The registry with the workbench completed: a workbench surface that does not list commands,
 * actions, bindings, operations or a capability has the desktop's (same UI, same core: ADR-0029).
 */
export function effectiveFeatures(registry) {
  return list(registry?.features).map((f) => {
    const desktop = f.desktop ?? {};
    const wb = f.workbench ?? {};
    const inherit = (key) => (wb[key] !== undefined ? wb[key] : desktop[key]);
    return {
      ...f,
      desktop: {
        ...desktop,
        commands: list(desktop.commands),
        actions: list(desktop.actions),
        bindings: list(desktop.bindings),
        operationIds: list(desktop.operationIds),
      },
      workbench: {
        ...wb,
        commands: list(inherit('commands')),
        actions: list(inherit('actions')),
        bindings: list(inherit('bindings')),
        operationIds: list(inherit('operationIds')),
        capability: inherit('capability'),
      },
      console: f.console
        ? {
            ...f.console,
            routes: list(f.console.routes),
            operationIds: list(f.console.operationIds),
            actions: list(f.console.actions),
          }
        : null,
      tests: Object.fromEntries(Object.keys(TEST_SURFACES).map((k) => [k, list(f.tests?.[k])])),
    };
  });
}

/** Which features reference each command, action, binding and operation. */
export function references(features) {
  const commands = new Map();
  const actions = new Map();
  const bindings = new Map();
  const operations = new Map();
  const add = (map, key, id) => {
    if (!map.has(key)) map.set(key, []);
    if (!map.get(key).includes(id)) map.get(key).push(id);
  };
  for (const f of features) {
    for (const s of ['desktop', 'workbench']) {
      for (const c of f[s].commands) add(commands, c, f.id);
      for (const a of f[s].actions) add(actions, a, f.id);
      for (const b of f[s].bindings) add(bindings, b, f.id);
      for (const o of f[s].operationIds) add(operations, o, f.id);
    }
    for (const o of f.console?.operationIds ?? []) add(operations, o, f.id);
  }
  return { commands, actions, bindings, operations };
}

/** The tests of `tests.workbench` of a feature that prove it on the WebAssembly core. */
export function proofsOf(f, evidence) {
  return f.tests.workbench.filter((t) => isWorkbenchProof(t, f.id, evidence));
}

/**
 * Every rule of `parity --check` except the schema and the freshness of the document.
 * `inputs`: { registry, commands: [{id, feature, platforms, requires}], actions: the declarative
 * actions of the workbench [{id, feature, platforms, requires, excludes}], capabilities: {desktop, web},
 * bindings: [], operations: [{operationId}], routes: [], exists(path),
 * core: Set of browser specs that run the WebAssembly core (coreSpecs), matrix: rows of
 * specCoverage, consoleOperations: Set of the operationIds the console calls (consoleCalls),
 * consoleActions: the `data-action` ids of the console (consoleActions), capabilityUses: Set of the
 * capabilities read by the UI (capabilityUses) } → list of error messages. Every input is required:
 * a rule with nothing to look at would pass without checking anything.
 */
export function check(inputs) {
  const { registry, commands, capabilities, bindings, operations, routes, exists } = inputs;
  for (const k of [
    'actions',
    'core',
    'matrix',
    'consoleOperations',
    'consoleActions',
    'capabilityUses',
  ])
    if (!inputs[k]) throw new Error(`check: input ${k} is missing`);
  const evidence = { core: inputs.core, matrix: inputs.matrix };
  const errors = [];
  const features = effectiveFeatures(registry);
  const commandById = new Map(commands.map((c) => [c.id, c]));
  const actionById = new Map(inputs.actions.map((a) => [a.id, a]));
  const bindingSet = new Set(bindings);
  const opSet = new Set(operations.map((o) => o.operationId));
  const routeSet = new Set(routes);

  // Unique feature ids.
  const ids = new Set();
  for (const f of features) {
    if (ids.has(f.id)) errors.push(`feature ${f.id}: declared twice`);
    ids.add(f.id);
  }

  for (const f of features) {
    const where = `feature ${f.id}`;
    // A status other than yes says why.
    for (const s of ['desktop', 'workbench', 'console']) {
      const surface = f[s];
      if (!surface) continue;
      if (surface.status !== 'yes' && !String(surface.reason ?? '').trim()) {
        errors.push(`${where}: ${s} is "${surface.status}" without a reason`);
      }
    }
    if (f.console?.status === 'console-only') {
      errors.push(`${where}: "console-only" describes desktop or workbench, not the console`);
    }
    // References to things that exist.
    for (const s of ['desktop', 'workbench']) {
      for (const c of f[s].commands) {
        if (!commandById.has(c)) errors.push(`${where}: ${s} command ${c} does not exist`);
      }
      for (const a of f[s].actions) {
        if (!actionById.has(a)) errors.push(`${where}: ${s} action ${a} does not exist`);
      }
      for (const b of f[s].bindings) {
        if (!bindingSet.has(b)) errors.push(`${where}: ${s} binding ${b} does not exist`);
      }
      for (const o of f[s].operationIds) {
        if (!opSet.has(o)) errors.push(`${where}: ${s} operation ${o} is not in api/openapi.yaml`);
      }
      const cap = f[s].capability;
      if (cap && capabilities.desktop && !(cap in capabilities.desktop)) {
        errors.push(`${where}: ${s} capability ${cap} is not a capability of the platform layer`);
      }
    }
    for (const o of f.console?.operationIds ?? []) {
      if (!opSet.has(o)) errors.push(`${where}: console operation ${o} is not in api/openapi.yaml`);
    }
    for (const r of f.console?.routes ?? []) {
      if (!routeSet.has(r)) errors.push(`${where}: console route ${r} does not exist`);
    }
    for (const [kind, place] of Object.entries(TEST_SURFACES)) {
      for (const t of f.tests[kind]) {
        if (!exists(t)) errors.push(`${where}: ${kind} test ${t} does not exist`);
        else if (!place.test(t)) errors.push(`${where}: ${t} is not a ${kind} test`);
      }
    }
    // A surface that says yes really offers the function on its platform.
    for (const { surface, platform } of CLIENTS) {
      const s = f[surface];
      if (s.status !== 'yes') continue;
      const cap = s.capability;
      if (cap && capabilities[platform] && capabilities[platform][cap] === false) {
        errors.push(
          `${where}: ${surface} is "yes" but needs capability ${cap}, which ${platform} lacks`,
        );
      }
      for (const c of s.commands) {
        const cmd = commandById.get(c);
        if (cmd && cmd.platforms && cmd.platforms[platform] === false) {
          errors.push(
            `${where}: ${surface} is "yes" but command ${c} requires ${cmd.requires?.join(', ') || 'a capability'} that ${platform} lacks`,
          );
        }
      }
      for (const a of s.actions) {
        const act = actionById.get(a);
        if (act && act.platforms && act.platforms[platform] === false) {
          const needs = [
            ...(act.requires ?? []).map((x) => `needs ${x}`),
            ...(act.excludes ?? []).map((x) => `is offered only without ${x}`),
          ].join(', ');
          errors.push(
            `${where}: ${surface} is "yes" but action ${a} is not offered on ${platform} (${needs || 'capabilities'})`,
          );
        }
      }
    }
  }

  // The workbench (ADR-0045 §4): "yes" is proved on the WebAssembly core; a spec of the matrix
  // skipped on the web for a feature that says "yes" has an alternative; "not verified" goes once
  // there is a proof.
  const skippedWhole = new Map();
  for (const r of inputs.matrix)
    for (const x of r.skips)
      if (x.scope === 'file' && !skippedWhole.has(x.feature)) skippedWhole.set(x.feature, r.file);
  for (const f of features) {
    const where = `feature ${f.id}`;
    const proofs = proofsOf(f, evidence);
    const status = f.workbench.status;
    // A spec of the matrix is the same test on both targets: it runs on the desktop mock first.
    for (const t of f.tests.workbench)
      if (inputs.matrix.some((r) => r.file === t) && !f.tests.desktop.includes(t))
        errors.push(
          `${where}: ${t} is a spec of the e2e matrix: list it in tests.desktop too (it runs on the desktop mock as well)`,
        );
    if (status === 'yes' && proofs.length === 0) {
      if (skippedWhole.has(f.id))
        errors.push(
          `${where}: ${skippedWhole.get(f.id)} is skipped on the web (skipOnWeb) and the workbench is "yes": name an alternative test on the WebAssembly core in tests.workbench`,
        );
      else
        errors.push(
          `${where}: workbench is "yes" without a test on the WebAssembly core in tests.workbench (a browser spec that opens the workbench, a spec of the e2e matrix that runs on the web for it, web/e2e-cloud or web/e2e-mixed); otherwise it is "partial" with the reason "${UNVERIFIED}: …"`,
        );
    }
    if (
      status === 'partial' &&
      String(f.workbench.reason ?? '').startsWith(UNVERIFIED) &&
      proofs.length
    )
      errors.push(
        `${where}: workbench is "partial" (${UNVERIFIED}) but ${proofs.join(', ')} proves it on the WebAssembly core: set it to "yes"`,
      );
  }

  // The console (ADR-0045 §4): every route, every operation it calls and every action is cited.
  const cited = { routes: new Set(), operations: new Set(), actions: new Set() };
  for (const f of features) {
    for (const r of f.console?.routes ?? []) cited.routes.add(r);
    for (const o of f.console?.operationIds ?? []) cited.operations.add(o);
    for (const a of f.console?.actions ?? []) cited.actions.add(a);
  }
  for (const r of routes)
    if (!cited.routes.has(r)) errors.push(`console route ${r} is not cited by any feature`);
  for (const o of [...inputs.consoleOperations].sort())
    if (!cited.operations.has(o))
      errors.push(`operation ${o}, which the console calls, is not cited by any feature's console`);
  const actions = new Set(inputs.consoleActions);
  for (const a of actions)
    if (!cited.actions.has(a)) errors.push(`console action ${a} is not cited by any feature`);
  for (const f of features)
    for (const a of f.console?.actions ?? [])
      if (!actions.has(a))
        errors.push(`feature ${f.id}: console action ${a} is not a data-action of the console`);

  // A capability that nothing reads gates nothing (ADR-0045 §1).
  const consumed = new Set(inputs.capabilityUses);
  for (const c of commands) for (const r of c.requires ?? []) consumed.add(r);
  for (const a of inputs.actions)
    for (const r of [...(a.requires ?? []), ...(a.excludes ?? [])]) consumed.add(r);
  for (const cap of Object.keys(capabilities.desktop ?? {}))
    if (!consumed.has(cap))
      errors.push(
        `capability ${cap} has no consumer (can, useCan, Command.requires or an action's requires/excludes)`,
      );

  // Coverage: everything that exists is part of some feature.
  const refs = references(features);
  for (const c of commands) {
    if (!refs.commands.has(c.id)) errors.push(`command ${c.id} is not referenced by any feature`);
  }
  for (const a of inputs.actions) {
    if (!refs.actions.has(a.id)) errors.push(`action ${a.id} is not referenced by any feature`);
    if (commandById.has(a.id)) errors.push(`action ${a.id} has the id of a command`);
  }
  // The feature a command or an action declares (ADR-0045 §3) is one that lists it: the two
  // sides of the mapping cannot drift apart.
  for (const [kind, items, map] of [
    ['command', commands, refs.commands],
    ['action', inputs.actions, refs.actions],
  ]) {
    for (const x of items) {
      if (!x.feature) errors.push(`${kind} ${x.id} declares no feature`);
      else if (!ids.has(x.feature))
        errors.push(`${kind} ${x.id} declares feature ${x.feature}, which is not in the registry`);
      else if (map.has(x.id) && !map.get(x.id).includes(x.feature))
        errors.push(
          `${kind} ${x.id} declares feature ${x.feature}, but it is listed by ${map.get(x.id).join(', ')}`,
        );
    }
  }
  for (const b of bindings) {
    if (!refs.bindings.has(b)) errors.push(`binding ${b} is not referenced by any feature`);
  }
  const serverOnly = new Map();
  for (const s of list(registry?.server_only)) {
    if (!opSet.has(s.operationId)) {
      errors.push(`server_only: operation ${s.operationId} is not in api/openapi.yaml`);
    }
    if (!String(s.reason ?? '').trim()) {
      errors.push(`server_only: operation ${s.operationId} without a reason`);
    }
    if (refs.operations.has(s.operationId)) {
      errors.push(
        `server_only: operation ${s.operationId} is also referenced by ${refs.operations.get(s.operationId).join(', ')}`,
      );
    }
    serverOnly.set(s.operationId, s);
  }
  for (const o of operations) {
    if (!refs.operations.has(o.operationId) && !serverOnly.has(o.operationId)) {
      errors.push(
        `operation ${o.operationId} (${o.method.toUpperCase()} ${o.path}) is not referenced by any feature nor listed in server_only`,
      );
    }
  }
  return errors;
}

/** Schema errors of ajv as readable lines. */
export function formatSchemaErrors(errors) {
  return (errors ?? []).map(
    (e) =>
      `features.yaml${e.dataPath || e.instancePath || ''}: ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`,
  );
}

// ---- the generated document -------------------------------------------------------------------

export const BEGIN = '<!-- parity:begin (generated by scripts/parity.mjs; do not edit) -->';
export const END = '<!-- parity:end -->';

const cell = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n+/g, ' ');

function table(rows, head) {
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

const base = (p) => p.split('/').pop();
const code = (s) => `\`${s}\``;

function statusCount(features, surface) {
  const counts = {};
  for (const f of features) {
    const st = f[surface]?.status ?? 'n/a';
    counts[st] = (counts[st] ?? 0) + 1;
  }
  return [...STATUSES, 'n/a']
    .filter((s) => counts[s])
    .map((s) => `${s} ${counts[s]}`)
    .join(', ');
}

function reasons(f) {
  const out = [];
  for (const s of ['desktop', 'workbench', 'console']) {
    const surface = f[s];
    if (surface && surface.status !== 'yes' && surface.reason) out.push(`${s}: ${surface.reason}`);
    if (surface?.note) out.push(`${s} (nota): ${surface.note}`);
  }
  if (f.notes) out.push(f.notes);
  return out.join(' — ');
}

function tests(f, evidence) {
  const parts = [];
  for (const [k, label] of [
    ['desktop', 'D'],
    ['workbench', 'W'],
    ['console', 'K'],
    ['cloud', 'C'],
  ]) {
    if (!f.tests[k].length) continue;
    // A proof on the WebAssembly core is in bold.
    const name = (t) =>
      k === 'workbench' && isWorkbenchProof(t, f.id, evidence)
        ? `**${code(base(t))}**`
        : code(base(t));
    parts.push(`${label}: ${f.tests[k].map(name).join(', ')}`);
  }
  return parts.join(' · ') || '—';
}

/**
 * Coverage of the e2e matrix (web/playwright.workbench-ui.config.ts, P7 of the W8 review): every spec
 * of apps/desktop/frontend/e2e runs on the desktop mock and on the web core, unless it calls
 * `skipOnWeb('<feature id>', '<reason>')` (e2e/support.ts): at file level (not indented) the whole
 * spec is skipped on the web, inside a test only that test. A top-level `test.skip(!X, …)` marks an
 * opt-in benchmark. `specs`: [{ file, text }]; `featureIds`: the ids of the registry.
 * Returns { rows: [{ file, tests, desktop, web, skips: [{ feature, reason, scope }] }], errors }.
 */
export function specCoverage(specs, featureIds) {
  const known = new Set(featureIds);
  const rows = [];
  const errors = [];
  const skipRe = /^([ \t]*)skipOnWeb\(\s*(['"])([^'"]+)\2,\s*(['"])((?:(?!\4)[^\\]|\\.)*)\4/gm;
  for (const { file, text } of specs) {
    const tests = (text.match(/^[ \t]*test\(/gm) ?? []).length;
    const optIn = /^test\.skip\(!/m.test(text);
    const skips = [...text.matchAll(skipRe)].map((m) => ({
      feature: m[3],
      reason: m[5].replace(/\\(['"])/g, '$1'),
      scope: m[1] === '' ? 'file' : 'test',
    }));
    for (const s of skips)
      if (!known.has(s.feature))
        errors.push(
          `${file}: skipOnWeb names '${s.feature}', which is not a feature of the registry`,
        );
    const fileSkip = skips.find((s) => s.scope === 'file');
    const testSkips = skips.filter((s) => s.scope === 'test');
    const web = fileSkip
      ? 'no'
      : testSkips.length
        ? `partial (${testSkips.length} of ${tests} skipped)`
        : 'yes';
    rows.push({
      file,
      tests,
      desktop: optIn ? 'opt-in' : 'yes',
      web: optIn && !fileSkip ? 'opt-in' : web,
      skips,
    });
  }
  return { rows, errors };
}

/**
 * The generated part of docs/web-workbench-parity.md (markers included).
 * `inputs`: { registry, commands, actions, bindings, operations, calledByWebTests(binding) → bool,
 * calledByConsole: Set<operationId>, specs: rows of specCoverage, core: Set of the browser specs
 * that run the core (coreSpecs) }.
 */
export function render(inputs) {
  const { registry, commands, bindings, operations, calledByWebTests, calledByConsole } = inputs;
  const features = effectiveFeatures(registry);
  const evidence = { core: inputs.core ?? new Set(), matrix: inputs.specs ?? [] };
  const proved = features.filter((f) => proofsOf(f, evidence).length > 0).length;
  const unverified = features.filter(
    (f) =>
      f.workbench.status === 'partial' && String(f.workbench.reason ?? '').startsWith(UNVERIFIED),
  ).length;
  const byId = new Map(features.map((f) => [f.id, f]));
  const refs = references(features);
  const serverOnly = new Map(list(registry?.server_only).map((s) => [s.operationId, s]));

  // Why the web lacks something: the workbench reason of its features, unless one of them is
  // "yes" on the workbench (then the web has it, through that feature).
  const webNote = (ids) => {
    const fs = (ids ?? []).map((id) => byId.get(id)).filter(Boolean);
    if (fs.some((f) => f.workbench.status === 'yes')) return '';
    return fs.find((f) => f.workbench.reason)?.workbench.reason ?? '';
  };

  const featureRows = features.map((f) => [
    `${code(f.id)} ${f.title}`,
    f.desktop.status,
    f.workbench.status,
    f.console?.status ?? 'n/a',
    reasons(f),
    tests(f, evidence),
  ]);
  const cmdRows = commands.map((c) => [
    code(c.id),
    c.group,
    c.platforms?.web === false ? `no (needs ${(c.requires ?? []).map(code).join(', ')})` : 'yes',
    (refs.commands.get(c.id) ?? []).map(code).join(', '),
    webNote(refs.commands.get(c.id)),
  ]);
  const actions = inputs.actions ?? [];
  const onPlatform = (a, p) => {
    if (a.platforms?.[p] !== false) return 'yes';
    const why = [
      ...(a.requires ?? []).map((x) => `needs ${code(x)}`),
      ...(a.excludes ?? []).map((x) => `only without ${code(x)}`),
    ];
    return `no (${why.join(', ')})`;
  };
  const actionRows = actions.map((a) => [
    code(a.id),
    onPlatform(a, 'desktop'),
    onPlatform(a, 'web'),
    (refs.actions.get(a.id) ?? []).map(code).join(', '),
  ]);
  const actionSection = actions.length
    ? [
        `### Azioni dei pannelli (${actions.length})`,
        '',
        `I pulsanti dei pannelli che non sono comandi ma realizzano una funzione (\`defineAction\` in \`packages/workbench/src/commands/actions.ts\`, mostrati da \`<ActionButton>\`, ADR-0045 §2). Come i comandi nominano la loro funzione e le capability che richiedono (\`requires\`) o di cui fanno le veci dove mancano (\`excludes\`); l'elenco viene dal registro a runtime.`,
        '',
        table(actionRows, ['Azione', 'Desktop', 'Web', 'Funzione']),
        '',
      ]
    : [];
  const bindRows = bindings.map((b) => [
    code(b),
    (refs.bindings.get(b) ?? []).map(code).join(', '),
    calledByWebTests(b) ? 'yes' : '—',
    webNote(refs.bindings.get(b)),
  ]);
  const opRows = operations.map((o) => [
    code(o.operationId),
    `${o.method.toUpperCase()} ${code(o.path)}`,
    serverOnly.has(o.operationId)
      ? `server_only: ${serverOnly.get(o.operationId).reason}`
      : (refs.operations.get(o.operationId) ?? []).map(code).join(', '),
    calledByConsole.has(o.operationId) ? 'yes' : '—',
  ]);
  const specRows = (inputs.specs ?? []).map((r) => [
    code(r.file),
    String(r.tests),
    r.desktop,
    r.web,
    r.skips
      .map((x) => `${code(x.feature)}${x.scope === 'test' ? ' (un test)' : ''}: ${x.reason}`)
      .join(' · ') || '—',
  ]);
  const specSection = specRows.length
    ? [
        `### Spec e2e per target (${specRows.length})`,
        '',
        `Gli spec di \`apps/desktop/frontend/e2e\` girano su entrambi i target della matrice (\`web/playwright.workbench-ui.config.ts\`: \`desktop-mock\` = UI sul mock Wails, \`web-core\` = workbench sul core WebAssembly). Sul web: **${specRows.filter((r) => r[3] === 'yes').length}** interi, **${specRows.filter((r) => r[3].startsWith('partial')).length}** in parte, **${specRows.filter((r) => r[3] === 'no').length}** esclusi; \`opt-in\` = benchmark che girano solo con la loro variabile d'ambiente. Un'esclusione si dichiara con \`skipOnWeb(<funzione>, <motivo>)\`; i test sono contati nel sorgente (un ciclo conta una volta).`,
        '',
        table(specRows, ['Spec', 'Test', 'Desktop (mock)', 'Web (core)', 'Esclusioni sul web']),
        '',
      ]
    : [];
  const nCalled = bindRows.filter((r) => r[2] === 'yes').length;
  const nWeb = commands.filter((c) => c.platforms?.web !== false).length;
  const nConsole = opRows.filter((r) => r[3] === 'yes').length;

  return [
    BEGIN,
    '',
    `### Funzioni (${features.length})`,
    '',
    `Dal registro \`shared/parity/features.yaml\`. Desktop: ${statusCount(features, 'desktop')}. Workbench: ${statusCount(features, 'workbench')}. Console: ${statusCount(features, 'console')} (n/a = funzione sul contenuto del vault, che la console affida al workbench). Test per superficie: D = desktop (UI, e2e sul mock, core Go), W = workbench (host web, spec nel browser e spec della matrice e2e), K = console, C = cloud; in grassetto le prove sul core WebAssembly. ${proved} funzioni hanno almeno una prova sul core; ${unverified} sono \`partial\` soltanto per la mancanza di una prova (motivazione «${UNVERIFIED}: …»).`,
    '',
    table(featureRows, [
      'Funzione',
      'Desktop',
      'Workbench',
      'Console',
      'Motivazione e note',
      'Test',
    ]),
    '',
    `### Comandi (${commands.length})`,
    '',
    `${nWeb} su ${commands.length} sono disponibili sul web; gli altri richiedono (\`Command.requires\`) una capability che il browser non ha. L'elenco viene dal registro a runtime (\`packages/workbench/src/commands/parity.test.ts\`), non dal sorgente; ogni comando dichiara la sua funzione (\`Command.feature\`, un \`FeatureId\` generato), che deve essere una di quelle che lo elencano.`,
    '',
    table(cmdRows, ['Comando', 'Gruppo', 'Sul web', 'Funzione', 'Nota']),
    '',
    ...actionSection,
    `### Binding Go (${bindings.length} metodi, ${new Set(bindings.map((b) => b.split('.')[0])).size} servizi)`,
    '',
    `Il dispatcher del core espone tutti i ${bindings.length} metodi (verificato da \`TestDispatcherMatchesTheGeneratedBindings\`). **${nCalled} su ${bindings.length}** sono chiamati da un test del workbench web contro il core vero (\`web/e2e\`, \`web/e2e-cloud\`); gli altri girano nello stesso codice Go, provato sotto WASM dai test del core (\`task test-wasm\`), ma non hanno ancora un test nel browser.`,
    '',
    table(bindRows, ['Binding', 'Funzione', 'Chiamato in un test web', 'Nota']),
    '',
    `### Operazioni REST (${operations.length})`,
    '',
    `Da \`api/openapi.yaml\`. **${nConsole} su ${operations.length}** sono chiamate dalla console (\`web/src\`); le altre le usa il core (sincronizzazione, condivisione) oppure nessun client.`,
    '',
    table(opRows, ['Operazione', 'Metodo e percorso', 'Funzione', 'Chiamata dalla console']),
    '',
    ...specSection,
    END,
  ].join('\n');
}

/** The document with its generated part replaced. */
export function splice(text, generated) {
  const i = text.indexOf(BEGIN);
  const j = text.indexOf(END);
  if (i < 0 || j < 0) throw new Error('the document has no parity:begin / parity:end markers');
  return text.slice(0, i) + generated + text.slice(j + END.length);
}
