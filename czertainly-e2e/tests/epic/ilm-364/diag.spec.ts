import { test, request as pr } from '@playwright/test';
import { loadEnv } from '../../../utils/env';
import { certificate } from '../../../utils/regression/inventory/importFixtures';
import { readSmokeState } from '../../../utils/smokeState';
import { Cleanup, adminApi, apiAs, createCustomAttribute, createGroup, createUploadTrigger, commonNameIs, send, setAutomaticOwnership, subjectOf, upload } from '../../../utils/epicOwnership';

test('DIAG @epic-364 @diag', async () => {
    test.setTimeout(180_000);
    const env = loadEnv();
    const b = await pr.newContext({ ignoreHTTPSErrors: true });
    const admin = await adminApi(b, env);
    const U = await apiAs(b, env, 'U');
    const st = readSmokeState()!;
    await setAutomaticOwnership(admin, true);
    for (const variant of ['group', 'ra', 'custom']) {
        const cleanup = new Cleanup();
        try {
            const cn = subjectOf(`diag${Date.now()}`, variant);
            const c = certificate(cn);
            cleanup.certificate(c.fingerprint);
            const group = await createGroup(admin, cleanup, `diag-${Date.now()}-${variant}-g`);
            const attr = await createCustomAttribute(admin, cleanup, `diag-${Date.now()}-${variant}-a`);
            const f = variant === 'group' ? { fieldSource: 'property', fieldIdentifier: 'GROUP_NAME', data: [group.uuid] }
                : variant === 'ra' ? { fieldSource: 'property', fieldIdentifier: 'RA_PROFILE_NAME', data: st.raProfileUuid }
                : { fieldSource: 'custom', fieldIdentifier: `${attr.name}|STRING`, data: 'x' };
            await createUploadTrigger(admin, cleanup, { name: `diag-${Date.now()}-${variant}`, conditions: [commonNameIs(cn)], setFields: [f] });
            const a = await upload(U, c.pem);
            console.log(`DIAG ${variant}: ${a.status} ${a.text.slice(0, 300)}`);
        } finally {
            await cleanup.run(admin);
        }
    }
    await setAutomaticOwnership(admin, false);
});
