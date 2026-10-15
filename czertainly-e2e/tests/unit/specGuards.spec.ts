/**
 * Static guards over the REG-* and API-* specs and the regression helpers (reviews S2, R7b, R19, Q2), run by
 * `npm run test:unit` and by framework-checks.yml.
 *
 * 1. A spec that mentions `@local` ANYWHERE (title, tag literal, `tags.local`, `local: true`) or sets the guard's
 *    `localStack` / `guardOptions` / `apiGuardOptions` (fix pass 3) also calls `describeLocal(test)` (second guard
 *    next to the configs' grepInvert).
 * 2. A test that carries a `@bug` tag also calls `test.fail()`; `test.fixme` / `test.skip` declarations are included
 *    (a skipped test is never a bug marker). Test blocks come from the TypeScript AST (tags.ts).
 * 3. Every test carries exactly one suite tag, `@regression` or `@api` (its own or inherited from a describe).
 * 4. Deny by default (review Q2; rules in utils/regression/tags.ts `rawMutations`): in tests/regression, tests/api,
 *    utils/regression AND utils/api (the qa-api-coverage templates, fix pass 3), nothing but a provably guarded context
 *    (the `api` fixture, a `GuardedApi` parameter, a guard factory and their aliases) sends anything but a GET; no
 *    `getAuthenticatedApiContext`, no raw `request` fixture / `page.request` / `fetch` for non-GET, every non-GET method
 *    counted (POST too, unless the literal URL is a read-only / protocol POST of the guard's allow-list), aliases, element access, dynamic methods, method extraction, `apiJson*` variants, casts to
 *    GuardedApi, util imports only from the allow-list, no child_process in a spec; in the specs (fix pass 3) `test`
 *    only from the fixtures (or utils/api/apiCase), no `.extend(`, no `route.continue` / `route.fulfill` with a method,
 *    no http / https / http2 / net / tls / undici / @kubernetes/client-node / utils/k8sClient; and (fix pass 4) imports by
 *    allow-list only (relative inside the suite, `@playwright/test` for types, a few node built-ins), no `process.env`
 *    writes, no fs writes / removals, no `createRequire`; a literal raw POST URL is judged like `allowListedPost` (printable
 *    ASCII, the path as written = as sent, segment-strict patterns). The REG specs and API-GEN-33 use the
 *    `api` fixture, so the counted allow-list is EMPTY. Exemptions, each with its reason (`LINT_EXEMPT`):
 *      - tests/api/_run-setup.setup.ts: raw-context, raw-request-use, guarded-cast only (the guard proof needs the raw
 *        context behind its blocking spy and removes the guard layer from one helper on purpose);
 *      - utils/api/apiCase.ts (installed by the qa-api-coverage generator; may be absent): raw-context only — it
 *        authenticates the worker's session with `getAuthenticatedApiContext` and hands out guarded views only;
 *      - utils/regression/guardedApi.ts (the guard sends what it approved through the raw context), teardownHandlers.ts
 *        (the deletion layer: each handler runs after guardHandler's ledger + live check, with deleteVerified),
 *        runTeardown.ts (authenticates raw contexts for the handlers; its re-authenticating wrapper dispatches methods
 *        dynamically) and nonInterference.ts (read-only: GETs and allow-listed search POSTs through a method parameter).
 * 5. Outside `pages/`: no `waitForTimeout`, no `svg.lucide-` icon classes, no `-button').first()` on a duplicated id,
 *    no raw `page.locator('main tr[data-id=…` rows. The existing REG specs that still do this are an explicit,
 *    counted allow-list that may only shrink.
 * 6. The resolved project filters of both configs, evaluated on the loaded configs (Playwright 1.58 takes a project's
 *    grep INSTEAD of the config's): with TIER_KIND unset no project selects a `@local` test; TIER_KIND=local needs a
 *    loopback BASE_URL, a live loopback REG_LOCAL_CORE_URL with a build marker AND a container proof (R8, Q4: a
 *    throw-away core in a child process, a fake `docker` script through REG_DOCKER_BIN); REG_PHASE=B narrows the row
 *    projects to `@phaseB` but keeps the infrastructure projects; a missing env file the user named stops the load (Q11).
 * 7. The same, for real: `playwright test --list --reporter=json` through both configs over the fixture folder
 *    tests/unit/fixtures/list-filter (R19) lists zero `@local` tests with TIER_KIND unset.
 */
