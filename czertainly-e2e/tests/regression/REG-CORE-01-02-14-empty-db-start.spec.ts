/**
 * REG-CORE-01 / REG-CORE-02 — an empty-database start of the image under test (ilm#425, T1; platform area; `@local`,
 * `@needs:docker`). `compose down -v` then `up`: the core log shows every Flyway migration applied (≥ 211, the baseline
 * floor, A1 r1, r3) with no ERROR, `core.core_schema_history` all success, the numerically greatest (13-digit) version at the highest
 * installed rank (out-of-order evidence), `core.spring_session` exists; liveness UP within the startup budget. Then the
 * Java migrations' auth objects exist (`superadmin`, `localhost`), the resource sync completed (A1 r4, r6, r16) and a
 * role round trip works.
 *
 * This spec RESETS the local stack: every object the run made before it is gone (the run-end teardown reports them as
 * missing). Run it in a run of its own (`--grep REG-CORE-01|REG-CORE-02`), after everything else. Docker is reached
 * only through `platformStack` (REG_DOCKER_BIN / `docker`, refused unless TIER_KIND=local with a loopback BASE_URL).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { ACCEPT_JSON, PROBE_PATHS, readProbe } from '../../utils/regression/connectorApi';
import { coreStartLogFacts, PlatformStack, pollUntil, stackProblem } from '../../utils/regression/platformStack';
import { apiJson, createOwnRole } from '../../utils/regression/regressionApi';
import { meta, tags } from '../../utils/regression/tags';
import { describeLocal } from '../../utils/regression/tier';
import { versionGreater } from '../../utils/regression/upgradeHarness';

const SPEC = 'REG-CORE-01-02-14';
type Json = Record<string, any>;
/** Startup budget: the chart's startup probe allows 180 × 10 s (helm-charts#340); an empty database migrates in minutes. */
const STARTUP_BUDGET_MS = 15 * 60_000;
const TEST_BUDGET_MS = 17 * 60_000;
const MIGRATION_FLOOR = 211;

test.describe('REG-CORE empty-database start (local stack)', { tag: tags.regression }, () => {
    describeLocal(test);
    test.describe.configure({ mode: 'serial' });
    let stack: PlatformStack;
    let startedAt: Date;

    test.beforeAll(() => {
        const problem = stackProblem();
        test.skip(!!problem, problem ?? '');
        stack = new PlatformStack();
    });

    test('REG-CORE-01: after compose down -v and a start, every Flyway migration is applied (≥ 211, no ERROR), the schema history is all success with the greatest version last, spring_session exists, liveness UP',
        meta({ id: 'REG-CORE-01', prio: 'P1', issue: 'ilm#425', local: true, needs: 'docker', rule: ['platform-keys-connectors A1 r1 (Flyway at startup, out-of-order load-bearing: the 13-digit version sorts last), r2 (Flyway auto-configuration restored: core bb20aaba), r3 (211 migrations baseline), r5 (checksums)'] }),
        async ({ request }, testInfo) => {
            test.setTimeout(TEST_BUDGET_MS);
            await test.step('compose down -v, then up', async () => {
                stack.downWithVolumes();
                startedAt = new Date();
                stack.up('db', 'rabbitmq', 'auth', 'scheduler', 'core');
            });
            const up = await test.step('liveness answers 200 {"status":"UP"} within the startup budget', async () => pollUntil(async () => {
                const res = await request.get(PROBE_PATHS.liveness, { headers: ACCEPT_JSON }).catch(() => undefined);
                if (!res) return undefined;
                const p = await readProbe(res, 0);
                return p.status === 200 && JSON.stringify(p.json) === JSON.stringify({ status: 'UP' }) ? p : undefined;
            }, STARTUP_BUDGET_MS, 5_000));
            testInfo.annotations.push({ type: 'startup-seconds', description: String(Math.round(up.elapsedMs / 1000)) });
            expect(up.value, 'liveness UP within the startup budget').toBeTruthy();

            await test.step('core log: Successfully applied N migrations (N ≥ 211), now at a 13-digit version, no ERROR', async () => {
                const facts = coreStartLogFacts(stack.logs('core', startedAt.toISOString()));
                expect(facts.appliedMigrations, 'the applied-migrations line').toBeDefined();
                expect(facts.appliedMigrations!).toBeGreaterThanOrEqual(MIGRATION_FLOOR);
                expect(facts.nowAtVersion, 'now at a 13-digit version (the one out-of-order migration sorts last, A1 r1)').toMatch(/^\d{13}$/);
                expect(facts.errors, 'no ERROR line').toEqual([]);
                testInfo.annotations.push({ type: 'migrations', description: `${facts.appliedMigrations} applied, now at ${facts.nowAtVersion}` });
            });

            await test.step('core_schema_history: every row success, versioned count ≥ 211, the greatest version has the highest installed_rank; core.spring_session exists', async () => {
                const [notSuccess] = stack.psql('select count(*) from core.core_schema_history where success = false');
                expect(Number(notSuccess)).toBe(0);
                const [versioned] = stack.psql('select count(*) from core.core_schema_history where version is not null');
                expect(Number(versioned)).toBeGreaterThanOrEqual(MIGRATION_FLOOR);
                // The row installed last is the numerically GREATEST version (Flyway's order; the 13-digit version beats every 12-digit one):
                // computed from the history, never a literal (Sonnet F11).
                const versions = stack.psql('select version from core.core_schema_history where version is not null');
                const greatest = versions.reduce((m, v) => (versionGreater(v, m) ? v : m), '');
                const [last] = stack.psql('select version from core.core_schema_history order by installed_rank desc limit 1');
                expect(last).toBe(greatest);
                expect(last).toMatch(/^\d{13}$/);
                const [session] = stack.psql("select to_regclass('core.spring_session') is not null");
                expect(session).toBe('t');
            });
        });

    test('REG-CORE-02: the Java migrations created the auth objects (superadmin, localhost), the resource sync completed, a role round trip works',
        meta({ id: 'REG-CORE-02', prio: 'P1', issue: 'ilm#425', local: true, needs: 'docker', rule: ['platform-keys-connectors A1 r4 (Java migrations call the auth service), r6 (AuthResourceSynchronizer: "Sync operation completed"), r16 (system role superadmin, system user localhost)'] }),
        async ({ api }, testInfo) => {
            test.setTimeout(120_000);
            const roles = await apiJson<Json[]>(api, 'GET', '/api/v1/roles');
            expect(roles.map((r) => String(r.name))).toContain('superadmin');
            const users = await apiJson<Json[]>(api, 'GET', '/api/v1/users');
            expect(users.map((u) => String(u.username))).toContain('localhost');
            const resources = await apiJson<Json[]>(api, 'GET', '/api/v1/auth/resources');
            expect(resources.length, 'resource listing non-empty').toBeGreaterThan(0);
            const facts = coreStartLogFacts(stack.logs('core', (startedAt ?? new Date(Date.now() - 30 * 60_000)).toISOString()));
            expect(facts.syncCompleted, 'log has "Sync operation completed"').toBe(true);
            expect(facts.syncFailed, 'log has no "Unable to synchronize resources with Auth Service"').toBe(false);
            const role = await createOwnRole(api, 'core02', SPEC);
            const detail = await apiJson<Json>(api, 'GET', `/api/v1/roles/${role.uuid}`);
            expect(detail.name).toBe(role.name);
            testInfo.annotations.push({ type: 'role-round-trip', description: role.uuid });
        });
});
