import { containerState, startContainer, stopContainer, waitFor, waitForContainerState } from '../utils/docker';
import { provisionedFamilies } from '../utils/env';
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
 * Every qualified profile is checked inside the one outage window rather than in a test per
 * family: the gate is a property of the time-quality configuration they share, so a second
 * outage would prove nothing and cost another few minutes.
 *
 * Tagged @slow: it takes the NTP source away and waits for the platform to notice.
 */
test.describe('time quality @slow', () => {
  test.describe.configure({ timeout: 480_000 });

  const families = provisionedFamilies();
  // Polling one profile is enough to learn the platform has noticed; the rest are then
  // checked once, because they are gated by the same configuration.
  const [leading] = families;

  test('qualified timestamps stop while the NTP source is gone and resume when it returns', async ({ tsp, env }) => {
    const qualified = leading.qualified.signingProfile.name;
    const expectedAccuracy = isoDurationToMicroseconds(env.timeQuality.accuracy);

    for (const family of families) {
      const baseline = await requestTimestamp(tsp, {
        label: `time-quality-baseline-${family.label}`,
        profileName: family.qualified.signingProfile.name,
      });
      expect(
        baseline.reply?.granted,
        `${family.label} qualified issuance before the outage: ${describeOutcome(baseline)}`,
      ).toBe(true);
    }

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

      // The platform has noticed by now, so any other qualified profile must already refuse.
      for (const family of families.slice(1)) {
        const alsoDegraded = await requestTimestamp(tsp, {
          label: `time-quality-degraded-${family.label}`,
          profileName: family.qualified.signingProfile.name,
        });
        expect(
          alsoDegraded.reply?.granted,
          `${family.label} qualified issuance during the outage: ${describeOutcome(alsoDegraded)}`,
        ).toBe(false);
      }

      for (const family of families) {
        const plain = await requestTimestamp(tsp, {
          label: `time-quality-degraded-non-qualified-${family.label}`,
          profileName: family.nonQualified.signingProfile.name,
        });
        expect(
          plain.reply?.granted,
          `${family.label} non-qualified issuance must survive the outage: ${describeOutcome(plain)}`,
        ).toBe(true);
      }
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
    expect(recovered.reply?.accuracyMicroseconds, 'configured accuracy is stated again').toBe(expectedAccuracy);

    for (const family of families.slice(1)) {
      const alsoRecovered = await requestTimestamp(tsp, {
        label: `time-quality-recovered-${family.label}`,
        profileName: family.qualified.signingProfile.name,
      });
      expect(
        alsoRecovered.reply?.granted,
        `${family.label} qualified issuance after recovery: ${describeOutcome(alsoRecovered)}`,
      ).toBe(true);
      expect(
        alsoRecovered.reply?.accuracyMicroseconds,
        `${family.label} states the configured accuracy again`,
      ).toBe(expectedAccuracy);
    }
  });

  // Whatever happened above, the next spec file must find an environment that can issue
  // qualified timestamps; a silent failure here would surface as an unrelated red test.
  test.afterAll(async ({ tsp }) => {
    if (containerState('ntp') !== 'healthy') {
      startContainer('ntp');
      await waitForContainerState('ntp', ['healthy'], 180_000);
    }
    const restored: TimestampOutcome = await waitFor(
      () =>
        requestTimestamp(tsp, {
          label: 'time-quality-restore',
          profileName: leading.qualified.signingProfile.name,
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