import { test, expect } from '@playwright/test';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { ResolvedFilter, resolveProjectFilters, selects } from '../../utils/regression/projectFilters';
import { bugTagsWithoutFail, codeNames, RawMutation, rawMutations, suiteTagProblems } from '../../utils/regression/tags';

const ROOT = path.resolve(__dirname, '..', '..');
const SCANNED = ['tests/regression', 'tests/api'];
/** Linted by the deny-by-default rules besides the specs (Q2). */
const HELPERS = ['utils/regression', 'utils/api'];

/** Files (or rules of a file) the deny-by-default lint does not apply to; the reasons are in the header. */
const LINT_EXEMPT: Record<string, RawMutation['rule'][] | 'all'> = {
    'tests/api/_run-setup.setup.ts': ['raw-context', 'raw-request-use', 'guarded-cast'],
    'utils/api/apiCase.ts': ['raw-context'],
    'utils/regression/guardedApi.ts': 'all',
    'utils/regression/teardownHandlers.ts': 'all',
    'utils/regression/runTeardown.ts': 'all',
    'utils/regression/nonInterference.ts': 'all',
};

function filesUnder(dir: string): string[] {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
        const rel = path.posix.join(dir, e.name);
        if (e.isDirectory()) return filesUnder(rel);
        return e.name.endsWith('.ts') ? [rel] : [];
    });
}

/** Exempt files that exist only once the qa-api-coverage generator installed its templates. */
const OPTIONAL_EXEMPT = new Set(['utils/api/apiCase.ts']);

const specs = SCANNED.flatMap(filesUnder);
const helpers = HELPERS.flatMap(filesUnder);
const source = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The deny-by-default findings of one file, minus its exemptions. */
function lintFile(rel: string): RawMutation[] {
    const exempt = LINT_EXEMPT[rel];
    if (exempt === 'all') return [];
    return rawMutations(source(rel), rel, { spec: rel.startsWith('tests/') }).filter((m) => !exempt?.includes(m.rule));
}

const FORBIDDEN = [
    { id: 'waitForTimeout', text: 'waitForTimeout', why: 'wait on API state, never on time' },
    { id: 'lucide', text: 'svg.lucide-', why: 'icon classes are not a contract: iconButton(widget, icon) / a test id' },
    { id: 'first-button', text: "-button').first()", why: 'a duplicated button id needs its widget scope, not .first()' },
    { id: 'raw-row', text: "page.locator('main tr[data-id=", why: 'detail-table rows belong in a page object' },
] as const;

type ForbiddenId = (typeof FORBIDDEN)[number]['id'];

// Existing REG specs that still use these locators. B1 migrated REG-CFG-05 (RaProfilePage) and REG-USE-04
// (CertificatePage.assertIssuedDetails) and removed their entries; REG-CFG-03 / REG-USE-02 (not B1 specs) and REG-CFG-08
// (permission editor, B5) remain. The counts may only go down (a stale entry fails below, so the list cannot hide a new
// violation).
const ALLOWED: Record<string, Partial<Record<ForbiddenId, number>>> = {
    'tests/regression/REG-CFG-03-ra-profile.spec.ts': { 'raw-row': 1 },
    'tests/regression/REG-CFG-08-role-permissions.spec.ts': { lucide: 1 },
    'tests/regression/REG-USE-02-inventory-filter.spec.ts': { 'raw-row': 1 },
};

// Raw mutations still pending a migration (each entry: "migrated in <batch>"). EMPTY since B0 fix pass 2 (2026-10-14):
// the REG specs and API-GEN-33 take the guarded `api` fixture (Q2). A stale entry fails below, so the list can only shrink.
const MUTATION_ALLOWED: Record<string, Partial<Record<RawMutation['rule'], number>>> = {};

const count = (text: string, needle: string) => text.split(needle).length - 1;

