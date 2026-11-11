/**
 * notificationProfileUtils — API wrappers for notification profiles.
 * WHAT: read a profile by uuid, find it by name, delete it.
 * WHY: Epic ilm#369 checks what the API returns for `frequency` and `repetitions`, and the UI-created profile must be removed again.
 * HOW: GET /api/v1/notificationProfiles/{uuid} returns the detail DTO (frequency is an ISO 8601 duration);
 *      the list is searched by name; DELETE answers 204.
 */

import { APIRequestContext } from '@playwright/test';
import { Logger } from './Logger';

const logger = new Logger('NotificationProfileUtils');

const PROFILES_API = '/api/v1/notificationProfiles';

export interface NotificationProfileDetail {
    uuid: string;
    name: string;
    frequency?: string;
    repetitions?: number;
    internalNotification: boolean;
    recipientType: string;
    recipients?: Array<{ uuid: string; name: string }>;
}

export async function getNotificationProfile(request: APIRequestContext, uuid: string): Promise<NotificationProfileDetail> {
    const response = await request.get(`${PROFILES_API}/${uuid}`);
    if (!response.ok()) {
        throw new Error(`Failed to read notification profile ${uuid}: ${response.status()} - ${await response.text()}`);
    }
    return (await response.json()) as NotificationProfileDetail;
}

export async function findNotificationProfileByName(request: APIRequestContext, name: string): Promise<{ uuid: string } | null> {
    const response = await request.get(`${PROFILES_API}?itemsPerPage=100&pageNumber=1`);
    if (!response.ok()) {
        throw new Error(`Failed to list notification profiles: ${response.status()} - ${await response.text()}`);
    }
    const body = (await response.json()) as { notificationProfiles?: Array<{ uuid: string; name: string }> };
    return (body.notificationProfiles ?? []).find((p) => p.name === name) ?? null;
}

export async function deleteNotificationProfile(request: APIRequestContext, uuid: string): Promise<void> {
    logger.info(`Deleting notification profile: ${uuid}`);
    const response = await request.delete(`${PROFILES_API}/${uuid}`);
    if (!response.ok() && response.status() !== 404) {
        throw new Error(`Failed to delete notification profile ${uuid}: ${response.status()} - ${await response.text()}`);
    }
}
