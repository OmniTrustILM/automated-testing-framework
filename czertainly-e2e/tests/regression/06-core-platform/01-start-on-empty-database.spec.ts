/**
 * REG-CORE-01, REG-CORE-02 — The image under test starts on an empty database (release checklist: core platform, local stack). ilm#425.
 *
 * WHAT: 1. compose down -v, then up with database, broker, auth, scheduler and core → liveness answers 200 {"status":"UP"}
 *          within the startup budget (REG-CORE-01).
 *       2. The core log says "Successfully applied N migrations" (N at least 211), now at a 13-digit version, with no ERROR line.
 *       3. The schema history: every row a success, at least 211 versioned rows, the greatest version has the highest installed
 *          rank, and the session table exists.
 *       4. The auth objects of the Java migrations exist (system role superadmin, system user localhost, a non-empty resource listing), the
 *          log has "Sync operation completed" and no synchronisation failure, and an own role round trip works (REG-CORE-02).
 * WHY: migrations run out of order (the 13-digit version sorts last) and Flyway auto-configuration must stay in force; a red
 *      test means the image does not start on a clean database or a migration was lost.
 * HOW: local stack only (@local, @needs:docker). It RESETS the stack (compose down -v), so it runs in a run of its own
 *      (`--grep "REG-CORE-01|REG-CORE-02"`) after everything else; docker is reached only through `localStack`. The tests are
 *      serial and the second reads the log window that the first opened; the migration floor is computed against the stack's
 *      own history, never a literal for the last version.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { ACCEPT_JSON, isHealthGroupUp, PROBE_PATHS } from '../../../utils/regression/platform/connectorApi';
import { coreStartLogFacts, PlatformStack } from '../../../utils/regression/platform/localStack';
import { pollUntil } from '../../../utils/regression/wait';
import { apiJson, answerOf } from '../../../utils/regression/apiReads';
import { testMeta, tags } from '../../../utils/regression/tags';
import { describeLocalOnly } from '../../../utils/regression/tier/localProof';
import { CONNECTOR_WRITE_TEST_MS, CORE_STARTUP_MS, CORE_STARTUP_TEST_MS, LOG_LOOKBACK_MS } from '../../../utils/regression/timeouts';
import { versionGreater } from '../../../utils/regression/platform/upgradeRunner';
import type { JsonObject } from '../../../utils/regression/json';

const MIGRATION_FLOOR = 211;

test.describe('Empty-database start (local stack)', { tag: tags.regression }, () => {
    describeLocalOnly(test);
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
                // The row installed last is the numerically GREATEST version (Flyway's order; the 13-digit version beats every 12-digit
                // one):
                // computed from the history, never a literal.
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
            const roles = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/roles');
            expect(roles.map((r) => String(r.name))).toContain('superadmin');
            const users = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/users');
            expect(users.map((u) => String(u.username))).toContain('localhost');
            const resources = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/auth/resources');
            expect(resources.length, 'resource listing non-empty').toBeGreaterThan(0);
            const facts = coreStartLogFacts(stack.logs('core', (startedAt ?? new Date(Date.now() - LOG_LOOKBACK_MS)).toISOString()));
            expect(facts.syncCompleted, 'log has "Sync operation completed"').toBe(true);
            expect(facts.syncFailed, 'log has no "Unable to synchronize resources with Auth Service"').toBe(false);
            const role = await own.role('core02');
            const detail = await apiJson<JsonObject>(api, 'GET', `/api/v1/roles/${role.uuid}`);
            expect(detail.name).toBe(role.name);
            testInfo.annotations.push({ type: 'role-round-trip', description: role.uuid });
        });
});
