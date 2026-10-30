/**
 * parseSpec — the AST reader of spec sources: `testBlocks`, inherited describe tags, `@bug` needs `test.fail()`, exactly
 * one suite tag per test, and `codeNames`.
 *
 * Reads inline spec sources and checks the test blocks found (title, kind, body, tags, describes), the tag problems
 * reported and the identifiers `codeNames` sees. The lints over the real specs (specGuards) rely on this reader, so a
 * missed block or a tag that is not inherited would let a spec through unchecked. Every source is an inline string,
 * including comments and brackets inside strings and regexes.
 */
import { test, expect } from '@playwright/test';
import { bugTagsWithoutFail, codeNames, suiteTagProblems, testBlocks } from '../../utils/regression/specLint/parseSpec';

test('testBlocks finds each test call with its whole body', () => {
    const src = [
        "test.describe('x', () => {",
        "  test('A-1: first', async () => { const s = ')'; /* ) */ await f(\"(\"); });",
        '  test(`A-2: second`, testMeta({ id: "A" }), async () => {',
        '    // a comment with ) and }',
        '    await g();',
        '  });',
        '});',
    ].join('\n');
    const blocks = testBlocks(src);
    expect(blocks.map((b) => b.title)).toEqual(['A-1: first', 'A-2: second']);
    expect(blocks[1].body).toContain('await g();');
    expect(blocks[0].body).not.toContain('A-2');
});

test('a @bug tag without test.fail() is found, with test.fail() it passes', () => {
    const src = `
test('API-GEN-07: refused method answers 400', testMeta({ id: 'API-GEN-07', prio: 'P1', issue: 'ilm#428', bug: 'core#2502' }), async () => {
    test.fail(await isMigratedBuild(api), '@bug:core#2502 on the migrated build');
    expect(1).toBe(1);
});
test('API-GEN-08: tag literal, no fail', { tag: ['@bug:core#1'] }, async () => {
    expect(1).toBe(1);
});
test('API-GEN-09: tags.bug builder, no fail', { tag: [tags.bug('core#2')] }, async () => {});
test('API-GEN-10: no bug at all', async () => {});
`;
    expect(bugTagsWithoutFail(src)).toEqual(['API-GEN-08: tag literal, no fail', 'API-GEN-09: tags.bug builder, no fail']);
});

test('the AST finds every declaration form, ignores modifiers and steps, and inherits describe tags', () => {
    const src = `
import { tags } from 'x';
test.describe('@regression REG-X suite', () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(!process.env.BASE_URL, 'no tier');            // a modifier, not a test
    test('REG-X-01: brackets in regexes and strings do not end the block', async () => {
        const re = /\\)[}]/;
        await test.step('a step is not a test', async () => {});
        const s = \`)\${'}'}\`;
    });
    test.fixme('REG-X-02: fixme counts', { tag: tags.bug('core#1') }, async () => {});
    test.skip('REG-X-03: skip counts', async () => {});
    test.describe('inner', { tag: ['@local'] }, () => {
        test.fail('REG-X-04: declared failing', testMeta({ id: 'REG-X-04', prio: 'P2', issue: 'ilm#1', bug: 'core#2' }), async () => {});
    });
});`;
    const blocks = testBlocks(src);
    expect(blocks.map((b) => [b.title, b.kind])).toEqual([
        ['REG-X-01: brackets in regexes and strings do not end the block', 'test'],
        ['REG-X-02: fixme counts', 'fixme'],
        ['REG-X-03: skip counts', 'skip'],
        ['REG-X-04: declared failing', 'fail'],
    ]);
    expect(blocks[0].body).toContain('a step is not a test');
    expect(blocks[1].tags).toEqual(['@regression', '@bug:core#1']);
    expect(blocks[3].tags).toEqual(expect.arrayContaining(['@regression', '@local', '@p2', '@bug:core#2']));
    expect(blocks[3].describes).toEqual(['@regression REG-X suite', 'inner']);
});

test('a @bug in a fixme or skip block, or inherited from a describe, needs test.fail()', () => {
    const src = `
test.fixme('A-1: fixme as a bug marker', { tag: ['@bug:core#3'] }, async () => {});
test.describe('known bug', { tag: '@bug:core#4' }, () => {
    test('A-2: inherits the bug', async () => {});
    test('A-3: asserts it', async () => { test.fail(true, 'core#4'); });
});
test.fail('A-4: a failing declaration is fine', { tag: ['@bug:core#5'] }, async () => {});`;
    expect(bugTagsWithoutFail(src)).toEqual(['A-1: fixme as a bug marker', 'A-2: inherits the bug']);
});

test('exactly one suite tag per test: missing and doubled tags are reported', () => {
    const src = `
test.describe('@regression R suite', () => { test('R-1: fine', async () => {}); });
test.describe('API suite', { tag: tags.api }, () => { test('A-1: fine', async () => {}); test('A-2: two', { tag: ['@regression'] }, async () => {}); });
test('X-1: none', async () => {});`;
    expect(suiteTagProblems(src)).toEqual(['A-2: two (line 3): @api + @regression', 'X-1: none (line 4): no suite tag']);
});

// codeNames sees identifiers and strings, not comments (the describeLocalOnly rule for localStack / guardOptions)
test('codeNames sees identifiers and strings, not comments, for the describeLocalOnly rule', () => {
    const names = codeNames("// test.use({ guardOptions: { localStack: true } })\nconst a = 1; /* apiGuardOptions */ test.use({ 'apiGuardOptions': {} });");
    expect(['guardOptions', 'localStack'].map((n) => names.has(n))).toEqual([false, false]);
    expect(names.has('apiGuardOptions')).toBe(true);
});
