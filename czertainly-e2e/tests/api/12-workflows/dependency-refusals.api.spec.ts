/**
 * API-WFL-26 — dependency refusals around notifications: an instance referenced by a profile's current version, a profile referenced
 * by an execution. ilm#434, core#1505. Own objects only, never fired; the unwinding deletes need `API_DELETE_OWN`.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { mayDeleteOwn } from '../../../utils/regression/ledger/ownership';
import { createOwnInstance, deleteOwnInstance, mentions } from '../../../utils/regression/events/notificationInstances';
import { createOwnProfile, deleteOwnProfile, getProfile, profileBody, putOwnProfile } from '../../../utils/regression/events/notificationProfiles';
import { EMAIL_TEMPLATE, emailAttributes, reservedSender } from '../../../utils/regression/events/notificationAttributes';
import { findNotificationConnector, instanceDefinitions } from '../../../utils/regression/events/notificationConnector';
import { createOwnAction, createOwnExecution, deleteOwnWorkflowObject, getKind, sendNotificationItem } from '../../../utils/regression/events/workflowObjects';
import { errorShapeOf, errorTexts } from '../../../utils/regression/events/workflowRequests';
import { testMeta, tags } from '../../../utils/regression/tags';
import { API_STANDARD_TEST_MS } from '../../../utils/regression/timeouts';

type Json = Record<string, any>;

test.describe('Notification dependency refusals', { tag: tags.api }, () => {
    test('a referenced instance and profile refuse their delete, and both delete once un-referenced',
        testMeta({
            id: 'API-WFL-26', prio: 'P1', issue: 'ilm#434', needs: ['email-provider'],
            rule: [
                'instance delete refused while the CURRENT version of a profile references it; old versions detach; core#1505 / PR#1541 text)',
                'profile delete refused while an execution item references it',
            ],
        }),
        async ({ api, own }) => {
            test.setTimeout(API_STANDARD_TEST_MS);
            const connector = await findNotificationConnector(api, 'EMAIL');
            expect(connector, 'the e-mail notification connector the declared need resolved').toBeTruthy();
            const defs = await instanceDefinitions(api, connector!);
            const attrs = () => emailAttributes(defs, { sender: reservedSender(), subject: 'QA API-WFL-26', template: EMAIL_TEMPLATE });
            const first = await createOwnInstance(api, own.spec, 'wf26-inst1', { connector: connector!, attributes: attrs() });
            const second = await createOwnInstance(api, own.spec, 'wf26-inst2', { connector: connector!, attributes: attrs() });
            const profile = await createOwnProfile(api, own.spec, 'wf26-prof', { recipientType: 'owner', instance: first });
            const execution = await createOwnExecution(api, own.spec, 'wf26-exec', { type: 'sendNotification', items: [sendNotificationItem(profile.uuid)] });
            const action = await createOwnAction(api, own.spec, 'wf26-act', { executions: [execution] });

            await test.step('a: the instance a profile\'s current version uses cannot be deleted', async () => {
                const sent = await deleteOwnInstance(api, first, own.spec);
                expect(sent.status, sent.text.slice(0, 300)).toBe(422);
                expect(errorShapeOf(sent)).toBe('array');
                expect(mentions(sent, `Cannot delete notification instance. Notification profile(s) referencing this notification instance: ${profile.name}`), JSON.stringify(sent.json)).toBe(true);
            });

            await test.step('c: the profile an execution uses cannot be deleted', async () => {
                const sent = await deleteOwnProfile(api, profile, own.spec);
                expect(sent.status, sent.text.slice(0, 300)).toBe(422);
                expect(errorTexts(sent)).toContain(`Cannot delete notification profile. 1 execution(s) are referencing this notification profile: ${execution.name}`);
                expect((await getProfile(api, profile.uuid)).status, 'the profile still exists').toBe(200);
            });

            test.skip(!mayDeleteOwn(), 'own deletes are off (API_DELETE_OWN=0): the refusals above are the result; the objects stay for the teardown');

            await test.step('b: repoint the profile (version 2), then the first instance deletes and version 1 shows it detached', async () => {
                const put = await putOwnProfile(api, profile, profileBody(undefined, { recipientType: 'owner', instance: second }));
                expect(put.status, put.text.slice(0, 300)).toBeLessThan(300);
                expect((await getProfile(api, profile.uuid)).json).toMatchObject({ version: 2, notificationInstance: { uuid: second.uuid } });
                const del = await deleteOwnInstance(api, first, own.spec);
                expect(del.status, `DELETE of the un-referenced instance: ${del.text.slice(0, 300)}`).toBe(204);
                const v1 = (await getProfile(api, profile.uuid, 1)).json as Json;
                expect(v1.version).toBe(1);
                expect(v1.notificationInstance ?? null, 'version 1 no longer references the deleted instance').toBeNull();
            });

            await test.step('d: remove the action, then the execution; the profile deletes (204)', async () => {
                for (const [kind, ref] of [['actions', action], ['executions', execution]] as const) {
                    const sent = await deleteOwnWorkflowObject(api, kind, ref, own.spec);
                    expect(sent.status, `DELETE ${kind}: ${sent.text.slice(0, 300)}`).toBe(204);
                    expect((await getKind(api, kind, ref.uuid)).status, `GET ${kind} after its delete`).toBe(404);
                }
                const sent = await deleteOwnProfile(api, profile, own.spec);
                expect(sent.status, `DELETE of the un-referenced profile: ${sent.text.slice(0, 300)}`).toBe(204);
            });
        });
});
