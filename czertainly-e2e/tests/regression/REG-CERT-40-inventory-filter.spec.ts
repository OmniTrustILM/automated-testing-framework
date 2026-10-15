/**
 * REG-CERT-40 … 43 — the certificate inventory filter widget (ilm#428 steps 3-8; inventory-api rules §3 "filter widget",
 * §2.2 / §2.3 "filter semantics" and "filter matrix"; plan §2.2 row tables T-*, D-*, L-*, G-*).
 *
 *   REG-CERT-40  the widget offers exactly the conditions the live catalogue advertises, equal to the absolute set per field type;
 *                Source / Field lists = the catalogue groups; opening the selects sends nothing
 *   REG-CERT-41  text filter matrix through the UI, one test per string condition (rows T-1 … T-10)
 *   REG-CERT-42  date / datetime filters: picker (UTC value with Z and milliseconds on the wire), In next / In past, empty / not
 *                empty, the duration `2d 30m` going out as `P2DT30M`, `5x` keeping Add disabled
 *   REG-CERT-43  enum / list filters: Certificate State, Subject Type multi-select (badge `a OR b`, an array on the wire), Key Size,
 *                Group (rows L-1, L-3, L-5, G-1)
 *
 * Oracles: the expected row sets come from the plan's row tables over the run's own SEED-A (`inventoryTables.ts`, double entry with
 * the plan text); the API search for the same filters is the oracle for the count and the uuid set; the catalogue (`GET
 * /v1/certificates/search`) is the oracle for what a field offers, compared with the ABSOLUTE condition sets of core
 * (`CONDITION_SETS`). Every exact row-set oracle carries the isolation filter, added through the widget FIRST and kept as a badge
 * (T-7 narrows the prefix instead: a second `starts with` on the same field is refused by the widget, rules §3.2 r5).
 *
 * Data: `ensureSeedA` (24 own certificates, 2 own groups, 5 own attribute definitions; the group / owner PATCHes are S-own). The
 * list is read, never changed; every request the UI sends is the list search the page itself sends (no mock, `page.waitForRequest`
 * registered before the click). Labels (sources, conditions, enum values) come from `GET /v1/enums`, where the FE reads them.
 * Known UI bug not relied on: fe#994 (the value is cleared on a condition switch): the condition is always chosen BEFORE the value.
 */
import type { Page } from '@playwright/test';
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import type { TestEnv } from '../../utils/env';
import { ListObservation, PickedDate, PlatformLabels, badgeOfFilter, catalogueFieldLabel, expectedBadgeText, expectedFieldLabels, filtersDifference, widgetSpecOf } from '../../pages/FilterWidget';
import { InventoryPage, formatDateTime } from '../../pages/InventoryPage';
import type { GuardedApi } from '../../utils/regression/guardedApi';
import {
    CONDITION_KINDS,
    CONDITION_SETS,
    Filter,
    findField,
    isolation,
    prop,
    readCatalogue,
    sameSet,
    searchAllRows,
    uuidSet,
} from '../../utils/regression/inventoryApi';
import { CertId, SeedAManifest, certById, ensureSeedA, idsWhere, uuidsOfIds } from '../../utils/regression/inventorySeedFull';
import { COLLECTION_ROWS, DATE_ROWS, FilterRow, LIST_ROWS, TEXT_ROWS } from '../../utils/regression/inventoryTables';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'REG-CERT-40';
const ISSUE = 'ilm#428';
const DAY = 24 * 3600 * 1000;

// ------------------------------------------------------------------ shared helpers of the four rows

async function openInventory(page: Page, env: TestEnv, opts: { pageSize?: 25 } = {}): Promise<InventoryPage> {
    const inventory = new InventoryPage(page);
    await loginAsSmokeUser(page, env);
    await inventory.goToList();
    if (opts.pageSize) await inventory.setPageSize(opts.pageSize);
    return inventory;
}

