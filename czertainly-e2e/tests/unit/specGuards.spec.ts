/**
 * specGuards — static rules over the REG and API specs and the regression helpers (run by `npm run test:unit` and by
 * CI). Rules: `@local` specs call describeLocalOnly; every @bug sits in a test that calls test.fail(); one suite tag per
 * test; deny by default for raw mutations.
 * The timestamping and key-onboarding blocks are not scanned: they use plain contexts these rules would refuse.
 */
import { test, expect } from '@playwright/test';
import { listedTitleProblems, titleProblems } from '../../utils/regression/specLint/titleLint';
import { spawnSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { bugTagsWithoutFail, codeNames, onlyCalls, suiteTagProblems, testBlocks } from '../../utils/regression/specLint/parseSpec';
import { sourceCitations } from '../../utils/regression/specLint/citations';
import { LOGOUT_FILE } from '../../utils/regression/regressionProjects';
import { RawMutation, rawMutations } from '../../utils/regression/specLint/rawMutations';
import { PLAYWRIGHT_FIXTURES, areaFixtureProblems, fixtureNamesOf, playwrightFixtureNamesOf } from '../../utils/regression/specLint/areaFixtures';
import { CONTEXT_FIXTURES } from '../../utils/regression/specLint/rules';

const ROOT = path.resolve(__dirname, '..', '..');
const SCANNED = ['tests/regression', 'tests/api'];
const HELPERS = ['utils/regression', 'utils/api'];
const AREA_FIXTURES = 'fixtures/areas';

/** Files (or rules of a file) the deny-by-default lint does not apply to; the reasons are in the header. */
const LINT_EXEMPT: Record<string, RawMutation['rule'][] | 'all'> = {
    'tests/api/tier-snapshot.setup.ts': ['raw-context', 'raw-request-use', 'guarded-cast'],
    'utils/api/apiCase.ts': ['raw-context'],
    'utils/regression/guard/createGuard.ts': 'all',
    'utils/regression/guard/sendRequest.ts': ['fetch-method'],
    'utils/regression/teardown/teardownHandlers.ts': 'all',
    'utils/regression/teardown/runTeardown.ts': 'all',
    'utils/regression/teardown/snapshot.ts': 'all',
    // The teardown handlers' own requests: each runs only after the wrapper proved the live object this run's.
    'utils/regression/teardown/certificateTeardownCalls.ts': ['context-method'],
    'utils/regression/events/workflowTeardown.ts': ['context-method'],
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

/** Exempt files that exist only once the API test generator installed its templates. */
const OPTIONAL_EXEMPT = new Set(['utils/api/apiCase.ts']);

const specs = SCANNED.flatMap(filesUnder);
const helpers = HELPERS.flatMap(filesUnder);
const areaFixtures = filesUnder(AREA_FIXTURES);
const isAreaFixture = (rel: string): boolean => rel.startsWith(`${AREA_FIXTURES}/`);
const source = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function lintFile(rel: string): RawMutation[] {
    const exempt = LINT_EXEMPT[rel];
    if (exempt === 'all') return [];
    const found = rawMutations(source(rel), rel, { spec: rel.startsWith('tests/') || isAreaFixture(rel) }).filter((m) => !exempt?.includes(m.rule));
    return isAreaFixture(rel) ? found.filter((m) => m.rule !== 'fixture-extend') : found;
}

const NOT_SOURCE = new Set(['node_modules', 'test-results', 'playwright-report', '.git']);
function everyTsFile(dir = ''): string[] {
    return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
        const rel = dir ? path.posix.join(dir, e.name) : e.name;
        if (e.isDirectory()) return NOT_SOURCE.has(e.name) ? [] : everyTsFile(rel);
        return e.name.endsWith('.ts') ? [rel] : [];
    });
}
test('callback-target: no .ts file of the suite outside the guard, the lint, the unit tests and the preflight reaches the callback-parent registration', () => {
    test.setTimeout(180_000);
    const files = everyTsFile();
    expect(files.length, 'the walk found the suite').toBeGreaterThan(300);
    expect(files).toContain('pages/' + fs.readdirSync(path.join(ROOT, 'pages')).find((f) => f.endsWith('.ts'))!);
    const hits = files.flatMap((rel) =>
        rawMutations(source(rel), rel, { spec: rel.startsWith('tests/') || isAreaFixture(rel) }).filter((m) => m.rule === 'callback-target').map((m) => `${rel}:${m.line} ${m.text}`));
    expect(hits).toEqual([]);
});

