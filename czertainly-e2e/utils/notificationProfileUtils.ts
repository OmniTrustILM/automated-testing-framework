/**
 * notificationProfileUtils — removes a notification profile a test created (its reads are in utils/regression/events/notificationProfiles.ts).
 */
import { APIRequestContext } from '@playwright/test';
import { Logger } from './Logger';

const logger = new Logger('NotificationProfileUtils');

export async function deleteNotificationProfile(request: APIRequestContext, uuid: string): Promise<void> {
    logger.info(`Deleting notification profile: ${uuid}`);
    const response = await request.delete(`/api/v1/notificationProfiles/${uuid}`);
    if (!response.ok() && response.status() !== 404) {
        throw new Error(`Failed to delete notification profile ${uuid}: ${response.status()} - ${await response.text()}`);
    }
}
