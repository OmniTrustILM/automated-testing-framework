/**
 * REG-WFL-27 — webhook delivery WITHOUT a template: the raw body keeps the documented shape, the headers are exactly a timestamp and a
 * nonce, and there is NO signature (ilm#434 steps 5, 6; T10 R34, R59, R63, E3; D-02; "not covered: signature headers"). `@local:notif`
 * (a runner-hosted receiver reached through a dotted alias, REG_WEBHOOK_HOST; the instance URL is the receiver's), `@phaseB`
 * (repeated on the migrated connectors).
 *
 * Two deliveries from two revokes of own certificates (own group scope, one trigger sending one RAW_JSON webhook profile):
 *   body keys EXACTLY {recipients, eventType, event, resource, notificationData}, no `objectData` (T10 R63: categories off → absent);
 *   `eventType` is the legacy `certificate_status_changed`, `event` the event code; value types: recipients array, eventType / event
 *   string, notificationData object (the `resource` type is annotated: string or object); the key set and value types are the golden
 *   shape defined in this spec (volatile values masked), taken from the rules, not from a baseline capture;
 *   headers: `Content-Type: application/json`, `X-Webhook-Timestamp` epoch milliseconds within a minute of now,
 *   `X-Webhook-Nonce` the Base64 of a UUID string and DIFFERENT on the second delivery; NO header whose name contains "signature"
 *   or "hmac" (the plan's "signature headers" do not exist: timestamp and nonce only).
 * The webhook is fire-and-forget (R61); the receiver answers 204. Reserved names only.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { WebhookReceiver, webhookReceiverProblem } from '../../utils/regression/catchers';
import { armGroup, buildRig, fire } from '../../utils/regression/notifRig';
import { createOwnInstance, createOwnProfile, findNotificationConnector, instanceDefinitions, webhookAttributes } from '../../utils/regression/notificationApi';
import { describeLocal } from '../../utils/regression/tier';
import { wfName } from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-WFL-27';
const GOLDEN_KEYS = ['event', 'eventType', 'notificationData', 'recipients', 'resource'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test.describe('@regression REG-WFL-27 webhook raw body, headers, no signature', () => {
    describeLocal(test);
    let receiver: WebhookReceiver | undefined;
    test.afterEach(async () => {
        await receiver?.close();
        receiver = undefined;
    });

    test('REG-WFL-27: the raw body has the documented keys, the headers are a timestamp and a nonce, and no signature exists',
        meta({
            id: 'REG-WFL-27', prio: 'P1', issue: 'ilm#434', local: true, phaseB: true, needs: ['webhook-receiver', 'webhook-provider'],
            rule: ['T10 R34 (notify request: recipients, eventType, event, resource, notificationData), R59 (headers Content-Type, X-Webhook-Timestamp, X-Webhook-Nonce; NO signature / HMAC), R63 (objectData omitted when no category)', 'ilm#434 steps 5, 6 and "not covered: signature headers"; D-02, E3'],
        }),
        async ({ api }) => {
            test.setTimeout(900_000);
            const problem = webhookReceiverProblem();
            test.skip(!!problem, problem ?? '');
            const connector = await findNotificationConnector(api, 'WEBHOOK');
            test.skip(!connector || !!connector.unhealthy, 'deploy gate: no healthy webhook notification connector on this stack (@needs:webhook-provider)');
            receiver = await WebhookReceiver.start();
            const marker = wfName('wf27');
            const instance = await createOwnInstance(api, SPEC, {
                suffix: 'wf27-inst', connector: connector!, attributes: webhookAttributes(await instanceDefinitions(api, connector!), { url: receiver.url(marker), contentType: 'RAW_JSON' }),
            });
            const profile = await createOwnProfile(api, SPEC, { suffix: 'wf27-prof', recipientType: 'default', instance });

            const deliveries = [];
            for (const n of [1, 2]) {
                const rig = await buildRig(api, SPEC, `wf27-${n}`, (reason) => test.skip(true, reason));
                const armed = await armGroup(api, SPEC, rig, `wf27-${n}`, [profile]);
                const row = await fire(api, rig, armed);
                expect({ matched: row.conditionsMatched, records: row.records.map((x) => x.message) }, `delivery ${n}: matched, no failure record`).toEqual({ matched: true, records: [] });
                deliveries.push((await receiver.waitForRequests(marker, n, 120_000))[n - 1]);
            }

            const nonces = new Set<string>();
            for (const [i, d] of deliveries.entries()) {
                await test.step(`Delivery ${i + 1}: method, headers and body`, async () => {
                    expect(d.method).toBe('POST');
                    expect(d.headers['content-type']).toMatch(/^application\/json/);
                    const ts = Number(d.headers['x-webhook-timestamp']);
                    expect(Number.isFinite(ts), 'X-Webhook-Timestamp is epoch milliseconds').toBe(true);
                    expect(Math.abs(Date.now() - ts), 'the timestamp is within a minute of now').toBeLessThan(60_000 + 5 * 60_000);
                    const nonce = Buffer.from(String(d.headers['x-webhook-nonce'] ?? ''), 'base64').toString('utf8');
                    expect(nonce, 'X-Webhook-Nonce is the Base64 of a UUID string').toMatch(UUID_RE);
                    nonces.add(d.headers['x-webhook-nonce']);
                    expect(Object.keys(d.headers).filter((h) => /signature|hmac/i.test(h)), 'no signature header exists').toEqual([]);
                    const body = JSON.parse(d.body) as Record<string, unknown>;
                    expect(Object.keys(body).sort(), 'the raw body keys').toEqual(GOLDEN_KEYS);
                    expect(body).not.toHaveProperty('objectData');
                    expect(body.eventType, 'legacy event type').toBe('certificate_status_changed');
                    expect(body.event).toBe('certificate_status_changed');
                    expect(Array.isArray(body.recipients)).toBe(true);
                    expect(typeof body.notificationData).toBe('object');
                    test.info().annotations.push({ type: `resource-type-${i + 1}`, description: typeof body.resource });
                });
            }
            expect(nonces.size, 'the nonce differs on the second delivery').toBe(2);
        });
});
