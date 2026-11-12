/**
 * notification-profile — Epic ilm#369: Frequency and Repetitions are saved on a notification profile.
 */
import { waitForDetailRoute } from '../../../pages/ui/detailRoute';
import { NotificationProfilePage } from '../../../pages/NotificationProfilePage';
import { expect, getAuthenticatedApiContext, loginAsSmokeUser, test } from '../../../fixtures/testFixtures';
import { recordCleanupFailure, statusOf } from '../../../utils/cleanupLedger';
import { uniqueName } from '../../../utils/names';
import { deleteNotificationProfile } from '../../../utils/notificationProfileUtils';
import { getProfile } from '../../../utils/regression/events/notificationProfiles';

test.describe('@epic-369 notification profile', () => {
    let createdUuid: string | undefined;

    test.afterEach(async ({ request, env }) => {
        if (!createdUuid) return;
        const uuid = createdUuid;
        createdUuid = undefined;
        const api = await getAuthenticatedApiContext(request, env);
        try {
            await deleteNotificationProfile(api, uuid);
        } catch (e) {
            recordCleanupFailure({ resource: 'notificationProfile', name: uuid, status: statusOf(e), message: String(e) });
        } finally {
            await api.dispose();
        }
    });

    test('S1: frequency and repetitions are saved on a notification profile', { tag: ['@epic-369'] }, async ({ page, env, api }) => {
        const name = uniqueName('atf-epic369-s1');
        const profiles = new NotificationProfilePage(page);
        await loginAsSmokeUser(page, env);
        await profiles.goToList();
        const answer = await profiles.create({ name, recipientUser: env.username, internal: true, frequency: '1h', repetitions: 2 });
        expect(answer.status, 'the create answer').toBe(201);
        createdUuid = answer.uuid;
        await waitForDetailRoute(page, 'notificationprofiles');

        // reloaded, so the values come from the server and not from the form
        await page.reload();
        await expect(profiles.detailValue('Name')).toHaveText(name);
        await expect(profiles.detailValue('Internal Notification')).toHaveText('Yes');
        await expect(profiles.detailValue('Frequency')).toHaveText('1h');
        await expect(profiles.detailValue('Max Repetitions')).toHaveText('2');

        const read = await getProfile(api, String(createdUuid));
        expect(read.status, 'the profile read').toBe(200);
        expect(read.json?.frequency, 'the frequency as an ISO 8601 duration').toBe('PT1H');
        expect(read.json?.repetitions).toBe(2);
        expect((read.json?.recipients as Array<{ name: string }> | undefined)?.map((r) => r.name)).toEqual([env.username]);
    });
});
