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
 * bindings, operations or a capability has the desktop's (same UI, same core: ADR-0029).
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
        bindings: list(desktop.bindings),
        operationIds: list(desktop.operationIds),
      },
      workbench: {
        ...wb,
        commands: list(inherit('commands')),
        bindings: list(inherit('bindings')),
        operationIds: list(inherit('operationIds')),
        capability: inherit('capability'),
      },
      console: f.console
        ? {
            ...f.console,
            routes: list(f.console.routes),
            operationIds: list(f.console.operationIds),
          }
        : null,
      tests: {
        desktop: list(f.tests?.desktop),
        web: list(f.tests?.web),
        cloud: list(f.tests?.cloud),
      },
    };
  });
}

/** Which features reference each command, binding and operation. */
export function references(features) {
  const commands = new Map();
  const bindings = new Map();
  const operations = new Map();
  const add = (map, key, id) => {
    if (!map.has(key)) map.set(key, []);
    if (!map.get(key).includes(id)) map.get(key).push(id);
  };
  for (const f of features) {
    for (const s of ['desktop', 'workbench']) {
      for (const c of f[s].commands) add(commands, c, f.id);
      for (const b of f[s].bindings) add(bindings, b, f.id);
      for (const o of f[s].operationIds) add(operations, o, f.id);
    }
    for (const o of f.console?.operationIds ?? []) add(operations, o, f.id);
  }
  return { commands, bindings, operations };
}

/**
 * Every rule of `parity --check` except the schema and the freshness of the document.
 * `inputs`: { registry, commands: [{id, platforms}], capabilities: {desktop, web}, bindings: [],
 * operations: [{operationId}], routes: [], exists(path) } → list of error messages.
 */
export function check(inputs) {
  const { registry, commands, capabilities, bindings, operations, routes, exists } = inputs;
  const errors = [];
  const features = effectiveFeatures(registry);
  const commandById = new Map(commands.map((c) => [c.id, c]));
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
    for (const kind of ['desktop', 'web', 'cloud']) {
      for (const t of f.tests[kind]) {
        if (!exists(t)) errors.push(`${where}: ${kind} test ${t} does not exist`);
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
    }
  }

  // Coverage: everything that exists is part of some feature.
  const refs = references(features);
  for (const c of commands) {
    if (!refs.commands.has(c.id)) errors.push(`command ${c.id} is not referenced by any feature`);
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

function tests(f) {
  const parts = [];
  for (const [k, label] of [
    ['desktop', 'D'],
    ['web', 'W'],
    ['cloud', 'C'],
  ]) {
    if (f.tests[k].length)
      parts.push(`${label}: ${f.tests[k].map((t) => code(base(t))).join(', ')}`);
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
 * `inputs`: { registry, commands, bindings, operations, calledByWebTests(binding) → bool,
 * calledByConsole: Set<operationId> }.
 */
export function render(inputs) {
  const { registry, commands, bindings, operations, calledByWebTests, calledByConsole } = inputs;
  const features = effectiveFeatures(registry);
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
    tests(f),
  ]);
  const cmdRows = commands.map((c) => [
    code(c.id),
    c.group,
    c.platforms?.web === false ? `no (needs ${(c.requires ?? []).map(code).join(', ')})` : 'yes',
    (refs.commands.get(c.id) ?? []).map(code).join(', '),
    webNote(refs.commands.get(c.id)),
  ]);
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
    `Dal registro \`shared/parity/features.yaml\`. Desktop: ${statusCount(features, 'desktop')}. Workbench: ${statusCount(features, 'workbench')}. Console: ${statusCount(features, 'console')} (n/a = funzione sul contenuto del vault, che la console affida al workbench). Test: D = desktop (UI, e2e sul mock, core Go), W = web (console e workbench), C = cloud.`,
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
    `${nWeb} su ${commands.length} sono disponibili sul web; gli altri richiedono (\`Command.requires\`) una capability che il browser non ha. L'elenco viene dal registro a runtime (\`packages/workbench/src/commands/parity.test.ts\`), non dal sorgente.`,
    '',
    table(cmdRows, ['Comando', 'Gruppo', 'Sul web', 'Funzione', 'Nota']),
    '',
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
