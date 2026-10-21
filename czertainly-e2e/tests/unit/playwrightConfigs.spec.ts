/**
 * playwrightConfigs — the regression and API configs loaded with a fake environment: the resolved project filters
 * (no `@local` test without TIER_KIND=local and a proven local core, REG_PHASE=B, a named env file that is missing),
 * the run-end teardown as globalTeardown, the API gate / P1 / rest projects, and a real `--list` over the fixture
 * folder tests/unit/fixtures/list-filter (child processes; a fake `docker`, a throw-away loopback core).
 */
import { test, expect } from '@playwright/test';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { ResolvedFilter, resolveProjectFilters, selectsTest } from '../../utils/regression/projectFilters';

const ROOT = path.resolve(__dirname, '..', '..');
/** Tests that start a child process (a Playwright CLI run or a throw-away core): `npm run test:unit:quick` leaves them out. */
const INTEGRATION = '@integration';

// ------------------------------------------------------------------ resolved project filters of both configs

const CONFIGS = ['playwright.regression.config.ts', 'playwright.api.config.ts'];
const RUN_ENV_KEYS = [
    'TIER_KIND', 'BASE_URL', 'REG_STATE_DIR', 'REG_PHASE', 'REG_ENV_FILE', 'REG_ENV_FILE_PINNED', 'API_ENV_FILE', 'REG_RUN_ID', 'API_RUN_ID',
    'API_DELETE_OWN', 'CLEANUP_LEDGER_FILE', 'TIER_LOCAL_HOSTS', 'AUTH_MODE', 'REG_RA_PROFILE_NAME', 'REG_TIER_ID', 'REG_LOCAL_CORE_URL',
    'REG_LOCAL_CORE_MARKER', 'REG_LOCAL_COMPOSE_PROJECT', 'REG_DOCKER_BIN', 'DOCKER_HOST', 'REG_RUN_ID_REUSE', 'REG_KEPT_STRICT',
    'API_TEARDOWN_DRY_RUN', 'AUTH_CLIENT_CERT',
];

/** An empty env file in the test's folder: a named env file must exist now, and an empty one sets nothing. */
function emptyEnvFile(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'empty.env');
    fs.writeFileSync(file, '');
    return file;
}

