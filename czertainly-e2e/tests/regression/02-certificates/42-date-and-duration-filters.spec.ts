/**
 * REG-CERT-42 — Certificate list filter: dates and durations (release checklist: Certificates, filters). ilm#428.
 *
 * WHAT: 1. Expires At >= and < a picked day (row picker) → the filter goes out as a UTC instant with Z and milliseconds; the
 *          badge and the rows follow.
 *       2. In next 30d → sent as P30D; the three seeds expiring within 30 days are shown.
 *       3. In past 2d → sent as P2D; only the seed that expired yesterday is shown.
 *       4. Expires At empty and not empty → the value control is disabled, Add stays enabled, no value is sent.
 *       5. The duration `2d 30m` → sent as P2DT30M; the badge reads `2d 30m` back.
 *       6. The duration `5x` and `1d 2x` → Add stays disabled and nothing is sent; `5d` enables it.
 * WHY: a date filter must send the instant the operator picked and a duration must reach the API as ISO-8601; a mismatch
 *      silently filters the wrong certificates.
 * HOW: data is the run's own certificate seed (idempotent), expiries spread from +5 days so that every window has a margin; the list is
 *      read, never changed. The oracle is the expected row set computed from the seed clock and an API search with the same filters.
 */
import { expect, test } from '../../../fixtures/areas/certificateList';
import { catalogueFieldLabel, expectedBadgeText } from '../../../utils/regression/inventory/fieldLabels';
import { filtersDifference, formatDateTime } from '../../../utils/regression/inventory/certificateListOracle';
import { isolation, propertyFilter } from '../../../utils/regression/inventory/searchApi';
import { idsWhere } from '../../../utils/regression/inventory/seedFull';
import { DATE_ROWS, FilterRow } from '../../../utils/regression/inventory/searchTables';
import { expectRowsAre, wire } from '../../../utils/regression/inventory/certificateListSteps';
import { CertificateListPage } from '../../../pages/CertificateListPage';
import { testMeta, tags } from '../../../utils/regression/tags';
import { LIST_SPEC_TEST_MS } from '../../../utils/regression/timeouts';

const ISSUE = 'ilm#428';
const DAY = 24 * 3600 * 1000;

