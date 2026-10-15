/**
 * REG-WFL-01 — own conditions built in the FORM and reopened: a property through an association (RA profile, Group, Owner), a date, a
 * custom attribute, a metadata item; operators equals, not equals, contains, greater than, empty — each saved as entered
 * (ilm#438 steps 1–5; T14 W8, W10, W14; TW02; table P-01). The object is never associated, so it never fires: the condition is
 * created and read back only; the refusal of such conditions for `Certificate uploaded` is association time (API-WFL-08, local-stack only).
 *
 * Per row (one test each): Rules → Conditions → Create Condition in the UI; the create request the form sent, the stored object
 * (API read-back) and the reopened detail page (badge text and the raw codes of the selected badge) agree. Rows:
 *   a RA profile equals (own RA profile)        b Groups equals (own group)            c Owner not equals (own user)
 *   d own DATE custom attribute greater than    e own custom attribute empty           f a metadata item the tier offers equals
 *   g Common Name contains (run prefix)         h own INTEGER custom attribute greater than 5
 * Rows that need an own object create it through the API first (an own custom attribute is never required). Row f is skipped
 * with the named reason when the tier offers no metadata field with a text value control. Own objects only; the condition is
 * recorded in the ledger as soon as the form redirected, before any assertion.
 *
 * The date picker is a readonly input with a calendar: the row clicks the 15th of the CURRENT month and the oracle is the stored
 * value starting with that ISO date (the exact serialisation — date or date-time — is the platform's).
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { ConditionFilterWidget, ItemInput } from '../../pages/ConditionFilterWidget';
import { WorkflowPage } from '../../pages/WorkflowPage';
import { createOwnCustomAttribute, createOwnGroup, createOwnRaProfileOrSkip, OwnCustomAttribute } from '../../utils/regression/eventsDrivers';
import { createOwnUser } from '../../utils/regression/regressionApi';
import { OwnRef, recordCreated, RUN_ID } from '../../utils/regression/regressionRun';
import { getKind, wfName } from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-WFL-01';
type Api = Parameters<typeof createOwnGroup>[0];
type Json = Record<string, any>;

interface RowSetup {
    item: ItemInput;
    /** What the stored item must be (the identifier, source and operator codes; the value is compared with the request). */
    expect: { fieldSource: string; fieldIdentifier: string | RegExp; operator: string };
    /** What the reopened detail's badge shows. */
    badge: { source: string; field: string; operator: string; value?: string };
    /** The typed value as the platform stores it (text rows), or a check on the stored value. */
    stored?: (value: unknown) => void;
}

