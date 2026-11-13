/**
 * settings-access — Epic ilm#364, S17: a user without permission to update settings cannot turn automatic ownership on.
 * Not @exclusive: a correct platform refuses and changes nothing; otherwise `finally` puts the value back.
 */

import { test, expect, request as playwrightRequest, APIRequestContext } from '@playwright/test';
import { loadEnv } from '../../../utils/env';
import { Answer, adminApi, apiAs, readAutomaticOwnership, send, setAutomaticOwnership } from '../../../utils/epicOwnership';

test('S17: a user without permission to update settings cannot turn the setting on', { tag: ['@epic-364'] }, async () => {
    const env = loadEnv();
    const grant = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
    let admin: APIRequestContext | undefined;
    let restricted: APIRequestContext | undefined;
    try {
        admin = adminApi(grant, env);
        restricted = apiAs(grant, env, 'R');
        const before = await readAutomaticOwnership(admin);
        let answer: Answer | undefined;
        try {
            answer = await send(restricted, 'PUT', '/api/v1/settings/platform', { certificates: { upload: { automaticOwnership: true } } });
            expect(answer.status, `refused for missing permission: ${answer.text}`).toBe(403);
            expect(await readAutomaticOwnership(admin), 'the setting keeps its value').toBe(before);
        } finally {
            // only a change this test made is undone: the exclusive tests may change the setting in parallel
            if (answer && answer.status < 300 && before !== undefined) await setAutomaticOwnership(admin, before);
        }
    } finally {
        await admin?.dispose();
        await restricted?.dispose();
        await grant.dispose();
    }
});