const FORBIDDEN = [
    { id: 'waitForTimeout', text: 'waitForTimeout', why: 'wait on API state, never on time' },
    { id: 'lucide', text: 'svg.lucide-', why: 'icon classes are not a contract: a test id inside the widget' },
    { id: 'first-button', text: "-button').first()", why: 'a duplicated button id needs its widget scope, not .first()' },
    { id: 'raw-row', text: "page.locator('main tr[data-id=", why: 'detail-table rows belong in a page object' },
] as const;

type ForbiddenId = (typeof FORBIDDEN)[number]['id'];

const ALLOWED: Record<string, Partial<Record<ForbiddenId, number>>> = {
};
const allowedFor = (rel: string): Partial<Record<ForbiddenId, number>> | undefined =>
    ALLOWED[rel];

const MUTATION_ALLOWED: Record<string, Partial<Record<RawMutation['rule'], number>>> = {};

const count = (text: string, needle: string) => text.split(needle).length - 1;

const LOCAL_TAG = /@local\b|\btags\.local\b|\blocal\s*:\s*true\b/;
const LOCAL_OPTIONS = ['localStack', 'localApi'];
function isLocalSpec(src: string, rel: string): boolean {
    if (LOCAL_TAG.test(src)) return true;
    const names = codeNames(src, rel);
    return LOCAL_OPTIONS.some((n) => names.has(n));
}

test('the guards see the REG and API specs and the regression helpers', () => {
    expect(specs.length, 'tests/regression and tests/api hold specs').toBeGreaterThan(17);
    expect(specs).toContain('tests/api/tier-non-interference.api.spec.ts');
    expect(specs).toContain('tests/api/tier-snapshot.setup.ts');
    expect(helpers).toEqual(expect.arrayContaining(['utils/regression/apiReads.ts', 'utils/regression/protocols/acmeClient.ts', 'utils/regression/kubernetesOwnObjects.ts']));
    for (const rel of Object.keys(LINT_EXEMPT)) {
        if (!OPTIONAL_EXEMPT.has(rel)) expect(fs.existsSync(path.join(ROOT, rel)), `exempt file ${rel} exists (else drop the entry)`).toBe(true);
    }
});

