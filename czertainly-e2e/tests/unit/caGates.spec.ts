/**
 * Every test or hook that reaches a CA-dependent creator is gated before it creates anything: a tier without a healthy CA SKIPS
 * the row with the deploy gate, it never fails with `RaProfileSourceMissing`.
 *
 * Name-based and simple. A test is gated when it declares the `ca` need (`testMeta({ needs })`, on the test or its describe), takes
 * the `ownRaProfile` fixture, wraps the work in `orSkipWithoutCa`, uses one of the `…OrSkip` creators or asks `needs.ca()` /
 * `needs.require('ca', …)` first. A spec-local helper that calls a creator counts as a creator in that spec, unless it wraps
 * `orSkipWithoutCa` itself. Specs of tests/regression, tests/api, tests/timestamping and tests/key-onboarding are read.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import type * as TS from 'typescript';
import { testBlocks, typescript } from '../../utils/regression/specLint/parseSpec';

const ROOT = path.resolve(__dirname, '..', '..');
const SCANNED = ['tests/regression', 'tests/api', 'tests/timestamping', 'tests/key-onboarding'];

/** Helpers that throw `RaProfileSourceMissing` (directly or through a helper below) when no healthy CA can be copied. */
const CREATORS = [
    'cloneRunRaProfile', 'createOwnRaProfile', 'createOwnRaProfileLike', 'ensureRunRaProfile', 'ensureOwnRaProfile',
    'ensureProtocolRaProfile', 'ensureAcmeOnRaProfile', 'openApprovalGate', 'ensureProtocolCaCertificate', 'ensureRbacObjects',
    'startAcmeRun', 'buildRig',
];

/** What gates a body by itself. */
const GATED_IN_BODY = /\b(ownRaProfile|orSkipWithoutCa|ensureRunRaProfileOrSkip|createOwnRaProfileOrSkip)\b|\bneeds\s*\.\s*ca\s*\(|\bneeds\s*\.\s*require\s*\([^)]*['"]ca['"]/;

/** Justified exceptions: `<file>:<test or hook title>` → why it is safe. Keep empty unless a reason is written here. */
const EXCEPTIONS: Record<string, string> = {};

const filesUnder = (dir: string): string[] => {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
        const rel = path.posix.join(dir, e.name);
        return e.isDirectory() ? filesUnder(rel) : e.name.endsWith('.ts') ? [rel] : [];
    });
};

const word = (names: Iterable<string>): RegExp => new RegExp(`\\b(${[...names].join('|')})\\b`);

/** The creators plus the spec-local helpers that reach one without gating it themselves (fixed point). */
function creatorsOf(ts: typeof TS, sf: TS.SourceFile): Set<string> {
    const locals = new Map<string, string>();
    const collect = (n: TS.Node): void => {
        if (ts.isFunctionDeclaration(n) && n.name && n.body) locals.set(n.name.text, n.body.getText(sf));
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) locals.set(n.name.text, n.initializer.getText(sf));
        ts.forEachChild(n, collect);
    };
    collect(sf);
    const set = new Set(CREATORS);
    for (let grew = true; grew;) {
        grew = false;
        for (const [name, body] of locals) {
            if (!set.has(name) && !GATED_IN_BODY.test(body) && word(set).test(body)) {
                set.add(name);
                grew = true;
            }
        }
    }
    return set;
}

/** Hook declarations (`test.beforeAll(…)` and the like) with their text and line. */
function hooksOf(ts: typeof TS, sf: TS.SourceFile): Array<{ title: string; body: string; line: number }> {
    const out: Array<{ title: string; body: string; line: number }> = [];
    const visit = (n: TS.Node): void => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && /^(beforeAll|beforeEach|afterAll|afterEach)$/.test(n.expression.name.text)
            && n.arguments.some((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a))) {
            out.push({ title: `hook ${n.expression.name.text}`, body: n.getText(sf), line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
}

/** `<file>:<line> <title>` of every test or hook that calls a creator without a gate. */
function ungated(rel: string, src: string): string[] {
    const ts = typescript();
    const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const creators = word(creatorsOf(ts, sf));
    const found: string[] = [];
    for (const b of testBlocks(src, rel)) {
        if (!creators.test(b.body) || b.tags.includes('@needs:ca') || GATED_IN_BODY.test(b.body)) continue;
        if (!EXCEPTIONS[`${rel}:${b.title}`]) found.push(`${rel}:${b.line} ${b.title}`);
    }
    for (const h of hooksOf(ts, sf)) {
        if (!creators.test(h.body) || GATED_IN_BODY.test(h.body)) continue;
        if (!EXCEPTIONS[`${rel}:${h.title}`]) found.push(`${rel}:${h.line} ${h.title}`);
    }
    return found;
}

test('a test or hook that reaches a CA-dependent creator declares the `ca` need or skips without a CA', () => {
    const specs = SCANNED.flatMap(filesUnder).filter((f) => f.endsWith('.spec.ts'));
    expect(specs.length, 'the scan sees the specs').toBeGreaterThan(50);
    const problems = specs.flatMap((rel) => ungated(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')));
    expect(problems, 'declare `needs: \'ca\'` in testMeta (or use ownRaProfile / orSkipWithoutCa), or list a reasoned exception').toEqual([]);
});

test('the CA gate rule recognises the three protections and a spec-local helper', () => {
    const open = `import { test } from '@playwright/test';
async function observer(api) { return cloneRunRaProfile(api, 's', 'x'); }
test('a', testMeta({ id: 'X-1' }), async ({ api }) => { await observer(api); });
test('b', testMeta({ id: 'X-2', needs: 'ca' }), async ({ api }) => { await observer(api); });
test('c', testMeta({ id: 'X-3' }), async ({ api, ownRaProfile }) => { await ensureOwnRaProfile(api, 's'); });
test('d', testMeta({ id: 'X-4' }), async ({ api, own }) => { await orSkipWithoutCa(openApprovalGate(api, 's', 'x'), own.skip); });
test.beforeAll(async ({ api }) => { await ensureRbacObjects(api, 's'); });`;
    expect(ungated('tests/api/x.spec.ts', open).map((p) => p.replace(/^\S+:\d+ /, ''))).toEqual(['a', 'hook beforeAll']);
});
