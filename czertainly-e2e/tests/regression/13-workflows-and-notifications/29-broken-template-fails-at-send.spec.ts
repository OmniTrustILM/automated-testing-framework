/**
 * REG-WFL-29 — A broken template fails at send (local stack). ilm#434, webhook-notification-provider#38.
 *
 * WHAT: 1. Three own profiles whose templates use a missing variable (an e-mail, a webhook JSON and a webhook XML instance) are sent by one
 *          trigger on one revoke of an own certificate.
 *       2. The trigger row is matched with actions not performed and "Notification sent" No, and has at least one WARN record per profile
 *          ("Validation error in sending notification to connector of notification instance …", not "Error in external notification").
 *       3. Nothing is delivered: the SMTP catcher holds no message and the receiver no request for the run's marker.
 * WHY: save accepts a template that parses; a render failure shows only at send, as a 422 from the connector. A webhook build that still
 *      reports the ERROR text fails this test. core#2492 is why the record count is "at least one".
 * HOW: `@local:notif` (SMTP catcher, runner-hosted webhook receiver); both notification connectors must be healthy (the needs are resolved
 *      before the test runs; the receiver is closed in a `finally`). The absence of a late delivery is read through a 15 s window every 3 s
 *      and asserted on each read. Own objects only, recorded before any assertion.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { MailCatcher, WebhookReceiver } from '../../../utils/regression/events/notificationCatchers';
import { addressOf, armGroup, buildRig, fire } from '../../../utils/regression/events/notificationDeliveryFixtures';
import { createOwnInstance } from '../../../utils/regression/events/notificationInstances';
import { createOwnProfile } from '../../../utils/regression/events/notificationProfiles';
import { emailAttributes, reservedSender, webhookAttributes } from '../../../utils/regression/events/notificationAttributes';
import { findNotificationConnector, instanceDefinitions } from '../../../utils/regression/events/notificationConnector';
import { describeLocalOnly } from '../../../utils/regression/tier/localProof';
import { assertHeldFor } from '../../../utils/regression/events/eventHistory';
import { testMeta, tags } from '../../../utils/regression/tags';
import { ABSENCE_READ_EVERY_MS, ABSENCE_WINDOW_MS, EVENT_DELIVERY_MS } from '../../../utils/regression/timeouts';
import { ownName } from '../../../utils/regression/ledger/runState';

test.describe('Template broken at send', { tag: tags.regression }, () => {
    describeLocalOnly(test);

    test('a missing template variable fails at send: WARN record, "Notification sent" No, nothing delivered',
        testMeta({
            id: 'REG-WFL-29', prio: 'P2', issue: 'ilm#434', local: true, phaseB: true, needs: ['smtp-catcher', 'webhook-receiver', 'webhook-provider', 'email-provider', 'ca'],
            rule: ['a failure is a TriggerHistoryRecord and flips Notification sent to No; connector 422 → WARN "Validation error in sending notification to connector of notification instance …"; render failure at send → 422, save only parses', 'ilm#434 steps 10–11; webhook-notification-provider#38'],
        }),
        async ({ api, own }) => {
            test.setTimeout(EVENT_DELIVERY_MS);
            // present and healthy: the provider needs are resolved before the test body
            const email = (await findNotificationConnector(api, 'EMAIL'))!;
            const webhook = (await findNotificationConnector(api, 'WEBHOOK'))!;
            const catcher = MailCatcher.fromEnv();
            await catcher.clear();
            const receiver = await WebhookReceiver.start();
            try {
                const marker = ownName('wf29');
                const rig = await buildRig(api, own.spec, 'wf29');

                const mailDefs = await instanceDefinitions(api, email);
                const hookDefs = await instanceDefinitions(api, webhook);
                const mail = await createOwnInstance(api, own.spec, 'wf29-mail', { connector: email, attributes: emailAttributes(mailDefs, { sender: reservedSender(), subject: `${marker}-mail`, template: '<html><body><p>${notificationData.missing}</p></body></html>' }) });
                const json = await createOwnInstance(api, own.spec, 'wf29-json', { connector: webhook, attributes: webhookAttributes(hookDefs, { url: receiver.url(`${marker}-json`), contentType: 'JSON', template: '{"missing": "${notificationData.missing}"}' }) });
                const xml = await createOwnInstance(api, own.spec, 'wf29-xml', { connector: webhook, attributes: webhookAttributes(hookDefs, { url: receiver.url(`${marker}-xml`), contentType: 'XML', template: '<m>${notificationData.missing}</m>' }) });
                const profiles = [
                    await createOwnProfile(api, own.spec, 'wf29-p-mail', { recipientType: 'owner', instance: mail }),
                    await createOwnProfile(api, own.spec, 'wf29-p-json', { recipientType: 'default', instance: json }),
                    await createOwnProfile(api, own.spec, 'wf29-p-xml', { recipientType: 'default', instance: xml }),
                ];
                expect(addressOf('wf29-owner'), 'the owner has an address, so only the template can fail').toBe(rig.ownerEmail);
                const armed = await armGroup(api, own.spec, rig, 'wf29', profiles);
                const row = await fire(api, rig, armed);

                await test.step('The trigger row: matched, actions NOT performed, Notification sent No, a WARN validation record per profile', async () => {
                    expect(row.conditionsMatched, 'the trigger matched').toBe(true);
                    expect(row.actionsPerformed, 'a failure record sets actionsPerformed false').toBe(false);
                    expect(row.notificationsSent, 'Notification sent reads No').toBe(false);
                    const texts = row.records.map((r) => String(r.message ?? ''));
                    for (const p of profiles) {
                        const mine = texts.filter((t) => t.includes(p.name));
                        expect(mine.length, `at least one record for ${p.name}`).toBeGreaterThanOrEqual(1);
                        expect(mine.some((t) => /^Validation error in sending notification to connector of notification instance /.test(t)), `the WARN validation sentence for ${p.name}, not "Error in external notification": ${JSON.stringify(mine)}`).toBe(true);
                    }
                });

                await test.step('Nothing was delivered', async () => {
                    // A late delivery would be a defect, and only the clock can show its absence: after the finished firing the catcher and
                    // the receiver are read through a short window and the absence is asserted on each read.
                    const reads = await assertHeldFor({ forMs: ABSENCE_WINDOW_MS, everyMs: ABSENCE_READ_EVERY_MS }, async () => {
                        expect((await catcher.list()).filter((m) => String(m.Subject ?? '').includes(marker)), 'the catcher holds no message for the marker').toEqual([]);
                        expect(receiver.all().filter((r) => r.path.includes(marker)), 'the receiver holds no request for the marker').toEqual([]);
                    });
                    test.info().annotations.push({ type: 'absence-window', description: `${reads} reads over ${ABSENCE_WINDOW_MS / 1000} s, every ${ABSENCE_READ_EVERY_MS / 1000} s` });
                });
            } finally {
                await receiver.close();
            }
        });
});
