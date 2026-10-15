/**
 * Fixture for tests/unit/specGuards.spec.ts (review R19): tests that are only LISTED, never run, through the real
 * REG / API configs (wrapped by regression.fixture.config.ts / api.fixture.config.ts, which point every project at this
 * folder). With TIER_KIND unset, no project may select a `@local` test, in any tag combination; the plain rows prove
 * that the projects still select something. Not a unit test itself: playwright.unit.config.ts ignores tests/unit/fixtures.
 */
import { test } from '@playwright/test';

test.describe('list-filter fixture', { tag: '@api' }, () => {
    test('FIX-01: plain P1 row', { tag: ['@p1'] }, () => {});
    test('FIX-02: plain P2 row', { tag: ['@p2'] }, () => {});
    test('FIX-03: gate row', { tag: ['@gate', '@p1'] }, () => {});
    test('FIX-04: local P1 row', { tag: ['@p1', '@local'] }, () => {});
    test('FIX-05: local P3 row with a variant', { tag: ['@p3', '@local:notif'] }, () => {});
    test('FIX-06: local gate row', { tag: ['@gate', '@p1', '@local'] }, () => {});
    test('FIX-07: local phase B row', { tag: ['@phaseB', '@p1', '@local'] }, () => {});
    test('FIX-08: @local in the title only @p2', () => {});
    test.describe('local describe', { tag: '@local' }, () => {
        test('FIX-09: inherits @local from its describe', { tag: ['@p1'] }, () => {});
    });
});
