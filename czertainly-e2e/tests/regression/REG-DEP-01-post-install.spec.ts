/**
 * REG-DEP-01 — New ILM deployment: the QA-side post-install check (release checklist: Deployment 1).
 * DevOps installs; this checks the result, read-only: core version, the required connectors are registered (the base test
 * no longer judges the STORED `connected` flag: whether they are alive is .d's oracle), the Version Info dialog shows
 * core, frontend and database versions, the connector detail pages open.
 *
 * B1 (platform rows, ilm#425): REG-DEP-01.a / .b anonymous health bodies (they replace the authenticated `status`
 * check the release spec had), .c the `/info` contract, .d the required connectors are ALIVE (live health by version
 * and one read-only attribute call), not only stored `connected` — the stored status gave a false pass while the
 * MS-ADCS-NG connector answered 503 (Phase 1 §10b). The health probes run on the anonymous `request` fixture.
 *
 * Env: REG_REQUIRED_CONNECTORS (comma list, default Common-Credential-Connector,MS-ADCS-NG-Connector),
 *      REG_BLOCKED_CONNECTORS (`name:reason;…`: that connector's .d test is skipped with the reason — an environment
 *      blocker with a Blockers row in the workflow README, never a pass),
 *      REG_EXPECTED_CORE_VERSION / REG_EXPECTED_FE_VERSION (exact versions of the release, optional),
 *      REG_STRICT_VERSIONS=true (fail when core and frontend major.minor differ; default: annotate only).
 * REG-DEP-02 (upgrade) is a local-stack spec of batch B4.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import {
    ACCEPT_JSON, blockedConnectors, describeHealth, findConnector, healthByVersion, PROBE_PATHS, probeAttributes, readProbe, requiredConnectors,
} from '../../utils/regression/connectorApi';
import { apiJson } from '../../utils/regression/regressionApi';
import { meta } from '../../utils/regression/tags';
import { isLocalTier } from '../../utils/regression/tier';

const required = requiredConnectors();
const majorMinor = (v: string) => /(\d+\.\d+)/.exec(v)?.[1] ?? v;
/**
 * REG-DEP-01.a latency budget (Fable F4), measured from the RUNNER: the ledger's 2 s was the initial server-side budget of
 * a probe that answers from memory; a runner outside the cluster adds DNS, TLS and the ingress / VPN round trip (a few
 * hundred ms each on a remote tier). 5 s keeps a hard bound that still catches a hanging probe; the measured time is
 * annotated on every run so Phase 9 can tighten it from data.
 */
const HEALTH_BUDGET_MS = 5_000;

interface CoreInfo {
    app: { name: string; version: string };
    build: { timestamp?: string; branch?: string; commitId?: string };
    db: { system: string; version: string };
}

