/**
 * titleLint — the title and details rules specGuards runs over the REG and API specs (no tag in a describe title; no id
 * prefix, at most 100 characters, one clause, lower-case start, unique per file, testMeta() on every test) and the reader of
 * a test's testMeta() row that the structure checks name tests by.
 */
import { test, expect } from '@playwright/test';
import { listedTitleProblems, metaRowOf, seedCodeProblems, testKey, titleProblems } from '../../utils/regression/specLint/titleLint';

test('the title lint: describe tags, id prefixes, length, one clause, capitals, duplicates and missing testMeta() are reported', () => {
    const m = "testMeta({ id: 'REG-CFG-01', prio: 'P1', issue: 'ilm#427' })";
    const src = `
test.describe('@regression credentials', { tag: ['@regression'] }, () => {
    test('REG-CFG-01: creates it', ${m}, async () => {});
    test('${'a'.repeat(101)}', ${m}, async () => {});
    test('creates it; deletes it', ${m}, async () => {});
    test('Creates it', ${m}, async () => {});
    test('creates it', ${m}, async () => {});
    test('creates it', ${m}, async () => {});
    test('creates nothing', { tag: ['@p1'] }, async () => {});
});`;
    expect(titleProblems(src).map((p) => p.replace(/ \(line.*$/, ''))).toEqual([
        'describe title carries a tag',
        'id prefix in the title',
        'title longer than 100 (101)',
        'two clauses joined by "; "',
        'title starts upper-case',
        'duplicate title, first at line 7',
        'no testMeta() details',
    ]);
});

test('the title lint accepts acronyms, proper nouns, template variants and testMeta() through a helper or a constant', () => {
    const src = `
test.describe('Credential configuration', { tag: ['@regression'] }, () => {
    const rowMeta = (row: string) => testMeta({ id: 'API-WFL-04', row, prio: 'P1', issue: 'ilm#438' });
    const details = testMeta({ id: 'API-WFL-05', prio: 'P1', issue: 'ilm#438' });
    test('ACME new-account answers 400', rowMeta('a'), async () => {});
    test('ML-DSA keys sign', rowMeta('b'), async () => {});
    test('PUT without the password answers 422', details, async () => {});
    test('GetCACert answers the CA chain', { ...rowMeta('c'), timeout: 1 }, async () => {});
    for (const k of ['a', 'b']) test(\`sorts \${k} both ways\`, rowMeta(k), async () => {});
    test(\`\${'x'.repeat(200)} stays short in the literal text\`, rowMeta('d'), async () => {});
});`;
    expect(titleProblems(src)).toEqual([]);
});

test('metaRowOf and testKey read the literal testMeta() row of a test call; no row gives the id alone', () => {
    const calls = [
        { id: 'REG-CERT-41', body: "test('keeps the rows it names', testMeta({ id: 'REG-CERT-41', prio: 'P2', issue: 'ilm#429', row: 'T-3', rule: ['row: not this'] }), async () => {})" },
        { id: 'REG-CERT-41', body: "test('keeps every row', testMeta({ id: 'REG-CERT-41', prio: 'P2', issue: 'ilm#429' }), async () => {})" },
        { id: 'REG-CERT-42', body: "test('a computed row is not read', testMeta({ id: 'REG-CERT-42', prio: 'P2', issue: 'ilm#429', row: key }), async () => {})" },
        { body: "test('no meta at all', async () => {})" },
    ];
    expect(calls.map((b) => [metaRowOf(b.body), testKey(b)])).toEqual([
        ['T-3', 'REG-CERT-41[T-3]'],
        [undefined, 'REG-CERT-41'],
        [undefined, 'REG-CERT-42'],
        [undefined, undefined],
    ]);
});

test('the title lint also reads describe ids, describe modifier chains and title-only declarations', () => {
    const m = "testMeta({ id: 'REG-CFG-01', prio: 'P1', issue: 'ilm#427' })";
    const src = `
test.describe('REG-PROT-01 ACME issue and revoke', () => {});
test.describe.serial.only('@regression x', () => {});
test.describe.parallel.only('API-GEN-01 errors', () => {});
test.fixme('REG-CFG-01: a declaration without a body', ${m});
test.fixme('a declaration without details');
test.skip(true, 'a condition is a modifier, not a declaration');`;
    expect(titleProblems(src).map((p) => p.replace(/ \(line.*$/, ''))).toEqual([
        'describe title carries an id',
        'describe title carries a tag',
        'describe title carries an id',
        'id prefix in the title',
        'no testMeta() details',
    ]);
});

test('the title lint accepts names with an inner capital or digit and still flags the article "A"', () => {
    const m = "testMeta({ id: 'REG-CFG-01', prio: 'P1', issue: 'ilm#427' })";
    const titles = ['OpenAPI documents describe the detail', 'IPv6 SANs are issued', 'GetCACert answers PKCS#7', 'A role sees nothing', 'Expires At sorts'];
    const src = titles.map((t) => `test('${t}', ${m}, async () => {});`).join('\n');
    expect(titleProblems(src).map((p) => p.replace(/^title starts upper-case \(line \d+: /, '').replace(/\)$/, ''))).toEqual(['A role sees nothing', 'Expires At sorts']);
});

test('the runtime check reads listed titles: template values, describe ids, length, duplicates in a file', () => {
    const report = {
        suites: [{
            title: 'a.api.spec.ts', file: 'a.api.spec.ts',
            specs: [{ title: 'sorts by name', line: 3, column: 5 }],
            suites: [{
                title: 'API-GEN-10 sort contract',
                specs: [
                    { title: 'API-GEN-10 sorts', line: 9, column: 9 },
                    { title: 'sorts by name', line: 12, column: 9 },
                    { title: 'x'.repeat(101), line: 15, column: 9 },
                    { title: 'refuses it; logs it', line: 18, column: 9 },
                    { title: 'a looped title', line: 21, column: 9 },
                    { title: 'a looped title', line: 21, column: 9 },
                ],
            }],
        }],
    };
    expect(listedTitleProblems(report).map((p) => p.replace(/: [^:]*$/, ''))).toEqual([
        'a.api.spec.ts: describe title carries an id',
        'a.api.spec.ts:9: id prefix in the title',
        'a.api.spec.ts:12: duplicate title in the file',
        'a.api.spec.ts:15: title longer than 100 (101)',
        'a.api.spec.ts:18: two clauses joined by "; "',
    ]);
});

test('the runtime check refuses seed codes and placeholders in a listed title, and accepts the words for them', () => {
    const listed = (titles: string[]) => ({ suites: [{ title: 'b.api.spec.ts', file: 'b.api.spec.ts', specs: titles.map((title, i) => ({ title, line: 3 * i + 3, column: 5 })) }] });
    expect(listedTitleProblems(listed([
        'a Common Name filter on <P> returns the seeds',
        'a filter on <…> returns nothing',
        'a NOT_AFTER filter before T(C03) returns two seeds',
        'a group filter returns {C03, C04}',
        'a day filter [a] returns two seeds',
        'the list shows C03 first',
    ])).map((p) => p.replace(/: [^:]*$/, ''))).toEqual([
        'b.api.spec.ts:3: a placeholder (<P>, <…>) in the title',
        'b.api.spec.ts:6: a placeholder (<P>, <…>) in the title',
        'b.api.spec.ts:9: a seed function code (T(C…)) in the title',
        'b.api.spec.ts:9: a seed code (C01 … C24) in the title',
        'b.api.spec.ts:12: a seed set code ({C…}) in the title',
        'b.api.spec.ts:12: a seed code (C01 … C24) in the title',
        'b.api.spec.ts:15: a bare row tag ([a]) in the title',
        'b.api.spec.ts:18: a seed code (C01 … C24) in the title',
    ]);
    expect(seedCodeProblems("a Common Name filter on the run's prefix returns the 25-day seed's expiry")).toEqual([]);
    expect(seedCodeProblems('the CMP [v2] answer, an ACME C0 control character, ML-DSA-65 and an array [] body')).toEqual([]);
});
