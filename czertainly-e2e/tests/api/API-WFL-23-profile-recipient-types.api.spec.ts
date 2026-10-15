/**
 * API-WFL-23 — one profile per recipient type is created and read back: USER, GROUP, ROLE (with uuids of OWN objects), OWNER,
 * NONE, DEFAULT, OBJECT (without); frequency and repetitions round-trip in the DETAIL while the LIST dto omits them; the event data
 * categories are normalised (deduplicated, enum order) (ilm#434 step 5; T10 R10, R11, R17, R20; P-01, P-11).
 *
 * Shared-tier safety: USER / GROUP / ROLE / OWNER profiles are INTERNAL-only (no instance, no connector: guard 5); NONE / DEFAULT /
 * OBJECT cannot be internal, so they reference one own e-mail instance (`@needs:email-provider`; reserved sender, nothing
 * delivered). Every profile starts at version 1; the detail resolves the recipient names. This spec also creates the internal-only
 * profile the firing rows (API-WFL-27) use on a shared tier.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnGroup } from '../../utils/regression/eventsDrivers';
import {
    createOwnInstance, createOwnProfile, durationSeconds, EMAIL_TEMPLATE, emailAttributes, findNotificationConnector, getProfile, instanceDefinitions, listProfiles, RecipientCode,
    reservedSender,
} from '../../utils/regression/notificationApi';
import { createOwnRole, createOwnUser } from '../../utils/regression/regressionApi';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-WFL-23';
type Json = Record<string, any>;

test.describe('API-WFL-23 notification profile per recipient type', { tag: tags.api }, () => {
    const m = (row: string, rule: string, needs: string[] = []) => meta({ id: 'API-WFL-23', prio: 'P1', issue: 'ilm#434', needs, rule: [`T10 R10 / R11 / R17 / R20: P-N23 ${row}: ${rule}`] });

    test('API-WFL-23[user,group,role,owner]: internal-only profiles of the four recipient types that need no instance are created at version 1 and resolve their recipients', m('user,group,role,owner', 'internal profile per type'), async ({ api }) => {
        const user = await createOwnUser(api, 'wf23-user', SPEC);
        const group = await createOwnGroup(api, SPEC, 'wf23-group');
        const role = await createOwnRole(api, 'wf23-role', SPEC);
        const rows: Array<[RecipientCode, Array<{ uuid: string; name: string }> | undefined]> = [
            ['user', [user]], ['group', [group]], ['role', [role]], ['owner', undefined],
        ];
        for (const [type, recipients] of rows) {
            const profile = await createOwnProfile(api, SPEC, { suffix: `wf23-${type}`, recipientType: type, ...(recipients ? { recipients } : {}), internal: true });
            const detail = (await getProfile(api, profile.uuid)).json as Json;
            expect(detail, `${type} profile`).toMatchObject({ uuid: profile.uuid, name: profile.name, version: 1, recipientType: type, internalNotification: true });
            if (recipients) expect((detail.recipients as Json[]).map((r) => r.uuid), `the detail resolves the ${type} recipient`).toEqual(recipients.map((r) => r.uuid));
            else expect(detail.recipients ?? [], 'an owner profile has no recipient uuids').toHaveLength(0);
            expect(detail.notificationInstance ?? null, 'an internal-only profile has no instance').toBeNull();
        }
    });

    for (const type of ['none', 'default', 'object'] as const) {
        test(`API-WFL-23[${type}]: a ${type} profile references an e-mail instance and is created at version 1`, m(type, `${type} profile with an instance`, ['email-provider']), async ({ api }) => {
            const connector = await findNotificationConnector(api, 'EMAIL');
            test.skip(!connector || !!connector.unhealthy, 'deploy gate: no healthy e-mail notification connector on this tier (@needs:email-provider)');
            const instance = await createOwnInstance(api, SPEC, { suffix: `wf23-inst-${type}`, connector: connector!, attributes: emailAttributes(await instanceDefinitions(api, connector!), { sender: reservedSender(), subject: 'QA API-WFL-23', template: EMAIL_TEMPLATE }) });
            const profile = await createOwnProfile(api, SPEC, { suffix: `wf23-${type}`, recipientType: type, instance });
            const detail = (await getProfile(api, profile.uuid)).json as Json;
            expect(detail).toMatchObject({ uuid: profile.uuid, name: profile.name, version: 1, recipientType: type, internalNotification: false });
            expect(detail.notificationInstance?.uuid, 'the detail names the instance').toBe(instance.uuid);
        });
    }

    test('API-WFL-23[frequency]: frequency and repetitions round-trip in the detail, the list omits them, categories are normalised', m('frequency', 'P1DT12H round trip; list dto omits; categories deduplicated in enum order'), async ({ api }) => {
        const group = await createOwnGroup(api, SPEC, 'wf23-f-group');
        const profile = await createOwnProfile(api, SPEC, {
            suffix: 'wf23-freq', recipientType: 'group', recipients: [group], internal: true, frequency: 'P1DT12H', repetitions: 3, categories: ['metadata', 'associations', 'metadata'],
        });
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
