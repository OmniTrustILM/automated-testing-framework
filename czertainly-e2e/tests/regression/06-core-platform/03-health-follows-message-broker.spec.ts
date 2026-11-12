/**
 * REG-CORE-03, REG-CORE-04 — Core health follows the message broker (release checklist: core platform, local stack). ilm#425, ilm#424.
 *
 * WHAT: 1. Stop RabbitMQ (REG-CORE-03) → `/health` answers 503 DOWN within 60 s while liveness stays 200 UP throughout;
 *          readiness is recorded, not asserted.
 *       2. Start it again (REG-CORE-04) → `/health` answers 200 UP within 180 s.
 *       3. Create an own group → its audit-log entry arrives through the broker within 60 s.
 * WHY: "health stays UP while RabbitMQ is down" is the defect of ilm#424; health must follow the broker and recover with it,
 *      after the listener's backoff (5 s doubling up to 120 s).
 * HOW: local stack only (@local, @needs:docker); the tests are serial. The broker is always started again in `finally`. The
 *      group is own (`own.group`, recorded before the audit-log read); the measured times are attached as annotations.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { ACCEPT_JSON, expectHealthGroupUp, PROBE_PATHS } from '../../../utils/regression/platform/connectorApi';
import { PlatformStack } from '../../../utils/regression/platform/localStack';
import { pollUntil } from '../../../utils/regression/wait';
import { apiJson, answerOf } from '../../../utils/regression/apiReads';
import { testMeta, tags } from '../../../utils/regression/tags';
import { describeLocalOnly } from '../../../utils/regression/tier/localProof';
import type { JsonObject } from '../../../utils/regression/json';
import { AUDIT_ENTRY_MS, BROKER_START_TEST_MS, BROKER_STOP_TEST_MS, HEALTH_DOWN_MS, HEALTH_UP_MS } from '../../../utils/regression/timeouts';


test.describe('Health and the message broker (local stack)', { tag: tags.regression }, () => {
    describeLocalOnly(test);
    test.describe.configure({ mode: 'serial' });
    test('with the message broker stopped, health turns DOWN while liveness stays UP',
        testMeta({ id: 'REG-CORE-03', prio: 'P2', issue: 'ilm#425', local: true, needs: 'docker', rule: ['health must follow RabbitMQ; liveness / readiness are Boot\'s default groups without the broker (readiness: recorded, not asserted); ilm#424 ("health stays UP while RabbitMQ is down" is the defect)'] }),
        async ({ request }, testInfo) => {
            test.setTimeout(BROKER_STOP_TEST_MS);
            const stack = new PlatformStack();
            const probe = async (path: string) => answerOf(await request.get(path, { headers: ACCEPT_JSON }), Date.now());
            try {
                const livenessSeen: number[] = [];
                const downAt = Date.now();
                const down = await test.step('Stop RabbitMQ: /health answers 503 DOWN within 60 s', async () => {
                    stack.stop('rabbitmq');
                    return pollUntil(async () => {
                        livenessSeen.push((await probe(PROBE_PATHS.liveness)).status);
                        const h = await probe(PROBE_PATHS.health);
                        return h.status === 503 && String((h.json as JsonObject)?.status) === 'DOWN' ? h : undefined;
                    }, (found) => found !== undefined, { timeoutMs: HEALTH_DOWN_MS, intervalMs: 3_000, tolerateErrors: 0, onTimeout: 'return' });
                });
                testInfo.annotations.push({ type: 'seconds-to-down', description: String(Math.round((Date.now() - downAt) / 1000)) });
                expect(down, '/health answered 503 DOWN within 60 s').toBeTruthy();
                await test.step('Liveness stayed 200 UP throughout; readiness is recorded', async () => {
                    expect(livenessSeen.every((s) => s === 200), 'liveness stayed 200 throughout').toBe(true);
                    expectHealthGroupUp(await probe(PROBE_PATHS.liveness), 'liveness');
                    const readiness = await probe(PROBE_PATHS.readiness);
                    testInfo.annotations.push({ type: 'readiness-while-broker-down', description: `${readiness.status} ${readiness.text.slice(0, 80)}` });
                });
            } finally {
                stack.start('rabbitmq');
            }
        });

    test('when the broker returns, health is UP again and messages are delivered',
        testMeta({ id: 'REG-CORE-04', prio: 'P2', issue: 'ilm#425', local: true, needs: 'docker', rule: ['health is UP after the broker is back; listener backoff 5 s × 2 up to 120 s; core.audit-logs queue'] }),
        async ({ api, request, own }, testInfo) => {
            test.setTimeout(BROKER_START_TEST_MS);
            const stack = new PlatformStack();
            const upAt = Date.now();
            const up = await test.step('Start RabbitMQ: /health answers 200 UP within 180 s', async () => {
                stack.start('rabbitmq');
                return pollUntil(async () => {
                    const h = await answerOf(await request.get(PROBE_PATHS.health, { headers: ACCEPT_JSON }), Date.now());
                    return h.status === 200 && String((h.json as JsonObject)?.status) === 'UP' ? h : undefined;
                }, (found) => found !== undefined, { timeoutMs: HEALTH_UP_MS, intervalMs: 3_000, tolerateErrors: 0, onTimeout: 'return' });
            });
            testInfo.annotations.push({ type: 'seconds-to-up', description: String(Math.round((Date.now() - upAt) / 1000)) });
            expect(up, '/health answered 200 UP within 180 s').toBeTruthy();

            const created = await test.step('Create an own group (recorded)', async () => own.group('grp04', { note: 'message-path probe' }));
            await test.step('The group\'s audit-log entry arrives through the broker within 60 s', async () => {
                const entry = await pollUntil(async () => {
                    const page = await apiJson<JsonObject>(api, 'POST', '/api/v1/auditLogs', { itemsPerPage: 100, pageNumber: 1, filters: [] });
                    const rows = (page.items ?? page.auditLogs ?? []) as JsonObject[];
                    return rows.find((r) => JSON.stringify(r).includes(created.uuid) || JSON.stringify(r).includes(created.name));
                }, (found) => found !== undefined, { timeoutMs: AUDIT_ENTRY_MS, intervalMs: 3_000, tolerateErrors: 0, onTimeout: 'return' });
                expect(entry, 'the audit-log entry of the own group arrived through core.audit-logs within 60 s').toBeTruthy();
            });
        });
});
