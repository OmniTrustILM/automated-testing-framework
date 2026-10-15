/**
 * API-WFL-26 — dependency refusals around notifications (ilm#434; T10 R5, R18; N-07; P-08; core#1505):
 *   a  an instance a profile's CURRENT version references cannot be deleted:
 *        422 "Cannot delete notification instance. Notification profile(s) referencing this notification instance: <name>"
 *   b  after the profile is repointed (version 2) the instance deletes (204) and version 1 shows the instance detached
 *   c  a profile an execution references cannot be deleted:
 *        422 "Cannot delete notification profile. 1 execution(s) are referencing this notification profile: <execution>"
 *   d  after the chain (action → execution) is removed the profile deletes (204)
 * Own objects only: two own e-mail instances (reserved sender, nothing delivered), one profile, one Send notification execution
 * and action. Never fired, never associated. The unwinding deletes are the behaviour under test (`API_DELETE_OWN`, default on;
 * off keeps everything for the teardown). `@needs:email-provider`.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { mayDeleteOwn } from '../../utils/regression/ownObjects';
import {
    createOwnInstance, createOwnProfile, deleteOwnInstance, deleteOwnProfile, EMAIL_TEMPLATE, emailAttributes, findNotificationConnector, getProfile, instanceDefinitions, mentions, profileBody,
    putOwnProfile, reservedSender,
} from '../../utils/regression/notificationApi';
import { createOwnAction, createOwnExecution, deleteOwn, errorShapeOf, errorTexts, getKind, sendNotificationItem } from '../../utils/regression/workflowApi';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-WFL-26';
type Json = Record<string, any>;

test.describe('API-WFL-26 notification dependency refusals', { tag: tags.api }, () => {
    test('API-WFL-26: an instance used by a profile and a profile used by an execution refuse their delete; once un-referenced both delete',
        meta({
            id: 'API-WFL-26', prio: 'P1', issue: 'ilm#434', needs: ['email-provider'],
            rule: [
                'T10 R5 (instance delete refused while the CURRENT version of a profile references it; old versions detach; core#1505 / PR#1541 text)',
                'T10 R18 (profile delete refused while an execution item references it); T10 N-07, P-08',
            ],
        }),
        async ({ api }) => {
            test.setTimeout(120_000);
            const connector = await findNotificationConnector(api, 'EMAIL');
            test.skip(!connector || !!connector.unhealthy, 'deploy gate: no healthy e-mail notification connector on this tier (@needs:email-provider)');
            const defs = await instanceDefinitions(api, connector!);
            const attrs = () => emailAttributes(defs, { sender: reservedSender(), subject: 'QA API-WFL-26', template: EMAIL_TEMPLATE });
            const first = await createOwnInstance(api, SPEC, { suffix: 'wf26-inst1', connector: connector!, attributes: attrs() });
            const second = await createOwnInstance(api, SPEC, { suffix: 'wf26-inst2', connector: connector!, attributes: attrs() });
            const profile = await createOwnProfile(api, SPEC, { suffix: 'wf26-prof', recipientType: 'owner', instance: first });
            const execution = await createOwnExecution(api, SPEC, { suffix: 'wf26-exec', type: 'sendNotification', items: [sendNotificationItem(profile.uuid)] });
            const action = await createOwnAction(api, SPEC, { suffix: 'wf26-act', executions: [execution] });

            await test.step('a: the instance a profile\'s current version uses cannot be deleted', async () => {
                const sent = await deleteOwnInstance(api, first, SPEC);
                expect(sent.status, sent.text.slice(0, 300)).toBe(422);
                expect(errorShapeOf(sent)).toBe('array');
                expect(mentions(sent, `Cannot delete notification instance. Notification profile(s) referencing this notification instance: ${profile.name}`), JSON.stringify(sent.json)).toBe(true);
            });

            await test.step('c: the profile an execution uses cannot be deleted', async () => {
                const sent = await deleteOwnProfile(api, profile, SPEC);
                expect(sent.status, sent.text.slice(0, 300)).toBe(422);
                expect(errorTexts(sent)).toContain(`Cannot delete notification profile. 1 execution(s) are referencing this notification profile: ${execution.name}`);
                expect((await getProfile(api, profile.uuid)).status, 'the profile still exists').toBe(200);
            });

            test.skip(!mayDeleteOwn(), 'own deletes are off (API_DELETE_OWN=0): the refusals above are the result; the objects stay for the teardown');

            await test.step('b: repoint the profile (version 2), then the first instance deletes and version 1 shows it detached', async () => {
                const put = await putOwnProfile(api, profile, profileBody(undefined, { recipientType: 'owner', instance: second }));
                expect(put.status, put.text.slice(0, 300)).toBeLessThan(300);
                expect((await getProfile(api, profile.uuid)).json).toMatchObject({ version: 2, notificationInstance: { uuid: second.uuid } });
                const del = await deleteOwnInstance(api, first, SPEC);
                expect(del.status, `DELETE of the un-referenced instance: ${del.text.slice(0, 300)}`).toBe(204);
                const v1 = (await getProfile(api, profile.uuid, 1)).json as Json;
                expect(v1.version).toBe(1);
                expect(v1.notificationInstance ?? null, 'version 1 no longer references the deleted instance').toBeNull();
            });

            await test.step('d: remove the action, then the execution; the profile deletes (204)', async () => {
                for (const [kind, ref] of [['actions', action], ['executions', execution]] as const) {
                    const sent = await deleteOwn(api, kind, ref, SPEC);
                    expect(sent.status, `DELETE ${kind}: ${sent.text.slice(0, 300)}`).toBe(204);
                    expect((await getKind(api, kind, ref.uuid)).status).toBe(404);
                }
                const sent = await deleteOwnProfile(api, profile, SPEC);
                expect(sent.status, `DELETE of the un-referenced profile: ${sent.text.slice(0, 300)}`).toBe(204);
            });
        });
});
