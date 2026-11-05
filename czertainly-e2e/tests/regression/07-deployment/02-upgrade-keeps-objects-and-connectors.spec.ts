/**
 * REG-DEP-02 — An upgrade of a local stack keeps the seeded objects and the connectors (release checklist: Deployment
 * 2; ilm#425).
 *
 * Seeds an own role, a group and a token chain on the old core image, starts the target core on the same database, and
 * diffs the snapshots: objects kept, counts equal, audit log not reset, schema history kept, every connected connector
 * still healthy. The upgrade is one way (a downgrade is refused).
 *
 * Local stack only (@local, @needs:docker). Skips with a named reason unless the stack runs the old image. Seeded
 * objects are own and recorded in the ledger.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { ACCEPT_JSON, expectHealthGroupUp, healthByVersion, isHealthGroupUp, listConnectors, PROBE_PATHS } from '../../../utils/regression/platform/connectorApi';
import { ensureKeyChain, isSkip } from '../../../utils/regression/platform/keyChain';
import { PlatformStack, stackConfig } from '../../../utils/regression/platform/localStack';
import { UPGRADE_STARTUP_MS, UPGRADE_TEST_MS } from '../../../utils/regression/timeouts';
import { pollUntil } from '../../../utils/regression/wait';
import type { JsonObject } from '../../../utils/regression/json';
import { apiJson, answerOf } from '../../../utils/regression/apiReads';
import { ensureRunRole } from '../../../utils/regression/ownRoles';
import { testMeta, tags } from '../../../utils/regression/tags';
import { describeLocalOnly } from '../../../utils/regression/tier/localProof';
import { diffSnapshots, schemaHistoryProblems, takeSnapshot, upgradeDirectionProblem } from '../../../utils/regression/platform/upgradeRunner';

test.describe('Upgrade of a local stack', { tag: tags.regression }, () => {
    describeLocalOnly(test);

    test('an upgrade on the same database keeps every seeded object and every connector alive',
        testMeta({ id: 'REG-DEP-02', prio: 'P1', issue: 'ilm#425', local: true, needs: 'docker', rule: ['migration checksums are a contract and the upgrade is one way; counts and uuids are unchanged, the audit log is not reset, connected connectors keep a live health'] }),
        async ({ api, request, own, regressionEnv }, testInfo) => {
            test.setTimeout(UPGRADE_TEST_MS);
            const { upgradeFromTag: fromTag, composeFileTarget: targetCompose } = regressionEnv;
            test.skip(!fromTag || !targetCompose, 'REG_UPGRADE_FROM_TAG (the 2.19.x tag the stack runs now) and LOCAL_COMPOSE_FILE_TARGET (the compose file pinning the image under test) are required');
            const stack = new PlatformStack();
            const image = stack.imageOf('core') ?? '';
            test.skip(!image.includes(fromTag!), 'the stack does not run the old image yet: start it with the old tag first (one-way upgrade)');

            const seeded = await test.step('Seed on the old image: a role, a group and a token chain through the existing helpers', async () => {
                const role = await ensureRunRole(api, own.spec);
                const extra = await own.role('dep02');
                const group = await own.group('dep02-grp', { note: 'seed before the upgrade' });
                const chain = await ensureKeyChain(api, own.spec);
                return { role, extra, group: group.uuid, chain: isSkip(chain) ? undefined : chain };
            });
            const before = await test.step('Snapshot before the upgrade: lists, totals, connector statuses, schema history', async () => {
                const snapshot = await takeSnapshot(api, stack);
                expect(snapshot.schemaHistory.length, 'the schema history is readable through psql').toBeGreaterThan(0);
                const info = await apiJson<{ app?: { version?: string } }>(api, 'GET', '/api/v1/info');
                testInfo.annotations.push({ type: 'from-version', description: String(info.app?.version) });
                return snapshot;
            });

            await test.step('Stop the old core; start the target core on the same database', async () => {
                stack.stop('core');
                const target = new PlatformStack({ ...stackConfig(), composeFile: targetCompose });
                target.up('core');
                const up = await pollUntil(async () => {
                    const res = await request.get(PROBE_PATHS.liveness, { headers: ACCEPT_JSON }).catch(() => undefined);
                    if (!res) return undefined;
                    const answer = await answerOf(res, Date.now());
                    return isHealthGroupUp(answer) ? answer : undefined;
                }, (found) => found !== undefined, { timeoutMs: UPGRADE_STARTUP_MS, intervalMs: 10_000, tolerateErrors: 0, onTimeout: 'return' });
                expect(up, 'the target core reached liveness within the startup budget').toBeTruthy();
                expectHealthGroupUp(up!, 'liveness');
                const targetInfo = await apiJson<{ app?: { version?: string } }>(api, 'GET', '/api/v1/info');
                testInfo.annotations.push({ type: 'to-version', description: String(targetInfo.app?.version) });
                expect(upgradeDirectionProblem(fromTag!, String(targetInfo.app?.version)), 'upgrade direction').toBeUndefined();
            });

            const after = await test.step('Snapshot after the upgrade', async () => takeSnapshot(api, stack));
            await test.step('Diff: objects kept, counts equal (system extras listed), audit not reset, schema history kept with new rows success, out-of-order evidenced', async () => {
                const report = diffSnapshots(before, after);
                if (report.systemExtras.length) testInfo.annotations.push({ type: 'system-extras', description: report.systemExtras.join('; ') });
                expect(report.problems).toEqual([]);
                const history = schemaHistoryProblems(before.schemaHistory, after.schemaHistory);
                expect(history.problems).toEqual([]);
                testInfo.annotations.push({ type: 'new-migrations', description: `${history.newVersions.length} (${history.outOfOrder ? 'out-of-order applied' : 'all newer than the previous maximum'})` });
            });

            await test.step('Every seeded detail answers 200; connectors stay connected with live health', async () => {
                for (const url of [`/api/v1/roles/${seeded.role.uuid}`, `/api/v1/roles/${seeded.extra.uuid}`, `/api/v1/groups/${seeded.group}`, ...(seeded.chain ? [`/api/v1/tokens/${seeded.chain.token.uuid}`, `/api/v1/keys/${seeded.chain.key.uuid}`] : [])]) {
                    const res = await api.get(url);
                    expect(res.status(), url).toBe(200);
                }
                for (const c of await listConnectors(api)) {
                    if (c.status !== 'connected') continue;
                    const h = await healthByVersion(api, c);
                    expect(h.healthy, `${c.name}: ${h.why}`).toBe(true);
                }
                const role = await apiJson<JsonObject>(api, 'GET', `/api/v1/roles/${seeded.extra.uuid}`);
                expect(role.name).toBe(seeded.extra.name);
                testInfo.annotations.push({ type: 'skipped-step', description: 'the UI login as the seeded user: the local stack has no identity provider' });
            });
        });
});
