/**
 * API-WFL-21 — a template that cannot be parsed is refused AT SAVE with a 422 and a readable message, never a 500
 * (ilm#434 steps 10–11, the save side; T10 R55, R62, E5; D-05; email-notification-provider#72 / PR #80; webhook-notification-
 * provider#38 fixed by PR #48 — a RE-TEST, not a `test.fail()`). Rows of the plan's table P-N21:
 *   a  e-mail, syntax error (an unclosed `${`)       422 "The email content template cannot be rendered: …" with line and column
 *   b  e-mail, a value escaped with `?html`          422 "…escapes a value with ?html, which is not accepted now that values are
 *                                                     escaped on their way into the email. Remove the ?html. …"
 *   c  e-mail, `?new`                                422 (PR #80)
 *   d  e-mail, empty template                        422 "The content template is missing."
 *   e  webhook JSON, syntax error                    422 with the position (PR #48)
 *   f  webhook XML, syntax error                     422
 *   g  webhook, template not Base64 / missing        422
 *   h  webhook, `?new`                               422
 *   i  both, valid syntax with `${notificationData.missing}`   201 ACCEPTED (it fails at SEND: REG-WFL-29)
 * No row may answer 5xx, and a list by name shows no instance for the refused rows. The connectors on the tier must carry
 * PR #80 / #48: a tier on older builds fails a row legitimately — that is the re-test result and is reported as such, it is not
 * quarantined. `@needs:email-provider` / `@needs:webhook-provider`; nothing is delivered (reserved sender and URL).
 */
import { expect, test } from '../../fixtures/testFixtures';
import {
    codeBlock, createOwnInstance, emailAttributes, findNotificationConnector, getInstance, instanceBody, instanceDefinitions, listInstances, mentions, recordNamed,
    NotificationConnector, NotificationKind, probeInstance, requestAttribute, reservedSender, reservedWebhookUrl, webhookAttributes, webhookTemplateAttribute,
} from '../../utils/regression/notificationApi';
import { errorShapeOf, Sent, wfName } from '../../utils/regression/workflowApi';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-WFL-21';
type Api = Parameters<typeof findNotificationConnector>[0];
type Json = Record<string, any>;

async function connectorOrSkip(api: Api, kind: NotificationKind): Promise<NotificationConnector> {
    const c = await findNotificationConnector(api, kind);
    test.skip(!c, `deploy gate: no connected ${kind} notification connector registered on this tier (@needs:${kind === 'EMAIL' ? 'email' : 'webhook'}-provider)`);
    test.skip(!!c?.unhealthy, `deploy gate: the ${kind} notification connector ${c?.name} is not healthy (${c?.unhealthy})`);
    return c!;
}

function expectRefusedAtSave(sent: Sent): void {
    expect(sent.status, `never a server error: ${sent.text.slice(0, 300)}`).toBeLessThan(500);
    expect(sent.status, `refused at save: ${sent.text.slice(0, 300)}`).toBe(422);
    expect(errorShapeOf(sent), '422 is a JSON array of strings').toBe('array');
}

async function expectNone(api: Api, name: string): Promise<void> {
    // A refused create that persisted something is recorded first (ledger before assertion), then the assertion fails.
    expect(await recordNamed(api, 'instances', name, SPEC), 'a list by name shows no instance').toEqual([]);
}

test.describe('API-WFL-21 notification templates are refused at save', { tag: tags.api }, () => {
    const m = (row: string, rule: string, needs: string[]) =>
        meta({ id: 'API-WFL-21', prio: 'P1', issue: 'ilm#434', needs, rule: [`T10 R55 / R62 (templates are validated at save: PR email#80, webhook#48): P-N21 row ${row}: ${rule}`] });

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
        test(`API-WFL-21[${row}]: an e-mail template with ${what} is refused at save`, m(row, `422 for ${what}`, ['email-provider']), async ({ api }) => {
            const connector = await connectorOrSkip(api, 'EMAIL');
            const name = wfName(`wf21-${row}`);
            const sent = await probeInstance(api, await emailWith(api, connector, name, template), SPEC);
            expectRefusedAtSave(sent);
            expect(mentions(sent, text), `the message names the cause: ${JSON.stringify(sent.json)}`).toBe(true);
            await expectNone(api, name);
        });
    }

    const webhookRefusals: Array<[string, string, 'JSON' | 'XML', string]> = [
        ['e', 'a JSON syntax error', 'JSON', '{"event": ${'],
        ['f', 'an XML syntax error', 'XML', '<notification><event>${</event></notification>'],
        ['h', 'the ?new built-in', 'JSON', '{"event": "${"java.lang.String"?new()}"}'],
    ];
    for (const [row, what, contentType, template] of webhookRefusals) {
        test(`API-WFL-21[${row}]: a webhook ${contentType} template with ${what} is refused at save`, m(row, `422 for ${what} (webhook PR #48)`, ['webhook-provider']), async ({ api }) => {
            const connector = await connectorOrSkip(api, 'WEBHOOK');
            const name = wfName(`wf21-${row}`);
            const defs = await instanceDefinitions(api, connector);
            const sent = await probeInstance(api, instanceBody(connector, name, webhookAttributes(defs, { url: reservedWebhookUrl(), contentType, template })), SPEC);
            expectRefusedAtSave(sent);
            await expectNone(api, name);
        });
    }

    test('API-WFL-21[g]: a webhook template that is not Base64, or missing, is refused at save', m('g', '422 not Base64 / missing', ['webhook-provider']), async ({ api }) => {
        const connector = await connectorOrSkip(api, 'WEBHOOK');
        const defs = await instanceDefinitions(api, connector);
        const notBase64: Json = { ...webhookTemplateAttribute('JSON', '{"event":"x"}'), content: [{ data: { language: 'json', code: '***not base64***' } }] };
        const base = webhookAttributes(defs, { url: reservedWebhookUrl(), contentType: 'JSON' });
        for (const [label, attributes] of [['not Base64', [...base, notBase64]], ['missing', base]] as Array<[string, Json[]]>) {
            const name = wfName('wf21-g');
            const sent = await probeInstance(api, instanceBody(connector, name, attributes), SPEC);
            expectRefusedAtSave(sent);
            await expectNone(api, name);
            test.info().annotations.push({ type: 'checked', description: `template ${label}: ${sent.status}` });
        }
    });

    test('API-WFL-21[i]: a template that parses but names a missing variable is ACCEPTED (it fails at send)', m('i', '201 for ${notificationData.missing}', ['email-provider', 'webhook-provider']), async ({ api }) => {
        const email = await connectorOrSkip(api, 'EMAIL');
        const webhook = await connectorOrSkip(api, 'WEBHOOK');
        const mailInstance = await createOwnInstance(api, SPEC, {
            suffix: 'wf21-i-mail', connector: email,
            attributes: emailAttributes(await instanceDefinitions(api, email), { sender: reservedSender(), subject: 'QA API-WFL-21', template: '<html><body><p>${notificationData.missing}</p></body></html>' }),
        });
        const hookInstance = await createOwnInstance(api, SPEC, {
            suffix: 'wf21-i-hook', connector: webhook,
            attributes: webhookAttributes(await instanceDefinitions(api, webhook), { url: reservedWebhookUrl(), contentType: 'JSON', template: '{"missing": "${notificationData.missing}"}' }),
        });
        for (const i of [mailInstance, hookInstance]) expect((await getInstance(api, i.uuid)).status, 'the instance exists').toBe(200);
        // Nothing here sends a notification: the failure at send is the subject of REG-WFL-29 (local-stack notification rows).
    });
});
