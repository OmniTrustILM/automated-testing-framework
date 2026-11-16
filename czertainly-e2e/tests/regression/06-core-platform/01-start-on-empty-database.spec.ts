/**
 * REG-CORE-01, REG-CORE-02 — the image under test starts on an empty database with every migration applied (local stack; ilm#425).
 * It wipes the stack (compose down -v), so it runs only with REG_ALLOW_STACK_RESET=true, in a run of its own.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { ACCEPT_JSON, isHealthGroupUp, PROBE_PATHS } from '../../../utils/regression/platform/connectorApi';
import { coreStartLogFacts, PlatformStack } from '../../../utils/regression/platform/localStack';
import { pollUntil } from '../../../utils/regression/wait';
import { apiJson, answerOf } from '../../../utils/regression/apiReads';
import { listAll } from '../../../utils/regression/rbac/authApi';
import { testMeta, tags } from '../../../utils/regression/tags';
import { describeLocalOnly } from '../../../utils/regression/tier/localProof';
import { CONNECTOR_WRITE_TEST_MS, CORE_STARTUP_MS, CORE_STARTUP_TEST_MS, LOG_LOOKBACK_MS } from '../../../utils/regression/timeouts';
import { versionGreater } from '../../../utils/regression/platform/upgradeRunner';
import type { JsonObject } from '../../../utils/regression/json';

const MIGRATION_FLOOR = 211;
const STACK_RESET_SKIP = 'wipes the local database (compose down -v): set REG_ALLOW_STACK_RESET=true for a run of its own';

test.describe('Empty-database start (local stack)', { tag: tags.regression }, () => {
    describeLocalOnly(test);
    test.skip(({ regressionEnv }) => !regressionEnv.allowStackReset, STACK_RESET_SKIP);
    test.describe.configure({ mode: 'serial' });
    /** When the first test started the stack: the second test reads the core log from then on (the tests are serial). */
    let startedAt: Date | undefined;

    test('core starts on an empty database with every migration applied',
        testMeta({ id: 'REG-CORE-01', prio: 'P2', issue: 'ilm#425', local: true, needs: 'docker', rule: ['Flyway at startup, out-of-order load-bearing: the 13-digit version sorts last; Flyway auto-configuration restored; 211 migrations baseline; checksums'] }),
        async ({ request }, testInfo) => {
            test.setTimeout(CORE_STARTUP_TEST_MS);
            const stack = new PlatformStack();
            const startedHere = await test.step('compose down -v, then up', async () => {
                stack.downWithVolumes();
                const started = new Date();
                stack.up('db', 'rabbitmq', 'auth', 'scheduler', 'core');
                return started;
            });
            startedAt = startedHere;
            const upAt = Date.now();
            const up = await test.step('liveness answers 200 {"status":"UP"} within the startup budget', async () => pollUntil(async () => {
                const res = await request.get(PROBE_PATHS.liveness, { headers: ACCEPT_JSON }).catch(() => undefined);
                if (!res) return undefined;
                const answer = await answerOf(res, Date.now());
                return isHealthGroupUp(answer) ? answer : undefined;
            }, (found) => found !== undefined, { timeoutMs: CORE_STARTUP_MS, intervalMs: 5_000, tolerateErrors: 0, onTimeout: 'return' }));
            testInfo.annotations.push({ type: 'startup-seconds', description: String(Math.round((Date.now() - upAt) / 1000)) });
            expect(up, 'liveness UP within the startup budget').toBeTruthy();

            await test.step('core log: Successfully applied N migrations (N ≥ 211), now at a 13-digit version, no ERROR', async () => {
                const facts = coreStartLogFacts(stack.logs('core', startedHere.toISOString()));
                expect(facts.appliedMigrations, 'the applied-migrations line').toBeDefined();
                expect(facts.appliedMigrations!).toBeGreaterThanOrEqual(MIGRATION_FLOOR);
                expect(facts.nowAtVersion, 'now at a 13-digit version (the one out-of-order migration sorts last)').toMatch(/^\d{13}$/);
                expect(facts.errors, 'no ERROR line').toEqual([]);
                testInfo.annotations.push({ type: 'migrations', description: `${facts.appliedMigrations} applied, now at ${facts.nowAtVersion}` });
            });

            await test.step('core_schema_history: every row success, versioned count ≥ 211, the greatest version has the highest installed_rank; core.spring_session exists', async () => {
                const [notSuccess] = stack.psql('select count(*) from core.core_schema_history where success = false');
                expect(Number(notSuccess)).toBe(0);
                const [versioned] = stack.psql('select count(*) from core.core_schema_history where version is not null');
                expect(Number(versioned)).toBeGreaterThanOrEqual(MIGRATION_FLOOR);
                // The last installed row is the numerically greatest version (the 13-digit one), computed from the history.
                const versions = stack.psql('select version from core.core_schema_history where version is not null');
                const greatest = versions.reduce((m, v) => (versionGreater(v, m) ? v : m), '');
                const [last] = stack.psql('select version from core.core_schema_history order by installed_rank desc limit 1');
                expect(last).toBe(greatest);
                expect(last).toMatch(/^\d{13}$/);
                const [session] = stack.psql("select to_regclass('core.spring_session') is not null");
                expect(session).toBe('t');
            });
        });

    test('after an empty-database start the auth objects exist and a role round trip works',
        testMeta({ id: 'REG-CORE-02', prio: 'P2', issue: 'ilm#425', local: true, needs: 'docker', rule: ['Java migrations call the auth service; AuthResourceSynchronizer: "Sync operation completed"; system role superadmin, system user localhost'] }),
        async ({ api, own }, testInfo) => {
            test.setTimeout(CONNECTOR_WRITE_TEST_MS);
            const stack = new PlatformStack();
            const roles = await listAll(api, 'roles');
            expect(roles.map((r) => String(r.name))).toContain('superadmin');
            const users = await listAll(api, 'users');
            expect(users.map((u) => String(u.username))).toContain('localhost');
            const resources = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/auth/resources');
            expect(resources.length, 'resource listing non-empty').toBeGreaterThan(0);
            // A lone run of REG-CORE-02 has no start time from REG-CORE-01, so it reads the last LOG_LOOKBACK_MS of the log.
            const facts = coreStartLogFacts(stack.logs('core', (startedAt ?? new Date(Date.now() - LOG_LOOKBACK_MS)).toISOString()));
            expect(facts.syncCompleted, 'log has "Sync operation completed"').toBe(true);
            expect(facts.syncFailed, 'log has no "Unable to synchronize resources with Auth Service"').toBe(false);
            const role = await own.role('core02');
            const detail = await apiJson<JsonObject>(api, 'GET', `/api/v1/roles/${role.uuid}`);
            expect(detail.name).toBe(role.name);
            testInfo.annotations.push({ type: 'role-round-trip', description: role.uuid });
        });
});
