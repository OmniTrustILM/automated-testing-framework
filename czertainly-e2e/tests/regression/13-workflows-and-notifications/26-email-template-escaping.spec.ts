/**
 * REG-WFL-26 — E-mail content templates render as written (local stack). ilm#434, email-notification-provider#68.
 *
 * WHAT: 1. Five uploads whose common names carry the value classes plain text, markup, `&`, quotes and non-ASCII fire a platform-level
 *          `Certificate uploaded` trigger that sends two own profiles to one own user: ESC (a plain template) and RAW (`?no_esc`).
 *       2. For each class the subject carries the value unescaped in both messages, the ESC content has it HTML-escaped (a value with
 *          markup never becomes live markup) and the RAW content has it as is.
 * WHY: values are HTML-escaped in the content, the subject is plain text and `?no_esc` opts out (HTMLOutputFormat); values must never
 *      become live markup. `?html` is refused at save (tests/api/08-notifications/template-refused-at-save.api.spec.ts).
 * HOW: `@local:notif` (SMTP catcher, REG_SMTP_CATCHER_URL). `@local`: the platform list is read first, the test skips when it is not empty,
 *      and it is restored in `finally`; the platform calls go through the `localApi` fixture. Reserved addresses only; own objects,
 *      recorded before any assertion.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { MailCatcher } from '../../../utils/regression/events/notificationCatchers';
import { addressOf } from '../../../utils/regression/events/notificationDeliveryFixtures';
import { createOwnInstance } from '../../../utils/regression/events/notificationInstances';
import { createOwnProfile } from '../../../utils/regression/events/notificationProfiles';
import { emailAttributes, reservedSender } from '../../../utils/regression/events/notificationAttributes';
import { findNotificationConnector, instanceDefinitions } from '../../../utils/regression/events/notificationConnector';
import { selfSignedPem } from '../../../utils/regression/pkiBuilders';
import { describeLocalOnly } from '../../../utils/regression/tier/localProof';
import { getPlatformAssociations, platformAssociate } from '../../../utils/regression/events/eventAssociations';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { createOwnAction, createOwnExecution, createOwnTrigger, sendNotificationItem } from '../../../utils/regression/events/workflowObjects';
import { testMeta, tags } from '../../../utils/regression/tags';
import { EVENT_DELIVERY_MS, SLOW_DELIVERY_WAIT_MS } from '../../../utils/regression/timeouts';
import { ownName } from '../../../utils/regression/ledger/runState';

const escapeHtml = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

test.describe('E-mail template escaping', { tag: tags.regression }, () => {
    describeLocalOnly(test);

    test('values are HTML-escaped in the content, not in the subject, and ?no_esc shows them raw',
        testMeta({
            id: 'REG-WFL-26', prio: 'P2', issue: 'ilm#434', local: true, phaseB: true, needs: ['smtp-catcher', 'email-provider'],
            rule: ['HTML content uses HTMLOutputFormat: every value escaped; subject plain text; `?no_esc` opts out; email README: values never become live markup', 'ilm#434 steps 7, 9; email-notification-provider#68'],
        }),
        async ({ api, localApi, own, needs }) => {
            test.setTimeout(EVENT_DELIVERY_MS);
            // present and healthy: the `email-provider` need is resolved before the test body
            const connector = (await findNotificationConnector(api, 'EMAIL'))!;
            await needs.platformTriggersFree(EVENT.uploaded);
            const catcher = MailCatcher.fromEnv();
            await catcher.clear();

            const marker = ownName('wf26');
            const recipient = await own.user('wf26-user', { email: addressOf('wf26-user') });
            const defs = await instanceDefinitions(api, connector);
            const instances = {
                esc: await createOwnInstance(api, own.spec, 'wf26-esc', { connector, attributes: emailAttributes(defs, { sender: reservedSender(), subject: 'ESC ${notificationData.subjectDn}', template: '<html><body><p>${notificationData.subjectDn}</p></body></html>' }) }),
                raw: await createOwnInstance(api, own.spec, 'wf26-raw', { connector, attributes: emailAttributes(defs, { sender: reservedSender(), subject: 'RAW ${notificationData.subjectDn}', template: '<html><body><p>${notificationData.subjectDn?no_esc}</p></body></html>' }) }),
            };
            const profiles = [
                await createOwnProfile(api, own.spec, 'wf26-p-esc', { recipientType: 'user', recipients: [recipient], instance: instances.esc }),
                await createOwnProfile(api, own.spec, 'wf26-p-raw', { recipientType: 'user', recipients: [recipient], instance: instances.raw }),
            ];
            const execution = await createOwnExecution(api, own.spec, 'wf26-e', { type: 'sendNotification', items: profiles.map((p) => sendNotificationItem(p.uuid)) });
            const action = await createOwnAction(api, own.spec, 'wf26-a', { executions: [execution] });
            const trigger = await createOwnTrigger(api, own.spec, 'wf26-t', { event: EVENT.uploaded, actions: [action] });

            const classes = ['plain text', '<b>x</b>', 'a & b', 'say "q"', 'Čeština'];
            try {
                const assoc = await platformAssociate(localApi, own.spec, EVENT.uploaded, [trigger]);
                expect(assoc.status, assoc.text.slice(0, 300)).toBeLessThan(300);

                for (const [i, value] of classes.entries()) {
                    const cn = `${marker}-k${i}- ${value}`;
                    await own.certificate.upload(selfSignedPem(cn).pem, cn, `upload carrying the value class ${i}`);
                }

                for (const [i, value] of classes.entries()) {
                    await test.step(`Value class ${i} (${value}): subject raw, content escaped, ?no_esc raw`, async () => {
                        const plain = `${marker}-k${i}-`;
                        const messages = await catcher.waitForMessages(plain, 2, SLOW_DELIVERY_WAIT_MS);
                        const esc = messages.find((m) => m.subject.startsWith('ESC '))!;
                        const raw = messages.find((m) => m.subject.startsWith('RAW '))!;
                        expect(esc, 'the ESC message').toBeTruthy();
                        expect(raw, 'the RAW message').toBeTruthy();
                        const v = raw.subject.slice('RAW '.length); // the subject is NOT escaped: it shows the value as rendered
                        expect(esc.subject, 'the subject carries the same unescaped value in both messages').toBe(`ESC ${v}`);
                        expect(esc.html, 'the content has the value HTML-escaped').toContain(escapeHtml(v));
                        if (/[<>&"']/.test(value)) expect(esc.html, 'a value holding markup never becomes live markup').not.toContain(v.includes('<') ? '<b' : v);
                        expect(raw.html, '?no_esc shows the value as is').toContain(v);
                    });
                }
            } finally {
                await platformAssociate(localApi, own.spec, EVENT.uploaded, []);
            }
            expect(await getPlatformAssociations(localApi, EVENT.uploaded), 'the platform list is restored (empty)').toEqual([]);
        });
});