/** What makes a spec a local-stack spec (needs describeLocal): the tag anywhere, or the guard's local options in code (fix pass 3). */
const LOCAL_TAG = /@local\b|\btags\.local\b|\blocal\s*:\s*true\b/;
const LOCAL_OPTIONS = ['localStack', 'guardOptions', 'apiGuardOptions'];
function isLocalSpec(src: string, rel: string): boolean {
    if (LOCAL_TAG.test(src)) return true;
    const names = codeNames(src, rel);
    return LOCAL_OPTIONS.some((n) => names.has(n));
}

test('the guards see the REG and API specs and the regression helpers', () => {
    expect(specs.length, 'tests/regression and tests/api hold specs').toBeGreaterThan(17);
    expect(specs).toContain('tests/api/API-GEN-33-non-interference.api.spec.ts');
    expect(specs).toContain('tests/api/_run-setup.setup.ts');
    expect(helpers).toEqual(expect.arrayContaining(['utils/regression/regressionApi.ts', 'utils/regression/acmeClient.ts', 'utils/regression/k8s.ts']));
    for (const rel of Object.keys(LINT_EXEMPT)) {
        if (!OPTIONAL_EXEMPT.has(rel)) expect(fs.existsSync(path.join(ROOT, rel)), `exempt file ${rel} exists (else drop the entry)`).toBe(true);
    }
});

