/**
 * API-WFL-19 — create notification instances (e-mail; webhook RAW_JSON, JSON, XML), read them back, edit them (ilm#434 steps 1–2;
 * T10 R1, R2, R4, R9, R53, R54, R58; N-01, N-02, N-10, N-11).
 *
 * Nothing is delivered: an instance is created at the connector and stored in core, no workflow trigger fires it, and the sender and
 * URL are reserved test names (`…@example.test`, `https://<run>.example.test/hook`: RFC 6761). The connector attributes are built
 * from the connector's live definitions (utils/regression/notificationApi.ts). `@needs:email-provider` / `@needs:webhook-provider`:
 * a tier without a healthy connector skips the row with the named deploy gate (the QA automation environment has none).
 *
 *   a  EMAIL                    201 → detail returns the sent attributes
 *   b  WEBHOOK RAW_JSON         no template attribute
 *   c  WEBHOOK JSON + template  the template attribute of the content type (derived name and uuid, see notificationApi)
 *   d  WEBHOOK XML + template
 *   e  PUT of each              description and attributes change; name, kind and connector stay (R4)
 *   f  mapping attributes       EMAIL → `data_recipientEmailAddress` (STRING, list, multi select, not required); WEBHOOK → []
 * The `attributeMappings` leg of e (a mapping names the connector's mapping attribute by its definition uuid, which the guard
 * cannot prove own) is `test.fixme` — guard request G-3 in the events-area patches README.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnCustomAttribute } from '../../utils/regression/eventsDrivers';
import {
    createOwnInstance, EMAIL_TEMPLATE, emailAttributes, findNotificationConnector, getInstance, getMappingAttributes, instanceDefinitions, NotificationConnector, NotificationKind,
    putOwnInstance, reservedSender, reservedWebhookUrl, WEBHOOK_JSON_TEMPLATE, WEBHOOK_XML_TEMPLATE, webhookAttributes, WebhookContentType,
} from '../../utils/regression/notificationApi';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-WFL-19';
type Api = Parameters<typeof findNotificationConnector>[0];
type Json = Record<string, any>;

async function connectorOrSkip(api: Api, kind: NotificationKind): Promise<NotificationConnector> {
    const c = await findNotificationConnector(api, kind);
    test.skip(!c, `deploy gate: no connected ${kind} notification connector registered on this tier (@needs:${kind === 'EMAIL' ? 'email' : 'webhook'}-provider)`);
    test.skip(!!c?.unhealthy, `deploy gate: the ${kind} notification connector ${c?.name} is not healthy (${c?.unhealthy})`);
    return c!;
}

const attrContent = (detail: Json, name: string): any => (detail.attributes ?? []).find((a: Json) => a.name === name)?.content?.[0];

test.describe('API-WFL-19 notification instances: create, read back, edit', { tag: tags.api }, () => {
    const m = (row: string, rule: string, needs: string[]) =>
        meta({ id: 'API-WFL-19', prio: 'P1', issue: 'ilm#434', needs, rule: [`T10 B1 / B7 (R1–R4, R9, R53, R54, R58): P-N19 row ${row}: ${rule}`] });

    test('API-WFL-19[a]: an EMAIL instance is created and read back with its attributes', m('a', 'EMAIL instance, detail returns the sent attributes', ['email-provider']), async ({ api }) => {
        const connector = await connectorOrSkip(api, 'EMAIL');
        const sender = reservedSender();
        const instance = await createOwnInstance(api, SPEC, { suffix: 'wf19-mail', connector, attributes: emailAttributes(await instanceDefinitions(api, connector), { sender, subject: 'QA API-WFL-19', template: EMAIL_TEMPLATE }) });
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
        test(`API-WFL-19[${row}]: a WEBHOOK instance of content type ${contentType} is created and read back`, m(row, `WEBHOOK ${contentType}`, ['webhook-provider']), async ({ api }) => {
            const connector = await connectorOrSkip(api, 'WEBHOOK');
            const url = reservedWebhookUrl();
            const instance = await createOwnInstance(api, SPEC, {
                suffix: `wf19-hook-${row}`, connector,
                attributes: webhookAttributes(await instanceDefinitions(api, connector), { url, contentType, ...(template ? { template } : {}) }),
            });
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

    test('API-WFL-19[e]: a PUT changes the description and the attributes; name, kind and connector stay (R4)', m('e', 'PUT changes description / attributes only', ['email-provider']), async ({ api }) => {
        const connector = await connectorOrSkip(api, 'EMAIL');
        const defs = await instanceDefinitions(api, connector);
        const instance = await createOwnInstance(api, SPEC, { suffix: 'wf19-put', connector, description: 'before', attributes: emailAttributes(defs, { sender: reservedSender(), subject: 'before', template: EMAIL_TEMPLATE }) });
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

    test.fixme('API-WFL-19[e-mappings]: guard request G-3: an instance PUT with an attribute mapping names the connector\'s mapping attribute by its definition uuid',
        m('e', 'attribute mappings', ['email-provider']),
        async ({ api }) => {
            // Full body (to run once the guard accepts `attributeMappings[].mappingAttributeUuid` as a reference to a connector attribute definition):
            const connector = await connectorOrSkip(api, 'EMAIL');
            const defs = await instanceDefinitions(api, connector);
            const mapping = ((await getMappingAttributes(api, connector)).json as Json[])[0];
            const instance = await createOwnInstance(api, SPEC, { suffix: 'wf19-map', connector, attributes: emailAttributes(defs, { sender: reservedSender(), subject: 'map', template: EMAIL_TEMPLATE }) });
            const attr = await createOwnCustomAttribute(api, SPEC, { suffix: 'wf19-map-attr', resources: ['certificates'] });
            const sent = await putOwnInstance(api, instance, {
                description: 'mapped', attributes: emailAttributes(defs, { sender: reservedSender(), subject: 'map', template: EMAIL_TEMPLATE }),
                attributeMappings: [{ mappingAttributeUuid: mapping.uuid, mappingAttributeName: mapping.name, customAttributeUuid: attr.uuid, customAttributeLabel: attr.name }],
            });
            expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
            const detail = (await getInstance(api, instance.uuid)).json;
            expect(detail.attributeMappings).toEqual([expect.objectContaining({ mappingAttributeName: mapping.name, customAttributeUuid: attr.uuid })]);
        });

    test('API-WFL-19[f]: the mapping attributes of EMAIL name the recipient address, those of WEBHOOK are empty', m('f', 'mapping attributes per kind', ['email-provider', 'webhook-provider']), async ({ api }) => {
        const email = await connectorOrSkip(api, 'EMAIL');
        const mail = await getMappingAttributes(api, email);
        expect(mail.status, mail.text.slice(0, 200)).toBe(200);
        const recipient = (mail.json as Json[]).find((a) => a.name === 'data_recipientEmailAddress');
        expect(recipient, 'EMAIL offers data_recipientEmailAddress').toBeTruthy();
        expect(recipient!.contentType).toBe('string');
        expect(recipient!.properties).toMatchObject({ list: true, multiSelect: true, required: false });
        const webhook = await connectorOrSkip(api, 'WEBHOOK');
        const hook = await getMappingAttributes(api, webhook);
        expect(hook.status, hook.text.slice(0, 200)).toBe(200);
        expect(hook.json, 'WEBHOOK has no mapping attributes').toEqual([]);
    });
});
