/**
 * auth-rbac area — structure of the AUTH specs, read from their sources (TypeScript AST, tags.ts `testBlocks`): the 21 P1 rows of
 * the area that B1 did not implement are all there, every test starts with its ledger id and carries its tags, every
 * `test.fixme` names its guard request, and every row that needs the second identity or a Keycloak in the local compose
 * calls its preflight (a skip with the named reason, never a pass).
 */
import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { testBlocks } from '../../utils/regression/tags';

const ROOT = path.resolve(__dirname, '..', '..');
const FILES = [
    'tests/regression/REG-AUTH-01-session.spec.ts', 'tests/regression/REG-AUTH-08-rbac-ui.spec.ts', 'tests/regression/REG-AUTH-99-logout.spec.ts',
    'tests/api/auth-authn.api.spec.ts', 'tests/api/auth-users.api.spec.ts', 'tests/api/auth-roles.api.spec.ts', 'tests/api/auth-known-bugs.api.spec.ts',
    'tests/api/auth-rbac-matrix.api.spec.ts',
];
const blocks = FILES.flatMap((f) => testBlocks(fs.readFileSync(path.join(ROOT, f), 'utf8'), f).map((b) => ({ ...b, file: f })));

/** The P1 rows of the area, minus the B1 rows (REG-CFG-07.a–c, REG-CFG-09.b–c). */
const EXPECTED_IDS = [
    'REG-AUTH-01', 'REG-AUTH-02', 'REG-AUTH-03', 'REG-AUTH-05', 'REG-AUTH-07', 'REG-AUTH-08', 'REG-AUTH-10',
    'API-AUTH-01', 'API-AUTH-02', 'API-AUTH-03', 'API-AUTH-06', 'API-AUTH-07', 'API-AUTH-11', 'API-AUTH-14', 'API-AUTH-18', 'API-AUTH-19', 'API-AUTH-20',
    'API-AUTH-30', 'API-AUTH-31', 'API-AUTH-32', 'API-AUTH-33',
];
const idOf = (title: string): string | undefined => /^((?:REG|API)-AUTH-\d{2})(?:\[|:)/.exec(title)?.[1];

test('every P1 row of the area that B1 did not build has at least one test; no test carries another id', () => {
    const ids = new Set(blocks.map((b) => idOf(b.title)));
    expect([...ids].filter((i) => !i).length, 'every title starts with its ledger id').toBe(0);
    expect([...ids].sort()).toEqual([...EXPECTED_IDS].sort());
});

test('every test carries its tags: the suite tag, @issue:ilm#448 plus an area issue, @p1, and the file\'s folder decides @regression / @api', () => {
    for (const b of blocks) {
        const where = `${b.file}:${b.line} ${b.title.slice(0, 60)}`;
        // `meta({ id, prio, issue })` adds @issue:ilm#448 itself (tags.ts); the area issue is the literal in the call.
        expect(b.body, `${where}: meta() call`).toMatch(/meta\(\{[\s\S]*?prio:\s*'P1'/);
        expect(b.body, `${where}: one area issue`).toMatch(/issue:\s*'ilm#4(26|27)'/);
        expect(b.tags, where).toContain('@p1');
        expect(b.tags, where).toContain(b.file.startsWith('tests/api/') ? '@api' : '@regression');
    }
});

test('every test.fixme names the guard request it waits for; nothing else is fixme, skip or only', () => {
    for (const b of blocks) {
        if (b.kind === 'fixme') expect(b.title, `${b.file}:${b.line}`).toMatch(/guard request|\$\{GR\}/i);
        else expect(['test', 'fail'], `${b.file}:${b.line} ${b.title.slice(0, 50)}`).toContain(b.kind);
    }
    // The body of a fixme is the real test: it names fixtures and helpers, not a stub.
    for (const b of blocks.filter((x) => x.kind === 'fixme')) expect(b.body.length, b.title.slice(0, 50)).toBeGreaterThan(500);
});

test('rows that need the second identity or a Keycloak in the local compose call their preflight and skip with the named reason', () => {
    for (const b of blocks) {
        const where = `${b.file}:${b.line} ${b.title.slice(0, 60)}`;
        if (b.tags.includes('@needs:second-identity')) expect(b.body, where).toMatch(/secondIdentityBlocker|prepare\(/);
        if (b.tags.includes('@needs:keycloak-local')) expect(b.body, where).toMatch(/keycloakLocalBlocker/);
        if (b.tags.includes('@needs:second-identity') && /needs:keycloak-local|keycloak-local/.test(b.tags.join(' '))) expect(b.body, where).toMatch(/replicaBlocker|keycloakLocalBlocker/);
    }
    // Both needs on the same row are tagged @local (REG-AUTH-07[delete]) and live under describeLocal.
    const local = blocks.filter((b) => b.tags.includes('@local'));
    expect(local.map((b) => idOf(b.title)).sort()).toEqual(['REG-AUTH-01', 'REG-AUTH-05', 'REG-AUTH-07']);
    expect(local.every((b) => b.file === 'tests/regression/REG-AUTH-01-session.spec.ts')).toBe(true);
});

test('a dedicated user left by an earlier run is a named skip (no adoption), and the refused-method row judges only core\'s answer', () => {
    for (const b of blocks.filter((x) => /ensureRestrictedUser\(/.test(x.body))) {
        // The only bare call is the re-creation in the `finally` of REG-AUTH-07[delete], after the user was deleted on purpose.
        expect(b.title, `${b.file}:${b.line}`).toMatch(/REG-AUTH-07\[delete\]/);
    }
    for (const b of blocks.filter((x) => x.tags.includes('@needs:second-identity'))) expect(b.body, `${b.file}:${b.line}`).toMatch(/ensureRestrictedUserOrSkip|prepare\(/);
    const method = blocks.find((b) => /^API-AUTH-02\[method\]/.test(b.title))!;
    expect(method.body).toMatch(/judgeRefusedMethod/);
    expect(method.body).toMatch(/INGRESS_SKIP_REASON/);
    expect(method.body, 'the response body is never printed').not.toMatch(/res\.text\(\)\.slice|\.text\(\)\)\.slice/);
});

test('known-bug pins keep their hard assertions outside test.fail: the bug marker sits right before the step it breaks', () => {
    for (const b of blocks.filter((x) => x.tags.some((t) => t.startsWith('@bug:')))) {
        const at = b.body.search(/test\.fail\s*\(/);
        expect(at, `${b.title.slice(0, 60)} calls test.fail()`).toBeGreaterThan(0);
        // At least one assertion comes BEFORE the marker, so the marker cannot mask the whole test (API-AUTH-02[method] and
        // API-AUTH-30[statusCode] are one-assertion tests of their own: the marker is conditional there).
        if (!/\[method\]|\[statusCode\]/.test(b.title)) expect(b.body.slice(0, at), `${b.title.slice(0, 60)}: hard assertions first`).toMatch(/expect\(/);
    }
});

test('the sign-out spec sorts last among the REG-AUTH files (phase-06 m1); across ALL REG specs the alphabet puts REG-AUTH before REG-CFG — see the report', () => {
    const auth = fs.readdirSync(path.join(ROOT, 'tests/regression')).filter((f) => /^REG-AUTH-.*\.spec\.ts$/.test(f)).sort();
    expect(auth[auth.length - 1]).toBe('REG-AUTH-99-logout.spec.ts');
});
