/**
 * REG-WFL-23 — Notification instances and profiles created through the UI forms. ilm#434.
 *
 * WHAT: 1. An e-mail instance (sender, subject, template): the request the form sent, the stored object (API read-back) and
 *          the detail page agree.
 *       2. Two profiles on it, one without and one with the internal switch (recipient type owner, frequency 5d 4h, 2 repetitions,
 *          categories metadata and associations): request, API and detail agree, and the frequency is stored as an ISO duration.
 *       3. A webhook instance with content type RAW_JSON and one with JSON and its template: request and API agree, the template
 *          round-trips, and both detail pages show name, kind and provider.
 *       4. A profile (recipient type default) on the first webhook instance: request, API and detail agree.
 * WHY: a form that stores something other than what was typed breaks notifications silently; request, stored object and detail page
 *      must say the same.
 * HOW: shared-tier safety: the sender and the URL are reserved test names (`…@example.test`, `https://<run>.example.test/hook`) and no
 *      trigger fires these instances, so nothing is delivered (`@needs:email-provider`, `@needs:webhook-provider`; without a healthy
 *      connector the tests skip with the reason). Every object is in the ledger from the form's answer, before the redirect is waited for.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { NotificationInstancePage } from '../../../pages/NotificationInstancePage';
import { NotificationProfilePage } from '../../../pages/NotificationProfilePage';
import { CATEGORY_LABEL, durationSeconds, getProfile } from '../../../utils/regression/events/notificationProfiles';
import { EMAIL_TEMPLATE, reservedSender, reservedWebhookUrl, WEBHOOK_JSON_TEMPLATE } from '../../../utils/regression/events/notificationAttributes';
import { findNotificationConnector } from '../../../utils/regression/events/notificationConnector';
import { getInstance } from '../../../utils/regression/events/notificationInstances';
import { lookupInList, lookupInPagedGet, submitRecordingByNameOnFailure } from '../../../utils/regression/ledger/uiCreates';
import { testMeta, tags, type Needs } from '../../../utils/regression/tags';
import { FORM_FLOW_MS } from '../../../utils/regression/timeouts';
import { ownName } from '../../../utils/regression/ledger/runState';

type Json = Record<string, any>;

test.describe('Notification forms', { tag: tags.regression }, () => {
    const rowMeta = (what: string, needs: Needs[], row: string) =>
        testMeta({ id: 'REG-WFL-23', row, prio: 'P2', issue: 'ilm#434', needs, rule: [`instance create: name, connector, kind, attributes; profile rules; ${what}`] });

    test('an e-mail instance and its profiles agree between request, API and detail', rowMeta('e-mail instance + profiles (also with the internal switch)', ['email-provider'], 'e-mail instance and profiles'), async ({ signedIn: page, api, own, live }) => {
        test.setTimeout(FORM_FLOW_MS);
        // present and healthy: the `email-provider` need is resolved before the test body
        const connector = (await findNotificationConnector(api, 'EMAIL'))!;
        const instances = new NotificationInstancePage(page);
        const profiles = new NotificationProfilePage(page);

        const name = ownName('wf23-mail');
        const sender = reservedSender();
        const instanceNote = 'e-mail instance built in the UI form (nothing delivered)';
        const created = await submitRecordingByNameOnFailure({ type: 'notificationInstances', name, spec: own.spec, note: instanceNote, lookup: lookupInList(api, '/api/v1/notificationInstances') }, () => instances.createInstance({
            name, description: 'REG-WFL-23 e-mail instance', provider: connector.name, kind: 'EMAIL',
            attributes: [
                { name: 'data_senderEmailAddress', kind: 'text', value: sender },
                { name: 'data_emailSubject', kind: 'text', value: 'QA REG-WFL-23' },
                { name: 'data_emailContentTemplate', kind: 'code', value: EMAIL_TEMPLATE },
            ],
        }));
        // The ledger line comes from the form's answer, before the redirect is waited for.
        const instance = { ...own.record('notificationInstances', created, { name, note: instanceNote }), body: created.body };
        await instances.waitForDetailRoute();

        await test.step('Request ↔ API: name, kind, connector and the typed attributes', async () => {
            expect(instance.body, 'the request the form sent').toMatchObject({ name, kind: 'EMAIL', connectorUuid: connector.uuid });
            const got = (await getInstance(api, instance.uuid)).json as Json;
            expect(got, 'the stored instance').toMatchObject({ uuid: instance.uuid, name, kind: 'EMAIL', connectorUuid: connector.uuid, description: 'REG-WFL-23 e-mail instance' });
            const attr = (n: string) => (got.attributes as Json[]).find((a) => a.name === n)?.content?.[0]?.data;
            expect(attr('data_senderEmailAddress'), 'the stored sender is the typed one').toBe(sender);
            expect(attr('data_emailSubject'), 'the stored subject is the typed one').toBe('QA REG-WFL-23');
        });
        await test.step('Detail page: name, kind, provider', async () => {
            await instances.goToDetail(instance.uuid);
            await instances.assertDetail({ name, kind: 'EMAIL', provider: connector.name });
        });

        for (const internal of [false, true]) {
            const profileName = ownName(`wf23-prof-${internal ? 'int' : 'ext'}`);
            const profileNote = `profile built in the UI form (internal ${internal})`;
            await live('notificationInstances', instance); // the profile form picks this own instance
            const createdProfile = await submitRecordingByNameOnFailure({ type: 'notificationProfiles', name: profileName, spec: own.spec, note: profileNote, lookup: lookupInPagedGet(api, '/api/v1/notificationProfiles', (p) => p.notificationProfiles as Array<Record<string, unknown>>) }, () => profiles.createProfile({
                name: profileName, description: 'REG-WFL-23 profile', recipientType: 'owner', instance: name, internal, frequency: '5d 4h', repetitions: 2, categories: ['metadata', 'associations'],
            }));
            const profile = { ...own.record('notificationProfiles', createdProfile, { name: profileName, note: profileNote }), body: createdProfile.body };
            await profiles.waitForDetailRoute();
            await test.step(`Profile ${internal ? 'with' : 'without'} the internal switch: request ↔ API ↔ detail`, async () => {
                expect(profile.body, 'the request the form sent').toMatchObject({ name: profileName, recipientType: 'owner', internalNotification: internal, notificationInstanceUuid: instance.uuid, frequency: 'P5DT4H', repetitions: 2 });
                const got = (await getProfile(api, profile.uuid)).json as Json;
                expect(got, 'the stored profile').toMatchObject({ uuid: profile.uuid, name: profileName, version: 1, recipientType: 'owner', internalNotification: internal, repetitions: 2 });
                expect(durationSeconds(got.frequency), 'the frequency 5d 4h is stored as an ISO duration').toBe(5 * 86_400 + 4 * 3_600);
                expect(got.notificationInstance?.uuid, 'the profile points at the instance').toBe(instance.uuid);
                expect([...(got.eventDataCategories as string[])].sort(), 'the stored event data categories').toEqual(['associations', 'metadata']);
                await profiles.goToDetail(profile.uuid);
                await profiles.assertDetail({
                    name: profileName, internal, recipientType: 'owner', categoryLabels: ['metadata', 'associations'].map((c) => CATEGORY_LABEL[c]), frequency: '5d 4h', repetitions: 2, instanceName: name,
                });
            });
        }
    });

    test('webhook instances (RAW_JSON and JSON) and a profile agree between request, API and detail', rowMeta('webhook instances + profile on the first', ['webhook-provider'], 'webhook instances and a profile'), async ({ signedIn: page, api, own, live }) => {
        test.setTimeout(FORM_FLOW_MS);
        // present and healthy: the `webhook-provider` need is resolved before the test body
        const connector = (await findNotificationConnector(api, 'WEBHOOK'))!;
        const instances = new NotificationInstancePage(page);
        const profiles = new NotificationProfilePage(page);

        const rawName = ownName('wf23-hook-raw');
        const url = reservedWebhookUrl();
        const rawNote = 'webhook RAW_JSON instance built in the UI form (nothing delivered)';
        const createdRaw = await submitRecordingByNameOnFailure({ type: 'notificationInstances', name: rawName, spec: own.spec, note: rawNote, lookup: lookupInList(api, '/api/v1/notificationInstances') }, () => instances.createInstance({
            name: rawName, provider: connector.name, kind: 'WEBHOOK',
            attributes: [{ name: 'data_webhookUrl', kind: 'text', value: url }, { name: 'data_contentType', kind: 'list', value: 'raw_json' }],
        }));
        const raw = { ...own.record('notificationInstances', createdRaw, { name: rawName, note: rawNote }), body: createdRaw.body };
        await instances.waitForDetailRoute();
        const jsonName = ownName('wf23-hook-json');
        const jsonNote = 'webhook JSON instance built in the UI form (nothing delivered)';
        const createdJson = await submitRecordingByNameOnFailure({ type: 'notificationInstances', name: jsonName, spec: own.spec, note: jsonNote, lookup: lookupInList(api, '/api/v1/notificationInstances') }, () => instances.createInstance({
            name: jsonName, provider: connector.name, kind: 'WEBHOOK',
            attributes: [
                { name: 'data_webhookUrl', kind: 'text', value: reservedWebhookUrl('hook2') },
                { name: 'data_contentType', kind: 'list', value: 'json' },
                { name: 'data_contentTemplate_json', kind: 'code', value: WEBHOOK_JSON_TEMPLATE },
            ],
        }));
        const json = { ...own.record('notificationInstances', createdJson, { name: jsonName, note: jsonNote }), body: createdJson.body };
        await instances.waitForDetailRoute();

        await test.step('Request ↔ API for both instances', async () => {
            for (const [i, n] of [[raw, rawName], [json, jsonName]] as const) {
                expect(i.body, `the request the form sent for ${n}`).toMatchObject({ name: n, kind: 'WEBHOOK', connectorUuid: connector.uuid });
                const got = (await getInstance(api, i.uuid)).json as Json;
                expect(got, `the stored instance ${n}`).toMatchObject({ uuid: i.uuid, name: n, kind: 'WEBHOOK', connectorUuid: connector.uuid });
            }
            const rawGot = (await getInstance(api, raw.uuid)).json as Json;
            expect((rawGot.attributes as Json[]).find((a) => a.name === 'data_webhookUrl')?.content?.[0]?.data, 'the stored webhook URL is the typed one').toBe(url);
            expect(String((rawGot.attributes as Json[]).find((a) => a.name === 'data_contentType')?.content?.[0]?.data), 'the stored content type is RAW_JSON').toBe('RAW_JSON');
            const jsonGot = (await getInstance(api, json.uuid)).json as Json;
            const template = (jsonGot.attributes as Json[]).find((a) => String(a.name).startsWith('data_contentTemplate'));
            expect(Buffer.from(String(template?.content?.[0]?.data?.code ?? ''), 'base64').toString('utf8'), 'the stored JSON template round-trips').toBe(WEBHOOK_JSON_TEMPLATE);
        });
        await test.step('Detail pages: name, kind, provider', async () => {
            await instances.goToDetail(raw.uuid);
            await instances.assertDetail({ name: rawName, kind: 'WEBHOOK', provider: connector.name });
            await instances.goToDetail(json.uuid);
            await instances.assertDetail({ name: jsonName, kind: 'WEBHOOK', provider: connector.name });
        });

        const profileName = ownName('wf23-prof-hook');
        await live('notificationInstances', raw); // the profile form picks this own instance
        const hookProfileNote = 'profile on the webhook instance built in the UI form';
        const createdProfile = await submitRecordingByNameOnFailure({ type: 'notificationProfiles', name: profileName, spec: own.spec, note: hookProfileNote, lookup: lookupInPagedGet(api, '/api/v1/notificationProfiles', (p) => p.notificationProfiles as Array<Record<string, unknown>>) }, () => profiles.createProfile({ name: profileName, recipientType: 'default', instance: rawName }));
        const profile = { ...own.record('notificationProfiles', createdProfile, { name: profileName, note: hookProfileNote }), body: createdProfile.body };
        await profiles.waitForDetailRoute();
        await test.step('Profile on the webhook instance: request ↔ API ↔ detail', async () => {
            expect(profile.body, 'the request the form sent').toMatchObject({ name: profileName, recipientType: 'default', notificationInstanceUuid: raw.uuid, internalNotification: false });
            const got = (await getProfile(api, profile.uuid)).json as Json;
            expect(got, 'the stored profile').toMatchObject({ uuid: profile.uuid, name: profileName, version: 1, recipientType: 'default', internalNotification: false });
            expect(got.notificationInstance?.uuid, 'the profile points at the webhook instance').toBe(raw.uuid);
            await profiles.goToDetail(profile.uuid);
            await profiles.assertDetail({ name: profileName, internal: false, recipientType: 'default', instanceName: rawName });
        });
    });
});
