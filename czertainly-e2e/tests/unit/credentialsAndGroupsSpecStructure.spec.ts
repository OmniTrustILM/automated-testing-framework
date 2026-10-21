/**
 * Structure checks of the credential, group and RA-profile API specs (credential-secrets, credential-validation,
 * group-crud, group-assignment, ra-profile-required-attribute) and their helpers: no literal password, the ids
 * and rows each spec declares, the bug and local rows. Reads the source files only.
 */
import { expect, test } from '@playwright/test';
import { metaRowOf, testKey } from '../../utils/regression/specLint/titleLint';
import * as fs from 'fs';
import * as path from 'path';
import { testBlocks } from '../../utils/regression/specLint/parseSpec';

const ROOT = path.resolve(__dirname, '..', '..');
const SPECS = [
    'tests/api/credential-secrets.api.spec.ts',
    'tests/api/credential-validation.api.spec.ts',
    'tests/api/group-crud.api.spec.ts',
    'tests/api/group-assignment.api.spec.ts',
    'tests/api/ra-profile-required-attribute.api.spec.ts',
];
const HELPERS = ['credentialsApi', 'groupProbes', 'raProfileValidation', 'configProbes'].map((m) => `utils/regression/inventory/${m}.ts`);
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the specs and their helpers hold no literal password: the only literal secret value is the empty string of the empty-password pin', () => {
    for (const rel of [...SPECS, ...HELPERS]) {
        const src = read(rel);
        const literal = [...src.matchAll(/\b(?:password|secret)\s*:\s*(['"`])([^'"`]*)\1/gi)].map((m) => m[2]).filter((v) => v !== '');
        expect(literal, `${rel}: a password / secret given as a string literal`).toEqual([]);
    }
});

test('the specs declare the ids 17 / 18 / 19 / 20 / 28 as testMeta({ id, row }) rows, one id family per file, with a priority tag each', () => {
    const blocks = SPECS.flatMap((rel) => testBlocks(read(rel), rel).map((b) => ({ ...b, rel, row: metaRowOf(b.body), key: testKey(b) })));
    const idsByFile = SPECS.map((rel) => [rel, [...new Set(blocks.filter((b) => b.rel === rel).map((b) => b.id))]]);
    expect(idsByFile).toEqual([
        [SPECS[0], ['API-GEN-17']], [SPECS[1], ['API-GEN-18']], [SPECS[2], ['API-GEN-19']], [SPECS[3], ['API-GEN-20']], [SPECS[4], ['API-GEN-28']],
    ]);
    const ids = new Set(blocks.map((b) => (b.row !== undefined && /^[a-z0-9-]+$/.test(b.row) ? b.id : undefined)));
    expect([...ids].sort(), 'every test is testMeta({ id, row }) of the five ledger ids (21 / 22 / 30 are P2 / blocked rows, left out)').toEqual(['API-GEN-17', 'API-GEN-18', 'API-GEN-19', 'API-GEN-20', 'API-GEN-28']);
    expect(new Set(blocks.map((b) => b.key)).size, 'no duplicate row').toBe(blocks.length);
    for (const b of blocks) {
        expect(b.tags, b.title).toContain('@api');
        expect(b.tags.filter((t) => /^@p[123]$/.test(t)), b.title).toHaveLength(1);
    }
    // The pins are P2 tests of their own; the bug row calls test.fail() before its failing step.
    const pins = blocks.filter((b) => /\bpin:\s*'Q\d+'/.test(b.body));
    expect(pins.map((b) => [b.key, /\bpin:\s*'(Q\d+)'/.exec(b.body)![1], b.tags.filter((t) => /^@p[123]$/.test(t))])).toEqual([
        ['API-GEN-18[empty-password]', 'Q9', ['@p2']],
        ['API-GEN-19[pin-q8]', 'Q8', ['@p2']],
    ]);
    const bugs = blocks.filter((b) => b.tags.some((t) => t.startsWith('@bug:')));
    expect(bugs.map((b) => [b.key, b.tags.filter((t) => t.startsWith('@bug:'))])).toEqual([['API-GEN-18[attribute-by-name]', ['@bug:core#2512']]]);
    expect(bugs[0].body).toMatch(/\btest\.fail\(/);
    expect(bugs[0].body.indexOf('test.fail('), 'test.fail() sits right before the failing step: after the ledger adoption, before the orphan assertion').toBeGreaterThan(bugs[0].body.indexOf('adoptByName('));
    // The unknown-group arm is the only @local row and lives under describeLocalOnly(test).
    const local = blocks.filter((b) => b.tags.includes('@local'));
    expect(local.map((b) => b.key)).toEqual(['API-GEN-20[unknown-group]']);
    expect(local[0].describes.join(' / ')).toContain('(local stack)');
    expect(read(SPECS[3])).toMatch(/describeLocalOnly\(test\);/);
    // No fixme is left: the malformed-uuid row waited for a guard change, which is now merged.
    expect(blocks.filter((b) => b.kind === 'fixme').map((b) => b.title)).toEqual([]);
});
