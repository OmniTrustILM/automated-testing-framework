/**
 * API-WFL-27 — internal delivery through the Send notification action, one internal-only profile per recipient type. ilm#434.
 * Internal-only profiles (nothing is delivered), the run's own recipients, triggers associated on an own RA profile.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { createOwnGroup } from '../../../utils/regression/ownGroups';
import { registerPlaceholder } from '../../../utils/regression/events/workflowFixtures';
import { createOwnInternalProfile } from '../../../utils/regression/events/notificationProfiles';
import { createOwnRole } from '../../../utils/regression/ownRoles';
import { createOwnUser } from '../../../utils/regression/ownUsers';
import { associateTriggers } from '../../../utils/regression/events/eventAssociations';
import { waitForFinishedFirings, waitForTriggerRows } from '../../../utils/regression/events/eventHistory';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { createOwnAction, createOwnExecution, createOwnTrigger, sendNotificationItem } from '../../../utils/regression/events/workflowObjects';
import { testMeta, tags } from '../../../utils/regression/tags';
import { ISSUE_MS } from '../../../utils/regression/timeouts';

test.describe('Internal delivery by recipient type', { tag: tags.api }, () => {
    test('user and owner recipients leave no failure record and an empty group or role logs "notified no one"',
        testMeta({
            id: 'API-WFL-27', prio: 'P1', issue: 'ilm#434', needs: ['ca', 'registration-settings'],
            rule: [
                'internal channel: USER direct, GROUP = members, ROLE = members of the role; an empty group or role is configuration, not failure: a WARN record "notified no one internally"',
                '"Notification sent" = no failure record',
            ],
        }),
        async ({ api, own }) => {
            test.setTimeout(ISSUE_MS);
            const { ra, user, rows, triggers } = await test.step('Own recipients, one profile per recipient type, and a trigger chain for each', async () => {
                const ra = await own.raProfile('wf27-ra');
                const user = await createOwnUser(api, own.spec, 'wf27-user');
                const group = await createOwnGroup(api, own.spec, 'wf27-group');
                const role = await createOwnRole(api, own.spec, 'wf27-role');

                const rows = [
                    { key: 'user', profile: await createOwnInternalProfile(api, own.spec, 'wf27-user', { recipientType: 'user', recipients: [user] }), noOne: false },
                    { key: 'owner', profile: await createOwnInternalProfile(api, own.spec, 'wf27-owner', { recipientType: 'owner' }), noOne: false },
                    { key: 'group', profile: await createOwnInternalProfile(api, own.spec, 'wf27-group', { recipientType: 'group', recipients: [group] }), noOne: true },
                    { key: 'role', profile: await createOwnInternalProfile(api, own.spec, 'wf27-role', { recipientType: 'role', recipients: [role] }), noOne: true },
                ];
                const triggers: Awaited<ReturnType<typeof createOwnTrigger>>[] = [];
                for (const r of rows) {
                    const execution = await createOwnExecution(api, own.spec, `wf27-${r.key}-e`, { type: 'sendNotification', items: [sendNotificationItem(r.profile.uuid)] });
                    const action = await createOwnAction(api, own.spec, `wf27-${r.key}-a`, { executions: [execution] });
                    triggers.push(await createOwnTrigger(api, own.spec, `wf27-${r.key}-t`, { event: EVENT.registered, actions: [action] }));
                }
                return { ra, user, rows, triggers };
            });

            const placeholder = await test.step('Associate the triggers with the RA profile and register a certificate', async () => {
                const sent = await associateTriggers(api, own.spec, { event: EVENT.registered, resource: 'raProfiles', object: ra, triggers });
                expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);

                const placeholder = await registerPlaceholder(api, own.spec, ra, 'wf27-cert', { ownerUuid: user.uuid });
                expect(placeholder.ref, `the pre-registration was refused: ${placeholder.status} ${placeholder.text.slice(0, 300)}`).toBeTruthy();
                return placeholder;
            });

            const history = await test.step('Wait for the firings and read the trigger history', async () => {
                await waitForFinishedFirings(api, { event: EVENT.registered, scope: { resource: 'raProfiles', objectUuid: ra.uuid } }, 1);
                const history = await waitForTriggerRows(api, 'certificates', placeholder.ref!.uuid, triggers.map((t) => t.name));
                return history;
            });

            await test.step('Every recipient type leaves the record its rule asks for', async () => {
                rows.forEach((r, i) => {
                    const row = history.find((h) => h.trigger.name === triggers[i].name)!;
                    expect(row.conditionsMatched, `${r.key}: a trigger without rules matches`).toBe(true);
                    const noOne = row.records.filter((rec) => /notified no one internally; its 1 recipient\(s\) resolved to no users\./.test(String(rec.message ?? '')));
                    if (r.noOne) {
                        expect(noOne, `${r.key}: the "notified no one" record`).toHaveLength(1);
                        expect(row.notificationsSent, `${r.key}: Notification sent reads No`).toBe(false);
                    } else {
                        expect(row.records, `${r.key}: no failure record`).toEqual([]);
                        expect(row.notificationsSent, `${r.key}: Notification sent reads Yes`).toBe(true);
                    }
                });
            });
        });
});
