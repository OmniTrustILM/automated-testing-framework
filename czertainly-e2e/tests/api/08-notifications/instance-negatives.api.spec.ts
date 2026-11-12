/**
 * API-WFL-20 — Notification instance negatives: a refused create leaves no instance behind. ilm#434.
 *
 * WHAT: 1. A second instance with the name of an existing one → 409 "Object of type 'NotificationInstanceReference' identified by <name>
 *          already exists."; exactly the first instance carries the name.
 *       2. An unknown connector → 404 naming the uuid; an unsupported kind → 422 "Unsupported kind <kind>".
 *       3. An e-mail instance without its sender, subject or template → 422 naming the attribute; a sender that is not an address and a
 *          webhook URL with a scheme other than http(s) → 422 "Value <value> of attribute <label> doesn't match regex <pattern>".
 *       4. A webhook without its URL or without its content type → 422 naming the attribute.
 *       After every refusal a list by name shows nothing was created.
 * WHY: core validates the attribute values against the connector's definitions and the connector validates the rest; the answers are fixed
 *      texts (a 422 is a JSON array of strings, 409 and 404 carry {message}). Attribute-missing texts are asserted as "names the attribute"
 *      because core's attribute engine words them.
 * HOW: needs an e-mail and a webhook notification provider (`@needs:email-provider` / `@needs:webhook-provider`); a missing or unhealthy
 *      provider skips with the named deploy gate. The only object created is the seed instance of the duplicate row (recorded in the
 *      ledger); a refused create
 *      that persisted something is recorded before the assertion fails. The empty-name probe is NOT sent because it may leave an orphan at
 *      the connector. Senders and URLs are reserved test names.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { attributeLabel, EMAIL_TEMPLATE, emailAttributes, reservedSender, reservedWebhookUrl, webhookAttributes } from '../../../utils/regression/events/notificationAttributes';
import { createOwnInstance, instanceBody, listInstances, mentions, probeInstance } from '../../../utils/regression/events/notificationInstances';
import { findNotificationConnector, instanceDefinitions, NotificationConnector, NotificationKind } from '../../../utils/regression/events/notificationConnector';
import { recordNamed } from '../../../utils/regression/events/notificationProfiles';
import { escapeRegExp } from '../../../utils/regression/text';
import { errorShapeOf } from '../../../utils/regression/events/workflowRequests';
import { testMeta, tags, type Needs } from '../../../utils/regression/tags';
import { checkedDnsName, ownName } from '../../../utils/regression/ledger/runState';
import { ApiAnswer } from '../../../utils/regression/apiReads';

type Api = Parameters<typeof findNotificationConnector>[0];

/**
 * The notification connector of a kind. The row's declared need (`email-provider` / `webhook-provider`) has already skipped the test
 * when there is none.
 */
async function connectorOf(api: Api, kind: NotificationKind): Promise<NotificationConnector> {
    const connector = await findNotificationConnector(api, kind);
    expect(connector, `the ${kind} notification connector the declared need resolved`).toBeTruthy();
    return connector!;
}

async function expectNone(api: Api, spec: string, name: string): Promise<void> {
    // A refused create that persisted something is recorded first (ledger before assertion), then the assertion fails.
    expect(await recordNamed(api, 'instances', name, spec), 'a list by name shows nothing new').toEqual([]);
}

function expect422(sent: ApiAnswer): void {
    expect(sent.status, `refused with 422: ${sent.text.slice(0, 300)}`).toBe(422);
    expect(errorShapeOf(sent), '422 is a JSON array of strings').toBe('array');
}

