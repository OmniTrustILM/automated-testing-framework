import { containerState, startContainer, stopContainer, waitFor, waitForContainerState } from '../utils/docker';
import { expect, test } from '../utils/fixtures';
import { isoDurationToMicroseconds } from '../utils/openssl';
import { describeOutcome, requestTimestamp, TimestampOutcome } from '../utils/tsp';

/**
 * Time quality gates the qualified profile only. The regression this guards against is a
 * change that makes degraded time either stop everything (non-qualified must keep working)
 * or nothing (qualified must stop).
 *
 * Outage and recovery are one test on purpose: recovery is only meaningful after an outage
 * this test caused, and a single try/finally guarantees the NTP source is restored even when
 * an assertion fails midway.
 *
 * Tagged @slow: it takes the NTP source away and waits for the platform to notice.
 */
test.describe('time quality @slow', () => {
  test.describe.configure({ timeout: 480_000 });

  test('qualified timestamps stop while the NTP source is gone and resume when it returns', async ({ tsp, env }) => {
    const qualified = env.sets.qualified.signingProfile.name;
    const nonQualified = env.sets.nonQualified.signingProfile.name;

    const baseline = await requestTimestamp(tsp, { label: 'time-quality-baseline', profileName: qualified });
    expect(baseline.reply?.granted, `qualified issuance before the outage: ${describeOutcome(baseline)}`).toBe(true);

    try {
      stopContainer('ntp');
      const stoppedState = await waitForContainerState('ntp', ['exited', 'missing'], 60_000);
      expect(stoppedState, 'the ntp container is stopped').not.toBe('healthy');

      const degraded = await waitFor(
        () => requestTimestamp(tsp, { label: 'time-quality-degraded', profileName: qualified }),
        (outcome) => outcome.reply?.granted === false,
        180_000,
        5000,
      );
      expect(degraded.reply?.granted, `qualified issuance during the outage: ${describeOutcome(degraded)}`).toBe(false);
      expect(
        `${degraded.reply?.failureInfo ?? ''} ${degraded.reply?.statusDescription ?? ''}`.toLowerCase(),
        'the rejection names the time source as the reason',
      ).toMatch(/time/);

      const plain = await requestTimestamp(tsp, {
        label: 'time-quality-degraded-non-qualified',
        profileName: nonQualified,
      });
      expect(plain.reply?.granted, `non-qualified issuance must survive the outage: ${describeOutcome(plain)}`).toBe(
        true,
      );
    } finally {
      startContainer('ntp');
    }

    const health = await waitForContainerState('ntp', ['healthy'], 180_000);
    expect(health, 'the ntp container is healthy again').toBe('healthy');

    const recovered = await waitFor(
      () => requestTimestamp(tsp, { label: 'time-quality-recovered', profileName: qualified }),
      (outcome) => outcome.reply?.granted === true,
      180_000,
      5000,
    );
    expect(recovered.reply?.granted, `qualified issuance after recovery: ${describeOutcome(recovered)}`).toBe(true);
    expect(recovered.reply?.accuracyMicroseconds, 'configured accuracy is stated again').toBe(
      isoDurationToMicroseconds(env.timeQuality.accuracy),
    );
  });

  // Whatever happened above, the next spec file must find an environment that can issue
  // qualified timestamps; a silent failure here would surface as an unrelated red test.
  test.afterAll(async ({ tsp, env }) => {
    if (containerState('ntp') !== 'healthy') {
      startContainer('ntp');
      await waitForContainerState('ntp', ['healthy'], 180_000);
    }
    const restored: TimestampOutcome = await waitFor(
      () =>
        requestTimestamp(tsp, {
          label: 'time-quality-restore',
          profileName: env.sets.qualified.signingProfile.name,
        }),
      (outcome) => outcome.reply?.granted === true,
      180_000,
      5000,
    );
    expect(
      restored.reply?.granted,
      `the environment was left unable to issue qualified timestamps: ${describeOutcome(restored)}`,
    ).toBe(true);
  });
});
