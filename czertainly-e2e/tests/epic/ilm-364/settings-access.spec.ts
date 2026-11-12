/**
 * settings-access — Epic ilm#364, S17: a user without permission to update settings cannot turn the automatic ownership setting on.
 *
 * WHAT: user R (certificate create only) sends the settings update; it must be refused and the setting must keep its value.
 * WHY:  the setting hands owner rights to every uploader, so who may change it is part of the Epic's security surface.
 * HOW:  not @exclusive: a correct platform refuses the request and changes nothing. If it does not refuse, the setting is put back by
 *       the administrator in `finally`, so a failing run does not leave the platform changed.
 */

import { test, expect, request as playwrightRequest, APIRequestContext } from '@playwright/test';
import { loadEnv } from '../../../utils/env';
import { adminApi, apiAs, readAutomaticOwnership, send, setAutomaticOwnership } from '../../../utils/epicOwnership';

test('S17: a user without permission to update settings cannot turn the setting on', { tag: ['@epic-364'] }, async () => {
    const env = loadEnv();
    const bootstrap = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
    let admin: APIRequestContext | undefined;
    let restricted: APIRequestContext | undefined;
    try {
        admin = await adminApi(bootstrap, env);
        restricted = await apiAs(bootstrap, env, 'R');
        const before = await readAutomaticOwnership(admin);
        try {
            const answer = await send(restricted, 'PUT', '/api/v1/settings/platform', { certificates: { upload: { automaticOwnership: !before } } });
            expect(answer.status, `refused for missing permission: ${answer.text}`).toBe(403);
            expect(await readAutomaticOwnership(admin), 'the setting keeps its value').toBe(before);
        } finally {
            if ((await readAutomaticOwnership(admin)) !== before) await setAutomaticOwnership(admin, before);
        }
    } finally {
        await bootstrap.dispose();
        await admin?.dispose();
        await restricted?.dispose();
    }
});
