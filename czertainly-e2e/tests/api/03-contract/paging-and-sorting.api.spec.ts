/**
 * API-GEN-11, API-GEN-12 — The sort and catalogue contract of the listings. ilm#428, ilm#442.
 *
 * WHAT: 1. Each searchable-fields catalogue (every searchable resource) has the right shape, unique identifiers and labels and the absolute
 *          condition set per field type; the keys' CKI_LENGTH is a number; the audit log publishes the Property source only and no sortable
 *          field.
 *       2. Any sort on the audit log and on every listing outside the configurable-column inventories → 422 with the fixed text "Sorting
 *          is not supported for the <listing> listing."; keys and discoveries refuse an unknown sort field and a non-sortable field with
 *          their fixed texts.
 *       3. Every sortable field of keys and discoveries sorts both ways over the real data with empty values last; page 2 continues page 1
 *          and ties are ordered by uuid ascending whatever the direction.
 * WHY: the front end offers exactly the conditions the catalogue publishes, and sortable is false for native-array, JSON-path, derived and
 *      bit-mask fields (core#2180: sortable implies displayable). The whole set is ordered before paging, rows without a value last,
 *      multi-valued fields by minimum ascending and maximum descending (core#2031, core#2394).
 * HOW: read-only; no count is written down. Whatever data the tier holds is the oracle's input, so a listing that is empty or answers 404
 *      on the tier skips with the named reason; the field oracles retry once with a re-read. About 20 reads per sortable field, hence the
 *      long time limit.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { expectRefused } from '../../../utils/regression/errorContract';
import { CatalogueGroup, fieldsOf, readJsonOk, readAnswer } from '../../../utils/regression/inventory/searchApi';
import { CATALOGUES, DISCOVERIES, expectationsOf, KEYS, SORT_REFUSING_LISTINGS } from '../../../utils/regression/inventory/oracles/listingTables';
import { catalogueProblems } from '../../../utils/regression/inventory/oracles/catalogueContract';
import { transportThroughGuard, ListingRun, ListingSpec, loadBaseline, RunLog, retryOnceWithReread } from '../../../utils/regression/inventory/oracles/listing';
import { probeSort, runSortField, runTieBreak, sortOf, targetOf, unsupportedSortText } from '../../../utils/regression/inventory/oracles/sortOracles';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import { EVENT_DELIVERY_MS } from '../../../utils/regression/timeouts';
import { testMeta, tags } from '../../../utils/regression/tags';

const ISSUES = ['ilm#428', 'ilm#442'];

/** The catalogue of a listing, or a named skip when the build does not serve it (404). */
async function catalogueOrSkip(api: GuardedApi, url: string): Promise<CatalogueGroup[]> {
    const p = await readAnswer(api, url);
    test.skip(p.status === 404, `${url} answers 404 on this build: the listing has no searchable-fields catalogue here`);
    return readJsonOk<CatalogueGroup[]>(p, `GET ${url}`);
}

