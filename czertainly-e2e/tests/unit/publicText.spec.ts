/**
 * publicText — the public-text lint (utils/regression/publicText.ts) over comments, titles, messages, rules and docs:
 * no private shorthand, tool or model names or local paths; each pattern class is caught, ordinary words and the
 * allow-listed public ids are not; no file name under the scanned folders carries a round or batch marker.
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { PUBLIC_TEXT_ALLOWED, publicTextFiles, publicTextHits, publicTextHitsIn } from '../../utils/regression/publicText';

const ROOT = path.resolve(__dirname, '..', '..');

// ------------------------------------------------------------------ public text: no private working notes
// The repository is public. Comments, titles, messages and the README explain the suite in plain words; the lint and its
// allow-list live in utils/regression/publicText.ts. The samples below are assembled from pieces so this file stays clean.

const join = (...parts: string[]) => parts.join('');

// public text: no private shorthand, tool or model names or local paths in comments, titles, messages or docs
test('public text: no private shorthand, tool or model names or local paths in comments, titles or docs', () => {
    const files = publicTextFiles(ROOT);
    expect(files).toEqual(expect.arrayContaining(['tests/regression/README.md', 'playwright.regression.config.ts', 'utils/regression/guard/createGuard.ts', 'pages/LoginPage.ts', 'fixtures/testFixtures.ts']));
    const hits = publicTextHits(ROOT);
    const shown = hits.slice(0, 40).map((h) => `${h.file}:${h.line} [${h.cls}] ${h.match} | ${h.text.slice(0, 140)}`);
    expect(shown, `${hits.length} hit(s); rewrite them in plain English (keep the reason, drop the history)`).toEqual([]);
});

test('public text: each pattern class is caught in a comment, a title and a message', () => {
    const cases: [string, string][] = [
        [join('fix', ' pass ', '3'), 'round-id'],
        [join('re', 'v5'), 'round-id'],
        [join('round', '-4'), 'round-id'],
        [join('live', ' run ', '2'), 'round-id'],
        [join('guard-integration', ' pass'), 'round-id'],
        [join('author', ' decision ', '2'), 'round-id'],
        [join('R', '17'), 'finding-id'],
        [join('platform ', 'G', '-1'), 'finding-id'],
        [join('GD', '-15'), 'finding-id'],
        [join('m', '6'), 'finding-id'],
        [join('C', '12'), 'candidate-id'],
        [join('Q', '2'), 'decision-id'],
        [join('D', '1'), 'decision-id'],
        [join('phase', '-05'), 'plan-id'],
        [join('B', '0'), 'plan-id'],
        [join('A4 ', 'r', '15'), 'plan-id'],
        ['\u00a7' + '2.2', 'plan-id'],
        [join('Son', 'net'), 'model-name'],
        [join('Fa', 'ble'), 'model-name'],
        [join('/Us', 'ers/', 'someone/x'), 'local-path'],
        [join('scratch', 'pad'), 'local-path'],
        [join('re', 'viewer'), 'process-wording'],
        [join('qa-api', '-cov', 'erage'), 'tool-name'],
        [join('T', 'W03'), 'plan-id'],
        [join('T', '14 ', 'W', '7'), 'plan-id'],
        [join('SCP', '#137'), 'plan-id'],
        [join('N', '-07; ', 'P', '-08'), 'plan-id'],
        [join('see the ', 'plan', ' table'), 'plan-id'],
        [join('row 4 of the ', 'plan'), 'plan-id'],
        [join('merge', ' pass'), 'process-wording'],
        [join('area', ' sandbox'), 'process-wording'],
        [join('(', 'S', '3)'), 'finding-id'],
        [join('F', '5'), 'finding-id'],
        [join('O', 'Q-6'), 'plan-id'],
        [join('merge ', '2026-10-15'), 'round-id'],
        [join('P2', 'Z'), 'restructure-word'],
        [join('P2', '.0'), 'restructure-word'],
        [join('W', 'P3'), 'restructure-word'],
        [join('barrel', ' kept'), 'restructure-word'],
    ];
    for (const [word, cls] of cases) {
        for (const [where, src] of [
            ['comment', `// keeps the order (${word})\nconst a = 1;\n`],
            ['title', `test('REG-CFG-01: creates it (${word})', () => {});\n`],
            ['message', `throw new Error(\`refused: ${word}\`);\n`],
        ]) {
            const classes = publicTextHitsIn('tests/regression/x.spec.ts', src).map((h) => h.cls);
            expect(classes, `${where}: ${word}`).toContain(cls);
        }
    }
    expect(publicTextHitsIn('README.md', `# Notes\n\nSee ${join('re', 'view ', 'Q', '2')}.\n`).map((h) => h.cls)).toEqual(['decision-id', 'process-wording']);
    expect(publicTextHitsIn('tests/regression/x.spec.ts', `// ${join('the ', 'plan', "'s")} question\n`).map((h) => h.cls)).toEqual(['plan-id']);
});

test('public text: testMeta() rule values and RULE constants are scanned; a public rule is not reported', () => {
    const privateRule = `testMeta({ id: 'REG-CFG-07', prio: 'P1', issue: 'ilm#427', rule: ['${join('inventory-api ', '\u00a7', '10.2 ', 'r', '6')} (no-op)', '${join('T', '14 W', '7')}'] });`;
    expect(publicTextHitsIn('tests/api/x.api.spec.ts', privateRule).map((h) => `${h.kind}/${h.cls}`)).toEqual(['rule/plan-id', 'rule/plan-id', 'rule/plan-id', 'rule/plan-id']);
    const constRule = `const RULE_TEXTS = ['${join('Pha', 'se 2 ', '\u00a7', 'A core')} 569e853c', '${join('Son', 'net')} said so'];`;
    expect(publicTextHitsIn('tests/api/x.api.spec.ts', constRule).map((h) => `${h.kind}/${h.cls}`)).toEqual(['rule/plan-id', 'rule/plan-id', 'rule/model-name']);
    const publicRule = `testMeta({ id: 'API-GEN-20', prio: 'P1', issue: 'ilm#428', rule: ['an identical set is a no-op: CertificateServiceImpl.updateCertificateGroups returns early (core#2394)', 'RFC 8555 \u00a77.4'] });`;
    expect(publicTextHitsIn('tests/api/x.api.spec.ts', publicRule)).toEqual([]);
});

test('public text: ordinary public words are not reported, in a comment, a title, a message and a rule', () => {
    const publicForms = [
        'an S3 bucket', 'the G1 group', 'a code review of the PR', 'a PR review', 'R5', 'core#2511', 'RFC 5280 \u00a74.2.1.6', 'SHA-256', 'P-256',
        'REG-CERT-42 and API-GEN-33', 'round-robin', 'the qa-reg- and qa-api- run prefixes', 'the date Y-03-30', 'API-X-01', 'P1 / P2 priorities',
    ];
    for (const text of publicForms) {
        for (const src of [`// ${text}\n`, `test('REG-CFG-01: ${text}', () => {});\n`, `throw new Error('${text}');\n`, `testMeta({ id: 'REG-CFG-01', rule: ['${text}'] });\n`]) {
            expect(publicTextHitsIn('tests/regression/x.spec.ts', src), src).toEqual([]);
        }
    }
    // The private forms of the same shapes are still reported.
    for (const [text, cls] of [[join('(', 'R', '5)'), 'finding-id'], [join('R', '11'), 'finding-id'], [join('G', '1-2'), 'finding-id'],
        [join('the ', 're', 'view'), 'process-wording'], [join('round ', '3'), 'round-id'], [join('N', '-07'), 'plan-id']] as const) {
        expect(publicTextHitsIn('tests/regression/x.spec.ts', `// ${text}\n`).map((h) => h.cls), text).toContain(cls);
    }
});

test('public text: a sub-id of a test id or a testMeta() row in the same file is public; the same token elsewhere is not', () => {
    const sub = join('D', '-12');
    const src = `// rows ${sub} and more\ntest('REG-CERT-42[${sub}]: in next 30 days', () => {});\n`;
    expect(publicTextHitsIn('tests/regression/x.spec.ts', src)).toEqual([]);
    expect(publicTextHitsIn('tests/regression/y.spec.ts', `// rows ${sub} and more\n`).map((h) => h.cls)).toEqual(['plan-id']);
    const viaMeta = `// rows ${sub} and more\ntest('in next 30 days', testMeta({ id: 'REG-CERT-42', row: '${sub}', prio: 'P1', issue: 'ilm#431' }), () => {});\n`;
    expect(publicTextHitsIn('tests/regression/x.spec.ts', viaMeta), 'a testMeta() row is a public sub-id too').toEqual([]);
});

// public text: each allow-list entry names its exact files; a defining file is allowed, any other file is not
test('public text: each allow-list entry names its exact files; a defining file is allowed, no other', () => {
    for (const a of PUBLIC_TEXT_ALLOWED) if (a.files) expect(a.files.source, a.why).toMatch(/^\^\(\?:.*\)\$$/);
    const seed = join('C', '03');
    const fixture = join('F', '4');
    expect(publicTextHitsIn('utils/regression/inventory/searchTables.ts', `// the ${seed} date`)).toEqual([]);
    expect(publicTextHitsIn('tests/api/auth-permissions-by-role.api.spec.ts', `// the ${seed} date`).map((h) => h.cls)).toEqual(['candidate-id']);
    expect(publicTextHitsIn('utils/regression/rbac/permissionFixtures.ts', `// fixture ${fixture}`)).toEqual([]);
    expect(publicTextHitsIn('utils/auth/accessToken.ts', `// fixture ${fixture}`).map((h) => h.cls)).toEqual(['finding-id']);
    expect(publicTextHitsIn('tests/unit/rbacWire.spec.ts.bak', `// fixture ${fixture}`).map((h) => h.cls), 'a prefix of a listed path is not enough').toEqual(['finding-id']);
});

test('public text: code, data keys and the allow-listed public ids are not reported', () => {
    const src = [
        `const ${join('guardRound', '6')} = /${join('fix', ' pass')} \\d/;`,
        `const row = { matrix: '${join('M', '1')}', id: '${join('C', '03')}' };`,
        `// PKCE uses S256; the CMP body follows RFC 4210 \u00a75.3.1; core#2511, fe-administrator#2349, ilm#448 stay.`,
        `test('API-GEN-33: the snapshot only reads', () => {});`,
        `const runPrefix = 'qa-api-adhoc';`,
    ].join('\n');
    expect(publicTextHitsIn('tests/api/x.api.spec.ts', src)).toEqual([]);
    // A seed id is allowed only where the seed is defined and used; elsewhere it is a private id.
    expect(publicTextHitsIn('utils/regression/inventory/searchTables.ts', `// the ${join('C', '03')} date`)).toEqual([]);
    expect(publicTextHitsIn('utils/regression/tier/kind.ts', `// the ${join('C', '03')} date`).map((h) => h.cls)).toEqual(['candidate-id']);
});

test('public text: no file name under the scanned folders carries a round or batch marker', () => {
    const bad = publicTextFiles(ROOT).filter((rel) => /round\d|(?:^|\/)run\d|Wire\d|(?:^|\/)b\d[A-Z]|minors/i.test(path.posix.basename(rel)));
    expect(bad).toEqual([]);
});