test.describe('Certificate list filter: dates and durations', { tag: tags.regression }, () => {
    test.describe.configure({ timeout: LIST_SPEC_TEST_MS });

    // ------------------------------------------------------------------ REG-CERT-42: dates and durations

    const dateRow = (id: string): FilterRow => {
        const row = DATE_ROWS.find((r) => r.row === id);
        if (!row) throw new Error(`no date row ${id}`);
        return row;
    };

    test(
        'the Expires At filter with >= and < a picked date sends a UTC instant with Z and gives the rows',
        testMeta({
            id: 'REG-CERT-42', row: 'picker',
            prio: 'P2',
            issue: ISSUE,
            rule: [
                'a datetime filter goes out as new Date(v).toISOString() (UTC, Z, milliseconds), FilterWidget computeValue',
                '>= and < on NOT_AFTER, picker value taken mid-window (domain analysis, +-5 d margin)',
            ],
        }),
        async ({ signedIn, api, listSeed }) => {
            const { manifest: m, catalogue, labels } = listSeed;
            const inventory = await CertificateListPage.openSeeded(signedIn, listSeed, { isolate: true, pageSize: 25 });
            // The middle of the gap between the seeds expiring in 25 and in 45 days: 35 days after the seed clock; every seed expires
            // more than 5 days away.
            const { picked, instant } = await inventory.pickDateInsideWindow(m.clock, 35, m.certificates.map((c) => c.notAfter));
            const zone = await inventory.browserTimeZone();
            const field = catalogueFieldLabel(catalogue, labels, 'property', 'NOT_AFTER');

            for (const condition of ['GREATER_OR_EQUAL', 'LESSER'] as const) {
                await test.step(`Expires At ${labels.condition(condition)} the picked day (${picked.year}-${picked.month}-${picked.day} 12:00:00 local)`, async () => {
                    const seen = await inventory.filter.addFilter({ source: labels.source('property'), field, condition: labels.condition(condition), value: picked });
                    const sent = (seen.body.filters ?? [])[1];
                    expect(sent, 'the second filter of the request').toMatchObject({ fieldSource: 'property', fieldIdentifier: 'NOT_AFTER', condition });
                    expect(sent.value, 'UTC instant with Z and milliseconds').toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
                    expect(sent.value, 'the instant of the picked local time').toBe(instant);
                    const badge = expectedBadgeText({ source: labels.source('property'), field, condition: labels.condition(condition), value: formatDateTime(instant, zone) });
                    await inventory.filter.assertBadges([expectedBadgeText({ source: labels.source('property'), field: 'Common Name', condition: labels.condition('STARTS_WITH'), value: m.prefix }), badge]);
                    const want = idsWhere(m, (c) => (condition === 'LESSER' ? Date.parse(c.notAfter) < Date.parse(instant) : Date.parse(c.notAfter) >= Date.parse(instant)));
                    await expectRowsAre(inventory, api, m, want, [isolation(m.prefix), propertyFilter('NOT_AFTER', condition, instant)], seen);
                    if (condition === 'GREATER_OR_EQUAL') await inventory.filter.removeBadge(badge);
                });
            }
        },
    );

    test(
        'the In next 30d filter goes out as P30D and shows the three seeds expiring within 30 days',
        testMeta({
            id: 'REG-CERT-42', row: 'in next 30d',
            prio: 'P2',
            issue: ISSUE,
            rule: ['IN_NEXT / IN_PAST take an ISO-8601 duration, `30d` is sent as P30D; an expired certificate is never "in next"'],
        }),
        async ({ signedIn, api, listSeed }) => {
            const { manifest: m, catalogue, labels } = listSeed;
            const inventory = await CertificateListPage.openSeeded(signedIn, listSeed, { isolate: true, pageSize: 25 });
            const row = dateRow('D-12a');
            const [f] = row.filters(m, {});
            const field = catalogueFieldLabel(catalogue, labels, 'property', 'NOT_AFTER');
            const seen = await inventory.filter.addFilter({ source: labels.source('property'), field, condition: labels.condition('IN_NEXT'), value: '30d' });
            expect(filtersDifference(seen.body.filters, [wire(isolation(m.prefix)), wire(f)]), 'the request carries IN_NEXT P30D').toBeUndefined();
            await inventory.filter.assertBadges([
                expectedBadgeText({ source: labels.source('property'), field: 'Common Name', condition: labels.condition('STARTS_WITH'), value: m.prefix }),
                expectedBadgeText({ source: labels.source('property'), field, condition: labels.condition('IN_NEXT'), value: '30d' }),
            ]);
            await expectRowsAre(inventory, api, m, row.expect(m), [isolation(m.prefix), f], seen);
        },
    );

    test(
        'the In past 2d filter goes out as P2D and shows only the seed that expired yesterday',
        testMeta({
            id: 'REG-CERT-42', row: 'in past 2d',
            prio: 'P2',
            issue: ISSUE,
            rule: ['IN_PAST = BETWEEN now-d AND now'],
        }),
        async ({ signedIn, api, listSeed }) => {
            const { manifest: m, catalogue, labels } = listSeed;
            const inventory = await CertificateListPage.openSeeded(signedIn, listSeed, { isolate: true, pageSize: 25 });
            const row = dateRow('D-13a');
            const [f] = row.filters(m, {});
            const field = catalogueFieldLabel(catalogue, labels, 'property', 'NOT_AFTER');
            const seen = await inventory.filter.addFilter({ source: labels.source('property'), field, condition: labels.condition('IN_PAST'), value: '2d' });
            expect(filtersDifference(seen.body.filters, [wire(isolation(m.prefix)), wire(f)]), 'the request carries IN_PAST P2D').toBeUndefined();
            await expectRowsAre(inventory, api, m, row.expect(m), [isolation(m.prefix), f], seen);
        },
    );

    test(
        'the Expires At empty / not empty filter disables the control, sends no value and gives 0 / 24',
        testMeta({
            id: 'REG-CERT-42', row: 'empty and not empty',
            prio: 'P2',
            issue: ISSUE,
            rule: ['EMPTY / NOT_EMPTY: the value control is disabled, not hidden; Add stays enabled; no value key'],
        }),
        async ({ signedIn, api, listSeed }) => {
            const { manifest: m, catalogue, labels } = listSeed;
            const inventory = await CertificateListPage.openSeeded(signedIn, listSeed, { isolate: true, pageSize: 25 });
            const field = catalogueFieldLabel(catalogue, labels, 'property', 'NOT_AFTER');
            for (const id of ['D-10', 'D-11']) {
                const row = dateRow(id);
                const [f] = row.filters(m, {});
                await test.step(`${id}: Expires At ${labels.condition(f.condition)}`, async () => {
                    await inventory.filter.choose({ source: labels.source('property'), field, condition: labels.condition(f.condition) });
                    await inventory.filter.assertValueControlDisabled();
                    await inventory.filter.assertAddEnabled();
                    const seen = await inventory.filter.add();
                    expect(filtersDifference(seen.body.filters, [wire(isolation(m.prefix)), wire(f)]), 'no value key was sent').toBeUndefined();
                    await inventory.filter.assertBadges([
                        expectedBadgeText({ source: labels.source('property'), field: 'Common Name', condition: labels.condition('STARTS_WITH'), value: m.prefix }),
                        expectedBadgeText({ source: labels.source('property'), field, condition: labels.condition(f.condition) }),
                    ]);
                    await expectRowsAre(inventory, api, m, row.expect(m), [isolation(m.prefix), f], seen);
                    await inventory.filter.removeBadge(expectedBadgeText({ source: labels.source('property'), field, condition: labels.condition(f.condition) }));
                });
            }
        },
    );

    test(
        'the duration `2d 30m` goes out as P2DT30M and the badge shows it back as 2d 30m',
        testMeta({
            id: 'REG-CERT-42', row: '2d 30m',
            prio: 'P2',
            issue: ISSUE,
            rule: ['"2d 30m" is sent as P2DT30M (the duration helper); the badge reads the ISO value back as `2d 30m` (FilterWidget getFilterBadgeValue)'],
        }),
        async ({ signedIn, api, listSeed }) => {
            const { manifest: m, catalogue, labels } = listSeed;
            const inventory = await CertificateListPage.openSeeded(signedIn, listSeed, { isolate: true, pageSize: 25 });
            const field = catalogueFieldLabel(catalogue, labels, 'property', 'NOT_AFTER');
            const f = propertyFilter('NOT_AFTER', 'IN_NEXT', 'P2DT30M');
            const seen = await inventory.filter.addFilter({ source: labels.source('property'), field, condition: labels.condition('IN_NEXT'), value: '2d 30m' });
            expect(filtersDifference(seen.body.filters, [wire(isolation(m.prefix)), wire(f)]), 'the request carries P2DT30M').toBeUndefined();
            await inventory.filter.assertBadges([
                expectedBadgeText({ source: labels.source('property'), field: 'Common Name', condition: labels.condition('STARTS_WITH'), value: m.prefix }),
                expectedBadgeText({ source: labels.source('property'), field, condition: labels.condition('IN_NEXT'), value: '2d 30m' }),
            ]);
            // The expected set: expiries between the seed clock and clock + 2 d 30 min (no seed expires that soon: the nearest is +5 d,
            // a 2.5-day margin).
            const clock = Date.parse(m.clock);
            const want = idsWhere(m, (c) => Date.parse(c.notAfter) >= clock && Date.parse(c.notAfter) <= clock + 2 * DAY + 30 * 60 * 1000);
            await expectRowsAre(inventory, api, m, want, [isolation(m.prefix), f], seen);
        },
    );

    test(
        'the duration `5x` keeps Add disabled and sends nothing, `5d` enables it',
        testMeta({
            id: 'REG-CERT-42', row: '5x',
            prio: 'P2',
            issue: ISSUE,
            rule: ['duration input ^(\\d{1,10}\\s*[dhms]\\s*)+$ (the duration validator); an invalid value disables Add (FilterWidget; the widget shows no message of its own, only the format hint)'],
        }),
        async ({ signedIn, listSeed }) => {
            const { manifest: m, catalogue, labels } = listSeed;
            const inventory = await CertificateListPage.openSeeded(signedIn, listSeed, { isolate: true, pageSize: 25 });
            const field = catalogueFieldLabel(catalogue, labels, 'property', 'NOT_AFTER');
            const mark = inventory.traffic.start().mark();
            await inventory.filter.choose({ source: labels.source('property'), field, condition: labels.condition('IN_NEXT') });
            await expect(inventory.filter.durationHint, 'the format hint of the duration box').toBeVisible();
            await inventory.filter.assertAddDisabled(); // no value yet
            await inventory.filter.fillValue('5x');
            await inventory.filter.assertAddDisabled();
            await inventory.filter.fillValue('1d 2x');
            await inventory.filter.assertAddDisabled();
            await inventory.filter.fillValue('5d');
            await inventory.filter.assertAddEnabled();
            expect(inventory.traffic.nonReadsSince(mark), 'an invalid duration sends nothing').toEqual([]);
            expect(await inventory.filter.badges(), 'only the isolation badge').toHaveLength(1);
        },
    );
});
