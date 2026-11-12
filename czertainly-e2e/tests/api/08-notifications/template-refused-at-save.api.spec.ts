/**
 * API-WFL-21 — Notification templates are refused at save. ilm#434.
 *
 * WHAT: 1. An e-mail template with a syntax error (unclosed ${), a value escaped with ?html, the ?new built-in or an empty template → 422
 *          with a readable message naming the cause.
 *       2. A webhook JSON or XML template with a syntax error, the ?new built-in, a template that is not Base64 or is missing → 422.
 *       3. A template that parses but names a missing variable is ACCEPTED (201): it fails at send, which is the subject of
 *          tests/regression/13-workflows-and-notifications/29-broken-template-fails-at-send.spec.ts.
 *       Every refused row answers a 422, never a 5xx, and a list by name shows no instance.
 * WHY: a template that cannot be parsed must be rejected when the instance is saved (email-notification-provider#72 and its PR #80,
 *      webhook-notification-provider#38 and its PR #48), not at send time and not with a 500. These rows re-test those fixes: they are
 *      plain tests, not `test.fail()`, so a connector build older than those PRs fails a row legitimately.
 * HOW: `@needs:email-provider` / `@needs:webhook-provider`; a missing or unhealthy provider skips with the named deploy gate. Nothing is
 *      delivered. A refused create that persisted something is recorded in the ledger before the assertion fails; the only instances
 *      created on purpose are the
 *      two of the accepted-template row (own, run-prefixed, reserved sender and URL).
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { codeBlock, emailAttributes, requestAttribute, reservedSender, reservedWebhookUrl, webhookAttributes, webhookTemplateAttribute } from '../../../utils/regression/events/notificationAttributes';
import { createOwnInstance, getInstance, instanceBody, mentions, probeInstance } from '../../../utils/regression/events/notificationInstances';
import { findNotificationConnector, instanceDefinitions, NotificationConnector, NotificationKind } from '../../../utils/regression/events/notificationConnector';
import { recordNamed } from '../../../utils/regression/events/notificationProfiles';
import { expectRefused } from '../../../utils/regression/errorContract';
import { testMeta, tags, type Needs } from '../../../utils/regression/tags';
import { ownName } from '../../../utils/regression/ledger/runState';
import { ApiAnswer } from '../../../utils/regression/apiReads';

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

function expectRefusedAtSave(sent: ApiAnswer): void {
    expect(sent.status, `never a server error: ${sent.text.slice(0, 300)}`).toBeLessThan(500);
    expectRefused(sent, { status: 422, what: 'refused at save' });
}

async function expectNone(api: Api, spec: string, name: string): Promise<void> {
    // A refused create that persisted something is recorded first (ledger before assertion), then the assertion fails.
    expect(await recordNamed(api, 'instances', name, spec), 'a list by name shows no instance').toEqual([]);
}

test.describe('Notification templates are refused at save', { tag: tags.api }, () => {
    const rowMeta = (row: string, rule: string, needs: Needs[]) =>
        testMeta({ id: 'API-WFL-21', prio: 'P1', issue: 'ilm#434', needs, rule: [`templates are validated at save (PR email-notification-provider#80, PR webhook-notification-provider#48), row ${row}: ${rule}`] });

    /** An e-mail instance request whose content template is exactly `code` (an empty string = the connector's "missing" case). */
    async function emailWith(api: Api, connector: NotificationConnector, name: string, template: string): Promise<Json> {
        const defs = await instanceDefinitions(api, connector);
        const base = emailAttributes(defs, { sender: reservedSender(), subject: 'QA API-WFL-21' });
        const def = defs.find((d) => d.name === 'data_emailContentTemplate')!;
        return instanceBody(connector, name, [...base, requestAttribute(def, [{ data: codeBlock('html', template) }])]);
    }

    const emailRefusals: Array<[string, string, string, RegExp]> = [
        ['a', 'a syntax error (unclosed ${)', '<html><body><p>${</p></body></html>', /The email content template cannot be rendered/],
        ['b', 'a value escaped with ?html', '<html><body><p>${event?html}</p></body></html>', /escapes a value with \?html/],
        ['c', 'the ?new built-in', '<html><body><p>${"java.lang.String"?new()}</p></body></html>', /./],
        ['d', 'an empty template', '', /The content template is missing\.|template/i],
    ];
    for (const [row, what, template, text] of emailRefusals) {
        test(`an e-mail template with ${what} is refused at save`, rowMeta(row, `422 for ${what}`, ['email-provider']), async ({ api, own }) => {
            const connector = await connectorOf(api, 'EMAIL');
            const name = ownName(`wf21-${row}`);
            const sent = await probeInstance(api, own.spec, await emailWith(api, connector, name, template));
            expectRefusedAtSave(sent);
            expect(mentions(sent, text), `the message names the cause: ${JSON.stringify(sent.json)}`).toBe(true);
            await expectNone(api, own.spec, name);
        });
    }

    const webhookRefusals: Array<[string, string, 'JSON' | 'XML', string]> = [
        ['e', 'a JSON syntax error', 'JSON', '{"event": ${'],
        ['f', 'an XML syntax error', 'XML', '<notification><event>${</event></notification>'],
        ['h', 'the ?new built-in', 'JSON', '{"event": "${"java.lang.String"?new()}"}'],
    ];
    for (const [row, what, contentType, template] of webhookRefusals) {
        test(`a webhook ${contentType} template with ${what} is refused at save`, rowMeta(row, `422 for ${what} (webhook PR #48)`, ['webhook-provider']), async ({ api, own }) => {
            const connector = await connectorOf(api, 'WEBHOOK');
            const name = ownName(`wf21-${row}`);
            const defs = await instanceDefinitions(api, connector);
            const sent = await probeInstance(api, own.spec, instanceBody(connector, name, webhookAttributes(defs, { url: reservedWebhookUrl(), contentType, template })));
            expectRefusedAtSave(sent);
            await expectNone(api, own.spec, name);
        });
    }

    test('a webhook template that is not Base64, or missing, is refused at save', rowMeta('g', '422 not Base64 / missing', ['webhook-provider']), async ({ api, own }) => {
        const connector = await connectorOf(api, 'WEBHOOK');
        const defs = await instanceDefinitions(api, connector);
        const notBase64: Json = { ...webhookTemplateAttribute('JSON', '{"event":"x"}'), content: [{ data: { language: 'json', code: '***not base64***' } }] };
        const base = webhookAttributes(defs, { url: reservedWebhookUrl(), contentType: 'JSON' });
        for (const [label, attributes] of [['not Base64', [...base, notBase64]], ['missing', base]] as Array<[string, Json[]]>) {
            const name = ownName('wf21-g');
            const sent = await probeInstance(api, own.spec, instanceBody(connector, name, attributes));
            expectRefusedAtSave(sent);
            await expectNone(api, own.spec, name);
            test.info().annotations.push({ type: 'checked', description: `template ${label}: ${sent.status}` });
        }
    });

    test('a template that parses but names a missing variable is ACCEPTED (it fails at send)', rowMeta('i', '201 for ${notificationData.missing}', ['email-provider', 'webhook-provider']), async ({ api, own }) => {
        const email = await connectorOf(api, 'EMAIL');
        const webhook = await connectorOf(api, 'WEBHOOK');
        const mailInstance = await createOwnInstance(api, own.spec, 'wf21-i-mail', { connector: email, attributes: emailAttributes(await instanceDefinitions(api, email), { sender: reservedSender(), subject: 'QA API-WFL-21', template: '<html><body><p>${notificationData.missing}</p></body></html>' }) });
        const hookInstance = await createOwnInstance(api, own.spec, 'wf21-i-hook', { connector: webhook, attributes: webhookAttributes(await instanceDefinitions(api, webhook), { url: reservedWebhookUrl(), contentType: 'JSON', template: '{"missing": "${notificationData.missing}"}' }) });
        for (const i of [mailInstance, hookInstance]) expect((await getInstance(api, i.uuid)).status, 'the instance exists').toBe(200);
        // Nothing here sends a notification: the failure at send is the subject of
        // 13-workflows-and-notifications/29-broken-template-fails-at-send.spec.ts (local-stack notification rows).
    });
});
