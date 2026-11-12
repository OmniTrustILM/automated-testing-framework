/**
 * REG-WFL-27 — A webhook without a template sends the raw body (local stack). ilm#434.
 *
 * WHAT: 1. A trigger on an own group sends one webhook notification profile (content type RAW_JSON, no template); an own certificate of the
 *          group is revoked → the receiver gets a delivery.
 *       2. The delivery is a POST with Content-Type application/json, an X-Webhook-Timestamp in epoch milliseconds near now and an
 *          X-Webhook-Nonce that is the Base64 of a UUID; no signature or HMAC header exists.
 *       3. The body keys are exactly recipients, eventType, event, resource and notificationData, with no `objectData`; event and legacy
 *          event type are `certificate_status_changed`.
 *       4. A second revoke of another own certificate delivers again, and its nonce differs from the first.
 * WHY: the raw body and headers are the contract of webhook consumers; the key set and value types come from the rules, not from a
 *      baseline, and the documented shape has no signature.
 * HOW: `@local:notif` (a runner-hosted receiver reached through a dotted alias, REG_WEBHOOK_HOST). The receiver is closed in a `finally`;
 *      the instance, profile, group, trigger and certificates are own and recorded before any assertion. The needs `webhook-receiver`,
 *      `webhook-provider` and `ca` are resolved before the test runs.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { WebhookReceiver } from '../../../utils/regression/events/notificationCatchers';
import { armGroup, buildRig, fire } from '../../../utils/regression/events/notificationDeliveryFixtures';
import { createOwnInstance } from '../../../utils/regression/events/notificationInstances';
import { createOwnProfile } from '../../../utils/regression/events/notificationProfiles';
import { findNotificationConnector, instanceDefinitions } from '../../../utils/regression/events/notificationConnector';
import { webhookAttributes } from '../../../utils/regression/events/notificationAttributes';
import { describeLocalOnly } from '../../../utils/regression/tier/localProof';
import { testMeta, tags } from '../../../utils/regression/tags';
import { DELIVERY_WAIT_MS, EVENT_DELIVERY_MS, WEBHOOK_CLOCK_TOLERANCE_MS } from '../../../utils/regression/timeouts';
import { ownName } from '../../../utils/regression/ledger/runState';

const GOLDEN_KEYS = ['event', 'eventType', 'notificationData', 'recipients', 'resource'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test.describe('Webhook raw body, headers, no signature', { tag: tags.regression }, () => {
    describeLocalOnly(test);

    test('the raw body has the documented keys and the headers carry a timestamp and a nonce, no signature',
        testMeta({
            id: 'REG-WFL-27', prio: 'P2', issue: 'ilm#434', local: true, phaseB: true, needs: ['webhook-receiver', 'webhook-provider', 'ca'],
            rule: ['notify request: recipients, eventType, event, resource, notificationData; headers Content-Type, X-Webhook-Timestamp, X-Webhook-Nonce, NO signature / HMAC; objectData omitted when no category', 'ilm#434 steps 5 and 6; the documented shape has no signature header'],
        }),
        async ({ api, own }) => {
            test.setTimeout(EVENT_DELIVERY_MS);
            // present and healthy: the `webhook-provider` need is resolved before the test body
            const connector = (await findNotificationConnector(api, 'WEBHOOK'))!;
            const receiver = await WebhookReceiver.start();
            try {
                const marker = ownName('wf27');
                const instance = await createOwnInstance(api, own.spec, 'wf27-inst', { connector, attributes: webhookAttributes(await instanceDefinitions(api, connector), { url: receiver.url(marker), contentType: 'RAW_JSON' }) });
                const profile = await createOwnProfile(api, own.spec, 'wf27-prof', { recipientType: 'default', instance });

                const deliveries = [];
                for (const n of [1, 2]) {
                    const rig = await buildRig(api, own.spec, `wf27-${n}`);
                    const armed = await armGroup(api, own.spec, rig, `wf27-${n}`, [profile]);
                    const row = await fire(api, rig, armed);
                    expect({ matched: row.conditionsMatched, records: row.records.map((x) => x.message) }, `delivery ${n}: matched, no failure record`).toEqual({ matched: true, records: [] });
                    deliveries.push((await receiver.waitForRequests(marker, n, DELIVERY_WAIT_MS))[n - 1]);
                }

                const nonces = new Set<string>();
                for (const [i, d] of deliveries.entries()) {
                    await test.step(`Delivery ${i + 1}: method, headers and body`, async () => {
                        expect(d.method, 'the webhook is a POST').toBe('POST');
                        expect(d.headers['content-type'], 'the raw body is sent as JSON').toMatch(/^application\/json/);
                        const ts = Number(d.headers['x-webhook-timestamp']);
                        expect(Number.isFinite(ts), 'X-Webhook-Timestamp is epoch milliseconds').toBe(true);
                        expect(Math.abs(Date.now() - ts), 'the timestamp is within the clock tolerance of now').toBeLessThan(WEBHOOK_CLOCK_TOLERANCE_MS);
                        const nonce = Buffer.from(String(d.headers['x-webhook-nonce'] ?? ''), 'base64').toString('utf8');
                        expect(nonce, 'X-Webhook-Nonce is the Base64 of a UUID string').toMatch(UUID_RE);
                        nonces.add(d.headers['x-webhook-nonce']);
                        expect(Object.keys(d.headers).filter((h) => /signature|hmac/i.test(h)), 'no signature header exists').toEqual([]);
                        const body = JSON.parse(d.body) as Record<string, unknown>;
                        expect(Object.keys(body).sort(), 'the raw body keys').toEqual(GOLDEN_KEYS);
                        expect(body, 'no objectData without an event data category').not.toHaveProperty('objectData');
                        expect(body.eventType, 'legacy event type').toBe('certificate_status_changed');
                        expect(body.event, 'the event code').toBe('certificate_status_changed');
                        expect(Array.isArray(body.recipients), 'recipients is a list').toBe(true);
                        expect(typeof body.notificationData, 'notificationData is an object').toBe('object');
                        test.info().annotations.push({ type: `resource-type-${i + 1}`, description: typeof body.resource });
                    });
                }
                expect(nonces.size, 'the nonce differs on the second delivery').toBe(2);
            } finally {
                await receiver.close();
            }
        });
});
