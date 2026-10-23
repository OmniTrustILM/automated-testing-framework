import { describeLocalOnly } from '../../utils/regression/tier/localProof';
import { containerState, DOCKER, dockerAvailable, listQueues } from '../../utils/timestamping/docker';
import { expect, test } from '../../utils/timestamping/fixtures';
import { cryptographyConnectors } from '../../utils/timestamping/provisioning';
import { timestampingConfig } from '../../utils/timestamping/config';
import { devTests } from '../../utils/timestamping/tags';

describeLocalOnly(test);

/**
 * The environment itself, asserted before anything is blamed on the code under test.
 * A failure here means the stack is broken, not that timestamping regressed.
 */
const c = timestampingConfig().containers;
test.describe('environment', devTests(), () => {
  // The containers the environment names; the ones the TSA_CONTAINER_* variables can rename come from the config.
  const containers = [
    'postgres',
    c.rabbitmq,
    'opa',
    'auth',
    'scheduler',
    'common-credential-provider',
    'ejbca-ng-connector',
    c.cryptographyProvider,
    c.timestampFormatting,
    c.timeQualityMonitor,
    c.ntp,
  ];

  test('Core answers its health probes', devTests(), async ({ admin }) => {
    const liveness = await admin.raw('GET', '/v1/health/liveness');
    expect(liveness.status(), 'Core liveness').toBe(200);

    const readiness = await admin.raw('GET', '/v1/health/readiness');
    expect(readiness.status(), 'Core readiness').toBe(200);
  });

  test('every dependency container is up', { tag: [...devTests().tag, DOCKER] }, () => {
    test.skip(!dockerAvailable(), 'docker is not available');
    const unhealthy = containers
      .map((name) => ({ name, state: containerState(name) }))
      .filter(({ state }) => state !== 'healthy' && state !== 'running');
    expect(unhealthy, `containers not up: ${JSON.stringify(unhealthy)}`).toEqual([]);
  });

  test('the connectors backing timestamping are connected and healthy', devTests(), async ({ admin, ts }) => {
    // v1 and v2 connectors expose different health routes: /v1/connectors/{uuid}/health
    // proxies the connector's /v1/health, which a v2 connector does not serve.
    const expected = [
      ts.connectors.credentialProvider,
      ts.connectors.ejbca,
      ...cryptographyConnectors(),
      ts.connectors.timestampFormatting,
      ts.connectors.vault,
    ];
    const alwaysV2 = [ts.connectors.timestampFormatting.uuid, ts.connectors.vault.uuid];

    const connectors = await admin.get<
      Array<{ uuid: string; name: string; status: string; functionGroups?: unknown[] }>
    >('/v1/connectors');
    for (const connector of expected) {
      const registered = connectors.find((candidate) => candidate.uuid === connector.uuid);
      expect(registered, `connector '${connector.name}' (${connector.uuid}) is registered`).toBeDefined();
      expect(registered!.status, `connector '${connector.name}' status`).toBe('connected');

      const servesV1 = (registered!.functionGroups ?? []).length > 0 && !alwaysV2.includes(connector.uuid);
      if (servesV1) {
        const health = await admin.get<{ status: string }>(`/v1/connectors/${connector.uuid}/health`);
        expect(health.status, `connector '${connector.name}' health`).toBe('ok');
      } else {
        const health = await admin.get<{ status: string }>(`/v2/connectors/${connector.uuid}/health`);
        expect(health.status, `connector '${connector.name}' health`).toBe('UP');
      }
    }
  });

  test('Core is subscribed to the time-quality exchange', { tag: [...devTests().tag, DOCKER] }, () => {
    test.skip(!dockerAvailable(), 'docker is not available');
    // 0 consumers on the config-request queue is the signature of a Core started without
    // MESSAGING_TIME_QUALITY_ENABLED — every qualified timestamp would fail later with
    // "time quality is not sufficient" and no other clue.
    const queues = listQueues(/time-quality/);
    expect(queues.length, 'time-quality queues exist').toBeGreaterThan(0);

    const configRequest = queues.find((queue) => queue.name.includes('config-request'));
    expect(configRequest, `time-quality.config-request queue exists (found: ${queues.map((q) => q.name)})`).toBeDefined();
    expect(configRequest!.consumers, 'consumers on time-quality.config-request').toBeGreaterThan(0);
  });
});
