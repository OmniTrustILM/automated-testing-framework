/**
 * API-GEN-11, 12 — the sort contract across the listings and the searchable-fields catalogue contract (inventory-api plan
 * §3.3; ilm#428 T4 steps 12–14, ilm#442 QA#10; rules §2.2 r21–r25, §2.3, §1.3 sort rows).
 *
 *   API-GEN-12  one test per searchable resource (`GET <listing>/search`): the shape (Ajv), the conditions of every field equal
 *               to the absolute set of its type or kind (core SearchFieldTypeEnum / SearchHelper), unique identifiers, non-empty
 *               labels, `sortable` / `displayable` consistent with the listing; the audit log publishes the Property source only
 *               and no sortable field; the keys catalogue has CKI_LENGTH as a NUMBER with the 8 number conditions.
 *   API-GEN-11  the listings that are not wired to configurable columns refuse ANY sort with 422 "Sorting is not supported for the
 *               <label> listing." (audit log, OIDs, …); keys / discoveries refuse an unknown and a non-sortable field with the
 *               §1.3 texts; every sortable catalogue field of keys and discoveries sorts ascending and descending over the real
 *               data, empty values last in both directions, page 2 continuing page 1, equal values ordered by uuid ascending.
 *
 * Everything is READ-ONLY on the tier (catalogue GETs and the listing search POSTs of the guard's read list); the oracles are
 * property oracles, no count is written down (utils/regression/inventoryOracles.ts, header). A resource the build does not
 * serve (the catalogue answers 404) or a listing with no data skips with the named reason, never passes.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { expect422Messages } from '../../utils/regression/errorContract';
import { CatalogueGroup, fieldsOf, okJson, readProbe } from '../../utils/regression/inventoryApi';
import {
    CATALOGUES, catalogueProblems, DISCOVERIES, expectationsOf, guardedTransport, KEYS, ListingSpec, loadBaseline, probeSort, runSortField, runTieBreak, RunLog,
    SORT_REFUSING_LISTINGS, sortOf, targetOf, unsupportedSortText, withReread,
} from '../../utils/regression/inventoryOracles';
import type { GuardedApi } from '../../utils/regression/guardedApi';
import { meta, tags } from '../../utils/regression/tags';

const ISSUES = ['ilm#428', 'ilm#442'];

/** The catalogue of a listing, or a named skip when the build does not serve it (404). */
async function catalogueOrSkip(api: GuardedApi, url: string): Promise<CatalogueGroup[]> {
    const p = await readProbe(api, url);
    test.skip(p.status === 404, `${url} answers 404 on this build: the listing has no searchable-fields catalogue here`);
    return okJson<CatalogueGroup[]>(p, `GET ${url}`);
}

