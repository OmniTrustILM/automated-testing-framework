/**
 * tags — the tag builders and `testMeta()`: every tag spelled in utils/regression/tags.ts, the tag rules enforced when a
 * test's details are built, the `rule` annotations and the @slow tag as the AST reader sees it.
 *
 * WHAT: spells every tag with its builder, refuses malformed references, builds the Playwright details of one ledger
 * row (tags and annotations) and checks that `testBlocks` reads the same id and tags back.
 * WHY: the run filters, the ledger and the reports are keyed by these tags; a misspelled or missing tag silently drops
 * a test from a filter.
 * HOW: pure unit cases over `tags` / `testMeta`; the spec sources are inline strings.
 */
import { test, expect } from '@playwright/test';
import { testBlocks } from '../../utils/regression/specLint/parseSpec';
import { idTag, testMeta, tags } from '../../utils/regression/tags';

test('builders spell every tag', () => {
    expect(tags.issue('ilm#429')).toBe('@issue:ilm#429');
    expect(tags.prio('P1')).toBe('@p1');
    expect(tags.prio('P3')).toBe('@p3');
    expect(tags.pin('A6')).toBe('@pin:A6');
    expect(tags.needs('openssl')).toBe('@needs:openssl');
    expect(tags.bug('core#2502')).toBe('@bug:core#2502');
    expect([tags.regression, tags.api, tags.gate, tags.phaseB, tags.local]).toEqual(['@regression', '@api', '@gate', '@phaseB', '@local']);
});

test('builders refuse malformed references', () => {
    expect(() => tags.issue('429')).toThrow(/repo>#<number/);
    expect(() => tags.bug('core 2502')).toThrow(/repo>#<number/);
    expect(() => tags.prio('P4' as 'P1')).toThrow(/P1, P2 or P3/);
    // The bad value takes the runtime path (a value read at run time, as a tag from a file would be), not a cast.
    expect(() => Reflect.apply(tags.needs, undefined, ['Open SSL'])).toThrow(/not one of/);
});

test('testMeta builds the Playwright details of one ledger row', () => {
    expect(testMeta({ id: 'API-GEN-33', prio: 'P1', issue: 'ilm#428' })).toEqual({
        tag: ['@issue:ilm#448', '@issue:ilm#428', '@p1', '@API-GEN-33'],
        annotation: [{ type: 'ledger-id', description: 'API-GEN-33' }],
    });
    const full = testMeta({ id: 'REG-CFG-07.a', prio: 'P2', issue: ['ilm#427', 'ilm#448'], needs: ['openssl', 'sscep'], local: true, phaseB: true, bug: 'core#2502', pin: 'A6' });
    expect(full.tag).toEqual(['@issue:ilm#448', '@issue:ilm#427', '@p2', '@phaseB', '@local', '@pin:A6', '@needs:openssl', '@needs:sscep', '@bug:core#2502', '@REG-CFG-07.a']);
    expect(testMeta({ id: 'API-GEN-32', prio: 'P1', issue: 'ilm#428', gate: true }).tag).toContain('@gate');
});

test('testMeta tags the test with its id and names a table row as an annotation; testBlocks reads the testMeta id', () => {
    expect(idTag('REG-USE-05')).toBe('@REG-USE-05');
    const m = testMeta({ id: 'REG-CERT-41', prio: 'P2', issue: 'ilm#429', row: 'T-3', rule: 'one rule' });
    expect(m.tag).toContain('@REG-CERT-41');
    expect(m.annotation).toEqual([
        { type: 'ledger-id', description: 'REG-CERT-41' },
        { type: 'row', description: 'T-3' },
        { type: 'rule', description: 'one rule' },
    ]);
    expect(() => testMeta({ id: 'REG-CERT-41', prio: 'P2', issue: 'ilm#429', row: ' ' }), 'a blank row').toThrow(/row/);
    const blocks = testBlocks(`
test('the filter keeps the rows it names', testMeta({ id: 'REG-CERT-41', prio: 'P2', issue: 'ilm#429', row: 'T-3' }), async () => {});
test('REG-CERT-42: the title still carries the id', { tag: ['@regression'] }, async () => {});`);
    expect(blocks.map((b) => b.id)).toEqual(['REG-CERT-41', undefined]);
    expect(blocks[0].tags).toContain('@REG-CERT-41');
});

test('testMeta enforces the tag rules', () => {
    expect(() => testMeta({ id: 'SMK-001', prio: 'P1', issue: 'ilm#428' }), 'not a REG / API ledger id').toThrow(/ledger id/);
    expect(() => testMeta({ id: 'API-GEN-07', prio: 'P1', issue: 'ilm#428', pin: 'A6' }), 'a pin is never P1').toThrow(/never P1/);
    expect(() => testMeta({ id: 'API-GEN-07', prio: 'P1', issue: 'ilm#428', gate: true }), '@gate is API-GEN-32 only').toThrow(/API-GEN-32 only/);
    expect(() => testMeta({ id: 'API-GEN-07', prio: 'P1', issue: 'ilm#448' }), 'the area issue is required').toThrow(/sub-issue/);
});

test('@slow is a registered tag: builder, testMeta and the AST reader know it', () => {
    expect(tags.slow).toBe('@slow');
    expect(testMeta({ id: 'REG-DISC-03', prio: 'P2', issue: 'ilm#430', slow: true }).tag).toEqual(['@issue:ilm#448', '@issue:ilm#430', '@p2', '@slow', '@REG-DISC-03']);
    const blocks = testBlocks(`
test('REG-DISC-03: a', { tag: [tags.slow] }, async () => {});
test('REG-DISC-04: b', testMeta({ id: 'REG-DISC-04', prio: 'P2', issue: 'ilm#430', slow: true }), async () => {});
test('REG-DISC-05: c', { tag: ['@regression', '@slow'] }, async () => {});`);
    expect(blocks.map((b) => b.tags.includes('@slow'))).toEqual([true, true, true]);
});

// ------------------------------------------------------------------ testMeta rule annotations

test('testMeta({ rule }) adds one `rule` annotation per cited rule after the ledger id', () => {
    const m = testMeta({ id: 'REG-CFG-07.a', prio: 'P1', issue: 'ilm#427', bug: 'core#2297', rule: ['release plan CFG-07 N1', 'core#2297'] });
    expect(m.annotation).toEqual([
        { type: 'ledger-id', description: 'REG-CFG-07.a' },
        { type: 'rule', description: 'release plan CFG-07 N1' },
        { type: 'rule', description: 'core#2297' },
    ]);
    expect(testMeta({ id: 'API-GEN-32', prio: 'P1', issue: 'ilm#428', gate: true, rule: 'one rule' }).annotation).toEqual([
        { type: 'ledger-id', description: 'API-GEN-32' },
        { type: 'rule', description: 'one rule' },
    ]);
    expect(m.tag).toEqual(['@issue:ilm#448', '@issue:ilm#427', '@p1', '@bug:core#2297', '@REG-CFG-07.a']);
});

test('testMeta gives a parked row its reason as a fixme annotation, and none otherwise', () => {
    const parked = testMeta({ id: 'REG-CFG-09', prio: 'P1', issue: 'ilm#427', parked: 'needs an account the suite cannot create' });
    expect(parked.annotation).toContainEqual({ type: 'fixme', description: 'needs an account the suite cannot create' });
    expect(testMeta({ id: 'REG-CFG-09', prio: 'P1', issue: 'ilm#427' }).annotation.some((a) => a.type === 'fixme')).toBe(false);
});