test('a spec that mentions @local anywhere, or sets localStack / guardOptions / apiGuardOptions, calls describeLocal', () => {
    const offenders = specs.filter((rel) => {
        const src = source(rel);
        const usesLocal = isLocalSpec(src, rel);
        return usesLocal && !/\bdescribeLocal\s*\(/.test(src);
    });
    expect(offenders, '@local specs must call describeLocal(test) inside their describe').toEqual([]);
});

test('the describeLocal rule also covers specs that set the guard\'s local options in code, not in a comment (fix pass 3)', () => {
    expect(isLocalSpec("test.use({ guardOptions: { localStack: true } });", 'tests/api/X.spec.ts')).toBe(true);
    expect(isLocalSpec("test.use({ apiGuardOptions: { localStack: true } });", 'tests/api/X.spec.ts')).toBe(true);
    expect(isLocalSpec("const o = { localStack: true };", 'tests/api/X.spec.ts')).toBe(true);
    expect(isLocalSpec("// the guard's localStack option is not used here\ntest('x', async () => {});", 'tests/api/X.spec.ts')).toBe(false);
    expect(isLocalSpec("test('x', { tag: ['@local'] }, async () => {});", 'tests/api/X.spec.ts')).toBe(true);
});

test('every @bug tag sits in a test that calls test.fail() (fixme / skip blocks included)', () => {
    const offenders = specs.flatMap((rel) => bugTagsWithoutFail(source(rel)).map((title) => `${rel}: ${title}`));
    expect(offenders, 'use test.fail() + @bug:<repo>#<n>, never skip / fixme as a bug marker').toEqual([]);
});

test('every test carries exactly one suite tag (@regression or @api)', () => {
    const offenders = specs.flatMap((rel) => suiteTagProblems(source(rel)).map((p) => `${rel}: ${p}`));
    expect(offenders).toEqual([]);
});

test('deny by default: no raw mutation around the guard in a REG / API spec or a regression helper (Q2)', () => {
    const offenders: string[] = [];
    for (const rel of [...specs, ...helpers]) {
        const found = lintFile(rel);
        const byRule = new Map<string, RawMutation[]>();
        for (const m of found) byRule.set(m.rule, [...(byRule.get(m.rule) ?? []), m]);
        for (const [rule, list] of byRule) {
            const allowed = MUTATION_ALLOWED[rel]?.[rule as RawMutation['rule']] ?? 0;
            if (list.length > allowed) offenders.push(...list.map((m) => `${rel}:${m.line} ${rule}: ${m.text}`));
        }
    }
    expect(offenders, 'use the guarded `api` fixture (or getGuardedApiContext / a GuardedApi parameter) and the own-object helpers').toEqual([]);
});

test('every REG spec and API-GEN-33 take the guarded api fixture; only the setup file holds a raw context (Q2)', () => {
    const raw = specs.filter((rel) => /\bgetAuthenticatedApiContext\b/.test(source(rel)));
    expect(raw).toEqual(['tests/api/_run-setup.setup.ts']);
    expect(source('tests/api/API-GEN-33-non-interference.api.spec.ts')).toMatch(/async \(\{ api \}/);
});

test('the mutation allow-list only names violations that still exist', () => {
    const stale: string[] = [];
    for (const [rel, entries] of Object.entries(MUTATION_ALLOWED)) {
        const found = fs.existsSync(path.join(ROOT, rel)) ? lintFile(rel) : [];
        for (const [rule, allowed] of Object.entries(entries)) {
            const n = found.filter((m) => m.rule === rule).length;
            if (n < allowed!) stale.push(`${rel}: ${rule} allowed ${allowed}, found ${n} — lower the entry`);
        }
    }
    expect(stale).toEqual([]);
});

test('no sleeps, icon classes, .first() on duplicated buttons or raw row locators outside pages/', () => {
    const offenders: string[] = [];
    for (const rel of specs) {
        const src = source(rel);
        for (const f of FORBIDDEN) {
            const n = count(src, f.text);
            const allowed = ALLOWED[rel]?.[f.id] ?? 0;
            if (n > allowed) offenders.push(`${rel}: ${n} x ${f.text} (allowed ${allowed}) — ${f.why}`);
        }
    }
    expect(offenders).toEqual([]);
});

test('the locator allow-list only names violations that still exist (it can only shrink)', () => {
    const stale: string[] = [];
    for (const [rel, entries] of Object.entries(ALLOWED)) {
        const src = fs.existsSync(path.join(ROOT, rel)) ? source(rel) : '';
        for (const [id, allowed] of Object.entries(entries)) {
            const n = count(src, FORBIDDEN.find((f) => f.id === id)!.text);
            if (n < allowed!) stale.push(`${rel}: ${id} allowed ${allowed}, found ${n} — lower the entry`);
        }
    }
    expect(stale).toEqual([]);
});

// ------------------------------------------------------------------ resolved project filters of both configs

const CONFIGS = ['playwright.regression.config.ts', 'playwright.api.config.ts'];
const RUN_ENV_KEYS = [
    'TIER_KIND', 'BASE_URL', 'REG_STATE_DIR', 'REG_PHASE', 'REG_ENV_FILE', 'REG_ENV_FILE_PINNED', 'API_ENV_FILE', 'REG_RUN_ID', 'API_RUN_ID',
    'API_DELETE_OWN', 'CLEANUP_LEDGER_FILE', 'TIER_LOCAL_HOSTS', 'AUTH_MODE', 'REG_RA_PROFILE_NAME', 'REG_TIER_ID', 'REG_LOCAL_CORE_URL',
    'REG_LOCAL_CORE_MARKER', 'REG_LOCAL_COMPOSE_PROJECT', 'REG_DOCKER_BIN', 'DOCKER_HOST', 'REG_RUN_ID_REUSE', 'REG_KEPT_STRICT',
    'API_TEARDOWN_DRY_RUN', 'AUTH_CLIENT_CERT',
];

/** An empty env file in the test's folder: a named env file must exist now (Q11), and an empty one sets nothing. */
function emptyEnvFile(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'empty.env');
    fs.writeFileSync(file, '');
    return file;
}

/**
 * A fake `docker` (REG_DOCKER_BIN): `docker context inspect` names a local socket (fix pass 4: the endpoint of the
 * current context is judged), `docker ps --format '{{json .}}'` lists one container publishing `port` on loopback.
 */
function fakeDocker(dir: string, port: number | undefined): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'fake-docker');
    const row = port === undefined ? '' : JSON.stringify({ ID: 'c0ffee', Names: 'core', Ports: `127.0.0.1:${port}->8080/tcp`, Labels: 'com.docker.compose.project=ilm' });
    const context = JSON.stringify([{ Name: 'default', Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]);
    fs.writeFileSync(file, `#!${process.execPath}\nconst a = process.argv.slice(2);\n` +
        `if (a[0] === 'context' && a[1] === 'inspect') process.stdout.write(${JSON.stringify(`${context}\n`)});\n` +
        `else if (a[0] === 'ps') process.stdout.write(${JSON.stringify(row ? `${row}\n` : '')});\n` +
        `else { process.stderr.write('fake docker: unexpected ' + a.join(' ')); process.exit(2); }\n`);
    fs.chmodSync(file, 0o755);
    return file;
}

