import { test, request as pr } from '@playwright/test';
import { loadEnv } from '../../../utils/env';
import { adminApi, apiAs, send } from '../../../utils/epicOwnership';

test('DIAG @epic-364 @diag', async () => {
    const env = loadEnv();
    const b = await pr.newContext({ ignoreHTTPSErrors: true });
    const admin = await adminApi(b, env);
    for (const a of ['U', 'V', 'R'] as const) {
        const api = await apiAs(b, env, a);
        const p = await send(api, 'GET', '/api/v1/auth/profile');
        const j: any = p.json;
        console.log(`DIAG ${a} status ${p.status} roles ${JSON.stringify(j?.roles?.map((r: any) => r.name))}`);
        console.log(`DIAG ${a} perms ${JSON.stringify(j?.permissions ?? j).slice(0, 3000)}`);
    }
    const attrs = await send(admin, 'GET', '/api/v1/attributes/custom');
    console.log(`DIAG attrs ${JSON.stringify((attrs.json as any[])?.map((x) => [x.name, x.resources]))}`.slice(0, 2000));
});