/**
 * A fake `docker` (REG_DOCKER_BIN): `docker context inspect` names a local socket (the endpoint of the
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
                    if (selectsTest(f, title(`${tags} ${local}`))) leaks.push(`${f.name}: ${tags} ${local}`);
                }
            }
        }
        expect(leaks).toEqual([]);
        expect(resolved.some((f) => selectsTest(f, title('@p1'))), 'control: a shared-safe P1 test is still selected').toBe(true);
    });

    // ${file}: TIER_KIND=local with a loopback BASE_URL, a live loopback core and a container proof lets @local tests through
    test(`${file}: TIER_KIND=local with loopback core and container proof admits @local`, { tag: INTEGRATION }, async ({}, testInfo) => {
        test.setTimeout(30_000);
        const core = await fakeLocalCore();
        try {
            const docker = fakeDocker(testInfo.outputPath('bin'), Number(new URL(core.url).port));
            const cfg = loadConfig(file, { TIER_KIND: 'local', BASE_URL: core.url, REG_LOCAL_CORE_URL: core.url, REG_DOCKER_BIN: docker }, testInfo.outputDir);
            expect(resolveProjectFilters(cfg).some((f) => selectsTest(f, title('@p1 @local')))).toBe(true);
        } finally {
            core.stop();
        }
    });

    // ${file}: TIER_KIND=local with a live core but no container publishing its port, or no docker CLI, refuses to load
    test(`${file}: TIER_KIND=local without a container on the core port refuses`, { tag: INTEGRATION }, async ({}, testInfo) => {
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

    test(`${file}: an env file the user named that does not exist stops the load`, ({}, testInfo) => {
        expect(() => loadConfig(file, { REG_ENV_FILE: path.join(testInfo.outputDir, 'typo.env') }, testInfo.outputDir)).toThrow(/REG_ENV_FILE names an env file that does not exist/);
        expect(() => loadConfig(file, { REG_ENV_FILE: '', API_ENV_FILE: path.join(testInfo.outputDir, 'typo.env') }, testInfo.outputDir))
            .toThrow(/API_ENV_FILE names an env file that does not exist/);
    });

    test(`${file}: TIER_KIND=local without proof of a local core refuses to load`, { tag: INTEGRATION }, async ({}, testInfo) => {
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

    // ${file}: REG_PHASE=B narrows the row projects to @phaseB, infrastructure keeps running
    test(`${file}: REG_PHASE=B narrows rows to @phaseB, infrastructure keeps running`, ({}, testInfo) => {
        const resolved = resolveProjectFilters(loadConfig(file, { REG_PHASE: 'B' }, testInfo.outputDir));
        const byName = (n: string) => resolved.find((f) => f.name === n) as ResolvedFilter;
        const rows = resolved.filter((f) => !['snapshot', 'non-interference'].includes(f.name));
        expect(rows.some((f) => selectsTest(f, title('@p1'))), 'no plain row in Phase B').toBe(false);
        expect(rows.some((f) => selectsTest(f, title('@phaseB @p1')))).toBe(true);
        expect(selectsTest(byName('snapshot'), title('@p1'))).toBe(true);
        expect(selectsTest(byName('non-interference'), title('@p1'))).toBe(true);
        expect(selectsTest(byName('snapshot'), title('@p1 @local')), '@local stays out of infrastructure too').toBe(false);
    });

    test(`${file}: the run-end teardown is the globalTeardown`, ({}, testInfo) => {
        const cfg = loadConfig(file, {}, testInfo.outputDir);
        expect(cfg.globalTeardown).toBe(path.join(ROOT, 'utils', 'regression', 'teardown', 'runTeardown.ts'));
    });
}

// the API config wires the gate, the first API project and the rest projects (the gate has a browser)
test('the API config wires the gate, the first project and the rest projects, and the gate has a browser', ({}, testInfo) => {
    const cfg = loadConfig('playwright.api.config.ts', {}, testInfo.outputDir);
    const resolved = resolveProjectFilters(cfg);
    const sel = (name: string, tags: string) => selectsTest(resolved.find((f) => f.name === name)!, title(tags));
    expect(sel('gate', '@gate @p1')).toBe(true);
    expect(sel('gate', '@p1')).toBe(false);
    expect(sel('api-p1', '@p1')).toBe(true);
    expect(sel('api-p1', '@gate @p1'), 'the gate is not repeated in api-p1').toBe(false);
    expect(sel('api-rest', '@p2')).toBe(true);
    expect(sel('api-rest', '@p3')).toBe(true);
    expect(sel('api-rest', '@p1')).toBe(false);
    expect(cfg.projects.find((p) => p.name === 'gate')?.use?.defaultBrowserType).toBe('chromium');
});

// ------------------------------------------------------------------ the real --list over a fixture folder

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
    // real --list through ${config} (TIER_KIND unset): zero @local tests, the plain rows are listed
    test(`real --list through ${config}, TIER_KIND unset: no @local test, only plain rows`, { tag: INTEGRATION }, ({}, testInfo) => {
        test.setTimeout(120_000);
        const listed = listFixture(config, testInfo.outputDir);
        const local = listed.filter((l) => l.tags.some((t) => /^@local\b/.test(t)) || /@local\b/.test(l.title));
        expect(local.map((l) => `${l.project}: ${l.title}`)).toEqual([]);
        expect(listed.some((l) => l.title.startsWith('FIX-01')), 'control: the plain P1 row is listed').toBe(true);
        expect(new Set(listed.map((l) => l.title.slice(0, 6))), 'only the shared-safe rows').toEqual(new Set(['FIX-01', 'FIX-02', 'FIX-03']));
    });
}

test('the fixture folder is invisible to the default, REG, API and unit configs', { tag: INTEGRATION }, ({}, testInfo) => {
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
