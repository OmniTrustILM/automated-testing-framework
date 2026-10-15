/**
 * REG-WFL-26 — e-mail content templates render as written; values are HTML-ESCAPED, the subject is not, and `?no_esc` opts out
 * (ilm#434 steps 7, 9; T10 R55; D-04; email-notification-provider#68; table P-N26b). `@local:notif` (SMTP catcher, REG_SMTP_CATCHER_URL).
 *
 * The value comes from an own certificate's SUBJECT: five uploads whose common names carry the value classes plain text, `<b>x</b>`,
 * `a & b`, `say "q"` and non-ASCII. The driver is a PLATFORM-level `Certificate uploaded` trigger (the event fires for the upload itself,
 * so no CA is needed; `@local`: the association replaces the platform list — read first, skipped when not empty, restored in `finally`),
 * sending two own profiles to one own user: instance ESC (template `${notificationData.subjectDn}` in a paragraph, subject `ESC <dn>`)
 * and instance RAW (the same with `?no_esc`, subject `RAW <dn>`).
 *   the subject line carries the value UNESCAPED (R55: plain text) — taken from the RAW message, its text is V (the distinguished-name
 *   rendering of the name, which may add backslashes: the oracle uses what the subject shows, never an assumed form);
 *   the ESC message HTML contains htmlEscape(V) and, where V holds markup, NOT the live markup; the RAW message HTML contains V as is.
 * Reserved addresses only. A value is found by its plain marker `<run>-k<i>-` (escaping leaves it unchanged).
 * `?html` is refused at save (API-WFL-21 row b).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { MailCatcher, smtpCatcherProblem } from '../../utils/regression/catchers';
import { addressOf } from '../../utils/regression/notifRig';
import {
    createOwnInstance, createOwnProfile, emailAttributes, findNotificationConnector, instanceDefinitions, reservedSender,
} from '../../utils/regression/notificationApi';
import { selfSignedPem } from '../../utils/regression/pki';
import { createOwnUser, uploadOwnCertificate } from '../../utils/regression/regressionApi';
import { getGuardedApiContext } from '../../utils/regression/guardedApi';
import type { GuardedApi } from '../../utils/regression/guardedApi';
import { describeLocal } from '../../utils/regression/tier';
import {
    createOwnAction, createOwnExecution, createOwnTrigger, EVENT, getPlatformAssociations, platformAssociate, sendNotificationItem, wfName,
} from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-WFL-26';
const escapeHtml = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

test.describe('@regression REG-WFL-26 e-mail template escaping', () => {
    describeLocal(test);
    // `@local` rows lift the guard's ownership rule on a proven local stack only (`localStack`, `describeLocal`): the guarded
    // context is built per test here, since a spec may not `test.use` the guard options.
    let api: GuardedApi;
    test.beforeEach(async ({ request, env }) => {
        api = await getGuardedApiContext(request, env, { localStack: true });
    });
    test.afterEach(async () => {
        await api?.dispose();
    });

    test('REG-WFL-26: values are HTML-escaped in the content, not in the subject, and ?no_esc shows them raw',
        meta({
            id: 'REG-WFL-26', prio: 'P1', issue: 'ilm#434', local: true, phaseB: true, needs: ['smtp-catcher', 'email-provider'],
            rule: ['T10 R55 (HTML content uses HTMLOutputFormat: every value escaped; subject plain text; `?no_esc` opts out; email README: values never become live markup)', 'ilm#434 steps 7, 9; D-04; email-notification-provider#68; P-N26b'],
        }),
        async () => {
            test.setTimeout(900_000);
            const problem = smtpCatcherProblem();
            test.skip(!!problem, problem ?? '');
            const connector = await findNotificationConnector(api, 'EMAIL');
            test.skip(!connector || !!connector.unhealthy, 'deploy gate: no healthy e-mail notification connector on this stack (@needs:email-provider)');
            const existing = await getPlatformAssociations(api, EVENT.uploaded);
            test.skip(existing.length > 0, `guard 3: ${existing.length} platform-level trigger(s) already listen on Certificate uploaded; the row stays out of that event`);
            const catcher = MailCatcher.fromEnv();
            await catcher.clear();

            const marker = wfName('wf26');
            const recipient = await createOwnUser(api, 'wf26-user', SPEC, { email: addressOf('wf26-user') });
            const defs = await instanceDefinitions(api, connector!);
            const instances = {
                esc: await createOwnInstance(api, SPEC, { suffix: 'wf26-esc', connector: connector!, attributes: emailAttributes(defs, { sender: reservedSender(), subject: 'ESC ${notificationData.subjectDn}', template: '<html><body><p>${notificationData.subjectDn}</p></body></html>' }) }),
                raw: await createOwnInstance(api, SPEC, { suffix: 'wf26-raw', connector: connector!, attributes: emailAttributes(defs, { sender: reservedSender(), subject: 'RAW ${notificationData.subjectDn}', template: '<html><body><p>${notificationData.subjectDn?no_esc}</p></body></html>' }) }),
            };
            const profiles = [
                await createOwnProfile(api, SPEC, { suffix: 'wf26-p-esc', recipientType: 'user', recipients: [recipient], instance: instances.esc }),
                await createOwnProfile(api, SPEC, { suffix: 'wf26-p-raw', recipientType: 'user', recipients: [recipient], instance: instances.raw }),
            ];
            const execution = await createOwnExecution(api, SPEC, { suffix: 'wf26-e', type: 'sendNotification', items: profiles.map((p) => sendNotificationItem(p.uuid)) });
            const action = await createOwnAction(api, SPEC, { suffix: 'wf26-a', executions: [execution] });
            const trigger = await createOwnTrigger(api, SPEC, { suffix: 'wf26-t', event: EVENT.uploaded, actions: [action] });

            const classes = ['plain text', '<b>x</b>', 'a & b', 'say "q"', 'Čeština'];
            try {
                const assoc = await platformAssociate(api, SPEC, EVENT.uploaded, [trigger]);
                expect(assoc.status, assoc.text.slice(0, 300)).toBeLessThan(300);

                for (const [i, value] of classes.entries()) {
                    const cn = `${marker}-k${i}- ${value}`;
                    await uploadOwnCertificate(api, selfSignedPem(cn).pem, cn, SPEC, `upload carrying the value class ${i}`);
                }

                for (const [i, value] of classes.entries()) {
                    await test.step(`Value class ${i} (${value}): subject raw, content escaped, ?no_esc raw`, async () => {
                        const plain = `${marker}-k${i}-`;
                        const messages = await catcher.waitForMessages(plain, 2, 180_000);
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
                await platformAssociate(api, SPEC, EVENT.uploaded, []);
            }
            expect(await getPlatformAssociations(api, EVENT.uploaded), 'the platform list is restored (empty)').toEqual([]);
        });
});
