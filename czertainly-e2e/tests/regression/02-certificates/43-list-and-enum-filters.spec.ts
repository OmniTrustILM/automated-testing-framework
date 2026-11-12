/**
 * REG-CERT-43 — Certificate list filter: lists and enums (release checklist: Certificates, filters). ilm#428.
 *
 * WHAT: One test per row (the state equals and does not equal issued, the key size, the subject type, the group collection):
 *       1. Add the multi-select filter in the widget (next to the run's isolation filter).
 *       2. The badge joins the labels with OR, and the request carries the value as an array (codes; names for groups).
 *       3. The rows shown equal the expected set of the seed and the API search for the same filters.
 * WHY: list filters compare codes, several values mean any of, and NOT_EQUALS is the complement; the widget must send what the badge shows.
 * HOW: data is the run's own certificate seed (idempotent; the groups are set on own certificates only); the list is read,
 *      never changed. The oracle is the seed row's expected set and an API search with the same filters.
 */
import { expect, test } from '../../../fixtures/areas/certificateList';
import { badgeOfFilter, expectedBadgeText, widgetSpecOf } from '../../../utils/regression/inventory/fieldLabels';
import { filtersDifference } from '../../../utils/regression/inventory/certificateListOracle';
import { isolation } from '../../../utils/regression/inventory/searchApi';
import { COLLECTION_ROWS, FilterRow, LIST_ROWS } from '../../../utils/regression/inventory/searchTables';
import { expectRowsAre, wire } from '../../../utils/regression/inventory/certificateListSteps';
import { CertificateListPage } from '../../../pages/CertificateListPage';
import { testMeta, tags } from '../../../utils/regression/tags';
import { LIST_SPEC_TEST_MS } from '../../../utils/regression/timeouts';

const ISSUE = 'ilm#428';

test.describe('Certificate list filter: lists and enums', { tag: tags.regression }, () => {
    test.describe.configure({ timeout: LIST_SPEC_TEST_MS });

    // ------------------------------------------------------------------ REG-CERT-43: enum and list filters

    const listRows: Array<{ table: readonly FilterRow[]; row: string; name: string }> = [
        { table: LIST_ROWS, row: 'L-1a', name: 'state equals issued' },
        { table: LIST_ROWS, row: 'L-1c', name: 'state not equals issued' },
        { table: LIST_ROWS, row: 'L-3a', name: 'key size equals 3072' },
        { table: LIST_ROWS, row: 'L-5c', name: 'subject type root or end entity' },
        { table: COLLECTION_ROWS, row: 'G-1a', name: 'group equals' },
    ];

    for (const { table, row: rowId, name } of listRows) {
        const row = table.find((r) => r.row === rowId);
        if (!row) throw new Error(`no row ${rowId}`);
        test(
            `in the widget, ${row.title}`,
            testMeta({
                id: 'REG-CERT-43', row: name,
                prio: 'P2',
                issue: ISSUE,
                rule: [
                    'a list value is a multi-select, sent as an array of codes (names for groups); the badge joins the labels with " OR " (FilterWidget getFilterBadgeValue)',
                    'LIST: EQUALS with several values = any of, enum lists compare the code, NOT_EQUALS = complement',
                ],
            }),
            async ({ signedIn, api, listSeed }) => {
                const { manifest: m, catalogue, labels } = listSeed;
                const [filter] = row.filters(m, {});
                const apiFilters = [isolation(m.prefix), filter];

                const inventory = await CertificateListPage.openSeeded(signedIn, listSeed, { isolate: true, pageSize: 25 });
                const seen = await inventory.filter.addFilter(widgetSpecOf(filter, catalogue, labels));

                await test.step('Badge text and the wire format of the value', async () => {
                    await inventory.filter.assertBadges([
                        expectedBadgeText({ source: labels.source('property'), field: 'Common Name', condition: labels.condition('STARTS_WITH'), value: m.prefix }),
                        badgeOfFilter(filter, catalogue, labels),
                    ]);
                    expect(filtersDifference(seen.body.filters, apiFilters.map(wire)), 'the request carries the filter').toBeUndefined();
                    if ((filter.value as unknown[]).length > 1) {
                        expect(Array.isArray((seen.body.filters ?? [])[1].value), 'a multi-select value goes out as an array').toBe(true);
                    }
                });
                await test.step('Rows shown = the expected set; count = the API total', async () => {
                    await expectRowsAre(inventory, api, m, row.expect(m), apiFilters, seen);
                });
            },
        );
    }
});
