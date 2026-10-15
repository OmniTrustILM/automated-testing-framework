/**
 * REG-WFL-23 — notification instances and profiles created through the UI forms: for each form the request the form sent, the
 * stored object (API read-back) and the detail page agree (ilm#434 steps 1–3; T10 R2, R12; P-N23b). Instances: an e-mail instance
 * and a webhook instance (RAW_JSON, and JSON with its template); profiles: one per instance and one that uses the e-mail instance
 * PLUS the internal switch (a profile references ONE instance plus an optional internal flag, so "a profile that uses both" is
 * this one: ⚠️ inferred step 3).
 *
 * Shared-tier safety: the sender and the URL are reserved test names (`…@example.test`, `https://<run>.example.test/hook`), no
 * trigger fires these instances, so nothing is delivered. `@needs:email-provider` / `@needs:webhook-provider`: a tier without a
 * healthy connector skips with the named deploy gate. Every object is recorded in the ledger right after the form redirected.
 * Open points (first live run): the form spreads extra keys into the instance request (the oracle compares the fields that
 * matter); the webhook JSON template attribute is added by a connector callback after the content type is chosen — its code
 * editor id is derived from the attribute name `data_contentTemplate_json`.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { NotificationPage } from '../../pages/NotificationPage';
import {
    durationSeconds, EMAIL_TEMPLATE, findNotificationConnector, getInstance, getProfile, NotificationConnector, reservedSender, reservedWebhookUrl, WEBHOOK_JSON_TEMPLATE,
} from '../../utils/regression/notificationApi';
import { recordCreated } from '../../utils/regression/regressionRun';
import { wfName } from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-WFL-23';
type Json = Record<string, any>;

async function connectorOrSkip(api: Parameters<typeof findNotificationConnector>[0], kind: 'EMAIL' | 'WEBHOOK'): Promise<NotificationConnector> {
    const c = await findNotificationConnector(api, kind);
    test.skip(!c || !!c.unhealthy, `deploy gate: no healthy ${kind} notification connector registered on this tier (@needs:${kind === 'EMAIL' ? 'email' : 'webhook'}-provider)`);
    return c!;
}

test.describe('@regression REG-WFL-23 notification forms', () => {
    const m = (what: string, needs: string[]) =>
        meta({ id: 'REG-WFL-23', prio: 'P1', issue: 'ilm#434', needs, rule: [`T10 R2 (instance create: name, connector, kind, attributes), R12 (profile rules); P-N23b: ${what}`] });

    test('REG-WFL-23[email]: an e-mail instance and a profile on it (and the same with the internal switch) agree between request, API and detail', m('e-mail instance + profiles', ['email-provider']), async ({ page, api, env }) => {
        test.setTimeout(300_000);
        const connector = await connectorOrSkip(api, 'EMAIL');
        const notification = new NotificationPage(page);
        await loginAsSmokeUser(page, env);

        const name = wfName('wf23-mail');
        const sender = reservedSender();
        const instance = await notification.createInstance({
            name, description: 'REG-WFL-23 e-mail instance', provider: connector.name, kind: 'EMAIL',
            attributes: [
                { name: 'data_senderEmailAddress', kind: 'text', value: sender },
                { name: 'data_emailSubject', kind: 'text', value: 'QA REG-WFL-23' },
                { name: 'data_emailContentTemplate', kind: 'code', value: EMAIL_TEMPLATE },
            ],
        });
        recordCreated('notificationInstances', { uuid: instance.uuid, name }, SPEC, 'e-mail instance built in the UI form (nothing delivered)');

        await test.step('Request ↔ API: name, kind, connector and the typed attributes', async () => {
            expect(instance.body).toMatchObject({ name, kind: 'EMAIL', connectorUuid: connector.uuid });
            const got = (await getInstance(api, instance.uuid)).json as Json;
            expect(got).toMatchObject({ uuid: instance.uuid, name, kind: 'EMAIL', connectorUuid: connector.uuid, description: 'REG-WFL-23 e-mail instance' });
            const attr = (n: string) => (got.attributes as Json[]).find((a) => a.name === n)?.content?.[0]?.data;
            expect(attr('data_senderEmailAddress')).toBe(sender);
            expect(attr('data_emailSubject')).toBe('QA REG-WFL-23');
        });
        await test.step('Detail page: name, kind, provider', async () => notification.assertInstanceDetail(instance.uuid, { name, kind: 'EMAIL', provider: connector.name }));

        for (const internal of [false, true]) {
            const profileName = wfName(`wf23-prof-${internal ? 'int' : 'ext'}`);
            const profile = await notification.createProfile({
                name: profileName, description: 'REG-WFL-23 profile', recipientType: 'owner', instance: name, internal, frequency: '5d 4h', repetitions: 2, categories: ['metadata', 'associations'],
            });
            recordCreated('notificationProfiles', { uuid: profile.uuid, name: profileName }, SPEC, `profile built in the UI form (internal ${internal})`);
            await test.step(`Profile ${internal ? 'with' : 'without'} the internal switch: request ↔ API ↔ detail`, async () => {
                expect(profile.body).toMatchObject({ name: profileName, recipientType: 'owner', internalNotification: internal, notificationInstanceUuid: instance.uuid, frequency: 'P5DT4H', repetitions: 2 });
                const got = (await getProfile(api, profile.uuid)).json as Json;
                expect(got).toMatchObject({ uuid: profile.uuid, name: profileName, version: 1, recipientType: 'owner', internalNotification: internal, repetitions: 2 });
                expect(durationSeconds(got.frequency)).toBe(5 * 86_400 + 4 * 3_600);
                expect(got.notificationInstance?.uuid).toBe(instance.uuid);
                expect([...(got.eventDataCategories as string[])].sort()).toEqual(['associations', 'metadata']);
                await notification.assertProfileDetail(profile.uuid, {
                    name: profileName, internal, recipientType: 'owner', categories: ['metadata', 'associations'], frequency: '5d 4h', repetitions: 2, instanceName: name,
                });
            });
        }
    });

    test('REG-WFL-23[webhook]: a webhook RAW_JSON and a webhook JSON instance and a profile on the first agree between request, API and detail', m('webhook instances + profile', ['webhook-provider']), async ({ page, api, env }) => {
        test.setTimeout(300_000);
        const connector = await connectorOrSkip(api, 'WEBHOOK');
        const notification = new NotificationPage(page);
        await loginAsSmokeUser(page, env);

        const rawName = wfName('wf23-hook-raw');
        const url = reservedWebhookUrl();
        const raw = await notification.createInstance({
            name: rawName, provider: connector.name, kind: 'WEBHOOK',
            attributes: [{ name: 'data_webhookUrl', kind: 'text', value: url }, { name: 'data_contentType', kind: 'list', value: 'raw_json' }],
        });
        recordCreated('notificationInstances', { uuid: raw.uuid, name: rawName }, SPEC, 'webhook RAW_JSON instance built in the UI form (nothing delivered)');
        const jsonName = wfName('wf23-hook-json');
        const json = await notification.createInstance({
            name: jsonName, provider: connector.name, kind: 'WEBHOOK',
            attributes: [
                { name: 'data_webhookUrl', kind: 'text', value: reservedWebhookUrl('hook2') },
                { name: 'data_contentType', kind: 'list', value: 'json' },
                { name: 'data_contentTemplate_json', kind: 'code', value: WEBHOOK_JSON_TEMPLATE },
            ],
        });
        recordCreated('notificationInstances', { uuid: json.uuid, name: jsonName }, SPEC, 'webhook JSON instance built in the UI form (nothing delivered)');

        await test.step('Request ↔ API for both instances', async () => {
            for (const [i, n] of [[raw, rawName], [json, jsonName]] as const) {
                expect(i.body).toMatchObject({ name: n, kind: 'WEBHOOK', connectorUuid: connector.uuid });
                const got = (await getInstance(api, i.uuid)).json as Json;
                expect(got).toMatchObject({ uuid: i.uuid, name: n, kind: 'WEBHOOK', connectorUuid: connector.uuid });
            }
            const rawGot = (await getInstance(api, raw.uuid)).json as Json;
            expect((rawGot.attributes as Json[]).find((a) => a.name === 'data_webhookUrl')?.content?.[0]?.data).toBe(url);
            expect(String((rawGot.attributes as Json[]).find((a) => a.name === 'data_contentType')?.content?.[0]?.data)).toBe('RAW_JSON');
            const jsonGot = (await getInstance(api, json.uuid)).json as Json;
            const template = (jsonGot.attributes as Json[]).find((a) => String(a.name).startsWith('data_contentTemplate'));
            expect(Buffer.from(String(template?.content?.[0]?.data?.code ?? ''), 'base64').toString('utf8')).toBe(WEBHOOK_JSON_TEMPLATE);
        });
        await test.step('Detail pages: name, kind, provider', async () => {
            await notification.assertInstanceDetail(raw.uuid, { name: rawName, kind: 'WEBHOOK', provider: connector.name });
            await notification.assertInstanceDetail(json.uuid, { name: jsonName, kind: 'WEBHOOK', provider: connector.name });
        });

        const profileName = wfName('wf23-prof-hook');
        const profile = await notification.createProfile({ name: profileName, recipientType: 'default', instance: rawName });
        recordCreated('notificationProfiles', { uuid: profile.uuid, name: profileName }, SPEC, 'profile on the webhook instance built in the UI form');
        await test.step('Profile on the webhook instance: request ↔ API ↔ detail', async () => {
            expect(profile.body).toMatchObject({ name: profileName, recipientType: 'default', notificationInstanceUuid: raw.uuid, internalNotification: false });
            const got = (await getProfile(api, profile.uuid)).json as Json;
            expect(got).toMatchObject({ uuid: profile.uuid, name: profileName, version: 1, recipientType: 'default', internalNotification: false });
            expect(got.notificationInstance?.uuid).toBe(raw.uuid);
            await notification.assertProfileDetail(profile.uuid, { name: profileName, internal: false, recipientType: 'default', instanceName: rawName });
        });
    });
});
