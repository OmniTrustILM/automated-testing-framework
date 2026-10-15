/**
 * REG-WFL-29 — a template saved with a MISSING VARIABLE fails AT SEND with a 422 from the connector: core records a WARN "Validation
 * error in sending notification…", Event History shows Notification sent No, nothing is delivered — for e-mail and for webhook JSON /
 * XML (ilm#434 steps 10–11, the send side; T10 R32, R33, R55, R62, E5; D-05; webhook-notification-provider#38 RE-TEST). `@local:notif`
 * (SMTP catcher, runner-hosted webhook receiver; REG_SMTP_CATCHER_URL, REG_WEBHOOK_HOST).
 *
 * Save accepts a template that parses (API-WFL-21 row i); the send renders it and the connector answers 422 for `${notificationData.
 * missing}`. One trigger sends three profiles (e-mail, webhook JSON, webhook XML) on one revoke of an own certificate (own group scope).
 *   the certificate's history row for the trigger: `conditionsMatched` true, `actionsPerformed` false, `notificationsSent` false, with at
 *   least one record per profile whose text is the WARN-class validation sentence "Validation error in sending notification to connector
 *   of notification instance <…> configured for notification profile <…> in event <…>: …" — NOT the ERROR text "Error in external
 *   notification…" (the old webhook 500 would be that one: on a webhook build older than PR #48 the row reports exactly that, which is
 *   the re-test result and not a quarantine); core#2492 (open: the records are duplicated per execution item) is why "at least one";
 *   the catcher holds no message for the marker and the receiver no request.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { MailCatcher, smtpCatcherProblem, WebhookReceiver, webhookReceiverProblem } from '../../utils/regression/catchers';
import { addressOf, armGroup, buildRig, fire } from '../../utils/regression/notifRig';
import {
    createOwnInstance, createOwnProfile, emailAttributes, findNotificationConnector, instanceDefinitions, reservedSender, webhookAttributes,
} from '../../utils/regression/notificationApi';
import { describeLocal } from '../../utils/regression/tier';
import { assertHeldFor, wfName } from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-WFL-29';

test.describe('@regression REG-WFL-29 template broken at send', () => {
    describeLocal(test);
    let receiver: WebhookReceiver | undefined;
    test.afterEach(async () => {
        await receiver?.close();
        receiver = undefined;
    });

    test('REG-WFL-29: a missing template variable fails at send with the WARN validation record, Notification sent No and nothing delivered',
        meta({
            id: 'REG-WFL-29', prio: 'P1', issue: 'ilm#434', local: true, phaseB: true, needs: ['smtp-catcher', 'webhook-receiver', 'webhook-provider', 'email-provider'],
            rule: ['T10 R32 (a failure is a TriggerHistoryRecord and flips Notification sent to No), R33 (connector 422 → WARN "Validation error in sending notification to connector of notification instance …"), R55 / R62 (render failure at send → 422; save only parses)', 'ilm#434 steps 10–11; D-05; webhook#38 re-test'],
        }),
        async ({ api }) => {
            test.setTimeout(900_000);
            const mailProblem = smtpCatcherProblem();
            test.skip(!!mailProblem, mailProblem ?? '');
            const hookProblem = webhookReceiverProblem();
            test.skip(!!hookProblem, hookProblem ?? '');
            const email = await findNotificationConnector(api, 'EMAIL');
            const webhook = await findNotificationConnector(api, 'WEBHOOK');
            test.skip(!email || !!email.unhealthy || !webhook || !!webhook.unhealthy, 'deploy gate: the e-mail and webhook notification connectors must both be healthy on this stack');
            const catcher = MailCatcher.fromEnv();
            await catcher.clear();
            receiver = await WebhookReceiver.start();
            const marker = wfName('wf29');
            const rig = await buildRig(api, SPEC, 'wf29', (reason) => test.skip(true, reason));

            const mailDefs = await instanceDefinitions(api, email!);
            const hookDefs = await instanceDefinitions(api, webhook!);
            const mail = await createOwnInstance(api, SPEC, {
                suffix: 'wf29-mail', connector: email!, attributes: emailAttributes(mailDefs, { sender: reservedSender(), subject: `${marker}-mail`, template: '<html><body><p>${notificationData.missing}</p></body></html>' }),
            });
            const json = await createOwnInstance(api, SPEC, {
                suffix: 'wf29-json', connector: webhook!, attributes: webhookAttributes(hookDefs, { url: receiver.url(`${marker}-json`), contentType: 'JSON', template: '{"missing": "${notificationData.missing}"}' }),
            });
            const xml = await createOwnInstance(api, SPEC, {
                suffix: 'wf29-xml', connector: webhook!, attributes: webhookAttributes(hookDefs, { url: receiver.url(`${marker}-xml`), contentType: 'XML', template: '<m>${notificationData.missing}</m>' }),
            });
            const profiles = [
                await createOwnProfile(api, SPEC, { suffix: 'wf29-p-mail', recipientType: 'owner', instance: mail }),
                await createOwnProfile(api, SPEC, { suffix: 'wf29-p-json', recipientType: 'default', instance: json }),
                await createOwnProfile(api, SPEC, { suffix: 'wf29-p-xml', recipientType: 'default', instance: xml }),
            ];
            expect(addressOf('wf29-owner'), 'the owner has an address, so only the template can fail').toBe(rig.ownerEmail);
            const armed = await armGroup(api, SPEC, rig, 'wf29', profiles);
            const row = await fire(api, rig, armed);

            await test.step('The trigger row: matched, actions NOT performed, Notification sent No, a WARN validation record per profile', async () => {
                expect(row.conditionsMatched).toBe(true);
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
                // A late delivery would be a defect, and only the clock can show its absence: the grace window after the finished firing stays, but
                // the catcher and the receiver are read through it every 3 s and the absence is asserted on each read.
                const reads = await assertHeldFor({ forMs: 15_000, everyMs: 3_000 }, async () => {
                    expect((await catcher.list()).filter((m) => String(m.Subject ?? '').includes(marker)), 'the catcher holds no message for the marker').toEqual([]);
                    expect(receiver!.all().filter((r) => r.path.includes(marker)), 'the receiver holds no request for the marker').toEqual([]);
                });
                test.info().annotations.push({ type: 'absence-window', description: `${reads} reads over 15 s, every 3 s` });
            });
        });
});
