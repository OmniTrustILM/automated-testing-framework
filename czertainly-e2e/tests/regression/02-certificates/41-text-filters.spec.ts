/**
 * REG-CERT-41 — certificate list filter: each text condition on Common Name sends what its badge says and shows the API's rows (ilm#428).
 */
import { expect, test } from '../../../fixtures/areas/certificateList';
import { ListObservation } from '../../../pages/ui/list';
import { badgeOfFilter, widgetSpecOf } from '../../../utils/regression/inventory/fieldLabels';
import { filtersDifference } from '../../../utils/regression/inventory/certificateListOracle';
import { isolation } from '../../../utils/regression/inventory/searchApi';
import { TEXT_ROWS } from '../../../utils/regression/inventory/searchTables';
import { expectRowsAre, wire } from '../../../utils/regression/inventory/certificateListSteps';
import { CertificateListPage } from '../../../pages/CertificateListPage';
import { testMeta, tags } from '../../../utils/regression/tags';
import { LIST_SPEC_TEST_MS } from '../../../utils/regression/timeouts';

const ISSUE = 'ilm#428';

/** The row of each string condition, in words. */
const TEXT_ROW_NAMES: Readonly<Record<string, string>> = {
    'T-1': 'contains',
    'T-2': 'not contains',
    'T-3': 'equals',
    'T-4': 'not equals',
    'T-5': 'empty',
    'T-6': 'not empty',
    'T-7': 'starts with',
    'T-8': 'ends with',
    'T-9': 'matches',
    'T-10': 'not matches'
};

test.describe('Certificate list filter: text conditions', { tag: tags.regression }, () => {
    test.describe.configure({ timeout: LIST_SPEC_TEST_MS });

    for (const row of TEXT_ROWS.filter((r) => /^T-([1-9]|10)$/.test(r.row))) {
        test(
            `in the widget, ${row.title}`,
            testMeta({
                id: 'REG-CERT-41', row: TEXT_ROW_NAMES[row.row],
                prio: 'P2',
                issue: ISSUE,
                rule: [
                    'string conditions: NOT_CONTAINS / NOT_EQUALS include nulls, NOT_MATCHES excludes them',
                    'Add disabled until a value is set, same field + condition refused, filters AND, badge text',
                ],
            }),
            async ({ signedIn, api, listSeed }) => {
                const { manifest: m, catalogue, labels } = listSeed;
                const [filter] = row.filters(m, {});
                // The row's own STARTS_WITH on Common Name (starts with) IS the narrowed isolation: a second one on the field is refused.
                const narrowsPrefix = filter.fieldIdentifier === 'COMMON_NAME' && filter.condition === 'STARTS_WITH';
                const apiFilters = narrowsPrefix ? [filter] : [isolation(m.prefix), filter];

                const inventory = await CertificateListPage.openSeeded(signedIn, listSeed, { pageSize: 25 });
                let seen!: ListObservation;
                for (const f of apiFilters) seen = await inventory.addFilter(widgetSpecOf(f, catalogue, labels));

                await test.step('Badges: the isolation badge is kept, the row\'s badge reads Property \'Common Name\' <condition> \'<value>\'', async () => {
                    await inventory.assertFilterBadges(apiFilters.map((f) => badgeOfFilter(f, catalogue, labels)));
                });
                await test.step('The request carries exactly these filters on page 1 with the size 25', async () => {
                    expect(filtersDifference(seen.body.filters, apiFilters.map(wire))).toBeUndefined();
                    expect(seen.body.itemsPerPage).toBe(25);
                    expect(seen.body.pageNumber).toBe(1);
                });
                await test.step(`Rows shown = the expected set (${row.expectedIds} expected); count = the API total`, async () => {
                    await expectRowsAre(inventory, api, { manifest: m, ids: row.expect(m), filters: apiFilters, seen });
                });
            },
        );
    }
});
