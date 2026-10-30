/**
 * REG-DEP-01 — The QA post-install check of a new ILM deployment (release checklist: Deployment 1; ilm#425).
 *
 * Checks the core version, the required connectors, the Version Info dialog and each connector's detail page. Rows: (.a)
 * anonymous liveness and readiness; (.b) anonymous /health; (.c) /info for an authenticated caller, 401 for an anonymous
 * one (not asserted on a local stack); (.d) every required connector answers its live health, not only the stored
 * `connected` (core#2461).
 *
 * Read-only. Settings: the REG_* connector and version settings (see .env.example); a connector named as blocked skips
 * with its reason. The 5 s latency budget is measured from the runner, which adds DNS, TLS and ingress time.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { ACCEPT_JSON, blockedConnectors, describeHealth, findConnector, healthByVersion, listConnectors, PROBE_PATHS, probeAttributes, requiredConnectors } from '../../../utils/regression/platform/connectorApi';
import { apiJson, answerOf } from '../../../utils/regression/apiReads';
import { testMeta, tags } from '../../../utils/regression/tags';
import { isLocalTier } from '../../../utils/regression/tier/kind';

const required = requiredConnectors();
const majorMinor = (v: string) => /(\d+\.\d+)/.exec(v)?.[1] ?? v;
/**
 * The liveness / readiness latency budget, measured from the RUNNER: 2 s was the first server-side budget of
 * a probe that answers from memory; a runner outside the cluster adds DNS, TLS and the ingress / VPN round trip (a few
 * hundred ms each on a remote tier). 5 s keeps a hard bound that still catches a hanging probe; the measured time is
 * annotated on every run so the budget can be tightened from data later.
 */
const HEALTH_BUDGET_MS = 5_000;

interface CoreInfo {
    app: { name: string; version: string };
    build: { timestamp?: string; branch?: string; commitId?: string };
    db: { system: string; version: string };
}

/** The registered required connectors by name; a missing one fails the test that asks. */
async function registeredRequired(api: Parameters<typeof listConnectors>[0]): Promise<Record<string, string>> {
    const connectors = await listConnectors(api);
    const uuids: Record<string, string> = {};
    for (const name of required) {
        const connector = connectors.find((c) => c.name === name);
        expect(connector, `connector ${name} is registered`).toBeTruthy();
        uuids[name] = connector!.uuid;
    }
    return uuids;
}

