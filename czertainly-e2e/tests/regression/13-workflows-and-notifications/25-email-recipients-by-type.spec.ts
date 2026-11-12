/**
 * REG-WFL-25 — E-mail delivery reaches the right recipient per recipient type (local stack). ilm#434, ilm#207.
 *
 * WHAT: 1. One own certificate is revoked; one execution holds five Send notification items, one own e-mail profile per recipient type
 *          (owner, group, role, default, user), each on its own instance with a per-type subject marker.
 *       2. The trigger matches and records no failure.
 *       3. For each type the SMTP catcher holds exactly one message whose `To` is the resolved address: the owner's, the group's contact,
 *          the role's own e-mail, owner plus group for default, the user's.
 *       4. No other message for the run: five profiles, five messages.
 * WHY: the default recipient is the owner and the groups for status changed; user, role and group resolve to their own addresses; one
 *      message per execution and profile.
 * HOW: `@local:notif`: the SMTP catcher of the local overlay (REG_SMTP_CATCHER_URL); the needs `smtp-catcher`, `email-provider` and `ca`
 *      are resolved before the test runs, so a stack without the overlay skips with the named reason. Addresses are reserved
 *      (`@example.test`). Own objects only, recorded before any assertion.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { MailCatcher } from '../../../utils/regression/events/notificationCatchers';
import { addressOf, armGroup, buildRig, fire } from '../../../utils/regression/events/notificationDeliveryFixtures';
import { createOwnInstance } from '../../../utils/regression/events/notificationInstances';
import { createOwnProfile, RecipientCode } from '../../../utils/regression/events/notificationProfiles';
import { EMAIL_TEMPLATE, emailAttributes, reservedSender } from '../../../utils/regression/events/notificationAttributes';
import { findNotificationConnector, instanceDefinitions } from '../../../utils/regression/events/notificationConnector';
import { describeLocalOnly } from '../../../utils/regression/tier/localProof';
import { testMeta, tags } from '../../../utils/regression/tags';
import { DELIVERY_WAIT_MS, EVENT_DELIVERY_MS } from '../../../utils/regression/timeouts';
import { ownName } from '../../../utils/regression/ledger/runState';

test.describe('E-mail recipients by type', { tag: tags.regression }, () => {
    describeLocalOnly(test);

    test('one message per profile reaches the address its recipient type resolves to',
        testMeta({
            id: 'REG-WFL-25', prio: 'P2', issue: 'ilm#434', local: true, phaseB: true, needs: ['smtp-catcher', 'email-provider', 'ca'],
            rule: ['DEFAULT = owner + groups for status changed; USER → the user\'s e-mail, ROLE → the role\'s own e-mail, GROUP → the group\'s contact e-mail; one message per execution and profile', 'ilm#434 step 4'],
        }),
        async ({ api, own }) => {
            test.setTimeout(EVENT_DELIVERY_MS);
            // present and healthy: the `email-provider` need is resolved before the test body
            const connector = (await findNotificationConnector(api, 'EMAIL'))!;
            const catcher = MailCatcher.fromEnv();
            await catcher.clear();

            const rig = await buildRig(api, own.spec, 'wf25');
            const user = await own.user('wf25-user', { email: addressOf('wf25-user') });
            const role = await own.role('wf25-role', { email: addressOf('wf25-role'), note: 'own role with a contact e-mail (notification recipient)' });
            const marker = ownName('wf25');
            const defs = await instanceDefinitions(api, connector);

            const rows: Array<{ type: RecipientCode; recipients?: Array<{ uuid: string }>; to: string[] }> = [
                { type: 'owner', to: [rig.ownerEmail] },
                { type: 'group', recipients: [rig.group], to: [addressOf('wf25-group')] },
                { type: 'role', recipients: [role], to: [addressOf('wf25-role')] },
                { type: 'default', to: [rig.ownerEmail, addressOf('wf25-group')] },
                { type: 'user', recipients: [user], to: [addressOf('wf25-user')] },
            ];
            const profiles = [];
            for (const r of rows) {
                const instance = await createOwnInstance(api, own.spec, `wf25-inst-${r.type}`, { connector, attributes: emailAttributes(defs, { sender: reservedSender(), subject: `${marker}-${r.type}`, template: EMAIL_TEMPLATE }) });
                profiles.push(await createOwnProfile(api, own.spec, `wf25-prof-${r.type}`, { recipientType: r.type, ...(r.recipients ? { recipients: r.recipients } : {}), instance }));
            }
            const armed = await armGroup(api, own.spec, rig, 'wf25', profiles);
            const row = await fire(api, rig, armed);
            expect({ matched: row.conditionsMatched, records: row.records.map((x) => x.message) }, 'the trigger matched and recorded no failure').toEqual({ matched: true, records: [] });

            for (const r of rows) {
                await test.step(`${r.type}: one message, To = ${r.to.join(', ')}`, async () => {
                    const messages = await catcher.waitForMessages(`${marker}-${r.type}`, 1, DELIVERY_WAIT_MS);
                    expect(messages, `exactly one message for ${r.type}`).toHaveLength(1);
                    expect([...messages[0].to].sort(), `To of the ${r.type} message`).toEqual([...r.to].sort());
                    expect(messages[0].subject, `the subject of the ${r.type} message`).toBe(`${marker}-${r.type}`);
                    expect(messages[0].html, 'the HTML part is the instance template rendered: its paragraph with the event filled in, no placeholder left').toMatch(/<body><p>QA [^<$]+<\/p><\/body>/);
                });
            }
            const all = (await catcher.list()).filter((m) => String(m.Subject ?? '').startsWith(marker));
            expect(all, 'no other message for this run: five profiles, five messages').toHaveLength(5);
        });
});