test.describe('sort and catalogue contracts', { tag: tags.api }, () => {
    // ------------------------------------------------------------------ API-GEN-12: the catalogue of every searchable resource

    for (const row of CATALOGUES) {
        test(`the ${row.name} catalogue holds the contract`,
            testMeta({
                id: 'API-GEN-12', row: row.name, prio: 'P1', issue: ISSUES,
                rule: [
                    'field type × conditions matrix: the FE offers exactly the catalogue\'s conditions; sortable false for native-array, JSON-path, derived and bit-mask fields',
                    'core SearchFieldTypeEnum, SearchHelper.availableConditions / prepareSearch / isSortableField; core#2180 (sortable ⇒ displayable); interfaces SearchFieldDataDto / SearchFieldDataByGroupDto',
                    ...(row.name === 'auditLogs' ? ['AuditLogServiceImpl (Property source only); RequestValidatorHelper (no sort)'] : []),
                    ...(row.name === 'keys' ? ['FilterField.CKI_LENGTH is a NUMBER (SearchFieldTypeEnum.NUMBER: 8 conditions)'] : []),
                    `contract of GET ${row.url}: shape, absolute condition sets, unique identifiers, labels${row.listing ? ', the field table' : ''}`,
                ],
            }),
            async ({ api }, testInfo) => {
                const p = await readAnswer(api, row.url);
                test.skip(p.status === 404, `${row.url} answers 404 on this build: the resource has no searchable-fields catalogue here`);
                expect(p.status, `GET ${row.url}: ${p.text.slice(0, 200)}`).toBe(200);
                const report = catalogueProblems(p.json, row.listing ? expectationsOf(row.listing, row.onlyProperty) : { configurable: row.configurable, onlyProperty: row.onlyProperty });
                testInfo.annotations.push({ type: 'fields', description: `${report.fields.length} fields: ${[...new Set(report.fields.map((f) => f.source))].join(', ')}` });
                expect(report.problems, `catalogue of ${row.name}`).toEqual([]);
                if (row.name === 'keys') {
                    const length = report.fields.find((f) => f.source === 'property' && f.id === 'CKI_LENGTH');
                    expect(length?.type, 'CKI_LENGTH is a NUMBER field').toBe('number');
                }
                if (row.name === 'auditLogs') {
                    expect(report.fields.every((f) => f.source === 'property'), 'the audit log publishes the Property source only').toBe(true);
                    expect(report.fields.filter((f) => f.sortable), 'and no sortable field').toEqual([]);
                }
            });
    }

    // ------------------------------------------------------------------ API-GEN-11: sort refusals

    for (const l of SORT_REFUSING_LISTINGS) {
        test(`any sort on the ${l.label} listing is refused 422`,
            testMeta({
                id: 'API-GEN-11', row: `refuse.${l.name}`, prio: 'P1', issue: ISSUES,
                rule: ['audit logs, and every listing outside the seven configurable-column inventories, refuse a sort (a sort on a listing that does not sort)', `core RequestValidatorHelper; ${l.evidence}`, `refusal text "${unsupportedSortText(l.label)}"`],
            }),
            async ({ api }) => {
                const t = transportThroughGuard(api);
                // Both probes are sent before anything is asserted: a listing that is not served skips the row as a whole, so no
                // assertion that already ran is hidden behind a skip decided by a later probe.
                const sorts = [sortOf('ANY_FIELD', 'property', 'asc'), sortOf('COMMON_NAME', 'property', 'desc')];
                const answers = [];
                for (const sort of sorts) answers.push(await probeSort(t, l.url, sort));
                // Only a 404 skips the row; any other answer is asserted (a 5xx or a wrong status on one probe fails the row even when the
                // other probe answered 404).
                for (const [i, p] of answers.entries()) {
                    if (p.status === 404) continue;
                    expectRefused(p, { status: 422, text: unsupportedSortText(l.label), among: true, what: `${l.url} sorted by ${sorts[i].fieldIdentifier}` });
                }
                test.skip(answers.some((p) => p.status === 404), `${l.url} answers 404 on this build: the listing does not exist here`);
            });
    }

    const CONFIGURABLE: ListingSpec[] = [KEYS, DISCOVERIES];
    for (const spec of CONFIGURABLE) {
        test(`${spec.name} refuses unknown and non-sortable sort fields`,
            testMeta({
                id: 'API-GEN-11', row: `refuse-fields.${spec.name}`, prio: 'P1', issue: ISSUES,
                rule: ['a sort on an unknown field or on a non-sortable field is refused (core ListingSortResolver, SortOrderBuilder; core#2031 AC4)', 'each refusal carries the fixed text'],
            }),
            async ({ api }) => {
                const t = transportThroughGuard(api);
                const catalogue = await catalogueOrSkip(api, spec.catalogueUrl);
                const unknown = await probeSort(t, spec.searchUrl, sortOf('QA_NO_SUCH_FIELD'));
                expectRefused(unknown, { status: 422, text: 'Unknown sort field identifier QA_NO_SUCH_FIELD.', among: true, what: `${spec.searchUrl} sorted by an unknown field` });
                const notSortable = fieldsOf(catalogue, 'property').find((f) => f.sortable === false);
                test.skip(!notSortable, `the ${spec.name} catalogue publishes no non-sortable property field to probe`);
                const p = await probeSort(t, spec.searchUrl, sortOf(notSortable!.fieldIdentifier));
                expectRefused(p, { status: 422, text: `Field ${notSortable!.fieldIdentifier} cannot be used to order this listing.`, among: true, what: `${spec.searchUrl} sorted by ${notSortable!.fieldIdentifier}` });
            });
    }

    // ------------------------------------------------------------------ API-GEN-11: every sortable field sorts over real data

    for (const spec of CONFIGURABLE) {
        test(`every sortable ${spec.name} field sorts both ways, empty values last`,
            testMeta({
                id: 'API-GEN-11', row: `sort.${spec.name}`, prio: 'P1', issue: ISSUES,
                rule: [
                    'the whole set is ordered before paging; rows without a value come last in both directions; multi-valued fields sort by min asc / max desc; core#2031 AC2, core#2394',
                    'core SortOrderBuilder.tieBreak (uuid ascending whatever the direction)',
                    'over the real data: page 2 continues page 1, ties by uuid ascending',
                    'both ways = ascending and descending',
                ],
            }),
            async ({ api }, testInfo) => {
                // About 20 reads per sortable field, two re-reads at most.
                test.setTimeout(EVENT_DELIVERY_MS);
                const t = transportThroughGuard(api);
                const log = new RunLog();
                const catalogue = await catalogueOrSkip(api, spec.catalogueUrl);
                const base = await loadBaseline(t, spec);
                const run: ListingRun = { transport: t, spec, baseline: base, log };
                test.skip(base.total === 0, `the ${spec.name} listing is empty on this tier: there is no data to sort`);
                const live = new Map(fieldsOf(catalogue, 'property').map((f) => [f.fieldIdentifier, f]));
                const problems: string[] = [];
                let sorted = 0;
                for (const field of spec.fields) {
                    if (!live.get(field.id)?.sortable || field.sort === 'none') continue;
                    sorted += 1;
                    try {
                        await retryOnceWithReread(field.id, log, () => runSortField(run, targetOf(field)));
                        await retryOnceWithReread(`${field.id} tie-break`, log, async () => void (await runTieBreak(run, targetOf(field))));
                    } catch (e) {
                        problems.push(`${field.id}: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
                testInfo.annotations.push({ type: 'sorted-fields', description: `${sorted} sortable field(s) over ${base.total} row(s)` });
                for (const n of log.notes) testInfo.annotations.push({ type: 'note', description: n });
                expect(sorted, `precondition: the ${spec.name} catalogue publishes sortable fields the table maps`).toBeGreaterThan(0);
                expect(problems.join('\n'), 'sortable fields that break the sort contract').toBe('');
            });
    }
});
