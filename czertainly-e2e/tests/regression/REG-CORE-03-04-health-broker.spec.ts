/**
 * REG-CORE-03 / REG-CORE-04 — core health follows RabbitMQ (ilm#425, T1 step 4; platform area; `@local`, `@needs:docker`).
 * Stop the broker: `GET /api/v1/health` becomes 503 `DOWN` within 60 s (Boot's default DOWN → 503; the
 * `jmsHealthContributor` restored by core bb20aaba, A1 r2, r11) while `/health/liveness` stays 200 `{"status":"UP"}`
 * and the readiness answer is only RECORDED (C1 / OQ-1). Start it again: `/health` is 200 `UP` within 180 s (listener
 * backoff cap 120 s, A1 r17) and the message path works: an own group's audit-log entry appears within 60 s. The
 * broker is always started again in `finally`. Seconds to DOWN and UP are annotations for the timing comparison.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { ACCEPT_JSON, PROBE_PATHS, readProbe } from '../../utils/regression/connectorApi';
import { PlatformStack, pollUntil, stackProblem } from '../../utils/regression/platformStack';
import { apiJson } from '../../utils/regression/regressionApi';
import { recordCreated, regName, RUN_ID } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';
import { describeLocal } from '../../utils/regression/tier';

const SPEC = 'REG-CORE-03-04';
type Json = Record<string, any>;

test.describe('REG-CORE health and the broker (local stack)', { tag: tags.regression }, () => {
    describeLocal(test);
    test.describe.configure({ mode: 'serial' });
    let stack: PlatformStack;

    test.beforeAll(() => {
        const problem = stackProblem();
        test.skip(!!problem, problem ?? '');
        stack = new PlatformStack();
    });

    test('REG-CORE-03: with RabbitMQ stopped /health becomes 503 DOWN within 60 s while liveness stays 200 UP; readiness recorded',
        meta({ id: 'REG-CORE-03', prio: 'P1', issue: 'ilm#425', local: true, needs: 'docker', rule: ['platform-keys-connectors A1 r11 (health must follow RabbitMQ; liveness / readiness are Boot\'s default groups without the broker), C1 (readiness: recorded, not asserted, OQ-1); ilm#424 §3 ("health stays UP while RabbitMQ is down" is the defect)'] }),
        async ({ request }, testInfo) => {
            test.setTimeout(180_000);
            const probe = async (path: string) => readProbe(await request.get(path, { headers: ACCEPT_JSON }), 0);
            try {
                stack.stop('rabbitmq');
                const livenessSeen: number[] = [];
                const down = await pollUntil(async () => {
                    livenessSeen.push((await probe(PROBE_PATHS.liveness)).status);
                    const h = await probe(PROBE_PATHS.health);
                    return h.status === 503 && String((h.json as Json)?.status) === 'DOWN' ? h : undefined;
                }, 60_000, 3_000);
                testInfo.annotations.push({ type: 'seconds-to-down', description: String(Math.round(down.elapsedMs / 1000)) });
                expect(down.value, '/health answered 503 DOWN within 60 s').toBeTruthy();
                expect(livenessSeen.every((s) => s === 200), 'liveness stayed 200 throughout').toBe(true);
                const liveness = await probe(PROBE_PATHS.liveness);
                expect(liveness.json).toEqual({ status: 'UP' });
                const readiness = await probe(PROBE_PATHS.readiness);
                testInfo.annotations.push({ type: 'readiness-while-broker-down', description: `${readiness.status} ${readiness.text.slice(0, 80)}` });
            } finally {
                stack.start('rabbitmq');
            }
        });

    test('REG-CORE-04: after the broker returns /health is 200 UP within 180 s and the message path works: an own group\'s audit-log entry appears within 60 s',
        meta({ id: 'REG-CORE-04', prio: 'P1', issue: 'ilm#425', local: true, needs: 'docker', rule: ['platform-keys-connectors A1 r11 (UP after the broker is back), r17 (listener backoff 5 s × 2 up to 120 s), A3 r16 (core.audit-logs queue)'] }),
        async ({ api, request }, testInfo) => {
            test.setTimeout(300_000);
            stack.start('rabbitmq');
            const up = await pollUntil(async () => {
                const h = await readProbe(await request.get(PROBE_PATHS.health, { headers: ACCEPT_JSON }), 0);
                return h.status === 200 && String((h.json as Json)?.status) === 'UP' ? h : undefined;
            }, 180_000, 3_000);
            testInfo.annotations.push({ type: 'seconds-to-up', description: String(Math.round(up.elapsedMs / 1000)) });
            expect(up.value, '/health answered 200 UP within 180 s').toBeTruthy();

            const name = regName(`grp04-${Date.now().toString(36)}`);
            const created = await apiJson<Json>(api, 'POST', '/api/v1/groups', { name, description: `REG run ${RUN_ID}`, customAttributes: [] });
            recordCreated('groups', { uuid: String(created.uuid), name }, SPEC, 'message-path probe');
            const entry = await pollUntil(async () => {
                const page = await apiJson<Json>(api, 'POST', '/api/v1/auditLogs', { itemsPerPage: 100, pageNumber: 1, filters: [] });
                const rows = (page.items ?? page.auditLogs ?? []) as Json[];
                return rows.find((r) => JSON.stringify(r).includes(String(created.uuid)) || JSON.stringify(r).includes(name));
            }, 60_000, 3_000);
            expect(entry.value, 'the audit-log entry of the own group arrived through core.audit-logs within 60 s').toBeTruthy();
        });
});