test.describe('API-GEN-10 sort and catalogue contracts', { tag: tags.api }, () => {
    // ------------------------------------------------------------------ API-GEN-12: the catalogue of every searchable resource

    for (const row of CATALOGUES) {
        test(`API-GEN-12[${row.name}]: the searchable-fields catalogue of ${row.name} (GET ${row.url}) holds the contract: shape, absolute condition sets, unique identifiers, labels${row.listing ? ', the field table' : ''}`,
            meta({
                id: 'API-GEN-12', prio: 'P1', issue: ISSUES,
                rule: [
                    'inventory-api §2.3 (field type × conditions matrix; the FE offers exactly the catalogue\'s conditions, §3.2 r2), §2.2 r8, r24 (sortable false for native-array, JSON-path, derived and bit-mask fields)',
                    'core SearchFieldTypeEnum.java, SearchHelper.availableConditions / prepareSearch / isSortableField; core#2180 (sortable ⇒ displayable); interfaces SearchFieldDataDto / SearchFieldDataByGroupDto',
                    ...(row.name === 'auditLogs' ? ['AuditLogServiceImpl.java:193-205 (Property source only); RequestValidatorHelper.java:24-30 (no sort)'] : []),
                    ...(row.name === 'keys' ? ['FilterField.CKI_LENGTH is a NUMBER (SearchFieldTypeEnum.NUMBER: 8 conditions)'] : []),
                ],
            }),
            async ({ api }, testInfo) => {
                const p = await readProbe(api, row.url);
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
        test(`API-GEN-11[refuse.${l.name}]: any sort on the ${l.label} listing is refused 422 "${unsupportedSortText(l.label)}"`,
            meta({
                id: 'API-GEN-11', prio: 'P1', issue: ISSUES,
                rule: ['inventory-api §2.2 r24 ("Audit logs, and every listing outside the seven configurable-column inventories, refuse a sort"), §1.3 row "sort … on a listing that does not sort"', `core RequestValidatorHelper.java:24-30; ${l.evidence}`],
            }),
            async ({ api }) => {
                const t = guardedTransport(api);
                for (const sort of [sortOf('ANY_FIELD', 'property', 'asc'), sortOf('COMMON_NAME', 'property', 'desc')]) {
                    const p = await probeSort(t, l.url, sort);
                    test.skip(p.status === 404, `${l.url} answers 404 on this build: the listing does not exist here`);
                    expect(p.status, `${l.url} sorted by ${sort.fieldIdentifier}: ${p.text.slice(0, 200)}`).toBe(422);
                    expect(p.contentType).toMatch(/application\/json/);
                    expect(expect422Messages(p.text), `${l.url}: the refusal text`).toContain(unsupportedSortText(l.label));
                }
            });
    }

    const CONFIGURABLE: ListingSpec[] = [KEYS, DISCOVERIES];
    for (const spec of CONFIGURABLE) {
        test(`API-GEN-11[refuse-fields.${spec.name}]: the ${spec.name} listing refuses an unknown and a non-sortable sort field with the §1.3 texts`,
            meta({
                id: 'API-GEN-11', prio: 'P1', issue: ISSUES,
                rule: ['inventory-api §1.3 rows "sort on unknown field / on a non-sortable field" (core ListingSortResolver.java:66-83, SortOrderBuilder.java:197-218; core#2031 AC4)'],
            }),
            async ({ api }) => {
                const t = guardedTransport(api);
                const catalogue = await catalogueOrSkip(api, spec.catalogueUrl);
                const unknown = await probeSort(t, spec.searchUrl, sortOf('QA_NO_SUCH_FIELD'));
                expect(unknown.status, unknown.text.slice(0, 200)).toBe(422);
                expect(expect422Messages(unknown.text)).toContain('Unknown sort field identifier QA_NO_SUCH_FIELD.');
                const notSortable = fieldsOf(catalogue, 'property').find((f) => f.sortable === false);
                test.skip(!notSortable, `the ${spec.name} catalogue publishes no non-sortable property field to probe`);
                const p = await probeSort(t, spec.searchUrl, sortOf(notSortable!.fieldIdentifier));
                expect(p.status, `${notSortable!.fieldIdentifier}: ${p.text.slice(0, 200)}`).toBe(422);
                expect(expect422Messages(p.text)).toContain(`Field ${notSortable!.fieldIdentifier} cannot be used to order this listing.`);
            });
    }

    // ------------------------------------------------------------------ API-GEN-11: every sortable field sorts over real data

    for (const spec of CONFIGURABLE) {
        test(`API-GEN-11[sort.${spec.name}]: every sortable catalogue field of ${spec.name} sorts ascending and descending over the real data: empty values last, page 2 continues page 1, ties by uuid ascending`,
            meta({
                id: 'API-GEN-11', prio: 'P1', issue: ISSUES,
                rule: [
                    'inventory-api §2.2 r21 (the whole set is ordered before paging), r22 (rows without a value last in both directions), r23 (multi-valued: min asc / max desc); core#2031 AC2, core#2394',
                    'core SortOrderBuilder.tieBreak :253-259 (uuid ascending whatever the direction): plan question Q-G answered from the code',
                ],
            }),
            async ({ api }, testInfo) => {
                // About 20 reads per sortable field, two re-reads at most.
                test.setTimeout(900_000);
                const t = guardedTransport(api);
                const log = new RunLog();
                const catalogue = await catalogueOrSkip(api, spec.catalogueUrl);
                const base = await loadBaseline(t, spec);
                test.skip(base.total === 0, `the ${spec.name} listing is empty on this tier: there is no data to sort`);
                const live = new Map(fieldsOf(catalogue, 'property').map((f) => [f.fieldIdentifier, f]));
                const problems: string[] = [];
                let sorted = 0;
                for (const field of spec.fields) {
                    if (!live.get(field.id)?.sortable || field.sort === 'none') continue;
                    sorted += 1;
                    try {
                        await withReread(field.id, log, () => runSortField(t, spec, targetOf(field), base, log));
                        await withReread(`${field.id} tie-break`, log, async () => void (await runTieBreak(t, spec, targetOf(field), base, log)));
                    } catch (e) {
                        problems.push(`${field.id}: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
                testInfo.annotations.push({ type: 'sorted-fields', description: `${sorted} sortable field(s) over ${base.total} row(s)` });
                for (const n of log.notes) testInfo.annotations.push({ type: 'note', description: n });
                expect(sorted, `the ${spec.name} catalogue publishes sortable fields the table maps`).toBeGreaterThan(0);
                expect(problems.join('\n'), 'sortable fields that break the sort contract').toBe('');
            });
    }
});
