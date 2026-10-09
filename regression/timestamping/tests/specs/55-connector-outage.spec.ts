import {
  containerState,
  cryptographyProviderContainer,
  DOCKER,
  startContainer,
  stopContainer,
  waitFor,
  waitForContainerState,
} from '../utils/docker';
import { primaryFamily } from '../utils/env';
import { expect, test } from '../utils/fixtures';
import { describeOutcome, requestTimestamp, TimestampOutcome } from '../utils/tsp';

/**
 * Core reaches the cryptography provider and the formatting connector over the connector wire. An
 * outage of either must reach the client as an in-band system failure, never as an HTTP error or a
 * token, and issuing must resume as soon as the connector is back.
 *
 * Tagged @slow: it stops a connector and waits for it to become healthy again.
 */
test.describe('connector outage @slow', { tag: DOCKER }, () => {
  test.describe.configure({ timeout: 480_000 });

  const primary = primaryFamily();
  const profileName = primary.nonQualified.signingProfile.name;
  const outages = [
    { container: cryptographyProviderContainer(primary.cryptoProvider), step: /signing/i },
    { container: 'timestamp-formatting-connector', step: /formatting/i },
  ];

  const INTERNALS = /exception|sql|com\.otilm|hibernate|nullpointer|stacktrace|host\.docker|http:\/\//i;

  for (const { container, step } of outages) {
    test(`a ${container} outage is a system failure and issuing resumes when it returns`, async ({ tsp }) => {
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
    for (const { container } of outages) {
      if (containerState(container) !== 'healthy') {
        startContainer(container);
        await waitForContainerState(container, ['healthy'], 180_000);
      }
    }
  });
});
