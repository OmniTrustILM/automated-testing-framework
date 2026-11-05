/**
 * REG-DEP-01.e, REG-DEP-01.f — Read-only probe of every required connector, and the inventory of the connected ones (ilm#425).
 *
 * (.e, one test per required connector) The connector answers its live health with the body of its version, and its detail
 * has the shape the platform relies on. (.f) Every connected connector is recorded as an annotation; one the suite does not
 * know is recorded, never a failure.
 *
 * Read-only: every call is a GET through the guarded context and nothing is created. A blocked connector skips with its
 * reason (the REG_* connector settings, see .env.example).
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { blockedConnectors, connectorVersion, describeHealth, findConnector, healthByVersion, listConnectors, requiredConnectors } from '../../../utils/regression/platform/connectorApi';
import { detailShapeProblems, featuresByInterface, infoShapeProblems, inventoryLine } from '../../../utils/regression/platform/connectorKinds';
import { answerOf } from '../../../utils/regression/apiReads';
import { testMeta, tags } from '../../../utils/regression/tags';
import { CONNECTOR_READ_TEST_MS } from '../../../utils/regression/timeouts';

const required = requiredConnectors();

test.describe('Connector probe (read-only)', { tag: tags.regression }, () => {
    for (const name of required) {
        test(`the connector ${name} answers its health and info with the expected shape`,
            testMeta({
                id: 'REG-DEP-01.e', row: name, prio: 'P1', issue: 'ilm#425',
                rule: [
                    'health by version: v1 HealthDto status ok, v2 HealthInfo status UP; a v2 connector offers the info and health interfaces',
                    'GET /v2/connectors/{uuid}/info answers the connector document (name, version); the metrics interface is listed with openMetrics on it only',
                ],
            }),
            async ({ api }, testInfo) => {
                test.setTimeout(CONNECTOR_READ_TEST_MS);
                const blocked = blockedConnectors().get(name);
                test.skip(!!blocked, `environment blocker (REG_BLOCKED_CONNECTORS): ${blocked}`);
                const connector = await findConnector(api, name);
                expect(connector, `connector ${name} is registered`).toBeTruthy();
                const detailRead = await connectorVersion(api, connector!.uuid);
                expect(detailRead.detail, `connector ${name}: the detail read answered ${detailRead.detailStatus}`).toBeTruthy();
                const version = detailRead.version;
                expect(version, `connector ${name}: version from the connector detail`).toBeDefined();

                await test.step('Live health answers the body of its version', async () => {
                    const health = await healthByVersion(api, connector!);
                    expect(health.healthy, describeHealth(health)).toBe(true);
                    expect(typeof (health.body as { status?: unknown } | undefined)?.status, `connector ${name}: the health body carries a status`).toBe('string');
                });
                await test.step('The detail has the shape of its version', async () => {
                    expect(detailShapeProblems(version!, detailRead.detail!), `connector ${name}: detail`).toEqual([]);
                });
                if (version === 2) {
                    await test.step('The info answers the connector document', async () => {
                        const answer = await answerOf(await api.get(`/api/v2/connectors/${connector!.uuid}/info`), Date.now());
                        expect(answer.status, answer.text.slice(0, 200)).toBe(200);
                        expect(infoShapeProblems(answer.json), `connector ${name}: info`).toEqual([]);
                    });
                    await test.step('The metrics interface, where offered', async () => {
                        const features = featuresByInterface(detailRead.detail!);
                        if (features.metrics === undefined) {
                            testInfo.annotations.push({ type: 'metrics', description: `${name}: the connector offers no metrics interface` });
                            return;
                        }
                        testInfo.annotations.push({ type: 'metrics', description: `${name}: metrics interface listed${features.metrics.includes('openMetrics') ? ' (openMetrics)' : ''}` });
                    });
                }
            });
    }

    test('every connected connector is recorded with its function groups, interfaces and features',
        testMeta({
            id: 'REG-DEP-01.f', prio: 'P2', issue: 'ilm#425',
            rule: ['inventory of what the tier offers; a group, kind, interface or feature that is not known is recorded, not a failure'],
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(CONNECTOR_READ_TEST_MS);
            const connected = (await listConnectors(api)).filter((c) => c.status === 'connected');
            expect(connected.length, 'the tier lists at least one connected connector').toBeGreaterThan(0);
            for (const connector of connected) {
                await test.step(`Record ${connector.name}`, async () => {
                    const read = await connectorVersion(api, connector.uuid);
                    const description = read.detail
                        ? inventoryLine(connector.name, read.version, read.detail)
                        : `${connector.name}: the detail read answered ${read.detailStatus}`;
                    testInfo.annotations.push({ type: 'connector-inventory', description });
                });
            }
        });
});
