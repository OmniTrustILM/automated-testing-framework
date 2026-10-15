/**
 * REG-DEP-02 — the upgrade harness (release checklist DEP-02-1…8; ilm#425, T1; platform area; `@local`, `@needs:docker`).
 *
 * Preconditions from the environment (no host, tag or path is written here): the stack runs the OLD core image
 * (`REG_UPGRADE_FROM_TAG`, a 2.19.x tag, and `imageOf('core')` carries it); `LOCAL_COMPOSE_FILE_TARGET` is the compose
 * file of the same project that pins the image under test. Steps: seed on the old image (P-SEED through the existing
 * ensure helpers: role, group, token chain) → `before` snapshot (API lists, certificates total, audit total, connector
 * statuses, `core_schema_history` through psql) → stop core, start the target core on the SAME database → `after`
 * snapshot → diff (uuid sets kept, counts equal except system extras in users / roles, audit total not reset, history
 * rows kept with the same checksums, new rows success, out-of-order evidenced) → every seeded detail answers 200,
 * connectors still connected with live health → the seeded role still holds its name (the UI login as a seeded user
 * is skipped: no IdP on the local stack). Guard: never a downgrade (A1 r19).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { ACCEPT_JSON, healthByVersion, listConnectors, PROBE_PATHS, readProbe } from '../../utils/regression/connectorApi';
import { ensureKeyChain, isSkip } from '../../utils/regression/keyApi';
import { PlatformStack, pollUntil, stackConfig, stackProblem } from '../../utils/regression/platformStack';
import { apiJson, createOwnRole, ensureRole } from '../../utils/regression/regressionApi';
import { recordCreated, regName, RUN_ID } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';
import { describeLocal } from '../../utils/regression/tier';
import { diffSnapshots, schemaHistoryProblems, takeSnapshot, upgradeDirectionProblem } from '../../utils/regression/upgradeHarness';

const SPEC = 'REG-DEP-02';
type Json = Record<string, any>;
const STARTUP_BUDGET_MS = 35 * 60_000;
const TEST_BUDGET_MS = 45 * 60_000;

test.describe('REG-DEP-02 upgrade (local stack)', { tag: tags.regression }, () => {
    describeLocal(test);

    test('REG-DEP-02: seed on the old image → snapshot → upgrade on the same database → diff → open objects → connectors live → the seeded role kept',
        meta({ id: 'REG-DEP-02', prio: 'P1', issue: 'ilm#425', local: true, needs: 'docker', rule: ['platform-keys-connectors A1 r2, r5 (checksums are a contract), r19 (one way), r20–r22, r27 (counts and uuids unchanged, connectors connected, issuable on the old RA profile); C2'] }),
        async ({ api, request }, testInfo) => {
            test.setTimeout(TEST_BUDGET_MS);
            const problem = stackProblem();
            test.skip(!!problem, problem ?? '');
            const fromTag = process.env.REG_UPGRADE_FROM_TAG;
            const targetCompose = process.env.LOCAL_COMPOSE_FILE_TARGET;
            test.skip(!fromTag || !targetCompose, 'REG_UPGRADE_FROM_TAG (the 2.19.x tag the stack runs now) and LOCAL_COMPOSE_FILE_TARGET (the compose file pinning the image under test) are required');
            const stack = new PlatformStack();
            const image = stack.imageOf('core') ?? '';
            test.skip(!image.includes(fromTag!), 'the stack does not run the old image yet: start it with the old tag first (one-way upgrade, A1 r19)');

            const seeded = await test.step('Seed on the old image (P-SEED subset through the existing helpers)', async () => {
                const role = await ensureRole(api, SPEC);
                const extra = await createOwnRole(api, 'dep02', SPEC);
                const groupName = regName(`dep02-grp-${Date.now().toString(36)}`);
                const group = await apiJson<Json>(api, 'POST', '/api/v1/groups', { name: groupName, description: `REG run ${RUN_ID}`, customAttributes: [] });
                recordCreated('groups', { uuid: String(group.uuid), name: groupName }, SPEC, 'DEP-02 seed');
                const chain = await ensureKeyChain(api, SPEC);
                return { role, extra, group: String(group.uuid), chain: isSkip(chain) ? undefined : chain };
            });
            const before = await takeSnapshot(api, stack);
            expect(before.schemaHistory.length, 'the schema history is readable through psql').toBeGreaterThan(0);
            const info = await apiJson<Json>(api, 'GET', '/api/v1/info');
            testInfo.annotations.push({ type: 'from-version', description: String(info.app?.version) });

            await test.step('Stop the old core; start the target core on the same database', async () => {
                stack.stop('core');
                const target = new PlatformStack(stackConfig({ ...process.env, LOCAL_COMPOSE_FILE: targetCompose }));
                target.up('core');
                const up = await pollUntil(async () => {
                    const res = await request.get(PROBE_PATHS.liveness, { headers: ACCEPT_JSON }).catch(() => undefined);
                    return res && (await readProbe(res, 0)).status === 200 ? true : undefined;
                }, STARTUP_BUDGET_MS, 10_000);
                expect(up.value, 'the target core reached liveness within the startup budget').toBeTruthy();
                const targetInfo = await apiJson<Json>(api, 'GET', '/api/v1/info');
                testInfo.annotations.push({ type: 'to-version', description: String(targetInfo.app?.version) });
                expect(upgradeDirectionProblem(fromTag!, String(targetInfo.app?.version)), 'upgrade direction').toBeUndefined();
            });

            const after = await takeSnapshot(api, stack);
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
                const role = await apiJson<Json>(api, 'GET', `/api/v1/roles/${seeded.extra.uuid}`);
                expect(role.name).toBe(seeded.extra.name);
                testInfo.annotations.push({ type: 'skipped-step', description: 'DEP-02-8 UI login as the seeded user: the local stack has no identity provider' });
            });
        });
});
