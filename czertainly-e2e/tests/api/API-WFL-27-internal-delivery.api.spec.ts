/**
 * API-WFL-27 — internal delivery through the Send notification action on a firing of an OWN scope, by recipient type
 * (ilm#434 steps 4+; T10 R27, R35, R41, R45, R69; D-10, D-11; §9.5 notifications). Shared-safe: the profiles are INTERNAL-only
 * (no instance, no connector), the recipients are the run's own user, group and role, the driver is one challenge-protected
 * pre-registration on an own RA profile (it fires `Certificate registered` and calls no connector).
 *
 * One placeholder fires four own triggers (one per profile) associated on the own RA profile; each trigger's row in the
 * placeholder's own history carries its outcome (T10 R32, R37):
 *   USER   (own user)             no failure record, "Notification sent" Yes            — resolved to one user
 *   OWNER  (the placeholder's owner = the own user)   no failure record, Yes
 *   GROUP  (own group, no members) a WARN record "…notified no one internally; its 1 recipient(s) resolved to no users.", No
 *   ROLE   (own role, no members)  the same record, No                                 (R35: configuration, not failure)
 * `Notification sent` = "no failure record" (T10 R37), so Yes / No is read from `notificationsSent` of the history row.
 * Not asserted here (guard request G-4, `test.fixme` below): that the suite's OWN identity receives a bell — an inbox is read
 * with `GET /v1/notifications`, but the guard refuses a pre-existing user as `recipientUuids` / `ownerUuid`; and the cleanup of
 * bell rows (no ledger type for notifications). Rows DEFAULT / NONE / OBJECT + internal are refused at save (API-WFL-22).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnGroup, createOwnRaProfileOrSkip, registerPlaceholder } from '../../utils/regression/eventsDrivers';
import { createOwnInternalProfile } from '../../utils/regression/notificationApi';
import { createOwnRole, createOwnUser } from '../../utils/regression/regressionApi';
import {
    associateTriggers, createOwnAction, createOwnExecution, createOwnTrigger, EVENT, sendNotificationItem, waitForFinishedFirings, waitForTriggerRows,
} from '../../utils/regression/workflowApi';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-WFL-27';

test.describe('API-WFL-27 internal delivery by recipient type', { tag: tags.api }, () => {
    test('API-WFL-27: user and owner recipients leave no failure record; an empty group and a role without members leave the "notified no one" record',
        meta({
            id: 'API-WFL-27', prio: 'P1', issue: 'ilm#434',
            rule: [
                'T10 R27 / R45 (internal channel: USER direct, GROUP = members, ROLE = members of the role), R35 (an empty group or role is configuration, not failure: a WARN record "notified no one internally")',
                'T10 R37 ("Notification sent" = no failure record); D-10, D-11; §9.5 notifications',
            ],
        }),
        async ({ api }) => {
            test.setTimeout(240_000);
            const ra = await createOwnRaProfileOrSkip(api, SPEC, 'wf27-ra', (reason) => test.skip(true, reason));
            const user = await createOwnUser(api, 'wf27-user', SPEC);
            const group = await createOwnGroup(api, SPEC, 'wf27-group');
            const role = await createOwnRole(api, 'wf27-role', SPEC);

            const rows = [
                { key: 'user', profile: await createOwnInternalProfile(api, SPEC, { suffix: 'wf27-user', recipientType: 'user', recipients: [user] }), noOne: false },
                { key: 'owner', profile: await createOwnInternalProfile(api, SPEC, { suffix: 'wf27-owner', recipientType: 'owner' }), noOne: false },
                { key: 'group', profile: await createOwnInternalProfile(api, SPEC, { suffix: 'wf27-group', recipientType: 'group', recipients: [group] }), noOne: true },
                { key: 'role', profile: await createOwnInternalProfile(api, SPEC, { suffix: 'wf27-role', recipientType: 'role', recipients: [role] }), noOne: true },
            ];
            const triggers: Awaited<ReturnType<typeof createOwnTrigger>>[] = [];
            for (const r of rows) {
                const execution = await createOwnExecution(api, SPEC, { suffix: `wf27-${r.key}-e`, type: 'sendNotification', items: [sendNotificationItem(r.profile.uuid)] });
                const action = await createOwnAction(api, SPEC, { suffix: `wf27-${r.key}-a`, executions: [execution] });
                triggers.push(await createOwnTrigger(api, SPEC, { suffix: `wf27-${r.key}-t`, event: EVENT.registered, actions: [action] }));
            }
            const sent = await associateTriggers(api, SPEC, { event: EVENT.registered, resource: 'raProfiles', object: ra, triggers });
            expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);

            const placeholder = await registerPlaceholder(api, SPEC, ra, 'wf27-cert', { ownerUuid: user.uuid });
            test.skip(!placeholder.ref, `deploy gate: the run RA profile's authority cannot pre-register (answer ${placeholder.status}: ${placeholder.text.slice(0, 160)})`);

            await waitForFinishedFirings(api, { event: EVENT.registered, scope: { resource: 'raProfiles', objectUuid: ra.uuid } }, 1);
            const history = await waitForTriggerRows(api, 'certificates', placeholder.ref!.uuid, triggers.map((t) => t.name));

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

    test.fixme('API-WFL-27[inbox]: guard request G-4: the suite\'s own identity receives the bell of a USER / OWNER profile',
        meta({ id: 'API-WFL-27', prio: 'P1', issue: 'ilm#434', rule: ['T10 R27 / R68: the identity named by the profile finds the notification in `GET /v1/notifications?unread=true`'] }),
        async ({ api }) => {
            // Needs: (1) the guard to accept the authenticated user's own uuid (GET /v1/auth/profile) as `recipientUuids` / `ownerUuid`
            // of an internal-only profile and a run certificate; (2) a `notifications` ledger type with a teardown handler for the bell rows.
            const profile = await api.get('/api/v1/auth/profile');
            const me = ((await profile.json()) as { user?: { uuid?: string } }).user?.uuid ?? '';
            const own = await createOwnInternalProfile(api, SPEC, { suffix: 'wf27-me', recipientType: 'user', recipients: [{ uuid: me }] });
            expect(own.uuid).toBeTruthy();
            const inbox = await api.get('/api/v1/notifications?unread=true&itemsPerPage=100&pageNumber=1');
            expect(inbox.status()).toBe(200);
        });
});