test('a spec that mentions @local or sets localStack or takes localApi calls describeLocalOnly', () => {
    const offenders = specs.filter((rel) => {
        const src = source(rel);
        const usesLocal = isLocalSpec(src, rel);
        return usesLocal && !/\bdescribeLocalOnly\s*\(/.test(src);
    });
    expect(offenders, '@local specs must call describeLocalOnly(test) inside their describe').toEqual([]);
});

// the describeLocalOnly rule also covers specs that set the guard's local options in code, not in a comment.
test('the describeLocalOnly rule also covers specs that set the guard local options in code, not in a comment', () => {
    expect(isLocalSpec("test('x', async ({ localApi }) => {});", 'tests/api/X.spec.ts')).toBe(true);
    expect(isLocalSpec("const o = { localStack: true };", 'tests/api/X.spec.ts')).toBe(true);
    expect(isLocalSpec("// the guard's localStack option is not used here\ntest('x', async () => {});", 'tests/api/X.spec.ts')).toBe(false);
    expect(isLocalSpec("test('x', { tag: ['@local'] }, async () => {});", 'tests/api/X.spec.ts')).toBe(true);
});

const ID_IN_TWO_FILES: Record<string, string[]> = {
    'API-GEN-33': ['tests/api/tier-non-interference.api.spec.ts', 'tests/api/tier-snapshot.setup.ts'],
};

test('every testMeta() id is defined in exactly one spec file, so a reader knows where an id lives', () => {
    const files = new Map<string, Set<string>>();
    for (const rel of specs) {
        for (const b of testBlocks(source(rel), rel)) {
            if (!b.id) continue;
            if (!files.has(b.id)) files.set(b.id, new Set());
            files.get(b.id)!.add(rel);
        }
    }
    const filesWithIds = new Set([...files.values()].flatMap((set) => [...set]));
    for (const dir of SCANNED) expect([...filesWithIds].some((rel) => rel.startsWith(`${dir}/`)), `the scanner finds ids under ${dir}`).toBe(true);
    expect(filesWithIds.size * 2, 'the scanner finds ids in most REG and API spec files').toBeGreaterThan(specs.length);
    expect(specs.filter((rel) => !filesWithIds.has(rel) && !/\btestMeta\s*\(/.test(source(rel))), 'a spec without an inline id still calls testMeta()').toEqual([]);
    const spread = [...files].filter(([id, set]) => set.size > 1 && JSON.stringify([...set].sort()) !== JSON.stringify(ID_IN_TWO_FILES[id] ?? []))
        .map(([id, set]) => `${id}: ${[...set].sort().join(', ')}`);
    expect(spread).toEqual([]);
    for (const [id, list] of Object.entries(ID_IN_TWO_FILES)) expect([...(files.get(id) ?? [])].sort(), `${id}: the exception still holds`).toEqual(list);
});

test('every @bug tag sits in a test that calls test.fail() (fixme / skip blocks included)', () => {
    const offenders = specs.flatMap((rel) => bugTagsWithoutFail(source(rel)).map((title) => `${rel}: ${title}`));
    expect(offenders, 'use test.fail() + @bug:<repo>#<n>, never skip / fixme as a bug marker').toEqual([]);
});

test('titles: no tag in a describe title; test titles without an id prefix, short, one clause, lower-case, unique; testMeta() on every test', () => {
    const offenders = specs.flatMap((rel) => titleProblems(source(rel), rel).map((p) => `${rel}: ${p}`));
    expect(offenders, 'the id and the row go in testMeta({ id, row }); the title says the expected behaviour in words').toEqual([]);
});

test('the listed REG and API titles (template values included) keep the title rules', { tag: '@integration' }, () => {
    test.setTimeout(180_000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titles-'));
    const envFile = path.join(dir, 'empty.env');
    fs.writeFileSync(envFile, '');
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^(PW|PLAYWRIGHT|TEST_)/.test(k)) env[k] = v;
    for (const config of ['playwright.regression.config.ts', 'playwright.api.config.ts']) {
        const out = path.join(dir, `${config}.json`);
        const r = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '-c', config, '--list', '--reporter=json'],
            { cwd: ROOT, env: { ...env, REG_ENV_FILE: envFile, REG_STATE_DIR: dir, PLAYWRIGHT_JSON_OUTPUT_NAME: out }, encoding: 'utf8', timeout: 150_000 });
        expect(r.status, `${config} --list: ${(r.stderr || '').slice(0, 400)}`).toBe(0);
        const report = JSON.parse(fs.readFileSync(out, 'utf8'));
        expect(report.suites.length, `${config} lists its specs`).toBeGreaterThan(10);
        expect(listedTitleProblems(report), config).toEqual([]);
    }
});

test('every test carries exactly one suite tag (@regression or @api)', () => {
    const offenders = specs.flatMap((rel) => suiteTagProblems(source(rel)).map((p) => `${rel}: ${p}`));
    expect(offenders).toEqual([]);
});

