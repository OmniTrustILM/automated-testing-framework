/**
 * ac7-baseline — Epic ilm#367 AC7 ("Pages do not load noticeably slower"): load times of three detail pages, per user,
 * before and after the frontend gating stack. A measurement, not a check: it fails only when a user cannot sign in.
 * Run on the Testkube Epic workflow with grep @ilm-367-ac7-baseline; the result is printed and attached as JSON.
 *
 * Ready time = from the navigation to the end of the last /api/ response, once no /api/ request was in flight for 1 s.
 * Each sample is a full document load (about:blank → detail URL), so the app boots and loads the profile every time.
 */
import { Page, test } from '@playwright/test';
import fs from 'node:fs';

const RUNS = Number(process.env.AC7_RUNS || 10);
const QUIET_MS = 1000;

const OBJECTS = {
    certificate: { uuid: 'ed2fb4f4-e335-4f53-b90a-b5f67f5ab0a1', path: (u: string) => `certificates/detail/${u}` },
    // key wrapper of the certificate qa-baseline-ilm259-leaf-rsa (the key list's `keyWrapperUuid`; its `uuid` is a key item)
    key: { uuid: '37751267-9d2e-459e-85d7-1d0da459d230', path: (u: string) => `keys/detail/${u}` },
    raProfile: {
        uuid: '7f7d664f-62f1-4a6b-8e92-36f58677d424',
        path: (u: string) => `raprofiles/detail/7d25ae89-d080-4a37-8f35-cd674e666da4/${u}`,
    },
};

const USERS = [
    { id: 'admin', username: process.env.SMOKE_USERNAME, password: process.env.SMOKE_PASSWORD },
    { id: 'U', username: process.env.EPIC_USER_U_USERNAME, password: process.env.EPIC_USER_U_PASSWORD },
    { id: 'V', username: process.env.EPIC_USER_V_USERNAME, password: process.env.EPIC_USER_V_PASSWORD },
    { id: 'R', username: process.env.EPIC_USER_R_USERNAME, password: process.env.EPIC_USER_R_PASSWORD },
];

interface Sample { readyMs: number; calls: string[]; statuses: Record<string, number> }

function appUrl(path = ''): string {
    return new URL('administrator/', process.env.BASE_URL).toString() + (path ? `#/${path}` : '');
}

async function signIn(page: Page, username: string, password: string): Promise<void> {
    await page.goto(appUrl());
    const user = page.getByRole('textbox', { name: 'Username' });
    try {
        await user.waitFor({ timeout: 5_000 });
    } catch {
        await page.getByRole('button', { name: process.env.LOCAL_AUTH_PROVIDER_NAME || 'Internal', exact: true }).click();
        await user.waitFor();
    }
    await user.fill(username);
    await page.getByRole('textbox', { name: 'Password' }).fill(password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.getByTestId('sidebar-sticky').waitFor({ timeout: 30_000 });
}

async function load(page: Page, path: string): Promise<Sample> {
    const inflight = new Set<unknown>();
    const calls: string[] = [];
    const statuses: Record<string, number> = {};
    let lastEnd = 0;
    const t0 = Date.now();
    const onReq = (r: { url(): string }) => { if (r.url().includes('/api/')) inflight.add(r); };
    const onDone = async (r: { url(): string; method(): string; response(): Promise<{ status(): number } | null> }) => {
        if (!inflight.has(r)) return;
        inflight.delete(r);
        lastEnd = Date.now();
        const call = `${r.method()} ${new URL(r.url()).pathname}`;
        calls.push(call);
        const res = await r.response().catch(() => null);
        statuses[call] = res ? res.status() : 0;
    };
    page.on('request', onReq);
    page.on('requestfinished', onDone);
    page.on('requestfailed', onDone);
    await page.goto('about:blank');
    await page.goto(appUrl(path));
    let quietSince = Date.now();
    for (;;) {
        await page.waitForTimeout(100);
        if (inflight.size) quietSince = Date.now();
        else if (lastEnd && Date.now() - quietSince >= QUIET_MS) break;
        if (Date.now() - t0 > 60_000) break;
    }
    page.off('request', onReq);
    page.off('requestfinished', onDone);
    page.off('requestfailed', onDone);
    return { readyMs: lastEnd - t0, calls, statuses };
}

const median = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

test.describe.configure({ mode: 'serial' });

test.describe('@ilm-367-ac7-baseline detail page load times', () => {
    for (const u of USERS) {
        test(`user ${u.id}`, async ({ browser }, testInfo) => {
            test.setTimeout(15 * 60_000);
            test.skip(!u.username || !u.password, `no credentials for user ${u.id}`);
            const context = await browser.newContext();
            const page = await context.newPage();
            await signIn(page, u.username!, u.password!);
            // read after sign-in through the session cookie (a listener before sign-in caught the unauthenticated answer)
            const profileRes = await page.request.get(new URL('api/v1/auth/profile', process.env.BASE_URL).toString());
            const profile = await profileRes.json().catch(() => ({}));
            const certActions = (profile.permissions?.allowedActions ?? profile.allowedActions ?? []) as unknown;
            console.log(`AC7-PROFILE ${u.id} status ${profileRes.status()} ${JSON.stringify({ roles: profile.roles, allowedListings: profile.allowedListings, allowedActions: certActions }).slice(0, 1500)}`);
            const result: Record<string, unknown> = {
                takenAt: new Date().toISOString(), user: u.id, username: u.username, runs: RUNS, quietMs: QUIET_MS,
                roles: (profile.roles ?? []).map((r: { name: string }) => r.name),
                allowAllResources: profile.permissions?.allowAllResources ?? null,
                allowedListings: profile.allowedListings ?? null,
                pages: {},
            };
            for (const [name, o] of Object.entries(OBJECTS)) {
                const path = o.path(o.uuid);
                await load(page, path); // warm-up, discarded
                const samples: Sample[] = [];
                for (let i = 0; i < RUNS; i++) samples.push(await load(page, path));
                const ms = samples.map((s) => s.readyMs);
                const notOk = Object.entries(samples[0].statuses).filter(([, st]) => st >= 400);
                (result.pages as Record<string, unknown>)[name] = {
                    path, medianMs: median(ms), minMs: Math.min(...ms), maxMs: Math.max(...ms), samplesMs: ms,
                    allowedActionsCalled: samples.some((s) => s.calls.some((c) => c.includes('allowed-actions'))),
                    apiCallsPerLoad: samples[0].calls.length, failedCalls: notOk, calls: samples[0].calls,
                };
                console.log(`AC7 ${u.id} ${name} median ${median(ms)} ms [${ms.join(',')}] failed calls: ${JSON.stringify(notOk)}`);
            }
            const json = JSON.stringify(result, null, 2);
            console.log(`AC7-RESULT ${u.id} ${JSON.stringify(result)}`);
            fs.mkdirSync('test-results', { recursive: true });
            fs.writeFileSync(`test-results/ilm-367-ac7-${u.id}.json`, json);
            await testInfo.attach(`ilm-367-ac7-${u.id}.json`, { body: json, contentType: 'application/json' });
            await context.close();
        });
    }
});
