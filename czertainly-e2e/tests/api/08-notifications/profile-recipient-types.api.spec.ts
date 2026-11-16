/**
 * API-WFL-23 — notification profile per recipient type: user, group, role and owner internal-only; none, default and object with an
 * own e-mail instance. ilm#434.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { createOwnGroup } from '../../../utils/regression/ownGroups';
import { createOwnInstance } from '../../../utils/regression/events/notificationInstances';
import { createOwnProfile, durationSeconds, getProfile, listProfiles, RecipientCode } from '../../../utils/regression/events/notificationProfiles';
import { EMAIL_TEMPLATE, emailAttributes, reservedSender } from '../../../utils/regression/events/notificationAttributes';
import { findNotificationConnector, instanceDefinitions } from '../../../utils/regression/events/notificationConnector';
import { createOwnRole } from '../../../utils/regression/ownRoles';
import { createOwnUser } from '../../../utils/regression/ownUsers';
import { testMeta, tags, type Needs } from '../../../utils/regression/tags';

type Json = Record<string, any>;

test.describe('Notification profile per recipient type', { tag: tags.api }, () => {
    const rowMeta = (row: string, rule: string, needs: Needs[] = []) => testMeta({ id: 'API-WFL-23', prio: 'P1', issue: 'ilm#434', needs, rule: [`ilm#434 (notification profile per recipient type), ${row}: ${rule}`] });

    test('internal-only profiles of the four instance-free recipient types are created at version 1', rowMeta('user,group,role,owner', 'internal profile per type; the detail resolves the recipient names'), async ({ api, own }) => {
        const user = await createOwnUser(api, own.spec, 'wf23-user');
        const group = await createOwnGroup(api, own.spec, 'wf23-group');
        const role = await createOwnRole(api, own.spec, 'wf23-role');
        const rows: Array<[RecipientCode, Array<{ uuid: string; name: string }> | undefined]> = [
            ['user', [user]], ['group', [group]], ['role', [role]], ['owner', undefined],
        ];
        for (const [type, recipients] of rows) {
            const profile = await createOwnProfile(api, own.spec, `wf23-${type}`, { recipientType: type, ...(recipients ? { recipients } : {}), internal: true });
            const detail = (await getProfile(api, profile.uuid)).json as Json;
            expect(detail, `${type} profile`).toMatchObject({ uuid: profile.uuid, name: profile.name, version: 1, recipientType: type, internalNotification: true });
            if (recipients) expect((detail.recipients as Json[]).map((r) => r.uuid), `the detail resolves the ${type} recipient`).toEqual(recipients.map((r) => r.uuid));
            else expect(detail.recipients ?? [], 'an owner profile has no recipient uuids').toHaveLength(0);
            expect(detail.notificationInstance ?? null, 'an internal-only profile has no instance').toBeNull();
        }
    });

    for (const type of ['none', 'default', 'object'] as const) {
        test(`a ${type} profile references an e-mail instance and is created at version 1`, rowMeta(type, `${type} profile with an instance`, ['email-provider']), async ({ api, own }) => {
            const connector = await findNotificationConnector(api, 'EMAIL');
            expect(connector, 'the e-mail notification connector the declared need resolved').toBeTruthy();
            const instance = await createOwnInstance(api, own.spec, `wf23-inst-${type}`, { connector: connector!, attributes: emailAttributes(await instanceDefinitions(api, connector!), { sender: reservedSender(), subject: 'QA API-WFL-23', template: EMAIL_TEMPLATE }) });
            const profile = await createOwnProfile(api, own.spec, `wf23-${type}`, { recipientType: type, instance });
            const detail = (await getProfile(api, profile.uuid)).json as Json;
            expect(detail).toMatchObject({ uuid: profile.uuid, name: profile.name, version: 1, recipientType: type, internalNotification: false });
            expect(detail.notificationInstance?.uuid, 'the detail names the instance').toBe(instance.uuid);
        });
    }

    test('frequency and repetitions round-trip in the detail, the list omits them, categories are normalised', rowMeta('frequency', 'P1DT12H round trip; list dto omits; categories deduplicated in enum order'), async ({ api, own }) => {
        const group = await createOwnGroup(api, own.spec, 'wf23-f-group');
        const profile = await createOwnProfile(api, own.spec, 'wf23-freq', { recipientType: 'group', recipients: [group], internal: true, frequency: 'P1DT12H', repetitions: 3, categories: ['metadata', 'associations', 'metadata'] });
        const detail = (await getProfile(api, profile.uuid)).json as Json;
        expect(durationSeconds(detail.frequency), `frequency ${JSON.stringify(detail.frequency)} = 1 day 12 hours`).toBe(129_600);
        expect(detail.repetitions).toBe(3);
        expect(detail.eventDataCategories, 'categories are deduplicated and in enum order (metadata, associations)').toEqual(['metadata', 'associations']);
        const row = (await listProfiles(api)).find((p) => p.uuid === profile.uuid);
        expect(row, 'the list contains the profile').toBeTruthy();
        expect(Object.keys(row!), 'the LIST dto carries neither frequency nor repetitions').not.toEqual(expect.arrayContaining(['frequency']));
        expect(row).not.toHaveProperty('repetitions');
    });
});