const contentTypeLabel = (labels: PlatformLabels) => (code: string): string => labels.display('AttributeContentType', code);

/** The rows the page shows are exactly `ids`, and the API search for the same filters agrees on the uuid set and the count. */
async function assertRowsAre(inventory: InventoryPage, api: GuardedApi, m: SeedAManifest, ids: readonly CertId[], apiFilters: Filter[], seen: ListObservation): Promise<void> {
    const expectedNames = ids.map((id) => certById(m, id).commonName).sort();
    await expect.poll(async () => [...(await inventory.commonNames())].sort(), { message: 'the rows shown' }).toEqual(expectedNames);
    const apiRows = await searchAllRows(api, { filters: apiFilters, includeArchived: false });
    expect(uuidSet(apiRows), 'the API search for the same filters returns the expected set').toEqual(uuidsOfIds(m, ids));
    expect(seen.status, 'the list request the page sent').toBe(200);
    expect(seen.json?.totalItems, 'totalItems of the list the page showed = the API total').toBe(apiRows.length);
    expect((await inventory.commonNames()).length, 'rows shown (page size 25) = the API total').toBe(apiRows.length);
    const summary = await inventory.summary();
    if (ids.length === 0) {
        expect(summary, 'no summary line without rows').toBeNull();
        await inventory.assertPageSizeControl(false);
    } else {
        expect(summary).toEqual({ from: 1, to: ids.length, total: ids.length });
    }
}

const wire = (f: Filter): Record<string, unknown> => ({ ...f });

