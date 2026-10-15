/**
 * API-WFL-20 — notification instance negatives: nothing is created (ilm#434 step 3; T10 R2, R3, R53, R58, R70; N-03…N-05).
 * Rows of the plan's table P-N20, each answered with the status and text of core / the connector and a list by name afterwards:
 *   a  duplicate name (the own seed instance)  409 "Object of type 'NotificationInstanceReference' identified by <name> already exists."
 *   b  unknown connector                        404, the body names the connector uuid
 *   c  unsupported kind                         422 "Unsupported kind <kind>"
 *   d  sender missing                           422, the list names the sender attribute
 *   e  subject missing                          422, the list names the subject attribute
 *   f  template missing                         422, the list names the template (e-mail provider PR #80: "The content template is missing.")
 *   g  sender `not-an-address`                  422 "Value <v> of attribute <label> doesn't match regex <pattern>" (core, attribute regexp constraint)
 *   h  webhook URL `ftp://…`                    422 the same regexp refusal, naming the URL attribute
 *   i  webhook URL missing                      422, the list names the URL
 *   j  webhook content type missing             422, the list names the content type
 * The empty-name probe (N-06) is NOT sent: it may leave an orphan at the connector (plan §3.4). The attribute-missing texts are
 * asserted as "names the attribute" because core's attribute engine words them, not the connector. `@needs:email-provider` /
 * `@needs:webhook-provider`.
 */
import { expect, test } from '../../fixtures/testFixtures';
import {
    attributeLabel, createOwnInstance, EMAIL_TEMPLATE, emailAttributes, escapeRegExp, findNotificationConnector, instanceBody, instanceDefinitions, listInstances, mentions, recordNamed, NotificationConnector,
    NotificationKind, probeInstance, reservedSender, reservedWebhookUrl, webhookAttributes,
} from '../../utils/regression/notificationApi';
import { errorShapeOf, Sent, wfName } from '../../utils/regression/workflowApi';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-WFL-20';
type Api = Parameters<typeof findNotificationConnector>[0];

async function connectorOrSkip(api: Api, kind: NotificationKind): Promise<NotificationConnector> {
    const c = await findNotificationConnector(api, kind);
    test.skip(!c, `deploy gate: no connected ${kind} notification connector registered on this tier (@needs:${kind === 'EMAIL' ? 'email' : 'webhook'}-provider)`);
    test.skip(!!c?.unhealthy, `deploy gate: the ${kind} notification connector ${c?.name} is not healthy (${c?.unhealthy})`);
    return c!;
}

async function expectNone(api: Api, name: string): Promise<void> {
    // A refused create that persisted something is recorded first (ledger before assertion), then the assertion fails.
    expect(await recordNamed(api, 'instances', name, SPEC), 'a list by name shows nothing new').toEqual([]);
}

function expect422(sent: Sent): void {
    expect(sent.status, `refused with 422: ${sent.text.slice(0, 300)}`).toBe(422);
    expect(errorShapeOf(sent), '422 is a JSON array of strings').toBe('array');
}

