/**
 * REG-CERT-40 — Certificate list filter: the condition catalogue (release checklist: Certificates, filters). ilm#428.
 *
 * WHAT: 1. For eight fields of different types (string, datetime, number, date, list, boolean, expected-value boolean,
 *          collection list), the catalogue read from the API advertises the absolute set of conditions of the field's type.
 *       2. In the filter widget, the Source select lists the catalogue's groups in order.
 *       3. For each Source, the Field select lists the group's fields that publish a condition.
 *       4. For each of the eight fields, the Condition select offers exactly the API's conditions in the API's order, and that is
 *          the absolute set of the type.
 *       5. Choosing sends nothing: no list search, no write, no badge.
 * WHY: the widget has no condition table of its own; if the catalogue and the widget drift, an operator is offered conditions
 *      that fail or misses ones that work.
 * HOW: data is the run's own certificate seed (idempotent); the list is read, never changed. The oracle is the live catalogue
 *      (GET search groups) plus the absolute sets per type in CONDITION_SETS; labels come from the platform enums.
 */
import { expect, test } from '../../../fixtures/areas/certificateList';
import { catalogueFieldLabel, expectedFieldLabels } from '../../../utils/regression/inventory/fieldLabels';
import { CONDITION_KINDS, CONDITION_SETS, findField, sameSet } from '../../../utils/regression/inventory/searchApi';
import { contentTypeLabel } from '../../../utils/regression/inventory/certificateListSteps';
import { CertificateListPage } from '../../../pages/CertificateListPage';
import { testMeta, tags } from '../../../utils/regression/tags';
import { LIST_SPEC_TEST_MS } from '../../../utils/regression/timeouts';

const ISSUE = 'ilm#428';

test.describe('Certificate list filter: condition catalogue', { tag: tags.regression }, () => {
    test.describe.configure({ timeout: LIST_SPEC_TEST_MS });

    // ------------------------------------------------------------------ REG-CERT-40

    test(
        'the filter widget offers exactly the catalogue-advertised conditions per field type',
        testMeta({
            id: 'REG-CERT-40',
            prio: 'P2',
            issue: ISSUE,
            rule: [
                'field sources = the groups of GET /v1/certificates/search; the FE offers exactly the conditions the API sends for the field (FilterWidget)',
                'absolute condition sets per field type (string 10, date / datetime 10, number 8, list 4, collection list 8, boolean 4, expected-value boolean 2); a plain boolean has 4 conditions, not 2, per core SearchFieldTypeEnum / SearchHelper (CONDITION_SETS header)',
            ],
        }),
        async ({ signedIn, listSeed }) => {
            const { manifest: m, catalogue, labels } = listSeed;
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

            const inventory = await CertificateListPage.openSeeded(signedIn, listSeed);
            const mark = inventory.traffic.start().mark();

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
});
