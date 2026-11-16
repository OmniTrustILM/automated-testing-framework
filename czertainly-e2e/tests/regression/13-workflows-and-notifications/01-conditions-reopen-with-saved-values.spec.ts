/**
 * REG-WFL-01 — Conditions built in the form and reopened. ilm#438.
 * The condition is never associated; the upload-event refusal is covered by tests/api/12-workflows/upload-event-conditions.api.spec.ts.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '../../../fixtures/regressionFixtures';
import { chooseOption } from '../../../pages/ui/select';
import { FilterItem, WorkflowPage } from '../../../pages/WorkflowPage';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import type { OwnObjects } from '../../../utils/regression/ownObjects';
import { lookupInList, submitRecordingByNameOnFailure } from '../../../utils/regression/ledger/uiCreates';
import { runId, ownName } from '../../../utils/regression/ledger/runState';
import { getKind, kindPath } from '../../../utils/regression/events/workflowObjects';
import { testMeta, tags, type Needs } from '../../../utils/regression/tags';
import { ISSUE_MS } from '../../../utils/regression/timeouts';

type Json = Record<string, any>;
type LiveCheck = (type: string, ref: { uuid: string; name?: string }) => Promise<unknown>;

interface RowSetup {
    /** The own object the form picks (checked live before the browser uses it); none for a typed value. */
    picked?: { type: string; ref: { uuid: string; name?: string } };
    item: FilterItem;
    /** What the stored item must be (the identifier, source and operator codes; the value is compared with the request). */
    expect: { fieldSource: string; fieldIdentifier: string | RegExp; operator: string };
    /** What the reopened detail's badge shows. */
    badge: { source: string; field: string; condition: string; value?: string };
    /** The typed value as the platform stores it (text rows), or a check on the stored value. */
    stored?: (value: unknown) => void;
}