test.describe('REG-CERT-40…43 inventory filter widget', { tag: tags.regression }, () => {
    test.describe.configure({ timeout: 240_000 });

    // ------------------------------------------------------------------ REG-CERT-40

    test(
        'REG-CERT-40: the filter widget offers exactly the conditions the catalogue advertises, and those equal the absolute set per field type',
        meta({
            id: 'REG-CERT-40',
            prio: 'P1',
            issue: ISSUE,
            rule: [
                'inventory-api rules §3.2 r1-r2: field sources = the groups of GET /v1/certificates/search; the FE offers exactly the conditions the API sends for the field (FilterWidget/index.tsx:723-779)',
                'inventory-api rules §2.3: absolute condition sets per field type (string 10, date / datetime 10, number 8, list 4, collection list 8, boolean 4, expected-value boolean 2); plan §2.2 "boolean 2" is corrected by core SearchFieldTypeEnum / SearchHelper (CONDITION_SETS header)',
            ],
        }),
        async ({ page, api, env }) => {
            const m = await ensureSeedA(api, SPEC);
            const catalogue = await readCatalogue(api);
            const labels = await PlatformLabels.read(api);
            const typeLabel = contentTypeLabel(labels);

            // The fields the row names, with the absolute set each must advertise.
            const targets: Array<{ key: string; source: 'property' | 'custom'; id: string; type: string; kind?: keyof typeof CONDITION_KINDS; count: number }> = [
                { key: 'COMMON_NAME', source: 'property', id: 'COMMON_NAME', type: 'string', count: 10 },
                { key: 'NOT_AFTER', source: 'property', id: 'NOT_AFTER', type: 'datetime', count: 10 },
                { key: 'num', source: 'custom', id: m.attributes.num.identifier, type: 'number', count: 8 },
                { key: 'day', source: 'custom', id: m.attributes.day.identifier, type: 'date', count: 10 },
                { key: 'CERTIFICATE_STATE', source: 'property', id: 'CERTIFICATE_STATE', type: 'list', count: 4 },
                { key: 'PRIVATE_KEY', source: 'property', id: 'PRIVATE_KEY', type: 'boolean', kind: 'expectedBoolean', count: 2 },
                { key: 'flag', source: 'custom', id: m.attributes.flag.identifier, type: 'boolean', count: 4 },
                { key: 'GROUP_NAME', source: 'property', id: 'GROUP_NAME', type: 'list', kind: 'collection', count: 8 },
            ];

            await test.step('Catalogue (API): each field advertises the absolute set of its type', async () => {
                for (const t of targets) {
                    const field = findField(catalogue, t.id, t.source);
                    expect.soft(field, `${t.key}: the catalogue lists the field`).toBeDefined();
                    if (!field) continue;
                    const absolute = t.kind ? CONDITION_KINDS[t.kind] : CONDITION_SETS[t.type];
                    expect.soft(absolute, `${t.key}: the absolute set has ${t.count} conditions`).toHaveLength(t.count);
                    expect.soft(field.type, `${t.key}: field type`).toBe(t.type);
                    expect.soft(sameSet(field.conditions, absolute), `${t.key}: [${field.conditions.join(', ')}] equals the absolute set [${absolute.join(', ')}]`).toBe(true);
                }
            });

            const inventory = await openInventory(page, env);
            const mark = inventory.traffic.mark();

            await test.step('Source select = the catalogue groups, in order', async () => {
                expect(await inventory.filter.offeredSources()).toEqual(catalogue.map((g) => labels.source(g.filterFieldSource)));
            });

            await test.step('Field select per Source = the group\'s fields that publish a condition', async () => {
                for (const group of catalogue) {
                    await inventory.filter.choose({ source: labels.source(group.filterFieldSource) });
                    expect(await inventory.filter.offeredFields(), `fields of ${group.filterFieldSource}`).toEqual(expectedFieldLabels(group.searchFieldData ?? [], typeLabel));
                }
            });

            for (const t of targets) {
                await test.step(`Condition select of ${t.key}: the catalogue's conditions, equal to the absolute set (${t.count})`, async () => {
                    const field = findField(catalogue, t.id, t.source)!;
                    const absolute = t.kind ? CONDITION_KINDS[t.kind] : CONDITION_SETS[t.type];
                    await inventory.filter.choose({ source: labels.source(t.source), field: catalogueFieldLabel(catalogue, labels, t.source, t.id) });
                    // Exactly what the API advertises, in its order (the FE has no condition table of its own)...
                    await inventory.filter.assertConditionsOffered(field.conditions.map((c) => labels.condition(c)), { ordered: true });
                    // ...and that is the absolute set of the type.
                    await inventory.filter.assertConditionsOffered(absolute.map((c) => labels.condition(c)));
                });
            }

            await test.step('Nothing was sent while choosing: no list search, no write; no badge was added', async () => {
                expect(inventory.traffic.nonReadsSince(mark)).toEqual([]);
                expect(await inventory.filter.badges()).toEqual([]);
            });
        },
    );

    // ------------------------------------------------------------------ REG-CERT-41: T-1 … T-10

    for (const row of TEXT_ROWS.filter((r) => /^T-([1-9]|10)$/.test(r.row))) {
        test(
            `REG-CERT-41[${row.row}]: text filter ${row.title} through the widget`,
            meta({
                id: 'REG-CERT-41',
                prio: 'P1',
                issue: ISSUE,
                rule: [
                    'inventory-api rules §2.2 r12, r15 (string conditions; NOT_CONTAINS / NOT_EQUALS include nulls, NOT_MATCHES excludes them) and plan §2.2 row table T-1…T-10',
                    'inventory-api rules §3.2 r4-r6 (Add disabled until a value is set, same field + condition refused, filters AND, badge text)',
                ],
            }),
            async ({ page, api, env }) => {
                const m = await ensureSeedA(api, SPEC);
                const catalogue = await readCatalogue(api);
                const labels = await PlatformLabels.read(api);
                const [filter] = row.filters(m, {});
                // The row's own STARTS_WITH on Common Name (T-7) IS the narrowed isolation: a second one on the field is refused.
                const narrowsPrefix = filter.fieldIdentifier === 'COMMON_NAME' && filter.condition === 'STARTS_WITH';
                const apiFilters = narrowsPrefix ? [filter] : [isolation(m.prefix), filter];

                const inventory = await openInventory(page, env, { pageSize: 25 });
                let seen!: ListObservation;
                for (const f of apiFilters) seen = await inventory.filter.addFilter(widgetSpecOf(f, catalogue, labels));

                await test.step('Badges: the isolation badge is kept, the row\'s badge reads Property \'Common Name\' <condition> \'<value>\'', async () => {
                    await inventory.filter.assertBadges(apiFilters.map((f) => badgeOfFilter(f, catalogue, labels)));
                });
                await test.step('The request carries exactly these filters on page 1 with the size 25', async () => {
                    expect(filtersDifference(seen.body.filters, apiFilters.map(wire))).toBeUndefined();
                    expect(seen.body.itemsPerPage).toBe(25);
                    expect(seen.body.pageNumber).toBe(1);
                });
                await test.step(`Rows shown = the expected set (${row.plan} per the plan); count = the API total`, async () => {
                    await assertRowsAre(inventory, api, m, row.expect(m), apiFilters, seen);
                });
            },
        );
    }

    // ------------------------------------------------------------------ REG-CERT-42: dates and durations

    const dateRow = (id: string): FilterRow => {
        const row = DATE_ROWS.find((r) => r.row === id);
        if (!row) throw new Error(`no date row ${id}`);
        return row;
    };

    test(
        'REG-CERT-42[picker]: Expires At >= and < a picked date send the UTC instant with Z and milliseconds and give the expected rows',
        meta({
            id: 'REG-CERT-42',
            prio: 'P1',
            issue: ISSUE,
            rule: [
                'inventory-api rules §3.2 r7: a datetime filter goes out as new Date(v).toISOString() (UTC, Z, milliseconds), FilterWidget computeValue + utils/dateUtil.ts:124-135',
                'inventory-api rules §2.2 r17 and plan §2.2 rows D-5 / D-7 (>= and < on NOT_AFTER), picker value taken mid-window (domain analysis, +-5 d margin)',
            ],
        }),
        async ({ page, api, env }) => {
            const m = await ensureSeedA(api, SPEC);
            const catalogue = await readCatalogue(api);
            const labels = await PlatformLabels.read(api);
            const inventory = await openInventory(page, env, { pageSize: 25 });
            await inventory.isolate(m.prefix, labels);
            // The middle of the C03 (+25 d) / C04 (+45 d) gap: 35 days after the seed clock; every seed expires more than 5 days away.
            const { picked, instant } = await inventory.midWindowPick(m.clock, 35, m.certificates.map((c) => c.notAfter));
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
                    await assertRowsAre(inventory, api, m, want, [isolation(m.prefix), prop('NOT_AFTER', condition, instant)], seen);
                    if (condition === 'GREATER_OR_EQUAL') await inventory.filter.removeBadge(badge);
                });
            }
        },
    );

    test(
        'REG-CERT-42[D-12]: In next 30d goes out as P30D and shows C01, C02, C03',
        meta({
            id: 'REG-CERT-42',
            prio: 'P1',
            issue: ISSUE,
            rule: ['inventory-api rules §3.2 r7 (IN_NEXT / IN_PAST take an ISO-8601 duration, `30d` is sent as P30D) and §2.2 r18; plan §2.2 row D-12 (an expired certificate is never "in next")'],
        }),
        async ({ page, api, env }) => {
            const m = await ensureSeedA(api, SPEC);
            const catalogue = await readCatalogue(api);
            const labels = await PlatformLabels.read(api);
            const inventory = await openInventory(page, env, { pageSize: 25 });
            await inventory.isolate(m.prefix, labels);
            const row = dateRow('D-12a');
            const [f] = row.filters(m, {});
            const field = catalogueFieldLabel(catalogue, labels, 'property', 'NOT_AFTER');
            const seen = await inventory.filter.addFilter({ source: labels.source('property'), field, condition: labels.condition('IN_NEXT'), value: '30d' });
            expect(filtersDifference(seen.body.filters, [wire(isolation(m.prefix)), wire(f)]), 'the request carries IN_NEXT P30D').toBeUndefined();
            await inventory.filter.assertBadges([
                expectedBadgeText({ source: labels.source('property'), field: 'Common Name', condition: labels.condition('STARTS_WITH'), value: m.prefix }),
                expectedBadgeText({ source: labels.source('property'), field, condition: labels.condition('IN_NEXT'), value: '30d' }),
            ]);
            await assertRowsAre(inventory, api, m, row.expect(m), [isolation(m.prefix), f], seen);
        },
    );

    test(
        'REG-CERT-42[D-13]: In past 2d goes out as P2D and shows C07 only',
        meta({
            id: 'REG-CERT-42',
            prio: 'P1',
            issue: ISSUE,
            rule: ['inventory-api rules §3.2 r7 and §2.2 r18 (IN_PAST = BETWEEN now-d AND now); plan §2.2 row D-13'],
        }),
        async ({ page, api, env }) => {
            const m = await ensureSeedA(api, SPEC);
            const catalogue = await readCatalogue(api);
            const labels = await PlatformLabels.read(api);
            const inventory = await openInventory(page, env, { pageSize: 25 });
            await inventory.isolate(m.prefix, labels);
            const row = dateRow('D-13a');
            const [f] = row.filters(m, {});
            const field = catalogueFieldLabel(catalogue, labels, 'property', 'NOT_AFTER');
            const seen = await inventory.filter.addFilter({ source: labels.source('property'), field, condition: labels.condition('IN_PAST'), value: '2d' });
            expect(filtersDifference(seen.body.filters, [wire(isolation(m.prefix)), wire(f)]), 'the request carries IN_PAST P2D').toBeUndefined();
            await assertRowsAre(inventory, api, m, row.expect(m), [isolation(m.prefix), f], seen);
        },
    );

    test(
        'REG-CERT-42[D-10 / D-11]: Expires At empty and not empty: the value control is disabled, no value key is sent, 0 / 24 rows',
        meta({
            id: 'REG-CERT-42',
            prio: 'P1',
            issue: ISSUE,
            rule: ['inventory-api rules §3.2 r3 (EMPTY / NOT_EMPTY: the value control is disabled, not hidden; Add stays enabled; no value key) and §2.2 r13; plan §2.2 rows D-10 / D-11'],
        }),
        async ({ page, api, env }) => {
            const m = await ensureSeedA(api, SPEC);
            const catalogue = await readCatalogue(api);
            const labels = await PlatformLabels.read(api);
            const inventory = await openInventory(page, env, { pageSize: 25 });
            await inventory.isolate(m.prefix, labels);
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
                    await assertRowsAre(inventory, api, m, row.expect(m), [isolation(m.prefix), f], seen);
                    await inventory.filter.removeBadge(expectedBadgeText({ source: labels.source('property'), field, condition: labels.condition(f.condition) }));
                });
            }
        },
    );

    test(
        'REG-CERT-42[2d 30m]: the duration `2d 30m` goes out as P2DT30M and the badge shows it back as 2d 30m',
        meta({
            id: 'REG-CERT-42',
            prio: 'P1',
            issue: ISSUE,
            rule: ['inventory-api rules §3.2 r7: "2d 30m" is sent as P2DT30M (utils/duration.ts:46-62); the badge reads the ISO value back as `2d 30m` (FilterWidget getFilterBadgeValue)'],
        }),
        async ({ page, api, env }) => {
            const m = await ensureSeedA(api, SPEC);
            const catalogue = await readCatalogue(api);
            const labels = await PlatformLabels.read(api);
            const inventory = await openInventory(page, env, { pageSize: 25 });
            await inventory.isolate(m.prefix, labels);
            const field = catalogueFieldLabel(catalogue, labels, 'property', 'NOT_AFTER');
            const f = prop('NOT_AFTER', 'IN_NEXT', 'P2DT30M');
            const seen = await inventory.filter.addFilter({ source: labels.source('property'), field, condition: labels.condition('IN_NEXT'), value: '2d 30m' });
            expect(filtersDifference(seen.body.filters, [wire(isolation(m.prefix)), wire(f)]), 'the request carries P2DT30M').toBeUndefined();
            await inventory.filter.assertBadges([
                expectedBadgeText({ source: labels.source('property'), field: 'Common Name', condition: labels.condition('STARTS_WITH'), value: m.prefix }),
                expectedBadgeText({ source: labels.source('property'), field, condition: labels.condition('IN_NEXT'), value: '2d 30m' }),
            ]);
            // The expected set: expiries between the seed clock and clock + 2 d 30 min (no seed expires that soon: the nearest is +5 d, a 2.5-day margin).
            const clock = Date.parse(m.clock);
            const want = idsWhere(m, (c) => Date.parse(c.notAfter) >= clock && Date.parse(c.notAfter) <= clock + 2 * DAY + 30 * 60 * 1000);
            await assertRowsAre(inventory, api, m, want, [isolation(m.prefix), f], seen);
        },
    );

    test(
        'REG-CERT-42[5x]: the duration `5x` keeps Add disabled, nothing is sent; `5d` enables it',
        meta({
            id: 'REG-CERT-42',
            prio: 'P1',
            issue: ISSUE,
            rule: ['inventory-api rules §3.2 r8: duration input ^(\\d{1,10}\\s*[dhms]\\s*)+$ (utils/validators.ts:112-121); an invalid value disables Add (FilterWidget/index.tsx:265-275,788-793; the widget shows no message of its own, only the format hint)'],
        }),
        async ({ page, api, env }) => {
            const m = await ensureSeedA(api, SPEC);
            const catalogue = await readCatalogue(api);
            const labels = await PlatformLabels.read(api);
            const inventory = await openInventory(page, env, { pageSize: 25 });
            await inventory.isolate(m.prefix, labels);
            const field = catalogueFieldLabel(catalogue, labels, 'property', 'NOT_AFTER');
            const mark = inventory.traffic.mark();
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

    // ------------------------------------------------------------------ REG-CERT-43: enum and list filters (S-own: the groups are PATCHed on own certificates)

    const listRows: Array<{ table: readonly FilterRow[]; row: string }> = [
        { table: LIST_ROWS, row: 'L-1a' },
        { table: LIST_ROWS, row: 'L-1c' },
        { table: LIST_ROWS, row: 'L-3a' },
        { table: LIST_ROWS, row: 'L-5c' },
        { table: COLLECTION_ROWS, row: 'G-1a' },
    ];

    for (const { table, row: rowId } of listRows) {
        const row = table.find((r) => r.row === rowId);
        if (!row) throw new Error(`no row ${rowId}`);
        test(
            `REG-CERT-43[${rowId}]: ${row.title} through the widget`,
            meta({
                id: 'REG-CERT-43',
                prio: 'P1',
                issue: ISSUE,
                rule: [
                    'inventory-api rules §3.2 r6 / §3.3: a list value is a multi-select, sent as an array of codes (names for groups); the badge joins the labels with " OR " (FilterWidget getFilterBadgeValue)',
                    'inventory-api rules §2.2 r14 (LIST: EQUALS with several values = any of, enum lists compare the code, NOT_EQUALS = complement) and plan §2.2 rows L-1, L-3, L-5, G-1',
                ],
            }),
            async ({ page, api, env }) => {
                const m = await ensureSeedA(api, SPEC);
                const catalogue = await readCatalogue(api);
                const labels = await PlatformLabels.read(api);
                const [filter] = row.filters(m, {});
                const apiFilters = [isolation(m.prefix), filter];

                const inventory = await openInventory(page, env, { pageSize: 25 });
                await inventory.isolate(m.prefix, labels);
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
                    await assertRowsAre(inventory, api, m, row.expect(m), apiFilters, seen);
                });
            },
        );
    }
});
