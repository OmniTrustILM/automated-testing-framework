import { containerState, listQueues } from '../utils/docker';
import { expect, test } from '../utils/fixtures';

/**
 * The environment itself, asserted before anything is blamed on the code under test.
 * A failure here means the stack is broken, not that timestamping regressed.
 */
test.describe('environment', () => {
  const containers = [
    'postgres',
    'rabbitmq',
    'opa',
    'auth',
    'scheduler',
    'common-credential-provider',
    'ejbca-ng-connector',
    'software-cryptography-provider',
    'timestamp-formatting-connector',
    'time-quality-monitor',
    'ntp',
  ];

  test('Core answers its health probes', async ({ admin }) => {
    const liveness = await admin.raw('GET', '/v1/health/liveness');
    expect(liveness.status(), 'Core liveness').toBe(200);

    const readiness = await admin.raw('GET', '/v1/health/readiness');
    expect(readiness.status(), 'Core readiness').toBe(200);
  });

  test('every dependency container is up', () => {
    const unhealthy = containers
      .map((name) => ({ name, state: containerState(name) }))
      .filter(({ state }) => state !== 'healthy' && state !== 'running');
    expect(unhealthy, `containers not up: ${JSON.stringify(unhealthy)}`).toEqual([]);
  });

  test('the connectors backing timestamping are connected and healthy', async ({ admin, env }) => {
    // v1 and v2 connectors expose different health routes: /v1/connectors/{uuid}/health
    // proxies the connector's /v1/health, which a v2 connector does not serve.
    const expected = [
      env.connectors.credentialProvider,
      env.connectors.ejbca,
      env.connectors.cryptographyProvider,
      env.connectors.timestampFormatting,
      env.connectors.vault,
    ];
    const alwaysV2 = [env.connectors.timestampFormatting.uuid, env.connectors.vault.uuid];

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

  test('Core is subscribed to the time-quality exchange', () => {
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
