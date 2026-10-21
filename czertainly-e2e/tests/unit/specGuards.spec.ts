/**
 * Static rules over the REG and API specs and the regression helpers (run by `npm run test:unit` and by CI): `@local`
 * specs call describeLocalOnly, every @bug sits in a test that calls test.fail(), one suite tag per test, every testMeta() id in
 * one file, deny by default (the rules of utils/regression/specLint/rawMutations.ts; exemptions in LINT_EXEMPT with their
 * reasons) and no sleeps, icon classes or raw row locators outside pages/ (a counted allow-list that may only shrink).
 */
import { test, expect } from '@playwright/test';
import { listedTitleProblems, titleProblems } from '../../utils/regression/specLint/titleLint';
import { spawnSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { bugTagsWithoutFail, codeNames, suiteTagProblems, testBlocks } from '../../utils/regression/specLint/parseSpec';
import { RawMutation, rawMutations } from '../../utils/regression/specLint/rawMutations';

const ROOT = path.resolve(__dirname, '..', '..');
const SCANNED = ['tests/regression', 'tests/api'];
/** Linted by the deny-by-default rules besides the specs. */
const HELPERS = ['utils/regression', 'utils/api'];

/** Files (or rules of a file) the deny-by-default lint does not apply to; the reasons are in the header. */
const LINT_EXEMPT: Record<string, RawMutation['rule'][] | 'all'> = {
    'tests/api/tier-snapshot.setup.ts': ['raw-context', 'raw-request-use', 'guarded-cast'],
    'utils/api/apiCase.ts': ['raw-context'],
    'utils/regression/guard/createGuard.ts': 'all',
    'utils/regression/teardown/teardownHandlers.ts': 'all',
    'utils/regression/teardown/runTeardown.ts': 'all',
    'utils/regression/teardown/nonInterference.ts': 'all',
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

// Existing REG specs that still use these locators. REG-CFG-05 (RaProfilePage) and REG-USE-04
// (CertificatePage.assertIssuedDetails) were migrated and their entries removed; REG-CFG-03 / REG-USE-02 and REG-CFG-08
// (permission editor) remain. The counts may only go down (a stale entry fails below, so the list cannot hide a new
// violation).
// Keyed by the spec's id prefix (`REG-USE-02-`), not its full name, so a renamed spec keeps its entry.
const ALLOWED: Record<string, Partial<Record<ForbiddenId, number>>> = {
    'REG-CFG-03-': { 'raw-row': 1 },
    'REG-CFG-08-': { lucide: 1 },
    'REG-USE-02-': { 'raw-row': 1 },
};
/** The ALLOWED entry of a spec path, by the id prefix of its file name. */
const allowedFor = (rel: string): Partial<Record<ForbiddenId, number>> | undefined =>
    Object.entries(ALLOWED).find(([prefix]) => path.posix.basename(rel).startsWith(prefix))?.[1];

// Raw mutations still pending a migration (each entry: "migrated in <change>"). EMPTY since 2026-10-14:
// the REG specs and API-GEN-33 take the guarded `api` fixture. A stale entry fails below, so the list can only shrink.
const MUTATION_ALLOWED: Record<string, Partial<Record<RawMutation['rule'], number>>> = {};

const count = (text: string, needle: string) => text.split(needle).length - 1;

/** What makes a spec a local-stack spec (needs describeLocalOnly): the tag anywhere, or the guard's local options in code. */
const LOCAL_TAG = /@local\b|\btags\.local\b|\blocal\s*:\s*true\b/;
const LOCAL_OPTIONS = ['localStack', 'guardOptions', 'apiGuardOptions'];
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

// a spec that mentions @local anywhere, or sets localStack / guardOptions / apiGuardOptions, calls describeLocalOnly
test('a spec that mentions @local or sets localStack, guardOptions or apiGuardOptions calls describeLocalOnly', () => {
    const offenders = specs.filter((rel) => {
        const src = source(rel);
        const usesLocal = isLocalSpec(src, rel);
        return usesLocal && !/\bdescribeLocalOnly\s*\(/.test(src);
    });
    expect(offenders, '@local specs must call describeLocalOnly(test) inside their describe').toEqual([]);
});

// the describeLocalOnly rule also covers specs that set the guard's local options in code, not in a comment
test('the describeLocalOnly rule also covers specs that set the guard local options in code, not in a comment', () => {
    expect(isLocalSpec("test.use({ guardOptions: { localStack: true } });", 'tests/api/X.spec.ts')).toBe(true);
    expect(isLocalSpec("test.use({ apiGuardOptions: { localStack: true } });", 'tests/api/X.spec.ts')).toBe(true);
    expect(isLocalSpec("const o = { localStack: true };", 'tests/api/X.spec.ts')).toBe(true);
    expect(isLocalSpec("// the guard's localStack option is not used here\ntest('x', async () => {});", 'tests/api/X.spec.ts')).toBe(false);
    expect(isLocalSpec("test('x', { tag: ['@local'] }, async () => {});", 'tests/api/X.spec.ts')).toBe(true);
});

/** Ids defined in two files on purpose: the non-interference setup (guard proof, before snapshot) and its check. */
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
    // a floor against a scanner that silently finds nothing: ids under both folders and in most spec files; the others
    // build their testMeta() in a local helper, which the scanner does not attribute to a test
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

// The static lint cannot read a title from a variable, a table or a template value: the listed titles can.
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
    for (const [prefix, entries] of Object.entries(ALLOWED)) {
        const matching = specs.filter((rel) => path.posix.basename(rel).startsWith(prefix));
        if (matching.length !== 1) stale.push(`${prefix}: ${matching.length} specs carry this id prefix (needs exactly one)`);
        const rel = matching[0] ?? prefix;
        const src = matching.length === 1 ? source(rel) : '';
        for (const [id, allowed] of Object.entries(entries)) {
            const n = count(src, FORBIDDEN.find((f) => f.id === id)!.text);
            if (n < allowed!) stale.push(`${rel}: ${id} allowed ${allowed}, found ${n} — lower the entry`);
        }
    }
    expect(stale).toEqual([]);
});

test('API-CERT-21 rfc4514: the setup runs before the bug marker, which sits right before the register step the bugs break', () => {
    const file = 'tests/api/certificate-registration.api.spec.ts';
    const block = testBlocks(fs.readFileSync(path.join(ROOT, file), 'utf8'), file).find((b) => /RFC 4514 special characters/.test(b.title));
    expect(block, 'the rfc4514 test is found').toBeDefined();
    const body = block!.body;
    const at = body.search(/test\.fail\s*\(/);
    expect(at, 'it calls test.fail()').toBeGreaterThan(0);
    const register = body.search(/registerOwnCertificate\(/);
    expect(register, 'the register step follows the marker').toBeGreaterThan(at);
    // nothing but comments between the marker statement and the register step
    const between = body.slice(body.indexOf(';', at) + 1, register).replace(/\/\/[^\n]*/g, '');
    expect(between.trim(), 'the marker sits right before the register step').toMatch(/^const r = await$/);
    expect(body.slice(0, at), 'the setup (the special-character CN) is built before the marker').toMatch(/specialCharCn\(/);
    expect(body.slice(at), 'the register status, the state and the DN rule are all under the marker').toMatch(/expect\(r\.answer\.status[\s\S]*waitForCertificateState\([\s\S]*expect\(String\(detail\.subjectDn\)\)/);
});