interface LoadedConfig {
    grep?: RegExp;
    grepInvert?: RegExp;
    globalTeardown?: string;
    projects: Array<{ name: string; grep?: RegExp; grepInvert?: RegExp; use?: { defaultBrowserType?: string } }>;
}

/** Evaluate a config module afresh under `env` (no .env file is read), then restore the process environment. */
function loadConfig(file: string, env: Record<string, string>, testInfoDir: string): LoadedConfig {
    const saved = Object.fromEntries(RUN_ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of RUN_ENV_KEYS) delete process.env[k];
    Object.assign(process.env, { REG_ENV_FILE: emptyEnvFile(testInfoDir), REG_STATE_DIR: testInfoDir, ...env });
    try {
        const abs = path.join(ROOT, file);
        delete require.cache[require.resolve(abs)];
        return (require(abs) as { default: LoadedConfig }).default;
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

/** A throw-away "local core" in a child process (the config's probe is synchronous, so it cannot be in this process). */
async function fakeLocalCore(): Promise<{ url: string; stop: () => void }> {
    const script = "const s=require('http').createServer((q,r)=>{if(q.url.startsWith('/api/v1/info')){r.setHeader('content-type','application/json');" +
        "r.end(JSON.stringify({app:{name:'core',version:'0.0.0-test'},build:{branch:'main',commitId:'abc',timestamp:'t'},db:{}}))}else{r.statusCode=404;r.end()}});" +
        "s.listen(0,'127.0.0.1',()=>process.stdout.write(s.address().port+'\\n'));";
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    const port = await new Promise<number>((resolve, reject) => {
        child.stdout.once('data', (d) => resolve(Number(String(d).trim())));
        child.once('error', reject);
    });
    return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

/** A loopback port nobody listens on. */
async function closedPort(): Promise<number> {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as net.AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    return port;
}

const TAG_SETS = ['@p1', '@p2', '@p3', '@gate @p1', '@phaseB @p1', '@phaseB @p3'];
const title = (tags: string) => `API-X-01.spec.ts API-X-01 suite API-X-01: behaviour @api @issue:ilm#448 @issue:ilm#428 ${tags}`;

for (const file of CONFIGS) {
    test(`${file}: with TIER_KIND unset no project selects a @local test`, ({}, testInfo) => {
        const cfg = loadConfig(file, {}, testInfo.outputDir);
        const resolved = resolveProjectFilters(cfg);
        expect(resolved.length).toBeGreaterThanOrEqual(3);
        const leaks: string[] = [];
        for (const f of resolved) {
            for (const tags of TAG_SETS) {
                for (const local of ['@local', '@local:notif']) {
                    if (selects(f, title(`${tags} ${local}`))) leaks.push(`${f.name}: ${tags} ${local}`);
                }
            }
        }
        expect(leaks).toEqual([]);
        expect(resolved.some((f) => selects(f, title('@p1'))), 'control: a shared-safe P1 test is still selected').toBe(true);
    });

    test(`${file}: TIER_KIND=local with a loopback BASE_URL, a live loopback core and a container proof lets @local tests through`, async ({}, testInfo) => {
        test.setTimeout(30_000);
        const core = await fakeLocalCore();
        try {
            const docker = fakeDocker(testInfo.outputPath('bin'), Number(new URL(core.url).port));
            const cfg = loadConfig(file, { TIER_KIND: 'local', BASE_URL: core.url, REG_LOCAL_CORE_URL: core.url, REG_DOCKER_BIN: docker }, testInfo.outputDir);
            expect(resolveProjectFilters(cfg).some((f) => selects(f, title('@p1 @local')))).toBe(true);
        } finally {
            core.stop();
        }
    });

    test(`${file}: TIER_KIND=local with a live core but no container publishing its port, or no docker CLI, refuses to load (Q4)`, async ({}, testInfo) => {
        test.setTimeout(30_000);
        const core = await fakeLocalCore();
        try {
            const local = { TIER_KIND: 'local', BASE_URL: core.url, REG_LOCAL_CORE_URL: core.url };
            expect(() => loadConfig(file, { ...local, REG_DOCKER_BIN: fakeDocker(testInfo.outputPath('bin'), undefined) }, testInfo.outputDir))
                .toThrow(/no container proof .*no running container publishes the core port/);
            expect(() => loadConfig(file, { ...local, REG_DOCKER_BIN: path.join(testInfo.outputDir, 'no-such-docker') }, testInfo.outputDir))
                .toThrow(/the docker CLI is not usable/);
        } finally {
            core.stop();
        }
    });

    test(`${file}: an env file the user named that does not exist stops the load (Q11)`, ({}, testInfo) => {
        expect(() => loadConfig(file, { REG_ENV_FILE: path.join(testInfo.outputDir, 'typo.env') }, testInfo.outputDir)).toThrow(/REG_ENV_FILE names an env file that does not exist/);
        expect(() => loadConfig(file, { REG_ENV_FILE: '', API_ENV_FILE: path.join(testInfo.outputDir, 'typo.env') }, testInfo.outputDir))
            .toThrow(/API_ENV_FILE names an env file that does not exist/);
    });

    test(`${file}: TIER_KIND=local without positive proof of a local core refuses to load`, async ({}, testInfo) => {
        test.setTimeout(30_000);
        const port = await closedPort();
        expect(() => loadConfig(file, { TIER_KIND: 'local', BASE_URL: 'https://qa.example.com' }, testInfo.outputDir)).toThrow(/loopback/);
        expect(() => loadConfig(file, { TIER_KIND: 'local', BASE_URL: 'http://localhost:3080' }, testInfo.outputDir)).toThrow(/REG_LOCAL_CORE_URL/);
        expect(() => loadConfig(file, { TIER_KIND: 'local', BASE_URL: 'http://localhost:3080', REG_LOCAL_CORE_URL: 'https://core.example.com' }, testInfo.outputDir))
            .toThrow(/REG_LOCAL_CORE_URL is not a loopback/);
        expect(() => loadConfig(file, { TIER_KIND: 'local', BASE_URL: 'http://localhost:3080', REG_LOCAL_CORE_URL: `http://127.0.0.1:${port}` }, testInfo.outputDir))
            .toThrow(/did not answer/);
    });

    test(`${file}: AUTH_MODE=header against a remote BASE_URL refuses to load`, ({}, testInfo) => {
        expect(() => loadConfig(file, { AUTH_MODE: 'header', BASE_URL: 'https://qa.example.com' }, testInfo.outputDir)).toThrow(/AUTH_MODE=header/);
    });

    test(`${file}: REG_PHASE=B narrows the row projects to @phaseB, infrastructure keeps running`, ({}, testInfo) => {
        const resolved = resolveProjectFilters(loadConfig(file, { REG_PHASE: 'B' }, testInfo.outputDir));
        const byName = (n: string) => resolved.find((f) => f.name === n) as ResolvedFilter;
        const rows = resolved.filter((f) => !['snapshot', 'non-interference'].includes(f.name));
        expect(rows.some((f) => selects(f, title('@p1'))), 'no plain row in Phase B').toBe(false);
        expect(rows.some((f) => selects(f, title('@phaseB @p1')))).toBe(true);
        expect(selects(byName('snapshot'), title('@p1'))).toBe(true);
        expect(selects(byName('non-interference'), title('@p1'))).toBe(true);
        expect(selects(byName('snapshot'), title('@p1 @local')), '@local stays out of infrastructure too').toBe(false);
    });

    test(`${file}: the run-end teardown is the globalTeardown`, ({}, testInfo) => {
        const cfg = loadConfig(file, {}, testInfo.outputDir);
        expect(cfg.globalTeardown).toBe(path.join(ROOT, 'utils', 'regression', 'runTeardown.ts'));
    });
}

test('the API config wires the gate, the P1 and the rest projects (m6: the gate has a browser)', ({}, testInfo) => {
    const cfg = loadConfig('playwright.api.config.ts', {}, testInfo.outputDir);
    const resolved = resolveProjectFilters(cfg);
    const sel = (name: string, tags: string) => selects(resolved.find((f) => f.name === name)!, title(tags));
    expect(sel('gate', '@gate @p1')).toBe(true);
    expect(sel('gate', '@p1')).toBe(false);
    expect(sel('api-p1', '@p1')).toBe(true);
    expect(sel('api-p1', '@gate @p1'), 'the gate is not repeated in api-p1').toBe(false);
    expect(sel('api-rest', '@p2')).toBe(true);
    expect(sel('api-rest', '@p3')).toBe(true);
    expect(sel('api-rest', '@p1')).toBe(false);
    expect(cfg.projects.find((p) => p.name === 'gate')?.use?.defaultBrowserType).toBe('chromium');
});

// ------------------------------------------------------------------ the real --list over a fixture folder (R19)

const FIXTURE_DIR = path.join('tests', 'unit', 'fixtures', 'list-filter');

interface Listed {
    project: string;
    title: string;
    tags: string[];
}

/** `playwright test -c <fixture config> --list --reporter=json` in a child process with a clean run environment. */
function listFixture(config: string, outDir: string, extraEnv: Record<string, string> = {}): Listed[] {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (RUN_ENV_KEYS.includes(k) || /^(PW|PLAYWRIGHT|TEST_)/.test(k)) continue;
        env[k] = v;
    }
    Object.assign(env, { REG_ENV_FILE: emptyEnvFile(outDir), REG_STATE_DIR: outDir, ...extraEnv });
    const r = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '-c', path.join(FIXTURE_DIR, config), '--list', '--reporter=json'], {
        cwd: ROOT, env, encoding: 'utf8', timeout: 90_000,
    });
    expect(r.status, `--list exited ${r.status}: ${(r.stderr || '').slice(0, 600)}`).toBe(0);
    const report = JSON.parse(r.stdout) as { suites: unknown[] };
    const out: Listed[] = [];
    const walk = (s: { specs?: Array<{ title: string; tags?: string[]; tests: Array<{ projectName: string }> }>; suites?: unknown[] }) => {
        for (const sp of s.specs ?? []) for (const t of sp.tests) out.push({ project: t.projectName, title: sp.title, tags: (sp.tags ?? []).map((x) => `@${x}`) });
        for (const c of (s.suites ?? []) as Array<typeof s>) walk(c);
    };
    for (const s of report.suites as Array<Parameters<typeof walk>[0]>) walk(s);
    return out;
}

