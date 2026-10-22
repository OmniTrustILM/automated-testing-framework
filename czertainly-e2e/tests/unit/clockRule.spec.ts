/**
 * Unit tests of the clock rule of derived objects.
 *
 * WHAT: a derived object's age is judged on the server's clock; where the answer carries no server time, the bound is one
 *       the object cannot reach, so the teardown keeps it.
 * WHY: a bound taken from the runner's clock deletes a key on a guess when the runner is behind the server; the rule must
 *      err toward keeping.
 * HOW: `createdAfterOf` and `keepingBound` against `derivedDeletable`, the teardown's own test of a creation time.
 */
import { expect, test } from '@playwright/test';
import { createdAfterOf } from '../../utils/regression/apiReads';
import { keepingBound, KEEPING_BOUND_AHEAD_MS } from '../../utils/regression/ledger/ledger';
import { derivedDeletable } from '../../utils/regression/ledger/ownership';

const line = (createdAfter: string) => ({ derived: true as const, createdAfter });

test('createdAfterOf: with a server time the bound is that time minus the margin and the request duration', () => {
    const serverAt = new Date('2026-10-13T12:00:10.000Z');
    const bound = createdAfterOf({ serverAt, startedAt: new Date(), elapsedMs: 3_000 });
    expect(bound).toBe('2026-10-13T12:00:05.000Z');
    expect(derivedDeletable(line(bound), '2026-10-13T12:00:06.000Z'), 'made after the call started').toBe(true);
    expect(derivedDeletable(line(bound), '2026-10-13T11:00:00.000Z'), 'made long before').toBe(false);
});

test('createdAfterOf: with no server time the bound is ahead of every clock skew, so nothing is deletable', () => {
    const now = Date.now();
    const bound = createdAfterOf({ startedAt: new Date(now), elapsedMs: 10 });
    expect(Date.parse(bound)).toBeGreaterThan(now + KEEPING_BOUND_AHEAD_MS - 60_000);
    for (const skew of [-3_600_000, 0, 3_600_000, 6 * 3_600_000]) {
        expect(derivedDeletable(line(bound), new Date(now + skew).toISOString()), `skew ${skew}`).toBe(false);
    }
});

test('keepingBound: a day ahead of the given time, as an ISO instant', () => {
    expect(keepingBound(Date.parse('2026-10-13T12:00:00.000Z'))).toBe('2026-10-14T12:00:00.000Z');
});

test('derivedDeletable: an unreadable bound or creation time keeps the object', () => {
    expect(derivedDeletable({ derived: true, createdAfter: 'not a date' }, '2026-10-13T12:00:00.000Z')).toBe(false);
    expect(derivedDeletable(line('2026-10-13T12:00:00.000Z'), 'not a date')).toBe(false);
    expect(derivedDeletable(line('2026-10-13T12:00:00.000Z'), undefined)).toBe(false);
    expect(derivedDeletable({ derived: true }, '2026-10-13T12:00:00.000Z')).toBe(false);
});
