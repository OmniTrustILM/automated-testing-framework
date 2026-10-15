/**
 * REG-WFL-25 — e-mail delivery on `Certificate status changed` reaches the RIGHT recipient per recipient type: Owner, Group, Role,
 * Default, User (ilm#434 step 4 + comments, recipient types; T10 R41, R43; D-01; ilm#207; table P-N25).
 *
 * `@local:notif` (the SMTP catcher of the local overlay, decision D3; REG_SMTP_CATCHER_URL): one own group in which one own
 * certificate (owned by an own user) is revoked; ONE execution with five Send notification items, one own e-mail profile per type,
 * each on its own e-mail instance whose subject carries a per-type marker. The catcher then holds exactly ONE message per profile
 * (T10 R29: one message per (execution, profile)) and the `To` of each is the resolved address (T10 R43):
 *   OWNER   the certificate owner's e-mail              GROUP   the group's contact e-mail
 *   ROLE    the role's OWN contact e-mail (not its members)   DEFAULT the owner plus the groups' contact e-mails
 *   USER    the user's e-mail
 * Subject and HTML come from the instance. No other message arrives for the markers. Addresses are reserved (`@example.test`).
 * `@needs:smtp-catcher`, `@needs:email-provider`; a stack without the overlay skips with the named reason.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnRoleWithEmail } from '../../utils/regression/eventsDrivers';
import { MailCatcher, smtpCatcherProblem } from '../../utils/regression/catchers';
import { addressOf, armGroup, buildRig, fire } from '../../utils/regression/notifRig';
import {
    createOwnInstance, createOwnProfile, EMAIL_TEMPLATE, emailAttributes, findNotificationConnector, instanceDefinitions, reservedSender, RecipientCode,
} from '../../utils/regression/notificationApi';
import { createOwnUser } from '../../utils/regression/regressionApi';
import { describeLocal } from '../../utils/regression/tier';
import { wfName } from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-WFL-25';

test.describe('@regression REG-WFL-25 e-mail recipients by type', () => {
    describeLocal(test);

    test('REG-WFL-25: one message per profile reaches the address its recipient type resolves to',
        meta({
            id: 'REG-WFL-25', prio: 'P1', issue: 'ilm#434', local: true, phaseB: true, needs: ['smtp-catcher', 'email-provider'],
            rule: ['T10 R41 (DEFAULT = owner + groups for status changed), R43 (USER → the user\'s e-mail, ROLE → the role\'s own e-mail, GROUP → the group\'s contact e-mail), R29 (one message per execution and profile)', 'ilm#434 step 4 + comments; D-01; P-N25'],
        }),
        async ({ api }) => {
            test.setTimeout(900_000);
            const problem = smtpCatcherProblem();
            test.skip(!!problem, problem ?? '');
            const connector = await findNotificationConnector(api, 'EMAIL');
            test.skip(!connector || !!connector.unhealthy, 'deploy gate: no healthy e-mail notification connector on this stack (@needs:email-provider)');
            const catcher = MailCatcher.fromEnv();
            await catcher.clear();

            const rig = await buildRig(api, SPEC, 'wf25', (reason) => test.skip(true, reason));
            const user = await createOwnUser(api, 'wf25-user', SPEC, { email: addressOf('wf25-user') });
            const role = await createOwnRoleWithEmail(api, SPEC, 'wf25-role', addressOf('wf25-role'));
            const marker = wfName('wf25');
            const defs = await instanceDefinitions(api, connector!);

            const rows: Array<{ type: RecipientCode; recipients?: Array<{ uuid: string }>; to: string[] }> = [
                { type: 'owner', to: [rig.ownerEmail] },
                { type: 'group', recipients: [rig.group], to: [addressOf('wf25-group')] },
                { type: 'role', recipients: [role], to: [addressOf('wf25-role')] },
                { type: 'default', to: [rig.ownerEmail, addressOf('wf25-group')] },
                { type: 'user', recipients: [user], to: [addressOf('wf25-user')] },
            ];
            const profiles = [];
            for (const r of rows) {
                const instance = await createOwnInstance(api, SPEC, {
                    suffix: `wf25-inst-${r.type}`, connector: connector!, attributes: emailAttributes(defs, { sender: reservedSender(), subject: `${marker}-${r.type}`, template: EMAIL_TEMPLATE }),
                });
                profiles.push(await createOwnProfile(api, SPEC, { suffix: `wf25-prof-${r.type}`, recipientType: r.type, ...(r.recipients ? { recipients: r.recipients } : {}), instance }));
            }
            const armed = await armGroup(api, SPEC, rig, 'wf25', profiles);
            const row = await fire(api, rig, armed);
            expect({ matched: row.conditionsMatched, records: row.records.map((x) => x.message) }, 'the trigger matched and recorded no failure').toEqual({ matched: true, records: [] });

            for (const r of rows) {
                await test.step(`${r.type}: one message, To = ${r.to.join(', ')}`, async () => {
                    const messages = await catcher.waitForMessages(`${marker}-${r.type}`, 1, 120_000);
                    expect(messages, `exactly one message for ${r.type}`).toHaveLength(1);
                    expect([...messages[0].to].sort(), `To of the ${r.type} message`).toEqual([...r.to].sort());
                    expect(messages[0].subject).toBe(`${marker}-${r.type}`);
                    expect(messages[0].html, 'the HTML part is the instance template rendered').toContain('QA');
                });
            }
            const all = (await catcher.list()).filter((m) => String(m.Subject ?? '').startsWith(marker));
            expect(all, 'no other message for this run: five profiles, five messages').toHaveLength(5);
        });
});