test.describe('Notification instance negatives (nothing created)', { tag: tags.api }, () => {
    const rowMeta = (row: string, rule: string, needs: Needs[]) => testMeta({ id: 'API-WFL-20', prio: 'P1', issue: 'ilm#434', needs, rule: [rule] });

    test('a second instance with the name of an existing one is refused with 409', rowMeta('a', '409 already exists', ['email-provider']), async ({ api, own }) => {
        const connector = await connectorOf(api, 'EMAIL');
        const defs = await instanceDefinitions(api, connector);
        const attrs = emailAttributes(defs, { sender: reservedSender(), subject: 'seed', template: EMAIL_TEMPLATE });
        const seed = await createOwnInstance(api, own.spec, 'wf20-seed', { connector, attributes: attrs });
        const sent = await probeInstance(api, own.spec, instanceBody(connector, seed.name, attrs));
        expect(sent.status, sent.text.slice(0, 300)).toBe(409);
        expect(errorShapeOf(sent)).toBe('message');
        expect(sent.json.message).toBe(`Object of type 'NotificationInstanceReference' identified by ${seed.name} already exists.`);
        expect((await listInstances(api)).filter((i) => i.name === seed.name).map((i) => i.uuid), 'exactly the seed instance carries the name').toEqual([seed.uuid]);
    });

    test('an unknown connector is refused with 404', rowMeta('b', '404 unknown connector', ['email-provider']), async ({ api, own }) => {
        const connector = await connectorOf(api, 'EMAIL');
        const attrs = emailAttributes(await instanceDefinitions(api, connector), { sender: reservedSender(), subject: 'x', template: EMAIL_TEMPLATE });
        const name = ownName('wf20-b');
        const unknown = api.probeUuid();
        const sent = await probeInstance(api, own.spec, instanceBody({ ...connector, uuid: unknown }, name, attrs));
        expect(sent.status, sent.text.slice(0, 300)).toBe(404);
        expect(mentions(sent, unknown), 'the answer names the connector uuid').toBe(true);
        await expectNone(api, own.spec, name);
    });

    test('an unsupported kind is refused with 422', rowMeta('c', '422 Unsupported kind', ['email-provider']), async ({ api, own }) => {
        const connector = await connectorOf(api, 'EMAIL');
        const attrs = emailAttributes(await instanceDefinitions(api, connector), { sender: reservedSender(), subject: 'x', template: EMAIL_TEMPLATE });
        const name = ownName('wf20-c');
        const sent = await probeInstance(api, own.spec, instanceBody(connector, name, attrs, { kind: 'FAX' }));
        expect422(sent);
        expect(mentions(sent, 'Unsupported kind FAX'), JSON.stringify(sent.json)).toBe(true);
        await expectNone(api, own.spec, name);
    });

    type Values = Parameters<typeof emailAttributes>[1];
    const missing: Array<[string, string, (sender: string) => Values, RegExp]> = [
        ['d', 'sender', () => ({ subject: 'x', template: EMAIL_TEMPLATE }), /sender|data_senderEmailAddress/i],
        ['e', 'subject', (sender) => ({ sender, template: EMAIL_TEMPLATE }), /subject|data_emailSubject/i],
        ['f', 'template', (sender) => ({ sender, subject: 'x' }), /template|data_emailContentTemplate/i],
    ];
    for (const [row, what, values, text] of missing) {
        test(`an e-mail instance without its ${what} is refused with 422`, rowMeta(row, `422 ${what} missing`, ['email-provider']), async ({ api, own }) => {
            const connector = await connectorOf(api, 'EMAIL');
            const defs = await instanceDefinitions(api, connector);
            const name = ownName(`wf20-${row}`);
            const sent = await probeInstance(api, own.spec, instanceBody(connector, name, emailAttributes(defs, values(reservedSender()))));
            expect422(sent);
            expect(mentions(sent, text), `the refusal names the ${what}: ${JSON.stringify(sent.json)}`).toBe(true);
            await expectNone(api, own.spec, name);
        });
    }

    test('a sender that is not an address is refused with 422', rowMeta('g', "422 <value> of attribute <label> doesn't match regex", ['email-provider']), async ({ api, own }) => {
        const connector = await connectorOf(api, 'EMAIL');
        const name = ownName('wf20-g');
        const defs = await instanceDefinitions(api, connector);
        const sent = await probeInstance(api, own.spec, instanceBody(connector, name, emailAttributes(defs, { sender: 'not-an-address', subject: 'x', template: EMAIL_TEMPLATE })));
        expect422(sent);
        // Core validates the value against the attribute's regexp constraint: "Value <value> of attribute <label> doesn't match regex
        // <pattern>".
        const label = attributeLabel(defs, 'data_senderEmailAddress');
        expect(mentions(sent, new RegExp(`of attribute ${escapeRegExp(label)} doesn't match regex`)), `the sender regexp refusal names "${label}": ${JSON.stringify(sent.json)}`).toBe(true);
        await expectNone(api, own.spec, name);
    });

    test('a webhook URL with another scheme than http(s) is refused with 422', rowMeta('h', "422 <value> of attribute <label> doesn't match regex", ['webhook-provider']), async ({ api, own }) => {
        const connector = await connectorOf(api, 'WEBHOOK');
        const name = ownName('wf20-h');
        const defs = await instanceDefinitions(api, connector);
        const sent = await probeInstance(api, own.spec, instanceBody(connector, name, webhookAttributes(defs, { url: `ftp://${checkedDnsName(`${ownName('x')}.example.test`)}/hook`, contentType: 'RAW_JSON' })));
        expect422(sent);
        const label = attributeLabel(defs, 'data_webhookUrl');
        expect(mentions(sent, new RegExp(`of attribute ${escapeRegExp(label)} doesn't match regex`)), `the URL regexp refusal names "${label}": ${JSON.stringify(sent.json)}`).toBe(true);
        await expectNone(api, own.spec, name);
    });

    test('a webhook without its URL is refused with 422', rowMeta('i', '422 URL missing', ['webhook-provider']), async ({ api, own }) => {
        const connector = await connectorOf(api, 'WEBHOOK');
        const name = ownName('wf20-i');
        const sent = await probeInstance(api, own.spec, instanceBody(connector, name, webhookAttributes(await instanceDefinitions(api, connector), { contentType: 'RAW_JSON' })));
        expect422(sent);
        expect(mentions(sent, /webhook ?url|data_webhookUrl/i), JSON.stringify(sent.json)).toBe(true);
        await expectNone(api, own.spec, name);
    });

    test('a webhook without its content type is refused with 422', rowMeta('j', '422 content type missing', ['webhook-provider']), async ({ api, own }) => {
        const connector = await connectorOf(api, 'WEBHOOK');
        const name = ownName('wf20-j');
        const sent = await probeInstance(api, own.spec, instanceBody(connector, name, webhookAttributes(await instanceDefinitions(api, connector), { url: reservedWebhookUrl() })));
        expect422(sent);
        expect(mentions(sent, /content ?type|data_contentType/i), JSON.stringify(sent.json)).toBe(true);
        await expectNone(api, own.spec, name);
    });
});