test('deny by default: no raw mutation around the guard in a REG / API spec or a regression helper', () => {
    const offenders: string[] = [];
    for (const rel of [...specs, ...helpers, ...areaFixtures]) {
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

const BASE_FIXTURE_NAMES: ReadonlySet<string> = new Set([
    ...PLAYWRIGHT_FIXTURES,
    ...playwrightFixtureNamesOf(fs.readFileSync(path.join(ROOT, 'node_modules', 'playwright', 'types', 'test.d.ts'), 'utf8')),
    ...CONTEXT_FIXTURES,
    ...fixtureNamesOf(source('fixtures/testFixtures.ts'), 'fixtures/testFixtures.ts'),
    ...fixtureNamesOf(source('fixtures/regressionFixtures.ts'), 'fixtures/regressionFixtures.ts'),
]);

test('an area fixture extends the spec-facing fixtures once and redefines no fixture', () => {
    expect([...BASE_FIXTURE_NAMES]).toEqual(expect.arrayContaining(['api', 'localApi', 'own', 'live', 'needs', 'signedIn', 'request', 'baseURL', 'env']));
    const offenders: string[] = [];
    for (const rel of areaFixtures) {
        const others = areaFixtures.filter((o) => o !== rel).flatMap((o) => fixtureNamesOf(source(o), o));
        const reserved = new Set([...BASE_FIXTURE_NAMES, ...others]);
        offenders.push(...areaFixtureProblems(source(rel), rel, reserved, new Set(others)).map((p) => `${rel}:${p.line} ${p.rule}: ${p.text}`));
    }
    expect(offenders, 'one `export const test = base.extend<…>({ newName: … })` per area fixture file, nothing else').toEqual([]);
});

// a spec imports an area fixture without an extension, so any other file there (.js, .tsx, .mts, a folder) would be
// resolved by Playwright but never linted.
test('the area fixture folder holds only lower-camel .ts files', () => {
    const abs = path.join(ROOT, AREA_FIXTURES);
    const entries = fs.existsSync(abs) ? fs.readdirSync(abs, { withFileTypes: true }) : [];
    const odd = entries.filter((e) => !e.isFile() || !/^[a-z][A-Za-z0-9]*\.ts$/.test(e.name)).map((e) => e.name);
    expect(odd).toEqual([]);
});

test('every REG spec and API-GEN-33 take the guarded api fixture; only the setup file holds a raw context', () => {
    const raw = specs.filter((rel) => /\bgetAuthenticatedApiContext\b/.test(source(rel)));
    expect(raw).toEqual(['tests/api/tier-snapshot.setup.ts']);
    expect(source('tests/api/tier-non-interference.api.spec.ts')).toMatch(/async \(\{ api \}/);
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
            const allowed = allowedFor(rel)?.[f.id] ?? 0;
            if (n > allowed) offenders.push(`${rel}: ${n} x ${f.text} (allowed ${allowed}) — ${f.why}`);
        }
    }
    expect(offenders).toEqual([]);
});

test('the locator allow-list only names violations that still exist (it can only shrink)', () => {
    const stale: string[] = [];
    for (const [rel, entries] of Object.entries(ALLOWED)) {
        const exists = specs.includes(rel);
        if (!exists) stale.push(`${rel}: no such spec`);
        const src = exists ? source(rel) : '';
        for (const [id, allowed] of Object.entries(entries)) {
            const n = count(src, FORBIDDEN.find((f) => f.id === id)!.text);
            if (n < allowed!) stale.push(`${rel}: ${id} allowed ${allowed}, found ${n} — lower the entry`);
        }
    }
    expect(stale).toEqual([]);
});

/** A source without its comments, so a rule never matches prose (a `//` inside a quoted URL is kept). */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

test('specs and regression helpers read the roles or users list only through the readers that refuse a list at its cap', () => {
    const raw = /(?:apiJson\s*(?:<[^(]*>)?\s*\(\s*[\w.]+\s*,\s*['"`]GET['"`]\s*,|\.get\s*\(|readAnswer\s*\(\s*[\w.]+\s*,)\s*['"`]\/api\/v1\/(?:roles|users)['"`]/g;
    const statusOnly: Record<string, number> = { 'tests/api/01-auth/permissions-by-role.api.spec.ts': 2 };
    for (const old of ["apiJson<Array<{ uuid: string }>>(api, 'GET', '/api/v1/roles')", "(await api.get('/api/v1/users')).json()", "readAnswer(api, '/api/v1/roles')"]) {
        expect(old.match(raw), `the rule matches ${old}`).toHaveLength(1);
    }
    expect("apiJson(api, 'GET', '/api/v1/roles/r-1')".match(raw), 'a detail read is not a list read').toBeNull();
    const reads = [...specs, ...helpers].map((rel) => [rel, stripComments(source(rel)).match(raw)?.length ?? 0] as const);
    expect(reads.filter(([rel, n]) => n !== (statusOnly[rel] ?? 0))).toEqual([]);
});

test('every row that needs the second identity or the local Keycloak CALLS its preflight, so it skips with a named reason instead of failing', () => {
    const offenders: string[] = [];
    let secondIdentity = 0;
    let keycloak = 0;
    for (const rel of specs) {
        for (const b of testBlocks(source(rel), rel)) {
            const body = stripComments(b.body);
            const where = `${rel}:${b.line} ${b.title.slice(0, 60)}`;
            if (b.tags.includes('@needs:second-identity')) {
                secondIdentity += 1;
                if (!/\b(?:secondIdentityBlocker|ensureRestrictedUserOrSkip|prepare)\s*\(|\bown\.restrictedUser\s*\(/.test(body)) offenders.push(`${where}: no second-identity preflight call`);
            }
            if (b.tags.includes('@needs:keycloak-local')) {
                keycloak += 1;
                if (!/\bkeycloakLocalBlocker\s*\(/.test(body)) offenders.push(`${where}: no local Keycloak preflight call`);
            }
        }
    }
    // not vacuous: the rule selects the rows that declare the needs
    // (10 second-identity rows and 1 local Keycloak row today)
    expect(secondIdentity, 'rows tagged @needs:second-identity').toBeGreaterThanOrEqual(5);
    expect(keycloak, 'rows tagged @needs:keycloak-local').toBeGreaterThanOrEqual(fs.existsSync(path.join(ROOT, 'tests/regression/01-sign-in-and-access')) ? 1 : 0);
    expect(offenders).toEqual([]);
});

test('every row that takes the run RA profile declares @needs:ca, so a tier without a CA skips it for a declared reason', () => {
    const offenders: string[] = [];
    let rows = 0;
    for (const rel of specs) {
        for (const b of testBlocks(source(rel), rel)) {
            if (!/\bownRaProfile\b/.test(stripComments(b.body))) continue;
            rows += 1;
            if (!b.tags.includes('@needs:ca')) offenders.push(`${rel}:${b.line} ${b.title.slice(0, 60)}`);
        }
    }
    // not vacuous: 42 rows take it today
    expect(rows, 'rows that take ownRaProfile').toBeGreaterThanOrEqual(30);
    expect(offenders).toEqual([]);
});

const MARKER_BEFORE_ASSERTION = new Set([
    'tests/api/07-keys/create.api.spec.ts: the algorithm list offers no unknown or deprecated entry',
    'tests/api/07-keys/create.api.spec.ts: an algorithm the connector cannot create is refused with a 4',
    "tests/api/07-keys/edge-cases.api.spec.ts: a certificate issued for a token key carries that key's publ",
    'tests/api/09-protocols/scep.api.spec.ts: form-encoded random bytes answer 400 with an empty body',
    'tests/api/09-protocols/wrong-content-type-refused.api.spec.ts: an ACME JWS sent as JSON is refused with 415',
    'tests/api/09-protocols/wrong-content-type-refused.api.spec.ts: a CMP POST sent as JSON is refused with 415',
]);

test('a known-bug test keeps a hard assertion BEFORE its unconditional test.fail(), so the marker cannot mask the whole test (a shrink-only list holds the older exceptions)', () => {
    const found = new Set<string>();
    const offenders: string[] = [];
    for (const rel of specs) {
        for (const b of testBlocks(source(rel), rel).filter((x) => x.tags.some((t) => t.startsWith('@bug:')))) {
            const body = stripComments(b.body);
            const at = b.kind === 'fail' ? 0 : body.search(/test\.fail\s*\(/);
            if (at < 0) continue;
            const before = body.slice(0, at);
            const lineStart = before.lastIndexOf('\n') + 1;
            const above = before.slice(0, Math.max(lineStart - 1, 0)).split('\n').pop() ?? '';
            const conditional = at > 0 && (/\bif\b|\?|&&/.test(before.slice(lineStart)) || /\bif\s*\(.*\)\s*\{?\s*$/.test(above));
            if (conditional || /\bexpect(?:\.soft)?\(/.test(before)) continue;
            const key = `${rel}: ${b.title.slice(0, 60).trim()}`;
            found.add(key);
            if (!MARKER_BEFORE_ASSERTION.has(key)) offenders.push(`${rel}:${b.line} ${b.title.slice(0, 60)}`);
        }
    }
    expect(offenders, 'assert something (hard, before the marker) or the marker hides a regression of the part that works').toEqual([]);
    // An entry is stale when its spec is in the tree and no longer
    // holds the marker (the main-flow branch lacks some specs).
    const inTree = (k: string): boolean => fs.existsSync(path.join(ROOT, k.slice(0, k.indexOf(':'))));
    expect([...MARKER_BEFORE_ASSERTION].filter((k) => inTree(k) && !found.has(k)), 'stale entries: lower the list').toEqual([]);
    expect(MARKER_BEFORE_ASSERTION.size, 'the list can only shrink').toBeLessThanOrEqual(6);
});

test('no spec or helper holds a literal password or secret value (a generated one, or the empty string of a pin)', () => {
    const offenders: string[] = [];
    const literal = /\b(?:\w*[a-z])?(?:Password|Secret)\b\s*[:=]\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)|\b(?:password|passwd|secret)\b\s*[:=]\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/g;
    for (const rel of [...specs, ...helpers, ...areaFixtures]) {
        for (const m of stripComments(source(rel)).matchAll(literal)) {
            const value = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? '';
            // a template that interpolates a variable is a reference; a blank value is the empty-secret pin
            if (/^`/.test(m[0].slice(m[0].search(/['"`]/))) && value.includes('${')) continue;
            if (value.trim() === '') continue;
            offenders.push(`${rel}: ${m[0].slice(0, 60)}`);
        }
    }
    expect(offenders).toEqual([]);
});

test('the sign-out spec the logout project selects is the last spec of its area folder, and exactly one file matches', () => {
    const matches = specs.filter((rel) => LOGOUT_FILE.test(rel));
    expect(matches.length).toBeLessThanOrEqual(1);
    if (matches.length === 0) return;
    const folder = path.posix.dirname(matches[0]);
    const siblings = fs.readdirSync(path.join(ROOT, folder)).filter((f) => /\.spec\.ts$/.test(f)).sort();
    expect(path.posix.join(folder, siblings[siblings.length - 1])).toBe(matches[0]);
});

test('no test.only, describe.only or test.describe.only is left in a spec or a unit test', () => {
    const unit = filesUnder('tests/unit').filter((rel) => !rel.includes('/fixtures/'));
    const offenders = [...specs, ...unit].flatMap((rel) => onlyCalls(source(rel), rel).map((line) => `${rel}:${line}`));
    expect(offenders, 'a stray .only silently skips every other test of the run').toEqual([]);
});

const CITATION_EXEMPT = ['tests/timestamping/', 'tests/key-onboarding/', 'utils/timestamping/', 'utils/keyOnboarding/', 'utils/devBlocks/'];

test('no spec, page object or regression helper cites a source file with a line number', () => {
    const files = [...specs, ...helpers, ...filesUnder('pages'), ...filesUnder('fixtures')].filter((rel) => !CITATION_EXEMPT.some((x) => rel.startsWith(x)));
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.flatMap((rel) => sourceCitations(source(rel)).map((c) => `${rel}:${c.line}: ${c.text}`));
    expect(offenders).toEqual([]);
});

test('the citation lint finds a file and line in a comment or a string and leaves names and numbers alone', () => {
    for (const text of ['// see Foo.java:12', ' * (core Approval.java:91-106)', "proof: 'Controller.java:17,23'", 'at Component.tsx:454-462', 'dateUtil.ts:128']) {
        expect(sourceCitations(text), text).toHaveLength(1);
    }
    for (const text of ['// ApprovalServiceImpl.decide', 'Component.tsx', 'const x = { a: 1 };', 'http://host:8443/path', 'id: 12:30', 'file.ts then :12']) {
        expect(sourceCitations(text), text).toEqual([]);
    }
    expect(sourceCitations('a\nb Foo.java:3\nc')).toEqual([{ line: 2, text: 'b Foo.java:3' }]);
});
