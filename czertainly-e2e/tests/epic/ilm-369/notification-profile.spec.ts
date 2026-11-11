/**
 * WHAT: Epic ilm#369 — Frequency and Repetitions on a notification profile (S1).
 * WHY: repeated notifications for non-compliant certificates are configured on the profile; if the UI or API loses the values, no reminder is ever sent.
 * HOW: create a profile with an internal recipient, Frequency `1h` and Repetitions `2` in the UI; check the detail page;
 *      read the same profile through the API (`frequency` is the ISO 8601 duration, `repetitions` a number); delete it afterwards.
 */

import { recordCleanupFailure, statusOf } from '../../../utils/cleanupLedger';
import { test, expect, loginAsSmokeUser, getAuthenticatedApiContext } from '../../../fixtures/testFixtures';
import { NotificationProfilePage } from '../../../pages/NotificationProfilePage';
import { deleteNotificationProfile, findNotificationProfileByName, getNotificationProfile } from '../../../utils/notificationProfileUtils';
import { uniqueName } from '../../../utils/names';

test.describe('@epic-369 notification profile', () => {
    let profileName: string | undefined;

    test.afterEach(async ({ request, env }) => {
        if (!profileName) return;
        const name = profileName;
        profileName = undefined;
        const api = await getAuthenticatedApiContext(request, env);
        try {
            const found = await findNotificationProfileByName(api, name);
            if (found) await deleteNotificationProfile(api, found.uuid);
        } catch (e) {
            recordCleanupFailure({ resource: 'notificationProfile', name, status: statusOf(e), message: String(e) });
        } finally {
            await api.dispose();
        }
    });

    test('S1: frequency and repetitions are saved on a notification profile', { tag: ['@epic-369'] }, async ({ page, request, env }) => {
        const name = uniqueName('atf-epic369-s1');
        profileName = name;
        const profiles = new NotificationProfilePage(page);

        // 1. Create a profile with an internal recipient, Frequency 1h and Repetitions 2 in the UI.
        await loginAsSmokeUser(page, env);
        await profiles.goToList();
        const uuid = await profiles.create({ name, recipientUser: env.username, internal: true, frequency: '1h', repetitions: 2 });

        // 2. The detail shows the saved values ...
        await expect(profiles.detailValue('Name')).toHaveText(name);
        await expect(profiles.detailValue('Internal Notification')).toHaveText('Yes');
        await expect(profiles.detailValue('Frequency')).toHaveText('1h');
        await expect(profiles.detailValue('Max Repetitions')).toHaveText('2');

        // ... and the API returns the ISO duration and the number.
        const api = await getAuthenticatedApiContext(request, env);
        try {
            const profile = await getNotificationProfile(api, uuid);
            expect(profile.frequency).toBe('PT2H');
            expect(profile.repetitions).toBe(2);
        } finally {
            await api.dispose();
        }
    });
});
