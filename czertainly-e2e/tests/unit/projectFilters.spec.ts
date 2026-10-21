/**
 * Unit tests for projectFilters.ts (direct tests): `allOf()` / `anyOf()` build single RegExps with the
 * documented semantics, flags that cannot be combined are refused, `withTierFilters` folds the tier rules into every
 * project (infrastructure projects keep running in Phase B), and `resolveProjectFilters` mirrors Playwright's
 * takeFirst (a project's grep REPLACES the config's).
 */
import { test, expect } from '@playwright/test';
import { allOf, anyOf, resolveProjectFilters, selectsTest, tierRules, withTierFilters } from '../../utils/regression/projectFilters';

test('or: any pattern; and: every pattern, in any order', () => {
    const o = anyOf(/@p1\b/, [/@p2\b/, /@p3\b/])!;
    expect(o.test('x @p2')).toBe(true);
    expect(o.test('x @p4')).toBe(false);
    const a = allOf(/@p1\b/, /@phaseB\b/)!;
    expect(a.test('@phaseB t @p1')).toBe(true);
    expect(a.test('t @p1')).toBe(false);
    expect(allOf(undefined, [])).toBeUndefined();
    expect(allOf(/@x/)!.test('a @x b')).toBe(true);
    expect(() => anyOf(/x/i)).toThrow(/cannot be combined/);
});

test('tierRules: @local excluded unless TIER_KIND=local; @phaseB only with REG_PHASE=B', () => {
    expect(tierRules({})).toEqual({ grep: undefined, grepInvert: /@local\b/ });
    expect(tierRules({ TIER_KIND: 'local', REG_PHASE: 'B' })).toEqual({ grep: /@phaseB\b/, grepInvert: undefined });
});

test('withTierFilters folds the rules into each project; infrastructure ignores the phase grep', () => {
    const projects = withTierFilters([{ name: 'snapshot' }, { name: 'rows', grep: /@p1\b/, grepInvert: /@gate\b/ }], { env: { REG_PHASE: 'B' }, infrastructure: ['snapshot'] });
    const [snapshot, rows] = resolveProjectFilters({ projects });
    expect(selectsTest(snapshot, 'setup @p1')).toBe(true);
    expect(selectsTest(snapshot, 'setup @local')).toBe(false);
    expect(selectsTest(rows, 'row @p1')).toBe(false);
    expect(selectsTest(rows, 'row @phaseB @p1')).toBe(true);
    expect(selectsTest(rows, 'row @phaseB @p1 @gate')).toBe(false);
    expect(selectsTest(rows, 'row @phaseB @p1 @local:notif')).toBe(false);
});

test('resolveProjectFilters: the project value replaces the config value (takeFirst)', () => {
    const [p] = resolveProjectFilters({ grep: /@a/, grepInvert: /@local/, projects: [{ name: 'p', grep: /@b/ }] });
    expect(p.grep.map(String)).toEqual(['/@b/']);
    expect(p.grepInvert!.map(String), 'the config grepInvert applies only because the project has none').toEqual(['/@local/']);
    const [q] = resolveProjectFilters({ grepInvert: /@local/, projects: [{ name: 'q', grepInvert: /@gate/ }] });
    expect(selectsTest(q, 't @local'), 'a project grepInvert drops the config one: why withTierFilters exists').toBe(true);
});