test.describe('@regression REG-DEP-01 post-install check', () => {
    // B1 fix pass (Sonnet F11): this release-check test no longer passes on the STORED `connected` flag — it checks the
    // registry lists the required connectors and their pages open; whether they are alive is REG-DEP-01.d's oracle.
    test('versions, the Version Info dialog and the connector registry (liveness: REG-DEP-01.d)', async ({ page, api, env }, testInfo) => {
        const info = await test.step('Core version (GET /api/v1/info)', async () => {
            const body = await apiJson<CoreInfo>(api, 'GET', '/api/v1/info');
            expect(body.app.version).toMatch(/^\d+\.\d+\.\d+/);
            if (process.env.REG_EXPECTED_CORE_VERSION) expect(body.app.version).toBe(process.env.REG_EXPECTED_CORE_VERSION);
            return body;
        });
        const coreVersion = info.app.version;

        const connectorUuids = await test.step(`The registry lists the required connectors: ${required.join(', ')}`, async () => {
            const connectors = await apiJson<Array<{ name: string; status: string; uuid: string }>>(api, 'GET', '/api/v1/connectors');
            const uuids: Record<string, string> = {};
            for (const name of required) {
                const c = connectors.find((x) => x.name === name);
                expect(c, `connector ${name} is registered`).toBeTruthy();
                uuids[name] = c!.uuid;
            }
            return uuids;
        });

        await test.step('Version Info dialog shows the core, frontend and database versions', async () => {
            await loginAsSmokeUser(page, env);
            await page.getByRole('button', { name: 'Version Info' }).click();
            const dialog = page.getByRole('dialog').last();
            await expect(dialog).toContainText('ILM Core');
            await expect(dialog).toContainText(coreVersion);
            // REG-DEP-01.c (UI half): the dialog shows the same database version as /v1/info.
            await expect(dialog).toContainText(info.db.version);
            await expect(dialog).toContainText('ILM Frontend');
            const text = (await dialog.innerText()).replace(/\s+/g, ' ');
            const fe = /ILM Frontend (\d+\.\d+\.\d+[\w.-]*)/.exec(text)?.[1] ?? '';
            expect(fe, 'frontend version').toMatch(/^\d+\.\d+\.\d+/);
            if (process.env.REG_EXPECTED_FE_VERSION) expect(fe).toBe(process.env.REG_EXPECTED_FE_VERSION);
            if (majorMinor(fe) !== majorMinor(coreVersion)) {
                testInfo.annotations.push({ type: 'version-skew', description: `frontend ${fe} vs core ${coreVersion}` });
                if (process.env.REG_STRICT_VERSIONS === 'true') expect(majorMinor(fe), 'frontend and core major.minor').toBe(majorMinor(coreVersion));
            }
            await page.keyboard.press('Escape');
        });

        await test.step('Each required connector detail page opens and names the connector (the list pages at 10 rows)', async () => {
            for (const name of required) {
                await page.goto(`administrator/#/connectors/detail/${connectorUuids[name]}`);
                await expect(page.locator('main')).toContainText(name);
            }
        });
    });

    test(`REG-DEP-01.a: anonymous liveness and readiness answer 200 with exactly {"status":"UP"} within ${HEALTH_BUDGET_MS / 1000} s`,
        meta({
            id: 'REG-DEP-01.a', prio: 'P1', issue: 'ilm#425',
            rule: ['platform-keys-connectors A1 r9 / r10 (health groups public, liveness / readiness body exactly {"status":"UP"}; the compose healthcheck greps it); Phase 2 §B'],
        }),
        async ({ request }, testInfo) => {
            for (const which of ['liveness', 'readiness'] as const) {
                await test.step(`GET ${PROBE_PATHS[which]} without credentials`, async () => {
                    const started = Date.now();
                    const p = await readProbe(await request.get(PROBE_PATHS[which], { headers: ACCEPT_JSON }), Date.now() - started);
                    expect(p.status, p.text.slice(0, 200)).toBe(200);
                    expect(p.contentType).toMatch(/json/);
                    expect(p.json).toEqual({ status: 'UP' });
                    testInfo.annotations.push({ type: 'latency', description: `${which}: ${p.elapsedMs} ms from the runner` });
                    expect(p.elapsedMs, `${which} answered within ${HEALTH_BUDGET_MS} ms (runner to tier)`).toBeLessThan(HEALTH_BUDGET_MS);
                });
            }
        });

    test('REG-DEP-01.b: anonymous /health answers 200 with exactly {"status":"UP","groups":["liveness","readiness"]}',
        meta({
            id: 'REG-DEP-01.b', prio: 'P1', issue: 'ilm#425',
            rule: ['platform-keys-connectors A1 r9 (anonymous /health), r11 (only Boot\'s two default groups, no group configuration), C5 (no components for an anonymous caller)'],
        }),
        async ({ request }) => {
            const started = Date.now();
            const p = await readProbe(await request.get(PROBE_PATHS.health, { headers: ACCEPT_JSON }), Date.now() - started);
            expect(p.status, p.text.slice(0, 200)).toBe(200);
            expect(p.json).toEqual({ status: 'UP', groups: ['liveness', 'readiness'] });
        });

    test('REG-DEP-01.c: /info needs authentication; authenticated it has exactly app, build and db with the documented fields',
        meta({
            id: 'REG-DEP-01.c', prio: 'P1', issue: 'ilm#425',
            rule: ['platform-keys-connectors A1 r10 (/info needs authentication) and r12 (CoreInfoResponseDto: app {name, version}, build {timestamp, branch, commitId}, db {system, version})'],
        }),
        async ({ api, request }, testInfo) => {
            await test.step('Anonymous GET /api/v1/info → 401, no `app` in the body', async () => {
                const started = Date.now();
                const anon = await readProbe(await request.get(PROBE_PATHS.info, { headers: ACCEPT_JSON }), Date.now() - started);
                if (isLocalTier()) {
                    // PKC A1 Q3: on a local stack the call may be seen as the localhost identity (or pass the dev proxy).
                    testInfo.annotations.push({ type: 'local-stack', description: `anonymous /info answered ${anon.status} (recorded, not asserted on a local stack)` });
                    return;
                }
                expect(anon.status).toBe(401);
                expect((anon.json as { app?: unknown } | undefined)?.app, 'no app document for an anonymous caller').toBeUndefined();
            });

            await test.step('Authenticated GET /api/v1/info → 200 with the documented document', async () => {
                const res = await api.get(PROBE_PATHS.info);
                expect(res.status()).toBe(200);
                const body = (await res.json()) as CoreInfo;
                expect(Object.keys(body).sort()).toEqual(['app', 'build', 'db']);
                expect(body.app.name).toBe('ILM Core');
                expect(body.app.version).toMatch(/^\d+\.\d+\.\d+/);
                expect(Number.isNaN(Date.parse(String(body.build.timestamp))), 'build.timestamp parses as an instant').toBe(false);
                if (body.app.version.endsWith('-SNAPSHOT')) {
                    expect(body.build.commitId, 'a SNAPSHOT build names its commit').toBeTruthy();
                    expect(body.build.branch, 'a SNAPSHOT build names its branch').toBeTruthy();
                } else {
                    expect(body.build.commitId ?? null, 'a release build carries no commit id').toBeNull();
                    expect(body.build.branch ?? null, 'a release build carries no branch').toBeNull();
                }
                expect(body.db.system).toBe('PostgreSQL');
                expect(String(body.db.version ?? '')).not.toBe('');
            });
        });

    for (const name of required) {
        test(`REG-DEP-01.d[${name}]: the required connector is alive (live health by version, one read-only attribute call), not only stored connected`,
            meta({
                id: 'REG-DEP-01.d', prio: 'P1', issue: 'ilm#425',
                rule: [
                    'platform-keys-connectors A4 r14 (health by version: v1 HealthDto status ok, v2 HealthInfo status UP), M6',
                    'Phase 1 §10b (false pass on the stored `connected` status while the health answered 503); core#2461',
                ],
            }),
            async ({ api }) => {
                const blocked = blockedConnectors().get(name);
                test.skip(!!blocked, `environment blocker (REG_BLOCKED_CONNECTORS): ${blocked}`);
                const connector = await test.step('Registered, stored status connected', async () => {
                    const c = await findConnector(api, name);
                    expect(c, `connector ${name} is registered`).toBeTruthy();
                    expect(c!.status, `connector ${name}: stored status`).toBe('connected');
                    return c!;
                });
                const health = await test.step('Live health by the version of the connector detail', async () => {
                    const h = await healthByVersion(api, connector);
                    expect(h.version, `connector ${name}: version from the connector detail`).toBeDefined();
                    expect(h.healthy, describeHealth(h)).toBe(true);
                    return h;
                });
                await test.step('One read-only attribute call through the connector', async () => {
                    const probe = await probeAttributes(api, connector, health.version!);
                    expect(probe.ok, `connector ${name}: stored connected, ${probe.what}: ${probe.why}`).toBe(true);
                });
            });
    }
});