for (const config of ['regression.fixture.config.ts', 'api.fixture.config.ts']) {
    test(`real --list through ${config} (TIER_KIND unset): zero @local tests, the plain rows are listed`, ({}, testInfo) => {
        test.setTimeout(120_000);
        const listed = listFixture(config, testInfo.outputDir);
        const local = listed.filter((l) => l.tags.some((t) => /^@local\b/.test(t)) || /@local\b/.test(l.title));
        expect(local.map((l) => `${l.project}: ${l.title}`)).toEqual([]);
        expect(listed.some((l) => l.title.startsWith('FIX-01')), 'control: the plain P1 row is listed').toBe(true);
        expect(new Set(listed.map((l) => l.title.slice(0, 6))), 'only the shared-safe rows').toEqual(new Set(['FIX-01', 'FIX-02', 'FIX-03']));
    });
}

test('the fixture folder is invisible to the default, REG, API and unit configs', ({}, testInfo) => {
    test.setTimeout(120_000);
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!RUN_ENV_KEYS.includes(k) && !/^(PW|PLAYWRIGHT|TEST_)/.test(k)) env[k] = v;
    Object.assign(env, { REG_ENV_FILE: emptyEnvFile(testInfo.outputDir), REG_STATE_DIR: testInfo.outputDir });
    for (const config of ['playwright.config.ts', 'playwright.regression.config.ts', 'playwright.api.config.ts', 'playwright.unit.config.ts']) {
        const r = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '-c', config, '--list'], { cwd: ROOT, env, encoding: 'utf8', timeout: 90_000 });
        expect(r.status, `${config} --list: ${(r.stderr || '').slice(0, 400)}`).toBe(0);
        expect(r.stdout, `${config} must not list the fixture`).not.toContain('filters.fixture.ts');
    }
});
