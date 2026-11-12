/**
 * API-WFL-19 — Notification instances: create, read back, edit. ilm#434.
 *
 * WHAT: 1. An EMAIL instance is created and read back with its sender, subject and HTML template.
 *       2. A WEBHOOK instance of content type RAW_JSON, JSON or XML is created and read back with its URL, content type and stored
 *          template.
 *       3. A PUT changes the description and the attributes while name, kind and connector stay; a PUT with an attribute mapping names the
 *          connector's mapping attribute by its definition uuid (parked as `test.fixme`).
 *       4. The mapping attributes of EMAIL name the recipient address (list, multi-select, optional); those of WEBHOOK are empty.
 * WHY: an instance is created at the connector and stored in core; the update takes name, kind and connector from the stored reference and
 *      ignores them in the body. The mapping leg stays `test.fixme` until the guard accepts the connector's mapping attribute definition
 *      uuid as a reference.
 * HOW: nothing is delivered: no workflow trigger fires the instance, and the sender and URL are reserved test names (`…@example.test`,
 *      `https://<run>.example.test/hook`, RFC 6761). The connector attributes are built from the connector's live definitions
 *      (utils/regression/events/notificationAttributes.ts); a tier without a healthy provider skips the row with the named deploy gate
 *      (`@needs:email-provider` / `@needs:webhook-provider`). Instances are own objects, recorded in the ledger before the first assertion.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { createOwnCustomAttribute } from '../../../utils/regression/customAttributes';
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

    test.fixme('a PUT with an attribute mapping names the connector\'s mapping attribute by its definition uuid',
        rowMeta('e', 'attribute mappings', ['email-provider']),
        async ({ api, own }) => {
            // Full body, to run once the guard accepts `attributeMappings[].mappingAttributeUuid` as a connector attribute reference:
            const connector = await connectorOf(api, 'EMAIL');
            const defs = await instanceDefinitions(api, connector);
            const mapping = ((await getMappingAttributes(api, connector)).json as Json[])[0];
            const { instance, attr } = await test.step('Own instance and own custom attribute', async () => {
                const made = await createOwnInstance(api, own.spec, 'wf19-map', { connector, attributes: emailAttributes(defs, { sender: reservedSender(), subject: 'map', template: EMAIL_TEMPLATE }) });
                const customAttribute = await createOwnCustomAttribute(api, own.spec, 'wf19-map-attr', { resources: ['certificates'] });
                return { instance: made, attr: customAttribute };
            });
            await test.step('PUT the instance with one attribute mapping', async () => {
                const sent = await putOwnInstance(api, instance, {
                    description: 'mapped', attributes: emailAttributes(defs, { sender: reservedSender(), subject: 'map', template: EMAIL_TEMPLATE }),
                    attributeMappings: [{ mappingAttributeUuid: mapping.uuid, mappingAttributeName: mapping.name, customAttributeUuid: attr.uuid, customAttributeLabel: attr.name }],
                });
                expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
            });
            await test.step('The detail lists the mapping', async () => {
                const detail = (await getInstance(api, instance.uuid)).json;
                expect(detail.attributeMappings, 'the stored mapping names the connector attribute and the custom attribute').toEqual([expect.objectContaining({ mappingAttributeName: mapping.name, customAttributeUuid: attr.uuid })]);
            });
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