test.describe('Post-install check', { tag: tags.regression }, () => {
    // The release check does not pass on the STORED `connected` flag: whether the connectors are alive is the
    // per-connector test below.
    test('core version, Version Info dialog and the registry of the required connectors are as released',
        testMeta({
            id: 'REG-DEP-01', prio: 'P1', issue: 'ilm#425',
            rule: ['core and frontend versions, the Version Info dialog (core, frontend, database), the required connectors registered'],
        }),
        async ({ signedIn: page, api, regressionEnv }, testInfo) => {
            const info = await test.step('Core version (GET /api/v1/info)', async () => {
                const body = await apiJson<CoreInfo>(api, 'GET', '/api/v1/info');
                expect(body.app.version).toMatch(/^\d+\.\d+\.\d+/);
                if (regressionEnv.expectedCoreVersion) expect(body.app.version).toBe(regressionEnv.expectedCoreVersion);
                return body;
            });
            const coreVersion = info.app.version;

            await test.step(`The registry lists the required connectors: ${required.join(', ')}`, async () => {
                await registeredRequired(api);
            });

            await test.step('Version Info dialog shows the core, frontend and database versions', async () => {
                await page.getByRole('button', { name: 'Version Info' }).click();
                const dialog = page.getByRole('dialog').last();
                await expect(dialog).toContainText('ILM Core');
                await expect(dialog).toContainText(coreVersion);
                // The UI half of the /info contract: the dialog shows the same database version as /v1/info.
                await expect(dialog).toContainText(info.db.version);
                await expect(dialog).toContainText('ILM Frontend');
                const text = (await dialog.innerText()).replace(/\s+/g, ' ');
                const frontend = /ILM Frontend (\d+\.\d+\.\d+[\w.-]*)/.exec(text)?.[1] ?? '';
                expect(frontend, 'frontend version').toMatch(/^\d+\.\d+\.\d+/);
                if (regressionEnv.expectedFeVersion) expect(frontend).toBe(regressionEnv.expectedFeVersion);
                if (majorMinor(frontend) !== majorMinor(coreVersion)) {
                    testInfo.annotations.push({ type: 'version-skew', description: `frontend ${frontend} vs core ${coreVersion}` });
                    if (regressionEnv.strictVersions) expect(majorMinor(frontend), 'frontend and core major.minor').toBe(majorMinor(coreVersion));
                }
                await page.keyboard.press('Escape');
            });
        });

    test('each required connector has a detail page that opens and names it',
        testMeta({
            id: 'REG-DEP-01', row: 'connector-detail-pages', prio: 'P1', issue: 'ilm#425',
            rule: ['each required connector has a detail page that opens and names it (the list pages at 10 rows)'],
        }),
        async ({ signedIn: page, api }) => {
            const connectorUuids = await registeredRequired(api);
            for (const name of required) {
                await test.step(`Detail page of ${name}`, async () => {
                    await page.goto(`/administrator/#/connectors/detail/${connectorUuids[name]}`);
                    await expect(page.locator('main'), `the detail page names ${name}`).toContainText(name);
                });
            }
        });

    test(`anonymous liveness and readiness answer 200 with exactly {"status":"UP"} within ${HEALTH_BUDGET_MS / 1000} s`,
        testMeta({
            id: 'REG-DEP-01.a', prio: 'P1', issue: 'ilm#425',
            rule: ['health groups public, liveness / readiness body exactly {"status":"UP"}; the compose healthcheck greps it'],
        }),
        async ({ request }, testInfo) => {
            for (const which of ['liveness', 'readiness'] as const) {
                await test.step(`GET ${PROBE_PATHS[which]} without credentials`, async () => {
                    const started = Date.now();
                    const answer = await answerOf(await request.get(PROBE_PATHS[which], { headers: ACCEPT_JSON }), started);
                    expect(answer.status, answer.text.slice(0, 200)).toBe(200);
                    expect(answer.contentType).toMatch(/json/);
                    expect(answer.json).toEqual({ status: 'UP' });
                    testInfo.annotations.push({ type: 'latency', description: `${which}: ${answer.elapsedMs} ms from the runner` });
                    expect(answer.elapsedMs, `${which} answered within ${HEALTH_BUDGET_MS} ms (runner to tier)`).toBeLessThan(HEALTH_BUDGET_MS);
                });
            }
        });

    test('anonymous /health answers 200 with exactly the status UP and the liveness and readiness groups',
        testMeta({
            id: 'REG-DEP-01.b', prio: 'P1', issue: 'ilm#425',
            rule: ['anonymous /health; only Boot\'s two default groups, no group configuration; no components for an anonymous caller'],
        }),
        async ({ request }) => {
            const started = Date.now();
            const answer = await answerOf(await request.get(PROBE_PATHS.health, { headers: ACCEPT_JSON }), started);
            expect(answer.status, answer.text.slice(0, 200)).toBe(200);
            expect(answer.json).toEqual({ status: 'UP', groups: ['liveness', 'readiness'] });
        });

    test('/info answers an authenticated caller exactly app, build and db with the documented fields',
        testMeta({
            id: 'REG-DEP-01.c', prio: 'P1', issue: 'ilm#425',
            rule: ['/info needs authentication; CoreInfoResponseDto: app {name, version}, build {timestamp, branch, commitId}, db {system, version}'],
        }),
        async ({ api }) => {
            await test.step('Authenticated GET /api/v1/info → 200 with the documented document', async () => {
                const res = await api.get(PROBE_PATHS.info);
                expect(res.status()).toBe(200);
                const body = (await res.json()) as CoreInfo;
                expect(Object.keys(body).sort()).toEqual(['app', 'build', 'db']);
                expect(body.app, 'app').toMatchObject({ name: 'ILM Core', version: expect.stringMatching(/^\d+\.\d+\.\d+/) });
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

    test('/info refuses an anonymous caller with 401 and no app document',
        testMeta({
            id: 'REG-DEP-01.c', row: 'anonymous', prio: 'P1', issue: 'ilm#425',
            rule: ['/info needs authentication: an anonymous GET is 401 and carries no `app` document; not asserted on a local stack, where the call may be seen as the localhost identity or pass the dev proxy'],
        }),
        async ({ request }) => {
            test.skip(isLocalTier(), 'local stack: an anonymous call may be seen as the localhost identity (or pass the dev proxy), so the 401 is not asserted there');
            const started = Date.now();
            const anonymous = await answerOf(await request.get(PROBE_PATHS.info, { headers: ACCEPT_JSON }), started);
            expect(anonymous.status).toBe(401);
            expect((anonymous.json as { app?: unknown } | undefined)?.app, 'no app document for an anonymous caller').toBeUndefined();
        });

    for (const name of required) {
        test(`the required connector ${name} is alive, not only stored as connected`,
            testMeta({
                id: 'REG-DEP-01.d', row: name, prio: 'P1', issue: 'ilm#425',
                rule: [
                    'health by version: v1 HealthDto status ok, v2 HealthInfo status UP',
                    'no false pass on the stored `connected` status while the health answered 503; core#2461',
                ],
            }),
            async ({ api }) => {
                const blocked = blockedConnectors().get(name);
                test.skip(!!blocked, `environment blocker (REG_BLOCKED_CONNECTORS): ${blocked}`);
                const connector = await test.step('Registered, stored status connected', async () => {
                    const found = await findConnector(api, name);
                    expect(found, `connector ${name} is registered`).toBeTruthy();
                    expect(found!.status, `connector ${name}: stored status`).toBe('connected');
                    return found!;
                });
                const health = await test.step('Live health by the version of the connector detail', async () => {
                    const result = await healthByVersion(api, connector);
                    expect(result.version, `connector ${name}: version from the connector detail`).toBeDefined();
                    expect(result.healthy, describeHealth(result)).toBe(true);
                    return result;
                });
                await test.step('One read-only attribute call through the connector', async () => {
                    const probe = await probeAttributes(api, connector, health.version!);
                    expect(probe.ok, `connector ${name}: stored connected, ${probe.what}: ${probe.why}`).toBe(true);
                });
            });
    }
});
