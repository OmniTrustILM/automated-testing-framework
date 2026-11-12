/**
 * REG-CERT-51 — Certificate list: the Standard view (release checklist: Certificates, list). ilm#428.
 *
 * WHAT: 1. The Standard view shows 16 columns in order with the shipped headings.
 *       2. For every one of the 24 own rows (four named seeds first), every cell equals the API value formatted for display:
 *          dates as `yyyy-MM-dd HH:mm:ss` in the browser zone, state and validation labels from the platform enums.
 *       3. State label, Archived, owner placeholder, the owner's name and the "+1" of a two-group row are as seeded.
 *       4. null, undefined, NaN and Invalid Date appear nowhere in the table body.
 * WHY: the list is the page operators read most; a cell that shows a raw value, a wrong zone or a missing placeholder is a
 *      defect even when the API is right. A blank value shows the shared empty state.
 * HOW: data is the run's own certificate seed (idempotent); the list is read, never changed. The oracle is the API's own rows
 *      (searched with the run's isolation filter) formatted by the same rules, an absolute check with no pixel differential.
 */
import { expect, test } from '../../../fixtures/areas/certificateList';
import { STANDARD_COLUMNS, expectedCell } from '../../../utils/regression/inventory/certificateListOracle';
import { isolation, searchAllRows, uuidSet } from '../../../utils/regression/inventory/searchApi';
import { CertId, certById, uuidsOfIds } from '../../../utils/regression/inventory/seedFull';
import { COLUMN } from '../../../utils/regression/inventory/certificateListSteps';
import { CertificateListPage } from '../../../pages/CertificateListPage';
import { testMeta, tags } from '../../../utils/regression/tags';
import { LIST_SPEC_TEST_MS } from '../../../utils/regression/timeouts';

const ISSUE = 'ilm#428';

test.describe('Certificate list: standard columns', { tag: tags.regression }, () => {
    test.describe.configure({ timeout: LIST_SPEC_TEST_MS });

    // ------------------------------------------------------------------ REG-CERT-51

    test(
        'the Standard view shows 16 columns in order with cells equal to the API value',
        testMeta({
            id: 'REG-CERT-51',
            prio: 'P2',
            issue: ISSUE,
            rule: [
                'the FE Standard set is 16 columns (certificate table helpers); ilm#428 step 2 (absolute variant: no pixel differential)',
                'display rules: dates `yyyy-MM-dd HH:mm:ss` in the browser zone (date utility), state / validation labels from the platform enums, a blank value is the shared empty state (CustomTable row builder, EmptyCell)',
            ],
        }),
        async ({ signedIn, api, listSeed }) => {
            const { manifest: m, labels } = listSeed;
            const inventory = await CertificateListPage.openSeeded(signedIn, listSeed, { isolate: true, pageSize: 25 });
            await expect.poll(async () => (await inventory.commonNames()).length, { message: 'the 24 own rows are shown' }).toBe(24);

            await test.step('The 16 columns, in order, with the shipped headings', async () => {
                await inventory.assertColumns(STANDARD_COLUMNS.map((c) => c.id));
                expect(await inventory.columnHeadings()).toEqual(STANDARD_COLUMNS.map((c) => c.heading));
            });

            const apiRows = await searchAllRows(api, { filters: [isolation(m.prefix)], includeArchived: false });
            expect(uuidSet(apiRows), 'the API holds the same 24 rows').toEqual(uuidsOfIds(m, m.certificates.map((c) => c.id)));
            const zone = await inventory.browserTimeZone();
            const ctx = { timeZone: zone, labels };

            // The four named seeds first (clearer failures), then every other own row: the rule is the same for all.
            const named: CertId[] = ['C07', 'C20', 'C03', 'C08'];
            const order = [...named, ...m.certificates.map((c) => c.id).filter((id) => !named.includes(id))];
            for (const id of order) {
                const cert = certById(m, id);
                const apiRow = apiRows.find((r) => r.uuid === cert.uuid);
                expect(apiRow, `${id} is in the API list`).toBeDefined();
                const expected = Object.fromEntries(STANDARD_COLUMNS.map((c) => [c.id, expectedCell(c.id, apiRow!, ctx)]));
                await test.step(`${id}${named.includes(id) ? ' (named seed)' : ''}: every cell equals the formatted API value`, async () => {
                    await inventory.assertCellValues(cert.commonName, expected);
                });
            }

            await test.step('Seeded rows: state label, Archived badge, owner and group cells', async () => {
                const state = labels.display('CertificateState', 'issued');
                expect(await inventory.cellTexts('property:CERTIFICATE_STATE'), 'state label of every uploaded certificate').toEqual(Array(24).fill(state));
                expect(await inventory.cellTexts('property:ARCHIVED'), 'Archived badge').toEqual(Array(24).fill('No'));
                const c08 = await inventory.readRow(certById(m, 'C08').commonName);
                expect(c08[COLUMN.owner].empty, 'the ownerless certificate shows the placeholder, not a word').toBe(true);
                const c01 = await inventory.readRow(certById(m, 'C01').commonName);
                expect(c01[COLUMN.owner].text, 'the owner shows the owner\'s name').toBe(m.owner.username);
                const c03 = await inventory.readRow(certById(m, 'C03').commonName);
                expect(c03[COLUMN.groups].text, 'two groups: the first name and +1').toContain('+1');
            });

            await test.step('null, undefined, NaN, Invalid Date appear nowhere in the table body', async () => {
                await inventory.assertNoForbiddenWords();
            });
        },
    );
});