test.describe('API-WFL-20 notification instance negatives (nothing created)', { tag: tags.api }, () => {
    const m = (row: string, rule: string, needs: string[]) => meta({ id: 'API-WFL-20', prio: 'P1', issue: 'ilm#434', needs, rule: [`T10 R2 / R3 / R53 / R58 / R70: P-N20 row ${row}: ${rule}`] });

    test('API-WFL-20[a]: a second instance with the name of an existing one is refused with 409', m('a', '409 already exists', ['email-provider']), async ({ api }) => {
        const connector = await connectorOrSkip(api, 'EMAIL');
        const defs = await instanceDefinitions(api, connector);
        const attrs = emailAttributes(defs, { sender: reservedSender(), subject: 'seed', template: EMAIL_TEMPLATE });
        const seed = await createOwnInstance(api, SPEC, { suffix: 'wf20-seed', connector, attributes: attrs });
        const sent = await probeInstance(api, instanceBody(connector, seed.name, attrs), SPEC);
        expect(sent.status, sent.text.slice(0, 300)).toBe(409);
        expect(errorShapeOf(sent)).toBe('message');
        expect(sent.json.message).toBe(`Object of type 'NotificationInstanceReference' identified by ${seed.name} already exists.`);
        expect((await listInstances(api)).filter((i) => i.name === seed.name).map((i) => i.uuid), 'exactly the seed instance carries the name').toEqual([seed.uuid]);
    });

    test('API-WFL-20[b]: an unknown connector is refused with 404', m('b', '404 unknown connector', ['email-provider']), async ({ api }) => {
        const connector = await connectorOrSkip(api, 'EMAIL');
        const attrs = emailAttributes(await instanceDefinitions(api, connector), { sender: reservedSender(), subject: 'x', template: EMAIL_TEMPLATE });
        const name = wfName('wf20-b');
        const unknown = api.probeUuid();
        const sent = await probeInstance(api, instanceBody({ ...connector, uuid: unknown }, name, attrs), SPEC);
        expect(sent.status, sent.text.slice(0, 300)).toBe(404);
        expect(mentions(sent, unknown), 'the answer names the connector uuid').toBe(true);
        await expectNone(api, name);
    });

    test('API-WFL-20[c]: an unsupported kind is refused with 422', m('c', '422 Unsupported kind', ['email-provider']), async ({ api }) => {
        const connector = await connectorOrSkip(api, 'EMAIL');
        const attrs = emailAttributes(await instanceDefinitions(api, connector), { sender: reservedSender(), subject: 'x', template: EMAIL_TEMPLATE });
        const name = wfName('wf20-c');
        const sent = await probeInstance(api, instanceBody(connector, name, attrs, { kind: 'FAX' }), SPEC);
        expect422(sent);
        expect(mentions(sent, 'Unsupported kind FAX'), JSON.stringify(sent.json)).toBe(true);
        await expectNone(api, name);
    });

    type Values = Parameters<typeof emailAttributes>[1];
    const missing: Array<[string, string, (sender: string) => Values, RegExp]> = [
        ['d', 'sender', () => ({ subject: 'x', template: EMAIL_TEMPLATE }), /sender|data_senderEmailAddress/i],
        ['e', 'subject', (sender) => ({ sender, template: EMAIL_TEMPLATE }), /subject|data_emailSubject/i],
        ['f', 'template', (sender) => ({ sender, subject: 'x' }), /template|data_emailContentTemplate/i],
    ];
    for (const [row, what, values, text] of missing) {
        test(`API-WFL-20[${row}]: an e-mail instance without its ${what} is refused with 422`, m(row, `422 ${what} missing`, ['email-provider']), async ({ api }) => {
            const connector = await connectorOrSkip(api, 'EMAIL');
            const defs = await instanceDefinitions(api, connector);
            const name = wfName(`wf20-${row}`);
            const sent = await probeInstance(api, instanceBody(connector, name, emailAttributes(defs, values(reservedSender()))), SPEC);
            expect422(sent);
            expect(mentions(sent, text), `the refusal names the ${what}: ${JSON.stringify(sent.json)}`).toBe(true);
            await expectNone(api, name);
        });
    }

    test('API-WFL-20[g]: a sender that is not an address is refused with 422', m('g', "422 <value> of attribute <label> doesn't match regex", ['email-provider']), async ({ api }) => {
        const connector = await connectorOrSkip(api, 'EMAIL');
        const name = wfName('wf20-g');
        const defs = await instanceDefinitions(api, connector);
        const sent = await probeInstance(api, instanceBody(connector, name, emailAttributes(defs, { sender: 'not-an-address', subject: 'x', template: EMAIL_TEMPLATE })), SPEC);
        expect422(sent);
        // Core validates the value against the attribute's regexp constraint: "Value <value> of attribute <label> doesn't match regex <pattern>".
        const label = attributeLabel(defs, 'data_senderEmailAddress');
        expect(mentions(sent, new RegExp(`of attribute ${escapeRegExp(label)} doesn't match regex`)), `the sender regexp refusal names "${label}": ${JSON.stringify(sent.json)}`).toBe(true);
        await expectNone(api, name);
    });

    test('API-WFL-20[h]: a webhook URL with another scheme than http(s) is refused with 422', m('h', "422 <value> of attribute <label> doesn't match regex", ['webhook-provider']), async ({ api }) => {
        const connector = await connectorOrSkip(api, 'WEBHOOK');
        const name = wfName('wf20-h');
        const defs = await instanceDefinitions(api, connector);
        const sent = await probeInstance(api, instanceBody(connector, name, webhookAttributes(defs, { url: `ftp://${wfName('x')}.example.test/hook`, contentType: 'RAW_JSON' })), SPEC);
        expect422(sent);
        const label = attributeLabel(defs, 'data_webhookUrl');
        expect(mentions(sent, new RegExp(`of attribute ${escapeRegExp(label)} doesn't match regex`)), `the URL regexp refusal names "${label}": ${JSON.stringify(sent.json)}`).toBe(true);
        await expectNone(api, name);
    });

    test('API-WFL-20[i]: a webhook without its URL is refused with 422', m('i', '422 URL missing', ['webhook-provider']), async ({ api }) => {
        const connector = await connectorOrSkip(api, 'WEBHOOK');
        const name = wfName('wf20-i');
        const sent = await probeInstance(api, instanceBody(connector, name, webhookAttributes(await instanceDefinitions(api, connector), { contentType: 'RAW_JSON' })), SPEC);
        expect422(sent);
        expect(mentions(sent, /webhook ?url|data_webhookUrl/i), JSON.stringify(sent.json)).toBe(true);
        await expectNone(api, name);
    });

    test('API-WFL-20[j]: a webhook without its content type is refused with 422', m('j', '422 content type missing', ['webhook-provider']), async ({ api }) => {
        const connector = await connectorOrSkip(api, 'WEBHOOK');
        const name = wfName('wf20-j');
        const sent = await probeInstance(api, instanceBody(connector, name, webhookAttributes(await instanceDefinitions(api, connector), { url: reservedWebhookUrl() })), SPEC);
        expect422(sent);
        expect(mentions(sent, /content ?type|data_contentType/i), JSON.stringify(sent.json)).toBe(true);
        await expectNone(api, name);
    });
});
