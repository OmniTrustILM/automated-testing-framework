/**
 * API-WFL-19 — notification instances: create, read back, edit, and the mapping attributes per kind. ilm#434.
 * Nothing is delivered: no trigger fires an instance, and senders and URLs are reserved test names (RFC 6761).
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { createOwnInstance, getInstance, putOwnInstance } from '../../../utils/regression/events/notificationInstances';
import { EMAIL_TEMPLATE, emailAttributes, reservedSender, reservedWebhookUrl, WEBHOOK_JSON_TEMPLATE, WEBHOOK_XML_TEMPLATE, webhookAttributes, WebhookContentType } from '../../../utils/regression/events/notificationAttributes';
import { findNotificationConnector, getMappingAttributes, instanceDefinitions, NotificationConnector, NotificationKind } from '../../../utils/regression/events/notificationConnector';
import { testMeta, tags, type Needs } from '../../../utils/regression/tags';

type Api = Parameters<typeof findNotificationConnector>[0];
type Json = Record<string, any>;

/**
 * The notification connector of a kind. The row's declared need (`email-provider` / `webhook-provider`) has already skipped the test
 * when there is none.
 */
async function connectorOf(api: Api, kind: NotificationKind): Promise<NotificationConnector> {
    const connector = await findNotificationConnector(api, kind);
    expect(connector, `the ${kind} notification connector the declared need resolved`).toBeTruthy();
    return connector!;
}

const attrContent = (detail: Json, name: string): any => (detail.attributes ?? []).find((a: Json) => a.name === name)?.content?.[0];

test.describe('Notification instances: create, read back, edit', { tag: tags.api }, () => {
    const rowMeta = (row: string, rule: string, needs: Needs[]) =>
        testMeta({ id: 'API-WFL-19', prio: 'P1', issue: 'ilm#434', needs, rule: [`notification instances, row ${row}: ${rule}`] });

    test('an EMAIL instance is created and read back with its attributes', rowMeta('a', 'EMAIL instance, detail returns the sent attributes', ['email-provider']), async ({ api, own }) => {
        const connector = await connectorOf(api, 'EMAIL');
        const sender = reservedSender();
        const instance = await createOwnInstance(api, own.spec, 'wf19-mail', { connector, attributes: emailAttributes(await instanceDefinitions(api, connector), { sender, subject: 'QA API-WFL-19', template: EMAIL_TEMPLATE }) });
        const detail = (await getInstance(api, instance.uuid)).json;
        expect(detail).toMatchObject({ uuid: instance.uuid, name: instance.name, kind: 'EMAIL', connectorUuid: connector.uuid });
        expect(attrContent(detail, 'data_senderEmailAddress')?.data).toBe(sender);
        expect(attrContent(detail, 'data_emailSubject')?.data).toBe('QA API-WFL-19');
        expect(attrContent(detail, 'data_emailContentTemplate')?.data?.language).toBe('html');
        expect(Buffer.from(String(attrContent(detail, 'data_emailContentTemplate')?.data?.code ?? ''), 'base64').toString('utf8')).toBe(EMAIL_TEMPLATE);
    });

    const webhookRows: Array<[string, WebhookContentType, string | undefined]> = [
        ['b', 'RAW_JSON', undefined],
        ['c', 'JSON', WEBHOOK_JSON_TEMPLATE],
        ['d', 'XML', WEBHOOK_XML_TEMPLATE],
    ];
    for (const [row, contentType, template] of webhookRows) {
        test(`a WEBHOOK instance of content type ${contentType} is created and read back`, rowMeta(row, `WEBHOOK ${contentType}`, ['webhook-provider']), async ({ api, own }) => {
            const connector = await connectorOf(api, 'WEBHOOK');
            const url = reservedWebhookUrl();
            const instance = await createOwnInstance(api, own.spec, `wf19-hook-${row}`, { connector, attributes: webhookAttributes(await instanceDefinitions(api, connector), { url, contentType, ...(template ? { template } : {}) }) });
            const detail = (await getInstance(api, instance.uuid)).json;
            expect(detail).toMatchObject({ uuid: instance.uuid, name: instance.name, kind: 'WEBHOOK', connectorUuid: connector.uuid });
            expect(attrContent(detail, 'data_webhookUrl')?.data).toBe(url);
            expect(String(attrContent(detail, 'data_contentType')?.data)).toBe(contentType);
            if (template) {
                const stored = (detail.attributes as Json[]).find((a) => String(a.name).startsWith('data_contentTemplate'));
                expect(Buffer.from(String(stored?.content?.[0]?.data?.code ?? ''), 'base64').toString('utf8'), 'the stored template').toBe(template);
            }
        });
    }

    test('a PUT changes the description and the attributes, and name, kind and connector stay', rowMeta('e', 'PUT changes description / attributes only', ['email-provider']), async ({ api, own }) => {
        const connector = await connectorOf(api, 'EMAIL');
        const defs = await instanceDefinitions(api, connector);
        const instance = await createOwnInstance(api, own.spec, 'wf19-put', { connector, description: 'before', attributes: emailAttributes(defs, { sender: reservedSender(), subject: 'before', template: EMAIL_TEMPLATE }) });
        const sender = reservedSender('sender2');
        const sent = await putOwnInstance(api, instance, {
            description: 'after',
            attributes: emailAttributes(defs, { sender, subject: 'after', template: EMAIL_TEMPLATE }),
            attributeMappings: [],
            // name / kind / connector in the body are ignored by the platform: the update takes them from the stored reference.
        });
        expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
        const detail = (await getInstance(api, instance.uuid)).json;
        expect(detail).toMatchObject({ uuid: instance.uuid, name: instance.name, kind: 'EMAIL', connectorUuid: connector.uuid, description: 'after' });
        expect(attrContent(detail, 'data_senderEmailAddress')?.data).toBe(sender);
        expect(attrContent(detail, 'data_emailSubject')?.data).toBe('after');
    });

    test('the mapping attributes of EMAIL name the recipient address, those of WEBHOOK are empty', rowMeta('f', 'mapping attributes per kind', ['email-provider', 'webhook-provider']), async ({ api }) => {
        const email = await connectorOf(api, 'EMAIL');
        const mail = await getMappingAttributes(api, email);
        expect(mail.status, mail.text.slice(0, 200)).toBe(200);
        const recipient = (mail.json as Json[]).find((a) => a.name === 'data_recipientEmailAddress');
        expect(recipient, 'EMAIL offers data_recipientEmailAddress').toBeTruthy();
        expect(recipient!.contentType).toBe('string');
        expect(recipient!.properties).toMatchObject({ list: true, multiSelect: true, required: false });
        const webhook = await connectorOf(api, 'WEBHOOK');
        const hook = await getMappingAttributes(api, webhook);
        expect(hook.status, hook.text.slice(0, 200)).toBe(200);
        expect(hook.json, 'WEBHOOK has no mapping attributes').toEqual([]);
    });
});
