import { describeLocalOnly } from '../../utils/regression/tier/localProof';
import { timestampingConfig } from '../../utils/timestamping/config';
import {
  containerState,
  cryptographyProviderContainer,
  DOCKER,
  dockerAvailable,
  startContainer,
  stopContainer,
  waitFor,
  waitForContainerState,
} from '../../utils/timestamping/docker';
import { expect, test } from '../../utils/timestamping/fixtures';
import { primaryFamily } from '../../utils/timestamping/provisioning';
import { devTests } from '../../utils/timestamping/tags';
import { describeOutcome, requestTimestamp, TimestampOutcome } from '../../utils/timestamping/tsp';

describeLocalOnly(test);

/**
 * Core reaches the cryptography provider and the formatting connector over the connector wire. An
 * outage of either must reach the client as an in-band system failure, never as an HTTP error or a
 * token, and issuing must resume as soon as the connector is back.
 *
 * Tagged @slow: it stops a connector and waits for it to become healthy again.
 */
test.describe('connector outage @slow', { tag: [...devTests({ slow: true, disruptive: true }).tag, DOCKER] }, () => {
  test.describe.configure({ timeout: 480_000 });
  // The tests stop containers: a local stack with a docker daemon, and the explicit opt-in.
  test.skip(!timestampingConfig().allowDisruption, 'disruptive: set TSA_ALLOW_DISRUPTION=true');
  test.skip(() => !dockerAvailable(), 'docker is not available');

  const outages = [
    { container: cryptographyProviderContainer(), step: /signing/i },
    { container: timestampingConfig().containers.timestampFormatting, step: /formatting/i },
  ];

  const INTERNALS = /exception|sql|com\.otilm|hibernate|nullpointer|stacktrace|host\.docker|http:\/\//i;

  for (const { container, step } of outages) {
    test(`a ${container} outage is a system failure and issuing resumes when it returns`, devTests({ slow: true, disruptive: true }), async ({ tsp }) => {
      const profileName = primaryFamily().nonQualified.signingProfile.name;
      const before = await requestTimestamp(tsp, { label: `outage-${container}-before`, profileName });
      expect(before.reply?.granted, `issuance before the outage: ${describeOutcome(before)}`).toBe(true);

      let refused: TimestampOutcome;
      try {
        stopContainer(container);
        const stoppedState = await waitForContainerState(container, ['exited', 'missing'], 60_000);
        expect(stoppedState, `the ${container} container is stopped`).not.toBe('healthy');
        refused = await requestTimestamp(tsp, { label: `outage-${container}-down`, profileName });
      } finally {
        startContainer(container);
      }

      expect(refused.httpStatus, describeOutcome(refused)).toBe(200);
      expect(refused.reply?.granted, describeOutcome(refused)).toBe(false);
      expect(refused.reply?.failureInfo, describeOutcome(refused)).toMatch(/system failure/i);
      expect(refused.reply?.statusDescription, 'the rejection names the failed step').toMatch(step);
      const text = `${refused.reply?.statusDescription ?? ''} ${refused.reply?.failureInfo ?? ''}`;
      expect(INTERNALS.test(text), `rejection text leaks internals: "${text}"`).toBe(false);

      const health = await waitForContainerState(container, ['healthy'], 180_000);
      expect(health, `the ${container} container is healthy again`).toBe('healthy');
      const recovered = await waitFor(
        () => requestTimestamp(tsp, { label: `outage-${container}-recovered`, profileName }),
        (outcome) => outcome.reply?.granted === true,
        120_000,
        5000,
      );
      expect(recovered.reply?.granted, `issuance after recovery: ${describeOutcome(recovered)}`).toBe(true);
    });
  }

  // The next spec file must find every connector serving again, whatever happened above.
  test.afterAll(async () => {
    if (!timestampingConfig().allowDisruption || !dockerAvailable()) return; // no test ran, no container was stopped
    for (const { container } of outages) {
      if (containerState(container) !== 'healthy') {
        startContainer(container);
        await waitForContainerState(container, ['healthy'], 180_000);
      }
    }
  });
});