test.describe('@regression REG-WFL-01 conditions built in the form and reopened', () => {
    const rows: Array<{ key: string; what: string; setup: (api: Api, skip: (reason: string) => void) => Promise<RowSetup> }> = [
        {
            key: 'a', what: 'RA profile equals an own RA profile',
            setup: async (api, skip) => {
                const ra = await createOwnRaProfileOrSkip(api, SPEC, 'wf01a-ra', skip);
                return {
                    item: { source: { value: 'property' }, field: { value: 'RA_PROFILE_NAME' }, operator: { value: 'EQUALS' }, option: { label: ra.name } },
                    expect: { fieldSource: 'property', fieldIdentifier: 'RA_PROFILE_NAME', operator: 'EQUALS' },
                    badge: { source: 'Property', field: 'RA Profile', operator: 'equals' },
                    stored: (v) => expect([ra.name, ra.uuid], 'the stored value identifies the own RA profile').toContain(String(Array.isArray(v) ? v[0] : v)),
                };
            },
        },
        {
            key: 'b', what: 'Groups equals an own group',
            setup: async (api) => {
                const group = await createOwnGroup(api, SPEC, 'wf01b-group');
                return {
                    item: { source: { value: 'property' }, field: { value: 'GROUP_NAME' }, operator: { value: 'EQUALS' }, option: { label: group.name } },
                    expect: { fieldSource: 'property', fieldIdentifier: 'GROUP_NAME', operator: 'EQUALS' },
                    badge: { source: 'Property', field: 'Groups', operator: 'equals' },
                    stored: (v) => expect([group.name, group.uuid], 'the stored value identifies the own group').toContain(String(Array.isArray(v) ? v[0] : v)),
                };
            },
        },
        {
            key: 'c', what: 'Owner not equals an own user',
            setup: async (api) => {
                const user = await createOwnUser(api, 'wf01c-user', SPEC);
                return {
                    item: { source: { value: 'property' }, field: { value: 'OWNER' }, operator: { value: 'NOT_EQUALS' }, option: { label: user.name } },
                    expect: { fieldSource: 'property', fieldIdentifier: 'OWNER', operator: 'NOT_EQUALS' },
                    badge: { source: 'Property', field: 'Owner', operator: 'not equals' },
                    stored: (v) => expect([user.name, user.uuid], 'the stored value identifies the own user').toContain(String(Array.isArray(v) ? v[0] : v)),
                };
            },
        },
        {
            key: 'd', what: 'an own date attribute is greater than a picked date',
            setup: async (api) => {
                const attr = await createOwnCustomAttribute(api, SPEC, { suffix: 'wf01d-date', resources: ['certificates'], contentType: 'date' });
                const now = new Date();
                const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-15`;
                return {
                    item: { source: { value: 'custom' }, field: { label: attr.attributeName }, operator: { value: 'GREATER' }, dayOfCurrentMonth: 15 },
                    expect: { fieldSource: 'custom', fieldIdentifier: new RegExp(`^${attr.attributeName}\\|`), operator: 'GREATER' },
                    badge: { source: 'Custom attribute', field: attr.attributeName, operator: 'greater than' },
                    stored: (v) => expect(String(v), 'the stored date is the picked day').toContain(iso),
                };
            },
        },
        {
            key: 'e', what: 'an own custom attribute is empty',
            setup: async (api) => {
                const attr = await createOwnCustomAttribute(api, SPEC, { suffix: 'wf01e-str', resources: ['certificates'] });
                return {
                    item: { source: { value: 'custom' }, field: { label: attr.attributeName }, operator: { value: 'EMPTY' } },
                    expect: { fieldSource: 'custom', fieldIdentifier: new RegExp(`^${attr.attributeName}\\|`), operator: 'EMPTY' },
                    badge: { source: 'Custom attribute', field: attr.attributeName, operator: 'empty' },
                };
            },
        },
        {
            key: 'g', what: 'Common Name contains the run prefix',
            setup: async () => ({
                item: { source: { value: 'property' }, field: { value: 'COMMON_NAME' }, operator: { value: 'CONTAINS' }, text: RUN_ID },
                expect: { fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', operator: 'CONTAINS' },
                badge: { source: 'Property', field: 'Common Name', operator: 'contains', value: RUN_ID },
                stored: (v) => expect(String(v)).toBe(RUN_ID),
            }),
        },
        {
            key: 'h', what: 'an own integer attribute is greater than 5',
            setup: async (api) => {
                const attr = await createOwnCustomAttribute(api, SPEC, { suffix: 'wf01h-int', resources: ['certificates'], contentType: 'integer' });
                return {
                    item: { source: { value: 'custom' }, field: { label: attr.attributeName }, operator: { value: 'GREATER' }, text: '5' },
                    expect: { fieldSource: 'custom', fieldIdentifier: new RegExp(`^${attr.attributeName}\\|`), operator: 'GREATER' },
                    badge: { source: 'Custom attribute', field: attr.attributeName, operator: 'greater than', value: '5' },
                    stored: (v) => expect(Number(v)).toBe(5),
                };
            },
        },
    ];

    async function buildAndReopen(o: { page: Parameters<typeof loginAsSmokeUser>[0]; api: Api; env: Parameters<typeof loginAsSmokeUser>[1]; key: string; setup: RowSetup }): Promise<void> {
        const { page, api, env, key, setup } = o;
        const workflow = new WorkflowPage(page);
        const name = wfName(`wf01${key}-cond`);
        await loginAsSmokeUser(page, env);
        const created = await workflow.createCondition({ name, description: `REG-WFL-01 row ${key}`, resource: 'certificates', items: [setup.item] });
        // Ledger before assertion: the form redirected, so the condition exists.
        const ref: OwnRef = recordCreated('conditions', { uuid: created.uuid, name }, SPEC, `built in the UI form (row ${key})`);

        await test.step('The create request the form sent carries the typed item', async () => {
            const items = created.body.items as Json[];
            expect(items, 'one item').toHaveLength(1);
            expect(items[0]).toMatchObject({ fieldSource: setup.expect.fieldSource, operator: setup.expect.operator });
            if (typeof setup.expect.fieldIdentifier === 'string') expect(items[0].fieldIdentifier).toBe(setup.expect.fieldIdentifier);
            else expect(String(items[0].fieldIdentifier)).toMatch(setup.expect.fieldIdentifier);
        });

        await test.step('API read-back: resource, name and the item equal what the form sent and what was typed', async () => {
            const got = (await getKind(api, 'conditions', ref.uuid)).json as Json;
            expect(got).toMatchObject({ uuid: ref.uuid, name, type: 'checkField', resource: 'certificates' });
            expect(got.items).toHaveLength(1);
            const stored = got.items[0] as Json;
            const sent = (created.body.items as Json[])[0];
            expect({ fieldSource: stored.fieldSource, fieldIdentifier: stored.fieldIdentifier, operator: stored.operator, value: stored.value ?? null }, 'stored = sent')
                .toEqual({ fieldSource: sent.fieldSource, fieldIdentifier: sent.fieldIdentifier, operator: sent.operator, value: sent.value ?? null });
            setup.stored?.(stored.value);
        });

        await test.step('The reopened detail page shows the item as entered (badge text and the raw codes of the selected badge)', async () => {
            await workflow.openDetail('condition', ref.uuid);
            const widget = ConditionFilterWidget.onDetail(page);
            await expect(widget.badges.first()).toBeVisible();
            await widget.assertBadge(setup.badge);
            const codes = await widget.selectBadgeAndReadCodes(0);
            expect(codes.source).toBe(setup.expect.fieldSource);
            expect(codes.operator).toBe(setup.expect.operator);
            if (typeof setup.expect.fieldIdentifier === 'string') expect(codes.field).toBe(setup.expect.fieldIdentifier);
            else expect(codes.field).toMatch(setup.expect.fieldIdentifier);
        });
    }

    for (const row of rows) {
        test(`REG-WFL-01[${row.key}]: a condition "${row.what}" is saved as entered and reopens the same`,
            meta({
                id: 'REG-WFL-01', prio: 'P1', issue: 'ilm#438',
                rule: ['T14 W8 (condition validation, names), W10, W14 (operator sets by field type); TW02 (build in the form, reopen, API read-back is the oracle)', `ilm#438 steps 1–5; P-01 row ${row.key}`],
            }),
            async ({ page, api, env }) => {
                test.setTimeout(240_000);
                const setup = await row.setup(api, (reason) => test.skip(true, reason));
                await buildAndReopen({ page, api, env, key: row.key, setup });
            });
    }

    test('REG-WFL-01[f]: a condition on a metadata item the tier offers is saved as entered (skipped when the tier offers none)',
        meta({
            id: 'REG-WFL-01', prio: 'P1', issue: 'ilm#438',
            rule: ['T14 W13 (metadata matched by name and content type), W14; TW02', 'ilm#438 steps 1–5; P-01 row f (metadata item the tier offers)'],
        }),
        async ({ page, api, env }) => {
            test.setTimeout(240_000);
            const workflow = new WorkflowPage(page);
            await loginAsSmokeUser(page, env);
            await workflow.openCreate('condition');
            const dialog = workflow.dialog('condition');
            await dialog.getByTestId('text-input-name').focus();
            const widgetProbe = async () => {
                await dialog.getByTestId('select-typeSelect-trigger').click();
                await page.getByTestId('select-typeSelect-content').locator('[role=option][data-value="checkField"]').click();
                await dialog.getByTestId('select-resourceSelect-trigger').click();
                await page.getByTestId('select-resourceSelect-content').locator('[role=option][data-value="certificates"]').click();
                const w = ConditionFilterWidget.inDialog(page);
                await w.waitUntilReady();
                return { w, labels: await w.fieldLabels({ value: 'meta' }) };
            };
            const { labels } = await widgetProbe();
            test.skip(labels.length === 0, 'the tier offers no metadata field for certificates (the row needs a metadata item the tier offers)');
            await page.keyboard.press('Escape');
            // A metadata field exists: build the condition through the shared flow with the first offered field and a text value.
            await workflow.page.goto('/administrator/#/rules?tab=conditions');
            const name = wfName('wf01f-cond');
            const created = await workflow.createCondition({ name, description: 'REG-WFL-01 row f', resource: 'certificates', items: [{ source: { value: 'meta' }, field: { label: labels[0] }, operator: { value: 'EQUALS' }, text: 'qa-regression' }] });
            const ref = recordCreated('conditions', { uuid: created.uuid, name }, SPEC, 'built in the UI form (row f, metadata)');
            const got = (await getKind(api, 'conditions', ref.uuid)).json as Json;
            expect(got.items[0]).toMatchObject({ fieldSource: 'meta', operator: 'EQUALS', value: 'qa-regression' });
            expect(String(got.items[0].fieldIdentifier), 'a metadata identifier is name|CONTENTTYPE').toMatch(/\|/);
            await workflow.openDetail('condition', ref.uuid);
            await ConditionFilterWidget.onDetail(page).assertBadge({ source: 'Metadata', field: labels[0].replace(/ \(.*\)$/, ''), operator: 'equals', value: 'qa-regression' });
        });
});