test.describe('Conditions built in the form and reopened', { tag: tags.regression }, () => {
    const rows: Array<{ key: string; what: string; needs?: Needs; setup: (own: OwnObjects) => Promise<RowSetup> }> = [
        {
            key: 'a', what: 'RA profile equals an own RA profile', needs: 'ca',
            setup: async (own) => {
                const ra = await own.raProfile('wf01a-ra');
                return {
                    picked: { type: 'raProfiles', ref: ra },
                    item: { source: { value: 'property' }, field: { value: 'RA_PROFILE_NAME' }, condition: { value: 'EQUALS' }, option: ra.name },
                    expect: { fieldSource: 'property', fieldIdentifier: 'RA_PROFILE_NAME', operator: 'EQUALS' },
                    badge: { source: 'Property', field: 'RA Profile', condition: 'equals' },
                    stored: (v) => expect([ra.name, ra.uuid], 'the stored value identifies the own RA profile').toContain(String(Array.isArray(v) ? v[0] : v)),
                };
            },
        },
        {
            key: 'b', what: 'Groups equals an own group',
            setup: async (own) => {
                const group = await own.group('wf01b-group');
                return {
                    picked: { type: 'groups', ref: group },
                    item: { source: { value: 'property' }, field: { value: 'GROUP_NAME' }, condition: { value: 'EQUALS' }, option: group.name },
                    expect: { fieldSource: 'property', fieldIdentifier: 'GROUP_NAME', operator: 'EQUALS' },
                    badge: { source: 'Property', field: 'Groups', condition: 'equals' },
                    stored: (v) => expect([group.name, group.uuid], 'the stored value identifies the own group').toContain(String(Array.isArray(v) ? v[0] : v)),
                };
            },
        },
        {
            key: 'c', what: 'Owner not equals an own user',
            setup: async (own) => {
                const user = await own.user('wf01c-user');
                return {
                    picked: { type: 'users', ref: user },
                    item: { source: { value: 'property' }, field: { value: 'OWNER' }, condition: { value: 'NOT_EQUALS' }, option: user.name },
                    expect: { fieldSource: 'property', fieldIdentifier: 'OWNER', operator: 'NOT_EQUALS' },
                    badge: { source: 'Property', field: 'Owner', condition: 'not equals' },
                    stored: (v) => expect([user.name, user.uuid], 'the stored value identifies the own user').toContain(String(Array.isArray(v) ? v[0] : v)),
                };
            },
        },
        {
            key: 'd', what: 'an own date attribute is greater than a picked date',
            setup: async (own) => {
                const attr = await own.customAttribute('wf01d-date', { resources: ['certificates'], contentType: 'date' });
                const now = new Date();
                const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-15`;
                return {
                    picked: { type: 'customAttributes', ref: attr },
                    item: { source: { value: 'custom' }, field: attr.attributeName, condition: { value: 'GREATER' }, dayOfCurrentMonth: 15 },
                    expect: { fieldSource: 'custom', fieldIdentifier: new RegExp(`^${attr.attributeName}\\|`), operator: 'GREATER' },
                    badge: { source: 'Custom attribute', field: attr.attributeName, condition: 'greater than' },
                    stored: (v) => expect(String(v), 'the stored date is the picked day').toContain(iso),
                };
            },
        },
        {
            key: 'e', what: 'an own custom attribute is empty',
            setup: async (own) => {
                const attr = await own.customAttribute('wf01e-str', { resources: ['certificates'] });
                return {
                    picked: { type: 'customAttributes', ref: attr },
                    item: { source: { value: 'custom' }, field: attr.attributeName, condition: { value: 'EMPTY' } },
                    expect: { fieldSource: 'custom', fieldIdentifier: new RegExp(`^${attr.attributeName}\\|`), operator: 'EMPTY' },
                    badge: { source: 'Custom attribute', field: attr.attributeName, condition: 'empty' },
                };
            },
        },
        {
            key: 'g', what: 'Common Name contains the run prefix',
            setup: async () => ({
                item: { source: { value: 'property' }, field: { value: 'COMMON_NAME' }, condition: { value: 'CONTAINS' }, text: runId() },
                expect: { fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', operator: 'CONTAINS' },
                badge: { source: 'Property', field: 'Common Name', condition: 'contains', value: runId() },
                stored: (v) => expect(String(v)).toBe(runId()),
            }),
        },
        {
            key: 'h', what: 'an own integer attribute is greater than 5',
            setup: async (own) => {
                const attr = await own.customAttribute('wf01h-int', { resources: ['certificates'], contentType: 'integer' });
                return {
                    picked: { type: 'customAttributes', ref: attr },
                    item: { source: { value: 'custom' }, field: attr.attributeName, condition: { value: 'GREATER' }, text: '5' },
                    expect: { fieldSource: 'custom', fieldIdentifier: new RegExp(`^${attr.attributeName}\\|`), operator: 'GREATER' },
                    badge: { source: 'Custom attribute', field: attr.attributeName, condition: 'greater than', value: '5' },
                    stored: (v) => expect(Number(v)).toBe(5),
                };
            },
        },
    ];

    async function buildAndReopen(o: { page: Page; api: GuardedApi; own: OwnObjects; live: LiveCheck; key: string; setup: RowSetup }): Promise<void> {
        const { page, api, own, live, key, setup } = o;
        const workflow = new WorkflowPage(page);
        const name = ownName(`wf01${key}-cond`);
        const note = `built in the UI form (row ${key})`;
        if (setup.picked) await live(setup.picked.type, setup.picked.ref);
        const created = await submitRecordingByNameOnFailure({ type: 'conditions', name, spec: own.spec, note, lookup: lookupInList(api, kindPath('conditions')) }, () => workflow.createCondition({ name, description: `REG-WFL-01 row ${key}`, resource: 'certificates', items: [setup.item] }));
        // Ledger before assertion, from the form's answer and before the redirect is waited for.
        const ref = own.record('conditions', created, { name, note });
        await workflow.waitForDetailRoute('condition');

        await test.step('The create request the form sent carries the typed item', async () => {
            const items = created.body.items as Json[];
            expect(items, 'one item').toHaveLength(1);
            expect(items[0], 'the request item carries the typed source and operator').toMatchObject({ fieldSource: setup.expect.fieldSource, operator: setup.expect.operator });
            if (typeof setup.expect.fieldIdentifier === 'string') expect(items[0].fieldIdentifier, 'the request item carries the typed field').toBe(setup.expect.fieldIdentifier);
            else expect(String(items[0].fieldIdentifier), 'the request item carries the typed field').toMatch(setup.expect.fieldIdentifier);
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
            await workflow.goToDetail('condition', ref.uuid);
            await expect(workflow.conditionItemBadges.first()).toBeVisible();
            await workflow.assertConditionItemBadge(setup.badge);
            const codes = await workflow.readConditionItemCodes(0);
            expect(codes, 'the reopened badge keeps the raw source and operator codes').toMatchObject({ source: setup.expect.fieldSource, condition: setup.expect.operator });
            if (typeof setup.expect.fieldIdentifier === 'string') expect(codes.field, 'the reopened badge keeps the raw field code').toBe(setup.expect.fieldIdentifier);
            else expect(codes.field, 'the reopened badge keeps the raw field code').toMatch(setup.expect.fieldIdentifier);
        });
    }

    for (const row of rows) {
        test(`the condition "${row.what}" is saved and reopens as entered`,
            testMeta({
                id: 'REG-WFL-01', row: row.what, prio: 'P2', issue: 'ilm#438', needs: row.needs,
                rule: ['condition validation and names; operator sets by field type; build in the form, reopen, API read-back is the oracle', `ilm#438 steps 1–5; row ${row.key}`],
            }),
            async ({ signedIn, api, own, live }) => {
                test.setTimeout(ISSUE_MS);
                const setup = await row.setup(own);
                await buildAndReopen({ page: signedIn, api, own, live, key: row.key, setup });
            });
    }

    test('a condition on a metadata item the tier offers is saved as entered',
        testMeta({
            id: 'REG-WFL-01', row: 'a metadata item the tier offers', prio: 'P2', issue: 'ilm#438', needs: 'metadata-field',
            rule: ['metadata matched by name and content type; operator sets by field type', 'ilm#438 steps 1–5; metadata item the tier offers'],
        }),
        async ({ signedIn: page, api, own }) => {
            test.setTimeout(ISSUE_MS);
            const workflow = new WorkflowPage(page);
            const labels = await test.step('Open Create Condition and read the metadata fields the tier offers for certificates', async () => {
                await workflow.openCreateDialog('condition');
                await chooseOption(page, workflow.conditionTypeSelect, { value: 'checkField' });
                await chooseOption(page, workflow.conditionResourceSelect, { value: 'certificates' });
                await workflow.waitForConditionCatalogue();
                return workflow.conditionFieldLabels({ value: 'meta' });
            });
            // The need read the catalogue before the test started; the condition form must offer the same fields.
            expect(labels.length, 'the Create Condition form offers the metadata fields the certificate catalogue lists').toBeGreaterThan(0);
            await workflow.cancelCreate('condition');

            // A metadata field exists: build the condition through the shared flow (it opens the list again) with the first offered field
            // and a text value.
            const name = ownName('wf01f-cond');
            const note = 'built in the UI form (row f, metadata)';
            const ref = await test.step('Create Condition: the first metadata field equals a text', async () => {
                const answer = await submitRecordingByNameOnFailure({ type: 'conditions', name, spec: own.spec, note, lookup: lookupInList(api, kindPath('conditions')) }, () => workflow.createCondition({ name, description: 'REG-WFL-01 row f', resource: 'certificates', items: [{ source: { value: 'meta' }, field: labels[0], condition: { value: 'EQUALS' }, text: 'qa-regression' }] }));
                // the ledger line comes from the form's answer, before the redirect is waited for
                const recorded = own.record('conditions', answer, { name, note });
                await workflow.waitForDetailRoute('condition');
                return recorded;
            });

            await test.step('API read-back: the stored item equals what was typed', async () => {
                const got = (await getKind(api, 'conditions', ref.uuid)).json as Json;
                expect(got.items[0], 'the stored metadata item equals what was typed').toMatchObject({ fieldSource: 'meta', operator: 'EQUALS', value: 'qa-regression' });
                expect(String(got.items[0].fieldIdentifier), 'a metadata identifier is name|CONTENTTYPE').toMatch(/\|/);
            });

            await test.step('The reopened detail page shows the item as entered', async () => {
                await workflow.goToDetail('condition', ref.uuid);
                await workflow.assertConditionItemBadge({ source: 'Metadata', field: labels[0].replace(/ \(.*\)$/, ''), condition: 'equals', value: 'qa-regression' });
            });
        });
});
